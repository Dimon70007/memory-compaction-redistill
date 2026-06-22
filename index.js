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
}
