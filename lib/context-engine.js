/**
 * ContextEngine with ownsCompaction=true — compaction entrypoint for OpenClaw 9.9.
 */
import { createCompactionProvider } from "./compaction-provider.js";
import { estimateMessagesTokens } from "./session-recovery.js";
import {
  createDefaultCompactPipelineDeps,
  runCompactPipeline,
} from "./compact-pipeline.js";

/**
 * Compaction entrypoint via ContextEngine (ownsCompaction=true).
 * Provider registration remains for `agents.defaults.compaction.provider=…`
 * lookups; assemble/autoRecall are safe passthroughs (C3).
 *
 * @param {import("./llm.js").LlmResolvedConfig} llmConfig
 * @param {(ctx?: { sessionKey?: string; agentId?: string; hintSessionFile?: string }) => Promise<string | null>} recoverPreviousSummary
 * @param {import("./staging.js").StagingConfig} stagingConfig
 * @param {{
 *   summarize?: (params: object) => Promise<string>;
 *   appendCompaction?: (params: object) => Promise<{ ok: true; entry: object; entryId: string }>;
 *   rotateSuccessor?: (params: object) => Promise<{ sessionId: string; sessionFile: string }>;
 *   loadTranscript?: (
 *     sessionFile: string,
 *     options?: { strict?: boolean },
 *   ) => Promise<{ entries: object[]; raw: string }>;
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

  const pipelineDeps = createDefaultCompactPipelineDeps({
    summarize: summarizeFn,
    recoverPreviousSummary,
    log: (msg) => llmConfig.log?.(msg),
    maxActiveTranscriptBytes: deps.maxActiveTranscriptBytes,
    preferRotate: deps.preferRotate,
    keepRecentTokens: deps.keepRecentTokens,
    appendCompaction: deps.appendCompaction,
    rotateSuccessor: deps.rotateSuccessor,
    loadTranscript: deps.loadTranscript,
  });

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
      return runCompactPipeline(params, pipelineDeps);
    },

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
