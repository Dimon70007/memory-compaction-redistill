import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { completeText, extractJsonObject } from "./llm.js";
import { asNonEmptyString } from "./env.js";

const FACTS_SYSTEM = [
  "Extract durable session decisions from a compaction summary.",
  "Return strict JSON only:",
  "{",
  '  "currentDecisions": string[],',
  '  "superseded": string[],',
  '  "openTodos": string[],',
  '  "archiveTranscript": string',
  "}",
  "Keep each item one short sentence. No tool noise. archiveTranscript must echo the provided transcript path.",
].join("\n");

/**
 * Parse markdown sections from compaction summary directly.
 * PRIMARY extraction method - reliable, no LLM needed.
 * @param {string} summary
 * @returns {{ currentDecisions: string[]; superseded: string[]; openTodos: string[] }}
 */
function parseMarkdownSections(summary) {
  const lines = summary.split("\n");
  const result = { currentDecisions: [], superseded: [], openTodos: [] };
  let currentSection = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Previous decisions/i.test(trimmed)) {
      currentSection = "currentDecisions"; // carried forward = current
      continue;
    }
    if (/^##\s+Current decisions/i.test(trimmed)) {
      currentSection = "currentDecisions";
      continue;
    }
    if (/^##\s+Superseded/i.test(trimmed)) {
      currentSection = "superseded";
      continue;
    }
    if (/^##\s+Open TODOs/i.test(trimmed)) {
      currentSection = "openTodos";
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      currentSection = null; // other sections
      continue;
    }
    if (currentSection && trimmed && !trimmed.startsWith("##")) {
      // Clean bullet points
      const clean = trimmed.replace(/^[-*•]\s*/, "").trim();
      if (clean && clean.toLowerCase() !== "none" && clean.length > 5) {
        result[currentSection].push(clean.slice(0, 200));
      }
    }
  }
  return result;
}

/**
 * @typedef {object} ExtractedFacts
 * @property {string[]} currentDecisions
 * @property {string[]} superseded
 * @property {string[]} openTodos
 * @property {string} archiveTranscript
 */

/**
 * @param {import("./llm.js").LlmResolvedConfig} llmConfig
 * @param {string} summary
 * @param {string} archiveTranscript
 * @returns {Promise<ExtractedFacts>}
 */
export async function extractFactsFromSummary(llmConfig, summary, archiveTranscript) {
  // PRIMARY: Parse markdown sections directly (reliable, no LLM needed)
  const parsed = parseMarkdownSections(summary);
  const hasContent = parsed.currentDecisions.length > 0 || parsed.superseded.length > 0 || parsed.openTodos.length > 0;
  
  if (hasContent) {
    return {
      currentDecisions: parsed.currentDecisions.slice(0, 12),
      superseded: parsed.superseded.slice(0, 12),
      openTodos: parsed.openTodos.slice(0, 12),
      archiveTranscript,
    };
  }
  
  // FALLBACK: JSON fact extraction (C4 — FACTS_SYSTEM; flush prompts are for workspace notes only)
  const complete = typeof llmConfig.completeText === "function" ? llmConfig.completeText : completeText;
  const raw = await complete(llmConfig, {
    system: FACTS_SYSTEM,
    user: [
      `Archive transcript: ${archiveTranscript}`,
      "",
      "Compaction summary:",
      summary,
    ].join("\n"),
  });
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return fallbackFacts(summary, archiveTranscript);
  }
  try {
    const parsed = JSON.parse(jsonText);
    return {
      currentDecisions: normalizeStringArray(parsed.currentDecisions),
      superseded: normalizeStringArray(parsed.superseded),
      openTodos: normalizeStringArray(parsed.openTodos),
      archiveTranscript: asNonEmptyString(parsed.archiveTranscript) ?? archiveTranscript,
    };
  } catch {
    return fallbackFacts(summary, archiveTranscript);
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

/**
 * @param {string} summary
 * @param {string} archiveTranscript
 * @returns {ExtractedFacts}
 */
function fallbackFacts(summary, archiveTranscript) {
  return {
    currentDecisions: [summary.slice(0, 500)],
    superseded: [],
    openTodos: [],
    archiveTranscript,
  };
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.memorySubdir
 * @param {string} params.sessionId
 * @param {string} params.sessionKey
 * @param {string} params.summary
 * @param {ExtractedFacts} params.facts
 * @param {string} params.activeTranscript
 * @returns {Promise<string>}
 */
export async function writeWorkspaceCompactionSnapshot(params) {
  const date = new Date().toISOString().slice(0, 10);
  const safeSession = params.sessionId.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 64);
  const relativePath = join(params.memorySubdir, `${date}-${safeSession}.md`);
  const absolutePath = join(params.workspaceDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const body = [
    "---",
    `sessionKey: ${params.sessionKey}`,
    `sessionId: ${params.sessionId}`,
    `activeTranscript: ${params.activeTranscript}`,
    `archiveTranscript: ${params.facts.archiveTranscript}`,
    `updatedAt: ${new Date().toISOString()}`,
    "---",
    "",
    "# Compaction snapshot",
    "",
    "## Summary",
    params.summary,
    "",
    "## Current decisions",
    ...params.facts.currentDecisions.map((line) => `- ${line}`),
    "",
    "## Superseded / rejected",
    ...params.facts.superseded.map((line) => `- ${line}`),
    "",
    "## Open TODOs",
    ...params.facts.openTodos.map((line) => `- ${line}`),
    "",
    "## Archive",
    `- Full session history: \`${params.facts.archiveTranscript}\``,
    `- Active transcript after rotation: \`${params.activeTranscript}\``,
    "",
  ].join("\n");
  await writeFile(absolutePath, body, "utf8");
  return relativePath;
}

/**
 * @param {object} params
 * @param {string} params.memoryLancedbProPath
 * @param {unknown} params.memoryProConfig
 * @param {ExtractedFacts} params.facts
 * @param {string} params.sessionKey
 * @param {string} params.sessionId
 * @param {string} params.agentId
 * @param {(msg: string) => void} params.log
 * @returns {Promise<void>}
 */
export async function syncFactsToLancedb(params) {
  const pluginRoot = params.memoryLancedbProPath.trim();
  if (!pluginRoot) {
    throw new Error("memoryLancedbProPath is not configured");
  }
  const storeUrl = pathToFileURL(join(pluginRoot, "dist/src/store.js")).href;
  const embedderUrl = pathToFileURL(join(pluginRoot, "dist/src/embedder.js")).href;
  const metadataUrl = pathToFileURL(join(pluginRoot, "dist/src/smart-metadata.js")).href;
  const [
    { MemoryStore, normalizeStoragePath },
    { createEmbedder, getEffectiveVectorDimensions },
    { buildSmartMetadata, stringifySmartMetadata },
  ] = await Promise.all([import(storeUrl), import(embedderUrl), import(metadataUrl)]);

  const memoryProConfig =
    params.memoryProConfig && typeof params.memoryProConfig === "object"
      ? /** @type {Record<string, unknown>} */ (params.memoryProConfig)
      : {};
  const dbPathRaw =
    asNonEmptyString(memoryProConfig.dbPath) ??
    join(process.env.HOME ?? "", ".openclaw", "memory", "lancedb_pro");
  const dbPath =
    typeof normalizeStoragePath === "function" ? normalizeStoragePath(dbPathRaw) : dbPathRaw;
  const embedding = memoryProConfig.embedding;
  if (!embedding || typeof embedding !== "object") {
    throw new Error("memory-lancedb-pro embedding config missing");
  }
  const embeddingCfg = /** @type {Record<string, unknown>} */ (embedding);
  const embeddingModel =
    asNonEmptyString(embeddingCfg.model) ?? "qwen3-embedding:0.6b-fp16";
  const vectorDim = getEffectiveVectorDimensions(
    embeddingModel,
    typeof embeddingCfg.dimensions === "number" ? embeddingCfg.dimensions : undefined,
    typeof embeddingCfg.requestDimensions === "number"
      ? embeddingCfg.requestDimensions
      : undefined,
  );
  const retrieval =
    memoryProConfig.retrieval && typeof memoryProConfig.retrieval === "object"
      ? /** @type {{ disableNativeCosine?: boolean }} */ (memoryProConfig.retrieval)
      : {};
  const store = new MemoryStore({
    dbPath,
    vectorDim,
    disableNativeCosine: retrieval.disableNativeCosine === true,
  });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: embeddingCfg.apiKey,
    model: embeddingModel,
    baseURL: asNonEmptyString(embeddingCfg.baseURL),
    dimensions: embeddingCfg.dimensions,
    requestDimensions: embeddingCfg.requestDimensions,
    omitDimensions: embeddingCfg.omitDimensions,
    taskPassage: embeddingCfg.taskPassage,
    normalized: embeddingCfg.normalized,
  });

  const scope =
    memoryProConfig.scopes &&
    typeof memoryProConfig.scopes === "object" &&
    typeof /** @type {{ default?: string }} */ (memoryProConfig.scopes).default === "string"
      ? /** @type {{ default?: string }} */ (memoryProConfig.scopes).default
      : "global";

  const now = Date.now();
  const lines = [
    ...params.facts.currentDecisions.map((line) => `CURRENT: ${line}`),
    ...params.facts.superseded.map((line) => `SUPERSEDED: ${line}`),
  ];
  if (lines.length === 0) {
    params.log("memory-compaction-redistill: no decision lines to store in LanceDB");
    return;
  }

  const memoryText = [
    `Session compaction decisions (${params.sessionId})`,
    `Session key: ${params.sessionKey}`,
    `Archive transcript: ${params.facts.archiveTranscript}`,
    "",
    ...lines,
  ].join("\n");

  const vector = await embedder.embedPassage(memoryText);
  await store.store({
    text: memoryText,
    vector,
    category: "decision",
    scope,
    importance: 0.85,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        {
          text: memoryText.slice(0, 240),
          category: "decision",
          importance: 0.85,
          timestamp: now,
        },
        {
          l0_abstract: `Compaction decisions for ${params.sessionId}`,
          l1_overview: params.facts.currentDecisions.slice(0, 3).join(" | "),
          l2_content: memoryText,
          memory_category: "patterns",
          tier: "working",
          confidence: 0.85,
          source: "session-summary",
          source_session: params.sessionKey,
          state: "confirmed",
          memory_layer: "durable",
          type: "session-compaction",
          sessionId: params.sessionId,
          agentId: params.agentId,
          archiveTranscript: params.facts.archiveTranscript,
          scope,
        },
      ),
    ),
  });
  params.log(
    `memory-compaction-redistill: stored compaction decisions in LanceDB (scope=${scope}, lines=${lines.length})`,
  );
}
