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

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * T031: Self-healing re-registration guard.
 * Tracks whether the compaction provider is actively registered.
 * Used by the after_compaction hook to detect fallback compactions.
 */
let registrationConfirmed = false;
let registrationTimestamp = 0;

/**
 * T031: Verify that previous decisions are carried forward in the new summary.
 * Reads the previous compaction from the archive transcript and checks
 * that key decisions appear in the new summary.
 */
async function verifyPreviousDecisions(api, sessionFile, newSummary) {
  try {
    // Read the archive transcript (parent session) to find previous compaction
    const parentSession = await readSessionHeaderParent(sessionFile);
    if (!parentSession) return;

    const fs = await import("node:fs/promises");
    let prevSummary = null;
    try {
      const raw = await fs.readFile(parentSession, "utf8");
      const lines = raw.split(/\r?\n/u).filter((l) => l.trim());
      // Find the LAST compaction entry in the parent transcript
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

    // Extract decision lines from previous summary
    const prevDecisions = extractDecisionLines(prevSummary);
    if (prevDecisions.length === 0) return;

    // Check how many appear in new summary
    const newSummaryLower = newSummary.toLowerCase();
    let carried = 0;
    let missing = [];
    for (const decision of prevDecisions) {
      // Normalize: strip markdown, bullets, whitespace for fuzzy match
      const normalized = decision.replace(/^[-*•]\s*/, "").replace(/\*+/g, "").trim().toLowerCase();
      if (normalized.length < 10) continue; // Skip trivial lines
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
 * Extract decision lines from a summary text.
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
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (value);
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

  api.registerCompactionProvider(createCompactionProvider(llmConfig));
  registrationConfirmed = true;
  registrationTimestamp = Date.now();
  api.logger.info(
    "memory-compaction-redistill: compaction provider registered (set agents.defaults.compaction.provider=memory-compaction-redistill)",
  );

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

    // T031: Detect fallback compaction (race condition indicator)
    if (!registrationConfirmed) {
      api.logger.warn(
        "memory-compaction-redistill: after_compaction fired while provider not registered — possible config reload race condition. Attempting emergency re-registration.",
      );
      try {
        api.registerCompactionProvider(createCompactionProvider(llmConfig));
        registrationConfirmed = true;
        registrationTimestamp = Date.now();
        api.logger.info("memory-compaction-redistill: emergency re-registration successful");
      } catch (err) {
        api.logger.warn(`memory-compaction-redistill: emergency re-registration failed: ${String(err)}`);
      }
    }

    // T031: Verify previous decisions are carried forward
    await verifyPreviousDecisions(api, sessionFile, compaction.summary);

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
}
