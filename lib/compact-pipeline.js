/**
 * Compact orchestration: load → cut → summarize → apply → optional rotate.
 * Used by ContextEngine.compact (ownsCompaction path).
 */
import { asNonEmptyString } from "./env.js";
import { asRecord } from "./util.js";
import { estimateMessagesTokens } from "./session-recovery.js";
import { resolveFilesystemSessionFile } from "./session-path.js";
import {
  appendCompactionToJsonl,
  buildOcJsonlRef,
  embedRefInSummary,
  extractActiveMessages,
  loadTranscript,
  parseByteSize,
  rotateSuccessorTranscript,
  selectToolSafeFirstKeptEntryId,
  transcriptByteSize,
  estimateEntryTokens,
} from "./transcript-apply.js";

/**
 * Typed successor target for OpenClaw `adoptCompactionTranscript` (prefer over bare sessionFile).
 *
 * @param {{
 *   agentId: string;
 *   sessionId: string;
 *   sessionKey?: string | null;
 *   storePath: string;
 *   threadId?: string | null;
 * }} params
 * @returns {{
 *   agentId: string;
 *   sessionId: string;
 *   storePath: string;
 *   sessionKey?: string;
 *   threadId?: string;
 * }}
 */
export function buildSuccessorSessionTarget(params) {
  const agentId = String(params.agentId || "main").trim() || "main";
  const sessionId = String(params.sessionId || "").trim();
  const storePath = String(params.storePath || "").trim();
  if (!sessionId) {
    throw new Error("buildSuccessorSessionTarget: sessionId required");
  }
  if (!storePath) {
    throw new Error("buildSuccessorSessionTarget: storePath required");
  }
  /** @type {{ agentId: string; sessionId: string; storePath: string; sessionKey?: string; threadId?: string }} */
  const target = { agentId, sessionId, storePath };
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "";
  if (sessionKey) {
    target.sessionKey = sessionKey;
  }
  const threadId =
    typeof params.threadId === "string" && params.threadId.trim()
      ? params.threadId.trim()
      : "";
  if (threadId) {
    target.threadId = threadId;
  }
  return target;
}

/**
 * Build structured compaction instructions from runtime config and event data.
 *
 * @param {string | undefined} customInstructions
 * @param {{ identifierPolicy?: string; identifierInstructions?: string } | undefined} summarizationInstructions
 * @param {string | undefined} latestUnresolvedUserRequest
 * @returns {string}
 */
export function buildCompactionStructureInstructions(
  customInstructions,
  summarizationInstructions,
  latestUnresolvedUserRequest,
) {
  const parts = [];
  if (customInstructions?.trim()) parts.push(customInstructions.trim());
  if (summarizationInstructions?.identifierPolicy?.trim()) {
    parts.push(`IDENTIFIER POLICY: ${summarizationInstructions.identifierPolicy.trim()}`);
  }
  if (summarizationInstructions?.identifierInstructions?.trim()) {
    parts.push(
      `IDENTIFIER INSTRUCTIONS: ${summarizationInstructions.identifierInstructions.trim()}`,
    );
  }
  if (latestUnresolvedUserRequest?.trim()) {
    parts.push(`LATEST UNRESOLVED USER REQUEST: ${latestUnresolvedUserRequest.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * @typedef {{
 *   summarize: (params: object) => Promise<string>;
 *   appendCompaction: (params: object) => Promise<{ ok: true; entry: object; entryId: string }>;
 *   rotateSuccessor: (params: object) => Promise<{ sessionId: string; sessionFile: string }>;
 *   loadTranscript: (
 *     sessionFile: string,
 *     options?: { strict?: boolean },
 *   ) => Promise<{ entries: object[]; raw: string }>;
 *   recoverPreviousSummary?: (ctx?: {
 *     sessionKey?: string;
 *     agentId?: string;
 *     hintSessionFile?: string;
 *   }) => Promise<string | null>;
 *   log?: (msg: string) => void;
 *   maxActiveTranscriptBytes?: number;
 *   preferRotate?: boolean;
 *   keepRecentTokens?: number;
 *   homeDir?: string;
 * }} CompactPipelineDeps
 */

/**
 * Run one ownsCompaction compact attempt.
 *
 * @param {object} params Host compact params
 * @param {CompactPipelineDeps} deps Injectable steps
 * @returns {Promise<{
 *   ok: boolean;
 *   compacted: boolean;
 *   reason?: string;
 *   result?: object;
 * }>}
 */
export async function runCompactPipeline(params, deps) {
  const signal = params?.abortSignal ?? params?.signal;
  const fail = (reason) => ({ ok: false, compacted: false, reason });
  const log = typeof deps.log === "function" ? deps.log : () => {};

  if (signal?.aborted) {
    return fail("aborted");
  }

  // Host often passes sessionKey as sessionFile (overflow / sessions.compact). Resolve to JSONL.
  const resolved = await resolveFilesystemSessionFile(params, {
    homeDir: deps.homeDir,
  });
  const sessionFile = resolved.sessionFile;
  if (sessionFile && resolved.resolvedFrom !== "params.sessionFile") {
    log(
      `memory-compaction-redistill: resolved sessionFile via ${resolved.resolvedFrom} → ${sessionFile}`,
    );
  }

  /** @type {object[]} */
  let entries = [];
  /** @type {unknown[]} */
  let messages = Array.isArray(params?.messages) ? params.messages : [];

  if (sessionFile) {
    try {
      // Fail-closed on corrupt/truncated JSONL (strict parse).
      const loaded = await deps.loadTranscript(sessionFile, { strict: true });
      entries = loaded.entries;
      const active = extractActiveMessages(entries);
      if (!Array.isArray(params?.messages) || params.messages.length === 0) {
        messages = active.messages;
      }
    } catch (err) {
      log(`memory-compaction-redistill: failed to read sessionFile: ${String(err)}`);
      return fail(`session_file_read: ${String(err)}`);
    }
  } else if (messages.length === 0) {
    const detail =
      "detail" in resolved && typeof resolved.detail === "string" ? resolved.detail : "";
    return fail(
      detail
        ? `missing_session_file_and_messages: ${detail}`
        : "missing_session_file_and_messages",
    );
  }

  if (signal?.aborted) {
    return fail("aborted");
  }

  const customInstructions = params?.customInstructions;
  const previousSummary = params?.previousSummary;
  const summarizationInstructions = params?.summarizationInstructions;
  const latestUnresolvedUserRequest = params?.latestUnresolvedUserRequest;

  let prevSummary = previousSummary?.trim() ?? "";
  if (!prevSummary && typeof deps.recoverPreviousSummary === "function") {
    try {
      const recovered = await deps.recoverPreviousSummary({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        hintSessionFile: sessionFile || undefined,
      });
      if (recovered?.trim()) {
        prevSummary = recovered.trim();
        log(
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
    const result = await deps.summarize({
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
      log("memory-compaction-redistill: context engine provider returned empty result");
      return fail("empty_result");
    }
    summaryText = result.trim();
  } catch (err) {
    if (signal?.aborted) {
      return fail("aborted");
    }
    log(`memory-compaction-redistill: context engine compact failed: ${String(err)}`);
    return fail(`error: ${String(err)}`);
  }

  if (signal?.aborted) {
    return fail("aborted");
  }

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
    const applied = await deps.appendCompaction({
      sessionFile,
      summary: summaryWithRef,
      firstKeptEntryId,
      tokensBefore,
      tokensAfter,
      details: { provider: "memory-compaction-redistill", ref },
    });
    compactionEntry = applied.entry;
  } catch (err) {
    log(`memory-compaction-redistill: appendCompaction failed (fail-closed): ${String(err)}`);
    return fail(`apply_failed: ${String(err)}`);
  }

  /** @type {{ sessionId?: string; sessionFile?: string; sessionTarget?: ReturnType<typeof buildSuccessorSessionTarget> }} */
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
      const rotated = await deps.rotateSuccessor({
        sessionFile,
        agentId,
        compactionEntry,
        firstKeptEntryId,
      });
      successor.sessionId = rotated.sessionId;
      successor.sessionFile = rotated.sessionFile;
      successor.sessionTarget = buildSuccessorSessionTarget({
        agentId,
        sessionId: rotated.sessionId,
        sessionKey: asNonEmptyString(params?.sessionKey),
        storePath: rotated.sessionFile,
      });
      log(`memory-compaction-redistill: rotated successor sessionFile=${rotated.sessionFile}`);
    }
  } catch (err) {
    log(
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
      details: {
        ref: resultRef,
        provider: "memory-compaction-redistill",
        // Diagnostic: host/UI can show shrink = tokensBefore - tokensAfter (no separate CompactResult field).
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      },
      ...(successor.sessionId ? { sessionId: successor.sessionId } : {}),
      ...(successor.sessionFile ? { sessionFile: successor.sessionFile } : {}),
      ...(successor.sessionTarget ? { sessionTarget: successor.sessionTarget } : {}),
    },
  };
}

/**
 * Default deps wired to filesystem helpers (production path).
 *
 * @param {{
 *   summarize: (params: object) => Promise<string>;
 *   recoverPreviousSummary?: CompactPipelineDeps["recoverPreviousSummary"];
 *   log?: (msg: string) => void;
 *   maxActiveTranscriptBytes?: number;
 *   preferRotate?: boolean;
 *   keepRecentTokens?: number;
 *   homeDir?: string;
 *   appendCompaction?: CompactPipelineDeps["appendCompaction"];
 *   rotateSuccessor?: CompactPipelineDeps["rotateSuccessor"];
 *   loadTranscript?: CompactPipelineDeps["loadTranscript"];
 * }} overrides
 * @returns {CompactPipelineDeps}
 */
export function createDefaultCompactPipelineDeps(overrides) {
  return {
    summarize: overrides.summarize,
    recoverPreviousSummary: overrides.recoverPreviousSummary,
    log: overrides.log,
    maxActiveTranscriptBytes: overrides.maxActiveTranscriptBytes,
    preferRotate: overrides.preferRotate,
    keepRecentTokens: overrides.keepRecentTokens,
    homeDir: overrides.homeDir,
    appendCompaction:
      typeof overrides.appendCompaction === "function"
        ? overrides.appendCompaction
        : appendCompactionToJsonl,
    rotateSuccessor:
      typeof overrides.rotateSuccessor === "function"
        ? overrides.rotateSuccessor
        : rotateSuccessorTranscript,
    loadTranscript:
      typeof overrides.loadTranscript === "function" ? overrides.loadTranscript : loadTranscript,
  };
}
