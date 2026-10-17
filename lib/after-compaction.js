/**
 * after_compaction hook body + filesystem path guard (testable without full register).
 */
import { join } from "node:path";
import { asNonEmptyString } from "./env.js";
import { asRecord } from "./util.js";
import { isNonFilesystemSessionLocator } from "./session-access.js";
import {
  extractFactsFromSummary,
  syncFactsToLancedb,
  writeWorkspaceCompactionSnapshot,
} from "./lancedb-sync.js";
import {
  readLatestCompaction,
  readSessionHeaderParent,
  resolveArchiveTranscriptPath,
} from "./session-transcript.js";
import {
  writeResidueChunks,
  readConsumedManifest,
  deleteStagingChunks,
} from "./staging.js";
import { createCompactionProvider } from "./compaction-provider.js";

/**
 * @param {unknown} sessionFile
 * @returns {boolean} true when hook must skip (no FS open)
 */
export function shouldSkipAfterCompactionSessionFile(sessionFile) {
  const sessionFileRaw = asNonEmptyString(sessionFile);
  // Skip sessionKey, sqlite: markers, and anything that is not a real FS transcript.
  return !sessionFileRaw || isNonFilesystemSessionLocator(sessionFileRaw);
}

/**
 * Extract decision lines from a summary text (Hybrid Variant B format).
 *
 * @param {string} summary
 * @returns {string[]}
 */
export function extractDecisionLines(summary) {
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
 *
 * @param {string} summary
 * @returns {string[]}
 */
export function extractIdentifiers(summary) {
  const identifiers = new Set();
  const patterns = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    /[0-9a-f]{8,}/g,
    /\bT\d{2,3}\b/g,
    /\b\d{10,}\b/g,
    /agents\.defaults\.[\w.]+/g,
    /keepRecentTokens|reserveTokensFloor|truncateAfterCompaction/g,
    /memory-compaction-redistill|memory-lancedb-pro/g,
    /qwen\/qwen3\.6-35b-a3b|ling-3\.0-flash-fin/g,
    /USDRUBF|UVXY|AAPL|TSLA|NVDA/g,
    /(?:\$HOME|~|\/home\/[^/\s]+)\/[^\s\)]+/g,
    /memory\/[\d-]+\.md/g,
  ];
  for (const pattern of patterns) {
    const matches = summary.match(pattern);
    if (matches) matches.forEach((m) => identifiers.add(m));
  }
  return Array.from(identifiers);
}

/**
 * @param {{
 *   logger: { info: Function; warn: Function; debug?: Function };
 *   sessionFile: string;
 *   newSummary: string;
 * }} params
 * @returns {Promise<void>}
 */
export async function verifyPreviousDecisions({ logger, sessionFile, newSummary }) {
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
        } catch {
          /* skip */
        }
      }
    } catch {
      /* parent file may not exist */
    }

    if (!prevSummary) return;

    const prevDecisions = extractDecisionLines(prevSummary);
    if (prevDecisions.length === 0) return;

    const newSummaryLower = newSummary.toLowerCase();
    let carried = 0;
    /** @type {string[]} */
    let missing = [];
    for (const decision of prevDecisions) {
      const normalized = decision
        .replace(/^[-*•]\s*/, "")
        .replace(/\*+/g, "")
        .trim()
        .toLowerCase();
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
        logger.warn(
          `memory-compaction-redistill: T031 VERIFICATION WARNING — only ${carried}/${prevDecisions.length} previous decisions carried forward. Missing: ${missing.slice(0, 3).join("; ")}`,
        );
      } else {
        logger.info(
          `memory-compaction-redistill: T031 verification OK — ${carried}/${prevDecisions.length} previous decisions carried forward`,
        );
      }
    }
  } catch (err) {
    logger.debug?.(
      `memory-compaction-redistill: T031 verification error: ${String(err)}`,
    );
  }
}

/**
 * Async quality metrics logging — fire-and-forget.
 *
 * @param {{
 *   logger: { info: Function; warn: Function; debug?: Function };
 *   sessionFile: string;
 *   newSummary: string;
 *   prevSummary?: string | null;
 * }} params
 */
export function logQualityMetricsAsync({
  logger,
  sessionFile,
  newSummary,
  prevSummary = null,
}) {
  Promise.resolve().then(async () => {
    try {
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
              } catch {
                /* skip */
              }
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (!previous) {
        logger.info(
          "memory-compaction-redistill: quality metrics — no previous summary to compare",
        );
        return;
      }

      const prevDecisions = extractDecisionLines(previous);
      let carried = 0;
      for (const decision of prevDecisions) {
        const normalized = decision
          .replace(/^[-*•]\s*/, "")
          .replace(/\*+/g, "")
          .trim()
          .toLowerCase();
        if (normalized.length < 10) continue;
        if (newSummary.toLowerCase().includes(normalized.slice(0, 60))) carried++;
      }
      const carryRate = prevDecisions.length > 0 ? carried / prevDecisions.length : 1;

      const prevIdentifiers = extractIdentifiers(previous);
      const newIdentifiers = new Set(extractIdentifiers(newSummary));
      let preservedIds = 0;
      for (const id of prevIdentifiers) {
        if (newIdentifiers.has(id)) preservedIds++;
      }
      const idPreservationRate =
        prevIdentifiers.length > 0 ? preservedIds / prevIdentifiers.length : 1;

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

      const supersededSection =
        newSummary.split("## Superseded / rejected")[1]?.split("##")[0] ?? "";
      const silentDrops = (supersededSection.match(/❌/g) || []).length;

      const hypothesisLines = (newSummary.match(/H-\d+/g) || []).length;
      const decisionLines = (newSummary.match(/D-\d+/g) || []).length;
      const hypothesisLabelingRate =
        hypothesisLines + decisionLines > 0
          ? hypothesisLines / (hypothesisLines + decisionLines)
          : 1;

      logger.info(
        `memory-compaction-redistill: QUALITY METRICS — carryForward=${(carryRate * 100).toFixed(0)}% (${carried}/${prevDecisions.length}) | idPreservation=${(idPreservationRate * 100).toFixed(0)}% (${preservedIds}/${prevIdentifiers.length}) | sections=${sectionsPresent}/7 | silentDrops≈${silentDrops} | hypothesisLabeling=${(hypothesisLabelingRate * 100).toFixed(0)}%`,
      );

      if (carryRate < 0.8) {
        logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — decision carry-forward rate ${(carryRate * 100).toFixed(0)}% < 80%`,
        );
      }
      if (idPreservationRate < 1.0 && prevIdentifiers.length > 0) {
        logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — identifier preservation ${(idPreservationRate * 100).toFixed(0)}% < 100% (lost: ${prevIdentifiers.filter((id) => !newIdentifiers.has(id)).slice(0, 5).join(", ")})`,
        );
      }
      if (sectionCompleteness < 1.0) {
        logger.warn(
          `memory-compaction-redistill: QUALITY ALERT — incomplete sections: ${sectionsPresent}/7`,
        );
      }
    } catch (err) {
      logger.debug?.(
        `memory-compaction-redistill: quality metrics error: ${String(err)}`,
      );
    }
  });
}

/**
 * @typedef {{
 *   api: import("openclaw/plugin-sdk").OpenClawPluginApi;
 *   llmConfig: import("./llm.js").LlmResolvedConfig;
 *   stagingConfig: import("./staging.js").StagingConfig;
 *   pluginConfig: Record<string, unknown>;
 *   openclawConfig: object;
 *   sessionRecovery: { remember: (sessionKey: string, sessionFile: string) => void };
 *   registrationState: { confirmed: boolean; timestamp: number };
 *   resolveMemoryProPath: (pluginConfig: unknown) => string;
 *   recoverPreviousSummary?: (ctx?: {
 *     sessionKey?: string;
 *     agentId?: string;
 *     hintSessionFile?: string;
 *   }) => Promise<string | null>;
 * }} AfterCompactionDeps
 */

/**
 * Create the after_compaction handler (filesystem sessionFile only).
 *
 * @param {AfterCompactionDeps} deps
 * @returns {(event: object, ctx: object) => Promise<void>}
 */
export function createAfterCompactionHandler(deps) {
  const {
    api,
    llmConfig,
    stagingConfig,
    pluginConfig,
    openclawConfig,
    sessionRecovery,
    registrationState,
    resolveMemoryProPath,
    recoverPreviousSummary,
  } = deps;

  return async (event, ctx) => {
    if (shouldSkipAfterCompactionSessionFile(event?.sessionFile)) {
      api.logger.debug?.(
        "memory-compaction-redistill: after_compaction without filesystem sessionFile, skip",
      );
      return;
    }
    const sessionFile = String(asNonEmptyString(event.sessionFile)).trim();

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

    sessionRecovery.remember(sessionKey, sessionFile);

    if (!registrationState.confirmed) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction fired while provider not registered — possible config reload race condition. Attempting emergency re-registration.",
      );
      try {
        api.registerCompactionProvider(
          createCompactionProvider(
            llmConfig,
            recoverPreviousSummary ?? (async () => null),
            stagingConfig,
          ),
        );
        registrationState.confirmed = true;
        registrationState.timestamp = Date.now();
        api.logger.info("memory-compaction-redistill: emergency re-registration successful");
      } catch (err) {
        api.logger.warn(
          `memory-compaction-redistill: emergency re-registration failed: ${String(err)}`,
        );
      }
    }

    await verifyPreviousDecisions({
      logger: api.logger,
      sessionFile,
      newSummary: compaction.summary,
    });

    logQualityMetricsAsync({
      logger: api.logger,
      sessionFile,
      newSummary: compaction.summary,
      prevSummary: null,
    });

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
  };
}
