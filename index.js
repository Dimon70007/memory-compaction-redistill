import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  createSessionRecoveryStore,
  estimateMessagesTokens,
} from "./lib/session-recovery.js";
import {
  resolveStagingConfig,
  writeResidueChunks,
  readConsumedManifest,
  deleteStagingChunks,
} from "./lib/staging.js";
import {
  appendCompactionToJsonl,
  buildOcJsonlRef,
  embedRefInSummary,
  extractActiveMessages,
  isFilesystemTranscriptPath,
  loadTranscript,
  parseByteSize,
  rotateSuccessorTranscript,
  selectToolSafeFirstKeptEntryId,
  transcriptByteSize,
  estimateEntryTokens,
} from "./lib/transcript-apply.js";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * T031: Self-healing re-registration guard.
 * Tracks whether the compaction provider is actively registered.
 * Used by the after_compaction hook to detect fallback compactions.
 */
let registrationConfirmed = false;
let registrationTimestamp = 0;

/**
 * T047: session-scoped previousSummary recovery (C2).
 * Avoids pulling another chat's newest compaction (e.g. wrong Telegram id).
 */
const sessionRecovery = createSessionRecoveryStore();

/**
 * @param {{ sessionKey?: string; agentId?: string; hintSessionFile?: string }} [ctx]
 * @returns {Promise<string | null>}
 */
async function recoverPreviousSummary(ctx = {}) {
  return sessionRecovery.recover(ctx);
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
    /(?:\$HOME|~|\/home\/[^/\s]+)\/[^\s\)]+/g, // File paths
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
 * Compaction entrypoint via ContextEngine (ownsCompaction=true).
 * Provider registration remains for `agents.defaults.compaction.provider=…`
 * lookups; assemble/autoRecall are safe passthroughs (C3).
 *
 * @param {import("./lib/llm.js").LlmResolvedConfig} llmConfig
 * @param {(ctx?: { sessionKey?: string; agentId?: string; hintSessionFile?: string }) => Promise<string | null>} recoverPreviousSummary
 * @param {import("./lib/staging.js").StagingConfig} stagingConfig
 * @param {{
 *   summarize?: (params: object) => Promise<string>;
 *   appendCompaction?: (params: object) => Promise<{ ok: true; entry: object; entryId: string }>;
 *   rotateSuccessor?: (params: object) => Promise<{ sessionId: string; sessionFile: string }>;
 *   loadTranscript?: (sessionFile: string) => Promise<{ entries: object[]; raw: string }>;
 *   maxActiveTranscriptBytes?: number;
 *   preferRotate?: boolean;
 *   keepRecentTokens?: number;
 * }} [deps] Injectable hooks for offline tests (no live gateway).
 */
export function createRedistillContextEngine(
  llmConfig,
  recoverPreviousSummary,
  stagingConfig,
  deps = {},
) {
  const provider = createCompactionProvider(llmConfig, recoverPreviousSummary, stagingConfig);
  const summarizeFn =
    typeof deps.summarize === "function"
      ? deps.summarize
      : (params) => provider.summarize(params);
  const appendCompactionFn =
    typeof deps.appendCompaction === "function"
      ? deps.appendCompaction
      : appendCompactionToJsonl;
  const rotateSuccessorFn =
    typeof deps.rotateSuccessor === "function"
      ? deps.rotateSuccessor
      : rotateSuccessorTranscript;
  const loadTranscriptFn =
    typeof deps.loadTranscript === "function" ? deps.loadTranscript : loadTranscript;

  return {
    info: {
      id: "memory-compaction-redistill",
      name: "Memory Compaction Redistill Context Engine",
      version: "1.1.0",
      ownsCompaction: true,
      acceptedHostParams: [
        "agentId",
        "sessionId",
        "sessionKey",
        "sessionTarget",
        "tokenBudget",
        "currentTokenCount",
        "force",
        "customInstructions",
        "abortSignal",
        "workspaceDir",
        "runtimeContext",
        "runtimeSettings",
      ],
    },

    /**
     * @param {object} params
     */
    async compact(params) {
      const signal = params?.abortSignal ?? params?.signal;
      const fail = (reason) => ({ ok: false, compacted: false, reason });

      if (signal?.aborted) {
        return fail("aborted");
      }

      const sessionFileRaw = asNonEmptyString(params?.sessionFile);
      const sessionFile = sessionFileRaw && isFilesystemTranscriptPath(sessionFileRaw)
        ? sessionFileRaw.trim()
        : "";

      /** @type {object[]} */
      let entries = [];
      /** @type {unknown[]} */
      let messages = Array.isArray(params?.messages) ? params.messages : [];

      if (sessionFile) {
        try {
          const loaded = await loadTranscriptFn(sessionFile);
          entries = loaded.entries;
          const active = extractActiveMessages(entries);
          if (!Array.isArray(params?.messages) || params.messages.length === 0) {
            messages = active.messages;
          }
        } catch (err) {
          llmConfig.log?.(
            `memory-compaction-redistill: failed to read sessionFile: ${String(err)}`,
          );
          return fail(`session_file_read: ${String(err)}`);
        }
      } else if (messages.length === 0) {
        return fail("missing_session_file_and_messages");
      }

      if (signal?.aborted) {
        return fail("aborted");
      }

      const customInstructions = params?.customInstructions;
      const previousSummary = params?.previousSummary;
      const summarizationInstructions = params?.summarizationInstructions;
      const latestUnresolvedUserRequest = params?.latestUnresolvedUserRequest;

      let prevSummary = previousSummary?.trim() ?? "";
      if (!prevSummary && typeof recoverPreviousSummary === "function") {
        try {
          const recovered = await recoverPreviousSummary({
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            hintSessionFile: sessionFile || undefined,
          });
          if (recovered?.trim()) {
            prevSummary = recovered.trim();
            llmConfig.log?.(
              `memory-compaction-redistill: context engine T047 recovered previousSummary from parent session (${prevSummary.length} chars)`,
            );
          }
        } catch {
          /* recovery is best-effort */
        }
      }

      const structuredInstructions = buildCompactionStructureInstructions(
        customInstructions,
        summarizationInstructions,
        latestUnresolvedUserRequest,
      );

      const runtimeSettings = asRecord(params?.runtimeSettings);
      const keepRecentTokens =
        (typeof deps.keepRecentTokens === "number" && deps.keepRecentTokens > 0
          ? deps.keepRecentTokens
          : undefined) ??
        (typeof runtimeSettings.keepRecentTokens === "number"
          ? runtimeSettings.keepRecentTokens
          : 20_000);

      const firstKeptEntryId =
        entries.length > 0
          ? selectToolSafeFirstKeptEntryId(entries, {
              keepRecentTokens,
              estimateTokens: estimateEntryTokens,
            })
          : null;

      if (sessionFile && !firstKeptEntryId) {
        return fail("no_first_kept_entry");
      }

      const tokensBefore =
        typeof params?.currentTokenCount === "number" && params.currentTokenCount > 0
          ? params.currentTokenCount
          : estimateMessagesTokens(messages);

      /** @type {string} */
      let summaryText;
      try {
        const result = await summarizeFn({
          messages,
          signal,
          customInstructions: structuredInstructions,
          summarizationInstructions,
          previousSummary: prevSummary,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          workspaceDir: params.workspaceDir,
        });
        if (typeof result !== "string" || !result.trim()) {
          llmConfig.log?.(
            "memory-compaction-redistill: context engine provider returned empty result",
          );
          return fail("empty_result");
        }
        summaryText = result.trim();
      } catch (err) {
        if (signal?.aborted) {
          return fail("aborted");
        }
        llmConfig.log?.(
          `memory-compaction-redistill: context engine compact failed: ${String(err)}`,
        );
        return fail(`error: ${String(err)}`);
      }

      if (signal?.aborted) {
        return fail("aborted");
      }

      // Without a live sessionFile we cannot apply — never lie with compacted:true.
      if (!sessionFile || !firstKeptEntryId) {
        return fail("apply_requires_session_file");
      }

      const agentId = asNonEmptyString(params?.agentId) ?? "main";
      const sessionId =
        asNonEmptyString(params?.sessionId) ??
        (typeof entries.find((e) => e?.type === "session")?.id === "string"
          ? /** @type {string} */ (entries.find((e) => e?.type === "session")?.id)
          : "unknown");

      const messageEntries = extractActiveMessages(entries).messageEntries;
      const firstKeptIndex = entries.findIndex((e) => e.id === firstKeptEntryId);
      const summarizedEntries = messageEntries.filter((e) => {
        const idx = entries.findIndex((x) => x.id === e.id);
        return idx >= 0 && idx < firstKeptIndex;
      });
      const fromEntryId = summarizedEntries[0]?.id ?? messageEntries[0]?.id ?? firstKeptEntryId;
      const toEntryId =
        summarizedEntries.at(-1)?.id ??
        (firstKeptIndex > 0 ? entries[firstKeptIndex - 1]?.id : fromEntryId) ??
        fromEntryId;

      const ref = buildOcJsonlRef({
        agentId,
        sessionId,
        sessionFile,
        fromEntryId: String(fromEntryId),
        toEntryId: String(toEntryId),
      });
      const summaryWithRef = embedRefInSummary(summaryText, ref);

      const keptMessages = messageEntries
        .filter((e) => {
          const idx = entries.findIndex((x) => x.id === e.id);
          return idx >= firstKeptIndex;
        })
        .map((e) => e.message);
      const tokensAfter = Math.max(
        1,
        estimateMessagesTokens([{ role: "user", content: summaryWithRef }, ...keptMessages]),
      );

      /** @type {object} */
      let compactionEntry;
      try {
        const applied = await appendCompactionFn({
          sessionFile,
          summary: summaryWithRef,
          firstKeptEntryId,
          tokensBefore,
          tokensAfter,
          details: { provider: "memory-compaction-redistill", ref },
        });
        compactionEntry = applied.entry;
      } catch (err) {
        llmConfig.log?.(
          `memory-compaction-redistill: appendCompaction failed (fail-closed): ${String(err)}`,
        );
        return fail(`apply_failed: ${String(err)}`);
      }

      /** @type {{ sessionId?: string; sessionFile?: string }} */
      const successor = {};
      let resultSummary = summaryWithRef;
      let resultRef = ref;
      const maxBytes =
        deps.maxActiveTranscriptBytes ??
        parseByteSize(runtimeSettings.maxActiveTranscriptBytes) ??
        parseByteSize("1.5mb");
      const preferRotate = deps.preferRotate === true;
      try {
        const bytes = await transcriptByteSize(sessionFile);
        const shouldRotate = preferRotate || (typeof maxBytes === "number" && bytes > maxBytes);
        if (shouldRotate) {
          resultRef = buildOcJsonlRef({
            agentId,
            sessionId,
            sessionFile,
            fromEntryId: String(fromEntryId),
            toEntryId: String(toEntryId),
            parentSessionFile: sessionFile,
          });
          resultSummary = embedRefInSummary(summaryText, resultRef);
          compactionEntry = { ...compactionEntry, summary: resultSummary };
          const rotated = await rotateSuccessorFn({
            sessionFile,
            agentId,
            compactionEntry,
            firstKeptEntryId,
          });
          successor.sessionId = rotated.sessionId;
          successor.sessionFile = rotated.sessionFile;
          llmConfig.log?.(
            `memory-compaction-redistill: rotated successor sessionFile=${rotated.sessionFile}`,
          );
        }
      } catch (err) {
        // Compaction boundary already applied — still success for active-window shrink.
        llmConfig.log?.(
          `memory-compaction-redistill: successor rotate skipped/failed (boundary kept): ${String(err)}`,
        );
      }

      return {
        ok: true,
        compacted: true,
        reason: "redistill",
        result: {
          summary: resultSummary,
          firstKeptEntryId,
          tokensBefore,
          tokensAfter,
          details: { ref: resultRef, provider: "memory-compaction-redistill" },
          ...(successor.sessionId ? { sessionId: successor.sessionId } : {}),
          ...(successor.sessionFile ? { sessionFile: successor.sessionFile } : {}),
        },
      };
    },

    // ContextEngine required methods — assemble must not under-report tokens (C3)
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      const messages = Array.isArray(params?.messages) ? params.messages : [];
      return { messages, estimatedTokens: estimateMessagesTokens(messages) };
    },
    async autoRecall() {
      return { memories: [] };
    },
    async afterTurn() {},
    async ingestBatch() {},
    async maintain() {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    },
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
  const stagingConfig = resolveStagingConfig(pluginConfig);

  // H2 fix: register compaction provider in real runtime modes ("full" and "discovery").
  // Setup/discovery modes ("setup-runtime", "setup-only", "cli-metadata", "tool-discovery") use noop registrars.
  // The main gateway process uses "discovery" mode (runtimeSideEffects: false), not "full".
  const isRealRuntimeMode = api.registrationMode === "full" || api.registrationMode === "discovery";
  if (isRealRuntimeMode) {
    api.registerCompactionProvider(
      createCompactionProvider(llmConfig, recoverPreviousSummary, stagingConfig),
    );
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
    const sessionFileRaw = asNonEmptyString(event.sessionFile);
    // Host must pass a filesystem path; never open sessionKey-shaped values (ENOENT).
    if (!sessionFileRaw || !isFilesystemTranscriptPath(sessionFileRaw)) {
      api.logger.debug?.(
        "memory-compaction-redistill: after_compaction without filesystem sessionFile, skip",
      );
      return;
    }
    const sessionFile = sessionFileRaw.trim();

    const compaction = await readLatestCompaction(sessionFile);
    if (!compaction?.summary) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction could not read compaction summary from transcript",
      );
      return;
    }

    const sessionKey = asNonEmptyString(ctx.sessionKey) ?? "unknown";
    const sessionId = asNonEmptyString(ctx.sessionId) ?? "unknown";
    const agentId = asNonEmptyString(ctx.agentId) ?? "main";

    // T047: session-scoped capture for next compaction (C2)
    sessionRecovery.remember(sessionKey, sessionFile);

    // T031: Detect fallback compaction (race condition indicator)
    if (!registrationConfirmed) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction fired while provider not registered — possible config reload race condition. Attempting emergency re-registration.",
      );
      try {
        api.registerCompactionProvider(
          createCompactionProvider(llmConfig, recoverPreviousSummary, stagingConfig),
        );
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
    const workspaceDir =
      asNonEmptyString(ctx.workspaceDir) ??
      join(process.env.HOME ?? "", ".openclaw", "workspace");

    const extractResult = await extractFactsFromSummary(
      llmConfig,
      compaction.summary,
      archiveTranscript,
    );

    const writeWorkspace = pluginConfig.writeWorkspaceMemory !== false;
    const memorySubdir =
      asNonEmptyString(pluginConfig.memorySubdir) ?? "memory/compaction-sync";

    if (extractResult.mode === "degraded") {
      api.logger.warn(
        "memory-compaction-redistill: structured fact extract degraded — staging residue (no LanceDB write)",
      );
      if (stagingConfig.enabled && extractResult.residue) {
        try {
          const ids = await writeResidueChunks({
            workspaceDir,
            stagingDir: stagingConfig.dir,
            sessionKey,
            residue: extractResult.residue,
            chunkMaxChars: stagingConfig.chunkMaxChars,
          });
          api.logger.info(
            `memory-compaction-redistill: wrote ${ids.length} staging chunk(s) under ${stagingConfig.dir}`,
          );
        } catch (err) {
          api.logger.warn(
            `memory-compaction-redistill: staging write failed: ${String(err)}`,
          );
        }
      } else if (!stagingConfig.enabled) {
        api.logger.warn(
          "memory-compaction-redistill: staging.enabled is false — residue not persisted for later multi-pass",
        );
      }
      if (writeWorkspace) {
        const relativePath = await writeWorkspaceCompactionSnapshot({
          workspaceDir,
          memorySubdir,
          sessionId,
          sessionKey,
          summary: compaction.summary,
          activeTranscript: sessionFile,
        });
        api.logger.info(
          `memory-compaction-redistill: wrote workspace snapshot ${relativePath} (degraded, no facts)`,
        );
      }
      return;
    }

    const facts = extractResult.facts;
    if (!facts) {
      return;
    }

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
      // Delete staging only after confirmed LanceDB success
      if (stagingConfig.enabled) {
        const consumed = await readConsumedManifest({
          workspaceDir,
          stagingDir: stagingConfig.dir,
          sessionKey,
        });
        if (consumed.length > 0) {
          await deleteStagingChunks({
            workspaceDir,
            stagingDir: stagingConfig.dir,
            sessionKey,
            chunkIds: consumed,
          });
          api.logger.info(
            `memory-compaction-redistill: deleted ${consumed.length} staging chunk(s) after LanceDB ack`,
          );
        }
      }
    } catch (error) {
      api.logger.warn(
        `memory-compaction-redistill: LanceDB sync failed (workspace snapshot still saved; staging kept): ${String(error)}`,
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
      api.registerContextEngine("memory-compaction-redistill", () =>
        createRedistillContextEngine(llmConfig, recoverPreviousSummary, stagingConfig),
      );
      api.logger.info("memory-compaction-redistill: context engine registered with ownsCompaction=true");
    } catch (err) {
      api.logger.warn(`memory-compaction-redistill: context engine registration failed: ${String(err)}`);
    }
  }
}