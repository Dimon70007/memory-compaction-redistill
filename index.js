import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompactionProvider } from "./lib/compaction-provider.js";
import { resolveLlmConfig } from "./lib/llm.js";
import { asNonEmptyString } from "./lib/env.js";
import { createSessionRecoveryStore } from "./lib/session-recovery.js";
import { resolveStagingConfig } from "./lib/staging.js";
import { asRecord } from "./lib/util.js";
import { createRedistillContextEngine } from "./lib/context-engine.js";
import { createAfterCompactionHandler } from "./lib/after-compaction.js";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/** @type {{ confirmed: boolean; timestamp: number }} */
const registrationState = { confirmed: false, timestamp: 0 };

/**
 * T047: session-scoped previousSummary recovery (C2).
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

export { createRedistillContextEngine } from "./lib/context-engine.js";
export {
  shouldSkipAfterCompactionSessionFile,
  createAfterCompactionHandler,
} from "./lib/after-compaction.js";
export {
  runCompactPipeline,
  buildCompactionStructureInstructions,
  buildSuccessorSessionTarget,
} from "./lib/compact-pipeline.js";

/**
 * @param {import("openclaw/plugin-sdk").OpenClawPluginApi} api
 */
export default function register(api) {
  const pluginConfig = asRecord(api.pluginConfig);
  const openclawConfig = api.config ?? {};
  const llmConfig = resolveLlmConfig(pluginConfig, openclawConfig);
  llmConfig.log = (msg) => api.logger.info(msg);
  const stagingConfig = resolveStagingConfig(pluginConfig);

  const isRealRuntimeMode =
    api.registrationMode === "full" || api.registrationMode === "discovery";
  if (isRealRuntimeMode) {
    api.registerCompactionProvider(
      createCompactionProvider(llmConfig, recoverPreviousSummary, stagingConfig),
    );
    registrationState.confirmed = true;
    registrationState.timestamp = Date.now();
    api.logger.info(
      "memory-compaction-redistill: compaction provider registered (set agents.defaults.compaction.provider=memory-compaction-redistill)",
    );
  } else {
    api.logger.debug?.(
      `memory-compaction-redistill: registrationMode=${api.registrationMode} — skipping compaction provider registration (noop API)`,
    );
    registrationState.confirmed = true;
    registrationState.timestamp = Date.now();
  }

  api.on(
    "after_compaction",
    createAfterCompactionHandler({
      api,
      llmConfig,
      stagingConfig,
      pluginConfig,
      openclawConfig,
      sessionRecovery,
      registrationState,
      resolveMemoryProPath,
      recoverPreviousSummary,
    }),
  );

  api.logger.info("memory-compaction-redistill: after_compaction sync hook registered");
  api.logger.info(
    "memory-compaction-redistill: T031 race-condition guard active — registration tracking enabled",
  );
  api.logger.info(
    "memory-compaction-redistill: T031+ async quality metrics enabled — carry-forward, identifiers, sections, silent-drops, hypothesis-labeling",
  );

  if (isRealRuntimeMode) {
    try {
      api.registerContextEngine("memory-compaction-redistill", () =>
        createRedistillContextEngine(llmConfig, recoverPreviousSummary, stagingConfig),
      );
      api.logger.info(
        "memory-compaction-redistill: context engine registered with ownsCompaction=true",
      );
    } catch (err) {
      api.logger.warn(
        `memory-compaction-redistill: context engine registration failed: ${String(err)}`,
      );
    }
  }
}
