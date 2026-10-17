/**
 * Semi-working OpenClaw ownsCompaction host mock (offline).
 * See ATTRIBUTION.md.
 */
import { readFile, stat } from "node:fs/promises";
import { parseTranscriptLines } from "../../lib/transcript-apply.js";
import { projectActiveWindow } from "./active-window.js";

/**
 * @param {string} sessionFile
 * @returns {Promise<{ entries: object[]; bytes: number; window: ReturnType<typeof projectActiveWindow> }>}
 */
async function snapshotWindow(sessionFile) {
  const raw = await readFile(sessionFile, "utf8");
  const entries = parseTranscriptLines(raw);
  const bytes = (await stat(sessionFile)).size;
  return { entries, bytes, window: projectActiveWindow(entries) };
}

/**
 * Mirror OpenClaw ownsCompaction path in-process:
 * compact → adopt successor → maintain → after_compaction.
 *
 * @param {{
 *   compact: (params: object) => Promise<object>;
 *   maintain: (params?: object) => Promise<object>;
 * }} engine
 * @param {{
 *   sessionFile: string;
 *   sessionId?: string;
 *   sessionKey?: string;
 *   agentId?: string;
 *   currentTokenCount?: number;
 *   abortSignal?: AbortSignal;
 *   runtimeSettings?: object;
 *   runtimeContext?: object;
 *   afterCompaction?: (event: object, ctx: object) => Promise<void> | void;
 * }} params
 * @returns {Promise<{
 *   result: object;
 *   maintain: object;
 *   activeWindowBefore: ReturnType<typeof projectActiveWindow>;
 *   activeWindowAfter: ReturnType<typeof projectActiveWindow>;
 *   transcriptBytesBefore: number;
 *   transcriptBytesAfter: number;
 *   activeSessionFile: string;
 *   activeSessionId: string | undefined;
 * }>}
 */
export async function runOwnsCompactionLifecycle(engine, params) {
  const sessionFile = String(params.sessionFile || "").trim();
  if (!sessionFile) {
    throw new Error("runOwnsCompactionLifecycle: sessionFile required");
  }

  const before = await snapshotWindow(sessionFile);

  const compactParams = {
    sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    currentTokenCount: params.currentTokenCount,
    abortSignal: params.abortSignal,
    runtimeSettings: params.runtimeSettings,
    runtimeContext: params.runtimeContext,
    // overflow-shaped: no messages
  };

  const result = await engine.compact(compactParams);

  let activeSessionFile = sessionFile;
  let activeSessionId = params.sessionId;
  if (result?.ok && result?.compacted && result?.result) {
    // Prefer typed sessionTarget (OpenClaw preferred); fall back to legacy sessionFile/sessionId.
    if (typeof result.result.sessionFile === "string" && result.result.sessionFile.trim()) {
      activeSessionFile = result.result.sessionFile.trim();
    }
    if (typeof result.result.sessionId === "string" && result.result.sessionId.trim()) {
      activeSessionId = result.result.sessionId.trim();
    }
    const target = result.result.sessionTarget;
    if (target && typeof target === "object") {
      if (typeof target.storePath === "string" && target.storePath.trim()) {
        activeSessionFile = target.storePath.trim();
      }
      if (typeof target.sessionId === "string" && target.sessionId.trim()) {
        activeSessionId = target.sessionId.trim();
      }
    }
  }

  const maintain = await engine.maintain({
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: params.sessionKey,
  });

  if (typeof params.afterCompaction === "function") {
    await params.afterCompaction(
      { sessionFile: activeSessionFile },
      {
        sessionKey: params.sessionKey,
        sessionId: activeSessionId,
        agentId: params.agentId,
      },
    );
  }

  const after = await snapshotWindow(activeSessionFile);

  return {
    result,
    maintain,
    activeWindowBefore: before.window,
    activeWindowAfter: after.window,
    transcriptBytesBefore: before.bytes,
    transcriptBytesAfter: after.bytes,
    activeSessionFile,
    activeSessionId,
  };
}
