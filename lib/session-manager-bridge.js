/**
 * OpenClaw 2026.9.9 SessionManager bridge for sqlite-era transcripts.
 *
 * Production: dynamic import `openclaw/plugin-sdk/agent-sessions`.
 * Tests: inject `openSessionManager` / full `openTranscriptStore`.
 */
import { asNonEmptyString } from "./env.js";
import {
  classifySessionFile,
  preferTranscriptKind,
  resolveSessionTranscriptTargetFromParams,
} from "./session-access.js";
import {
  appendCompactionToJsonl,
  isFilesystemTranscriptPath,
  loadTranscript,
  rotateSuccessorTranscript,
  transcriptByteSize,
} from "./transcript-apply.js";
import { isTranscriptJsonlPath } from "./session-path.js";

/**
 * @typedef {{
 *   agentId: string;
 *   sessionId: string;
 *   sessionKey: string;
 *   storePath: string;
 *   threadId?: string | number;
 * }} SessionTranscriptTarget
 */

/**
 * @typedef {{
 *   kind: 'sqlite' | 'jsonl';
 *   sessionFile: string;
 *   target?: SessionTranscriptTarget;
 *   entries: object[];
 *   appendCompaction: (params: {
 *     summary: string;
 *     firstKeptEntryId: string;
 *     tokensBefore: number;
 *     tokensAfter?: number;
 *     details?: unknown;
 *   }) => Promise<{ ok: true; entry: object; entryId: string }>;
 *   estimateBytes: () => Promise<number>;
 *   rotateSuccessor?: (params: {
 *     agentId: string;
 *     compactionEntry: object;
 *     firstKeptEntryId: string;
 *   }) => Promise<{ sessionId: string; sessionFile: string }>;
 * }} TranscriptStoreHandle
 */

/**
 * Lazy-load SessionManager from the host OpenClaw install.
 *
 * @returns {Promise<{ SessionManager: { openAsync: Function } } | null>}
 */
export async function importHostSessionManager() {
  try {
    const mod = await import("openclaw/plugin-sdk/agent-sessions");
    if (mod?.SessionManager?.openAsync) {
      return { SessionManager: mod.SessionManager };
    }
  } catch {
    /* not resolvable outside gateway / peer install */
  }
  return null;
}

/**
 * Open a sqlite-backed store via SessionManager.
 *
 * @param {SessionTranscriptTarget} target
 * @param {{
 *   openSessionManager?: (target: SessionTranscriptTarget, signal?: AbortSignal) => Promise<{
 *     getBranch?: () => object[];
 *     getEntries?: () => object[];
 *     appendCompaction: (
 *       summary: string,
 *       firstKeptEntryId: string,
 *       tokensBefore: number,
 *       details?: unknown,
 *       fromHook?: boolean,
 *       metadata?: unknown,
 *       tokensAfter?: number,
 *     ) => string;
 *   }>;
 *   signal?: AbortSignal;
 *   log?: (msg: string) => void;
 * }} [options]
 * @returns {Promise<TranscriptStoreHandle>}
 */
export async function openSqliteTranscriptStore(target, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  let manager;
  if (typeof options.openSessionManager === "function") {
    manager = await options.openSessionManager(target, options.signal);
  } else {
    const host = await importHostSessionManager();
    if (!host) {
      throw new Error(
        "session_manager_unavailable: openclaw/plugin-sdk/agent-sessions not resolvable",
      );
    }
    manager = await host.SessionManager.openAsync(target, undefined, undefined, options.signal);
  }

  const entries =
    (typeof manager.getBranch === "function"
      ? manager.getBranch()
      : typeof manager.getEntries === "function"
        ? manager.getEntries()
        : []) ?? [];

  if (!Array.isArray(entries)) {
    throw new Error("session_manager_invalid_branch");
  }

  log(
    `memory-compaction-redistill: opened SessionManager sqlite store sessionKey=${target.sessionKey} entries=${entries.length}`,
  );

  return {
    kind: "sqlite",
    sessionFile: target.sessionKey,
    target,
    entries: /** @type {object[]} */ (entries),
    async appendCompaction(params) {
      const entryId = manager.appendCompaction(
        params.summary,
        params.firstKeptEntryId,
        params.tokensBefore,
        params.details,
        false,
        undefined,
        params.tokensAfter,
      );
      const entry = {
        type: "compaction",
        id: entryId,
        summary: params.summary,
        firstKeptEntryId: params.firstKeptEntryId,
        tokensBefore: params.tokensBefore,
        tokensAfter: params.tokensAfter,
        details: params.details,
      };
      return { ok: true, entry, entryId: String(entryId) };
    },
    async estimateBytes() {
      // Approximate from serialized entries (sqlite has no single FS file size).
      try {
        return Buffer.byteLength(JSON.stringify(entries), "utf8");
      } catch {
        return entries.length * 256;
      }
    },
  };
}

/**
 * Open legacy JSONL transcript (only when host passes a real .jsonl path).
 *
 * @param {string} sessionFile
 * @param {{
 *   loadTranscript?: (path: string, options?: { strict?: boolean }) => Promise<{ entries: object[]; raw: string }>;
 *   appendCompaction?: (params: object) => Promise<{ ok: true; entry: object; entryId: string }>;
 *   rotateSuccessor?: (params: object) => Promise<{ sessionId: string; sessionFile: string }>;
 * }} [deps]
 * @returns {Promise<TranscriptStoreHandle>}
 */
export async function openJsonlTranscriptStore(sessionFile, deps = {}) {
  if (!isTranscriptJsonlPath(sessionFile) && !isFilesystemTranscriptPath(sessionFile)) {
    throw new Error(`not_jsonl_transcript_path: ${sessionFile}`);
  }
  const load = deps.loadTranscript ?? loadTranscript;
  const loaded = await load(sessionFile, { strict: true });
  const append = deps.appendCompaction ?? appendCompactionToJsonl;
  const rotate = deps.rotateSuccessor ?? rotateSuccessorTranscript;

  return {
    kind: "jsonl",
    sessionFile,
    entries: loaded.entries,
    async appendCompaction(params) {
      return append({
        sessionFile,
        summary: params.summary,
        firstKeptEntryId: params.firstKeptEntryId,
        tokensBefore: params.tokensBefore,
        tokensAfter: params.tokensAfter,
        details: params.details,
      });
    },
    async estimateBytes() {
      return transcriptByteSize(sessionFile);
    },
    async rotateSuccessor(params) {
      return rotate({
        sessionFile,
        agentId: params.agentId,
        compactionEntry: params.compactionEntry,
        firstKeptEntryId: params.firstKeptEntryId,
      });
    },
  };
}

/**
 * Resolve the live transcript store for compact().
 * SQLite / sessionKey is primary; JSONL only for real abs `.jsonl` paths.
 *
 * @param {object} params Host compact params
 * @param {{
 *   openTranscriptStore?: (params: object) => Promise<TranscriptStoreHandle>;
 *   openSessionManager?: Parameters<typeof openSqliteTranscriptStore>[1]['openSessionManager'];
 *   loadTranscript?: Parameters<typeof openJsonlTranscriptStore>[1]['loadTranscript'];
 *   appendCompaction?: Parameters<typeof openJsonlTranscriptStore>[1]['appendCompaction'];
 *   rotateSuccessor?: Parameters<typeof openJsonlTranscriptStore>[1]['rotateSuccessor'];
 *   signal?: AbortSignal;
 *   log?: (msg: string) => void;
 * }} [deps]
 * @returns {Promise<{ ok: true; store: TranscriptStoreHandle } | { ok: false; reason: string }>}
 */
export async function resolveTranscriptStore(params, deps = {}) {
  if (typeof deps.openTranscriptStore === "function") {
    try {
      const store = await deps.openTranscriptStore(params);
      return { ok: true, store };
    } catch (err) {
      return { ok: false, reason: `transcript_store_open: ${String(err)}` };
    }
  }

  const prefer = preferTranscriptKind(params);
  const sessionFile = asNonEmptyString(params?.sessionFile);
  const fileKind = classifySessionFile(sessionFile);

  // Legacy JSONL only when host gives a real transcript path (not sessions.json index).
  if (
    prefer === "jsonl" ||
    (fileKind === "jsonl" && sessionFile && isTranscriptJsonlPath(sessionFile))
  ) {
    if (!sessionFile || !isTranscriptJsonlPath(sessionFile)) {
      return {
        ok: false,
        reason: "missing_jsonl_transcript_path",
      };
    }
    try {
      const store = await openJsonlTranscriptStore(sessionFile, deps);
      return { ok: true, store };
    } catch (err) {
      return { ok: false, reason: `session_file_read: ${String(err)}` };
    }
  }

  // Sqlite-era: sessionKey / sqlite marker / sessionTarget — never JSONL resolve.
  const target = resolveSessionTranscriptTargetFromParams(params);
  if (!target) {
    return {
      ok: false,
      reason:
        "missing_session_target: need sessionTarget{agentId,sessionId,sessionKey,storePath} (or sqlite: marker) for sqlite transcript; refusing sessionKey→jsonl fallback",
    };
  }

  try {
    const store = await openSqliteTranscriptStore(target, {
      openSessionManager: deps.openSessionManager,
      signal: deps.signal,
      log: deps.log,
    });
    return { ok: true, store };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}
