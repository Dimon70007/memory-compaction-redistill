import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, stat } from "node:fs/promises";
import { createCompactionProvider } from "./lib/compaction-provider.js";
import { resolveLlmConfig } from "./lib/llm.js";
import {
  extractFactsFromSummary,
  syncFactsToLancedb,
  writeWorkspaceCompactionSnapshot,
} from "./lib/lancedb-sync.js";
import {
  readLatestCompaction,
  readSessionHeaderParent,
  resolveArchiveTranscriptPath,
} from "./lib/session-transcript.js";
import { asNonEmptyString } from "./lib/env.js";
import { formatMessagesForPrompt } from "./lib/messages.js";
import { completeText } from "./lib/llm.js";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * T031: Self-healing re-registration guard.
 * Tracks whether the compaction provider is actively registered.
 * Used by the after_compaction hook to detect fallback compactions.
 */
let registrationConfirmed = false;
let registrationTimestamp = 0;

/**
 * T047: Last session file seen by after_compaction.
 * Used by the compaction provider to recover `previousSummary` when OpenClaw
 * does not provide it (which happens after transcript rotation: the new child
 * transcript file has no compaction entry, so prepareCompaction passes
 * `previousSummary = undefined` and the provider loses all carried-forward decisions).
 */
let lastCompactedSessionFile = null;

/**
 * T047 fallback: find the most recent session file with a compaction entry
 * by scanning the sessions directory. Used after gateway restart when
 * in-memory `lastCompactedSessionFile` is lost.
 */
async function findLatestCompactedSessionFile() {
  const sessionsDir = join(process.env.HOME ?? "", ".openclaw", "agents", "main", "sessions");
  try {
    const entries = await readdir(sessionsDir);
    const jsonlFiles = entries
      .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
      .map((f) => join(sessionsDir, f));
    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => {
        const s = await stat(f).catch(() => null);
        return s ? { file: f, mtime: s.mtimeMs } : null;
      }),
    );
    const valid = withMtime.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    for (const { file } of valid) {
      const record = await readLatestCompaction(file);
      if (record?.summary) return file;
    }
  } catch {
    // directory may not exist or be unreadable
  }
  return null;
}

/**
 * T047: Recover the previous compaction summary when OpenClaw did not pass one.
 * After transcript rotation the active (child) session file has no compaction
 * entry, so `params.previousSummary` is empty. We recover it from the last
 * compacted file (captured in after_compaction) and, if that file also lacks a
 * compaction entry, from its parent session file.
 * Falls back to scanning sessions directory if in-memory state was lost (e.g. after gateway restart).
 */
async function recoverPreviousSummary() {
  if (lastCompactedSessionFile) {
    try {
      let record = await readLatestCompaction(lastCompactedSessionFile);
      if (!record?.summary) {
        const parent = await readSessionHeaderParent(lastCompactedSessionFile);
        if (parent) record = await readLatestCompaction(parent);
      }
      if (record?.summary) return record.summary;
    } catch {
      // fall through to filesystem scan
    }
  }
  const fallbackFile = await findLatestCompactedSessionFile();
  if (fallbackFile) {
    const record = await readLatestCompaction(fallbackFile);
    if (record?.summary) return record.summary;
  }
  return null;
}

/**
 * Extract decision lines from a summary text (Hybrid Variant B format).
 */
function extractDecisionLines(summary) {
  const lines = summary.split("\n");
  const decisions = [];
  let inDecisions = false;
  for (const line of lines) {
    if (/^##\s+(Previous decisions|Current decisions)/i.test(line)) {
      inDecisions = true;
      continue;
    }
    if (/^##\s+/.test(line) && inDecisions) break;
    if (inDecisions && line.trim() && !line.startsWith("##")) {
      decisions.push(line.trim());
    }
  }
  return decisions;
}

/**
 * Extract identifiers from a summary for preservation tracking.
 */
function extractIdentifiers(summary) {
  const identifiers = new Set();
  const patterns = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUIDs
    /[0-9a-f]{8,}/g, // short hashes / memory IDs
    /\bT\d{2,3}\b/g, // Task IDs T031, T047, T080
    /\b\d{10,}\b/g, // Cron IDs like 91838730-9f44-4e4d-9008-04b35aca9fb9
    /agents\.defaults\.[\w.]+/g, // Config keys
    /keepRecentTokens|reserveTokensFloor|truncateAfterCompaction/g,
    /memory-compaction-redistill|memory-lancedb-pro/g, // Plugin names
    /qwen\/qwen3\.6-35b-a3b|ling-3\.0-flash-fin/g, // Model names
    /USDRUBF|UVXY|AAPL|TSLA|NVDA/g, // Tickers
    /\/home\/<user_directory>\/[^\s\)]+/g, // File paths
    /memory\/[\d-]+\.md/g,
  ];
  for (const pattern of patterns) {
    const matches = summary.match(pattern);
    if (matches) matches.forEach((m) => identifiers.add(m));
  }
  return Array.from(identifiers);
}

/**
 * T031: Verify that previous decisions are carried forward in the new summary.
 * Reads the previous compaction from the archive transcript and checks
 * that key decisions appear in the new summary.
 */
async function verifyPreviousDecisions(api, sessionFile, newSummary) {
  try {
    const parentSession = await readSessionHeaderParent(sessionFile);
    if (!parentSession) return;

    const fs = await import("node:fs/promises");
    let prevSummary = null;
    try {
      const raw = await fs.readFile(parentSession, "utf8");
      const lines = raw.split(/\r?\n/u).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry?.type === "compaction" && entry.summary) {
            prevSummary = entry.summary;
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* parent file may not exist */ }

    if (!prevSummary) return;

    const prevDecisions = extractDecisionLines(prevSummary);
    if (prevDecisions.length === 0) return;

    const newSummaryLower = newSummary.toLowerCase();
    let carried = 0;
    let missing = [];
    for (const decision of prevDecisions) {
      const normalized = decision.replace(/^[-*•]\s*/, "").replace(/\*+/g, "").trim().toLowerCase();
      if (normalized.length < 10) continue;
      if (newSummaryLower.includes(normalized.slice(0, 60))) {
        carried++;
      } else {
        missing.push(decision.slice(0, 80));
      }
    }

    if (prevDecisions.length > 0) {
      const ratio = carried / prevDecisions.length;
      if (ratio < 0.5 && missing.length > 0) {
        api.logger.warn(
          `memory-compaction-redistill: T031 VERIFICATION WARNING — only ${carried}/${prevDecisions.length} previous decisions carried forward. Missing: ${missing.slice(0, 3).join("; ")}`,
        );
      } else {
        api.logger.info(
          `memory-compaction-redistill: T031 verification OK — ${carried}/${prevDecisions.length} previous decisions carried forward`,
        );
      }
    }
  } catch (err) {
    api.logger.debug?.(`memory-compaction-redistill: T031 verification error: ${String(err)}`);
  }
}

/**
 * Async quality metrics logging — fire-and-forget, doesn't block compaction.
 */
function logQualityMetricsAsync(api, sessionFile, newSummary, prevSummary) {
  // Run asynchronously without awaiting
  Promise.resolve().then(async () => {
    try {
      // Read previous summary from parent if not provided
      let previous = prevSummary;
      if (!previous) {
        const parentSession = await readSessionHeaderParent(sessionFile);
        if (parentSession) {
          const fs = await import("node:fs/promises");
          try {
            const raw = await fs.readFile(parentSession, "utf8");
            const lines = raw.split(/\r?\n/u).filter((l) => l.trim());
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry?.type === "compaction" && entry.summary) {
                  previous = entry.summary;
                  break;
                }
              } catch { /* skip */ }
            }
          } catch { /* ignore */ }
        }
      }

      if (!previous) {
        api.logger.info("memory-compaction-redistill: quality metrics — no previous summary to compare");
        return;
      }

      // 1. Decision carry-forward rate
      const prevDecisions = extractDecisionLines(previous);
      const newDecisions = extractDecisionLines(newSummary);
      let carried = 0;
      for (const decision of prevDecisions) {
        const normalized = decision.replace(/^[-*•]\s*/, "").replace(/\*+/g, "").trim().toLowerCase();
        if (normalized.length < 10) continue;
        if (newSummary.toLowerCase().includes(normalized.slice(0, 60))) carried++;
      }
      const carryRate = prevDecisions.length > 0 ? carried / prevDecisions.length : 1;

      // 2. Identifier preservation rate
      const prevIdentifiers = extractIdentifiers(previous);
      const newIdentifiers = new Set(extractIdentifiers(newSummary));
      let preservedIds = 0;
      for (const id of prevIdentifiers) {
        if (newIdentifiers.has(id)) preservedIds++;
      }
      const idPreservationRate = prevIdentifiers.length > 0 ? preservedIds / prevIdentifiers.length : 1;

      // 3. Section completeness (all 7 sections present)
      const requiredSections = [
        "## Previous decisions (carried forward)",
        "## Current decisions",
        "## Superseded / rejected",
        "## Open hypotheses (unconfirmed)",
        "## Open TODOs",
        "## Pending user asks",
        "## Session archive",
      ];
      const sectionsPresent = requiredSections.filter((s) => newSummary.includes(s)).length;
      const sectionCompleteness = sectionsPresent / requiredSections.length;

      // 4. Silent drops (decisions moved to Superseded without explanation)
      const supersededSection = newSummary.split("## Superseded / rejected")[1]?.split("##")[0] ?? "";
      const silentDrops = (supersededSection.match(/❌/g) || []).length; // rough heuristic

      // 5. Hypothesis labeling rate
      const hypothesisLines = (newSummary.match(/H-\d+/g) || []).length;
      const decisionLines = (newSummary.match(/D-\d+/g) || []).length;
      const hypothesisLabelingRate = (hypothesisLines + decisionLines) > 0
        ? hypothesisLines / (hypothesisLines + decisionLines)
        : 1;

      // Log metrics
      api.logger.info(
        `memory-compaction-redistill: QUALITY METRICS — carryForward=${(carryRate * 100).toFixed(0)}% (${carried}/${prevDecisions.length}) | idPreservation=${(idPreservationRate * 100).toFixed(0)}% (${preservedIds}/${prevIdentifiers.length}) | sections=${sectionsPresent}/7 | silentDrops≈${silentDrops} | hypothesisLabeling=${(hypothesisLabelingRate * 100).toFixed(0)}%`,
      );

      // Alert thresholds
      if (carryRate < 0.8) {
        api.logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — decision carry-forward rate ${(carryRate * 100).toFixed(0)}% < 80%`,
        );
      }
      if (idPreservationRate < 1.0 && prevIdentifiers.length > 0) {
        api.logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — identifier preservation ${(idPreservationRate * 100).toFixed(0)}% < 100% (lost: ${prevIdentifiers.filter((id) => !newIdentifiers.has(id)).slice(0, 5).join(", ")})`,
        );
      }
      if (sectionCompleteness < 1.0) {
        api.logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — incomplete sections: ${sectionsPresent}/7`,
        );
      }
    } catch (err) {
      api.logger.debug?.(`memory-compaction-redistill: quality metrics error: ${String(err)}`);
    }
  });
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (value);
}

// ============================================================================
// Context Engine with ownsCompaction=true
// ============================================================================
// This context engine handles compaction directly, bypassing the broken
// getCompactionProvider lookup (registry state duplicated across chunks in 9.9).
// When ownsCompaction=true, the gateway calls this engine's compact() method
// instead of looking up a provider from the plugin registry.

/**
 * @param {import("./lib/llm.js").LlmResolvedConfig} llmConfig
 * @param {() => Promise<string | null>} recoverPreviousSummary
 */
function createRedistillContextEngine(llmConfig, recoverPreviousSummary) {
  const provider = createCompactionProvider(llmConfig, recoverPreviousSummary);

  return {
    info: {
      id: "memory-compaction-redistill",
      name: "Memory Compaction Redistill Context Engine",
      version: "1.0.0",
      ownsCompaction: true,
      acceptedHostParams: ["agentId", "sessionId", "sessionKey", "sessionTarget", "tokenBudget", "currentTokenCount", "force", "customInstructions", "abortSignal", "workspaceDir"]
    },

    /**
     * @param {object} params
     * @param {unknown[]} params.messages
     * @param {AbortSignal} [params.signal]
     * @param {string} [params.customInstructions]
     * @param {string} [params.previousSummary]
     * @param {object} [params.summarizationInstructions]
     * @param {string} [params.summarizationInstructions.identifierPolicy]
     * @param {string} [params.summarizationInstructions.identifierInstructions]
     * @param {string} [params.latestUnresolvedUserRequest]
     */
    async compact(params) {
      const { messages, signal, customInstructions, previousSummary, summarizationInstructions, latestUnresolvedUserRequest } = params;

      // Recover previousSummary if missing (transcript rotation)
      let prevSummary = previousSummary?.trim() ?? "";
      if (!prevSummary && typeof recoverPreviousSummary === "function") {
        try {
          const recovered = await recoverPreviousSummary();
          if (recovered?.trim()) {
            prevSummary = recovered.trim();
            llmConfig.log?.(`memory-compaction-redistill: context engine T047 recovered previousSummary from parent session (${prevSummary.length} chars)`);
          }
        } catch {
          /* recovery is best-effort */
        }
      }

      const structuredInstructions = buildCompactionStructureInstructions(customInstructions, summarizationInstructions, latestUnresolvedUserRequest);

      try {
        const result = await provider.summarize({
          messages,
          signal,
          customInstructions: structuredInstructions,
          summarizationInstructions,
          previousSummary: prevSummary
        });

        if (typeof result === "string" && result.trim()) {
          return {
            ok: true,
            compacted: true,
            reason: "redistill",
            result: {
              summary: result,
              // The gateway will fill in tokensBefore/After from the preparation
            }
          };
        }
        llmConfig.log?.("memory-compaction-redistill: context engine provider returned empty result");
        return { ok: false, compacted: false, reason: "empty_result" };
      } catch (err) {
        if (signal?.aborted) throw err;
        llmConfig.log?.(`memory-compaction-redistill: context engine compact failed: ${String(err)}`);
        return { ok: false, compacted: false, reason: `error: ${String(err)}` };
      }
    },

    // Required no-op methods for ContextEngine interface
    async ingest() { return { ingested: false }; },
    async assemble(params) { return { messages: params.messages, estimatedTokens: 0 }; },
    async afterTurn() {},
    async ingestBatch() {},
    async maintain() {}
  };
}

/**
 * Build structured compaction instructions from runtime config and event data.
 * Mirrors the logic from the safeguard extension.
 */
function buildCompactionStructureInstructions(customInstructions, summarizationInstructions, latestUnresolvedUserRequest) {
  const parts = [];
  if (customInstructions?.trim()) parts.push(customInstructions.trim());
  if (summarizationInstructions?.identifierPolicy?.trim()) {
    parts.push(`IDENTIFIER POLICY: ${summarizationInstructions.identifierPolicy.trim()}`);
  }
  if (summarizationInstructions?.identifierInstructions?.trim()) {
    parts.push(`IDENTIFIER INSTRUCTIONS: ${summarizationInstructions.identifierInstructions.trim()}`);
  }
  if (latestUnresolvedUserRequest?.trim()) {
    parts.push(`LATEST UNRESOLVED USER REQUEST: ${latestUnresolvedUserRequest.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * @param {unknown} pluginConfig
 * @returns {string}
 */
function resolveMemoryProPath(pluginConfig) {
  const configured = asNonEmptyString(asRecord(pluginConfig).memoryLancedbProPath);
  if (configured) {
    return configured;
  }
  return join(PLUGIN_ROOT, "..", "memory-lancedb-pro");
}

/**
 * @param {import("openclaw/plugin-sdk").OpenClawPluginApi} api
 */
export default function register(api) {
  const pluginConfig = asRecord(api.pluginConfig);
  const openclawConfig = api.config ?? {};
  const llmConfig = resolveLlmConfig(pluginConfig, openclawConfig);
  llmConfig.log = (msg) => api.logger.info(msg);

  // H2 fix: register compaction provider in real runtime modes ("full" and "discovery").
  // Setup/discovery modes ("setup-runtime", "setup-only", "cli-metadata", "tool-discovery") use noop registrars.
  // The main gateway process uses "discovery" mode (runtimeSideEffects: false), not "full".
  const isRealRuntimeMode = api.registrationMode === "full" || api.registrationMode === "discovery";
  if (isRealRuntimeMode) {
    api.registerCompactionProvider(createCompactionProvider(llmConfig, recoverPreviousSummary));
    registrationConfirmed = true;
    registrationTimestamp = Date.now();
    api.logger.info(
      "memory-compaction-redistill: compaction provider registered (set agents.defaults.compaction.provider=memory-compaction-redistill)",
    );
  } else {
    api.logger.debug?.(
      `memory-compaction-redistill: registrationMode=${api.registrationMode} — skipping compaction provider registration (noop API)`,
    );
    // Still mark confirmed so after_compaction doesn't panic
    registrationConfirmed = true;
    registrationTimestamp = Date.now();
  }

  // session_before_compact hook removed — context engine with ownsCompaction=true handles compaction directly
  // This bypasses the broken getCompactionProvider lookup (registry state duplicated across chunks)

  api.on("after_compaction", async (event, ctx) => {
    const sessionFile = asNonEmptyString(event.sessionFile);
    if (!sessionFile) {
      api.logger.debug?.("memory-compaction-redistill: after_compaction without sessionFile, skip");
      return;
    }

    const compaction = await readLatestCompaction(sessionFile);
    if (!compaction?.summary) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction could not read compaction summary from transcript",
      );
      return;
    }

    // T047: capture the session file so the provider can recover previousSummary
    // on the NEXT compaction (after transcript rotation the child file has no
    // compaction entry and OpenClaw passes previousSummary = undefined).
    lastCompactedSessionFile = sessionFile;

    // T031: Detect fallback compaction (race condition indicator)
    if (!registrationConfirmed) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction fired while provider not registered — possible config reload race condition. Attempting emergency re-registration.",
      );
      try {
        api.registerCompactionProvider(createCompactionProvider(llmConfig, recoverPreviousSummary));
        registrationConfirmed = true;
        registrationTimestamp = Date.now();
        api.logger.info("memory-compaction-redistill: emergency re-registration successful");
      } catch (err) {
        api.logger.warn(`memory-compaction-redistill: emergency re-registration failed: ${String(err)}`);
      }
    }

    // T031: Verify previous decisions are carried forward (existing check)
    await verifyPreviousDecisions(api, sessionFile, compaction.summary);

    // T031+: Async quality metrics logging (non-blocking)
    logQualityMetricsAsync(api, sessionFile, compaction.summary, null);

    const parentSession = await readSessionHeaderParent(sessionFile);
    const archiveTranscript = resolveArchiveTranscriptPath(sessionFile, parentSession);
    const sessionKey = asNonEmptyString(ctx.sessionKey) ?? "unknown";
    const sessionId = asNonEmptyString(ctx.sessionId) ?? "unknown";
    const agentId = asNonEmptyString(ctx.agentId) ?? "main";
    const workspaceDir =
      asNonEmptyString(ctx.workspaceDir) ??
      join(process.env.HOME ?? "", ".openclaw", "workspace");

    const facts = await extractFactsFromSummary(
      llmConfig,
      compaction.summary,
      archiveTranscript,
    );

    const writeWorkspace = pluginConfig.writeWorkspaceMemory !== false;
    const memorySubdir =
      asNonEmptyString(pluginConfig.memorySubdir) ?? "memory/compaction-sync";

    if (writeWorkspace) {
      const relativePath = await writeWorkspaceCompactionSnapshot({
        workspaceDir,
        memorySubdir,
        sessionId,
        sessionKey,
        summary: compaction.summary,
        facts,
        activeTranscript: sessionFile,
      });
      api.logger.info(
        `memory-compaction-redistill: wrote workspace snapshot ${relativePath}`,
      );
    }

    if (pluginConfig.syncToLancedb === false) {
      return;
    }

    const memoryProConfig =
      openclawConfig?.plugins?.entries?.["memory-lancedb-pro"]?.config ?? {};
    try {
      await syncFactsToLancedb({
        memoryLancedbProPath: resolveMemoryProPath(pluginConfig),
        memoryProConfig,
        facts,
        sessionKey,
        sessionId,
        agentId,
        log: (message) => api.logger.info(message),
      });
    } catch (error) {
      api.logger.warn(
        `memory-compaction-redistill: LanceDB sync failed (workspace snapshot still saved): ${String(error)}`,
      );
    }
  });

  api.logger.info("memory-compaction-redistill: after_compaction sync hook registered");
  api.logger.info(
    "memory-compaction-redistill: T031 race-condition guard active — registration tracking enabled",
  );
  api.logger.info(
    "memory-compaction-redistill: T031+ async quality metrics enabled — carry-forward, identifiers, sections, silent-drops, hypothesis-labeling",
  );

  // Register context engine with ownsCompaction=true to bypass broken provider registry
  // This is the proper 9.9 fix: when ownsCompaction=true, gateway calls this engine's
  // compact() method directly instead of looking up provider from plugin registry
  if (isRealRuntimeMode) {
    try {
      api.registerContextEngine("memory-compaction-redistill", () => createRedistillContextEngine(llmConfig, recoverPreviousSummary));
      api.logger.info("memory-compaction-redistill: context engine registered with ownsCompaction=true");
    } catch (err) {
      api.logger.warn(`memory-compaction-redistill: context engine registration failed: ${String(err)}`);
    }
  }
}