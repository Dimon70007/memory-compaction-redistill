/**
 * In-memory SessionManager stand-in for OpenClaw 2026.9.9 sqlite-era tests.
 * No filesystem / clawbox I/O.
 */
import { randomUUID } from "node:crypto";

/**
 * @param {object[]} initialEntries
 * @returns {{
 *   getBranch: () => object[];
 *   getEntries: () => object[];
 *   appendCompaction: (
 *     summary: string,
 *     firstKeptEntryId: string,
 *     tokensBefore: number,
 *     details?: unknown,
 *     fromHook?: boolean,
 *     metadata?: unknown,
 *     tokensAfter?: number,
 *   ) => string;
 *   entries: object[];
 * }}
 */
export function createFakeSessionManager(initialEntries) {
  /** @type {object[]} */
  const entries = initialEntries.map((e) => ({ ...e }));

  return {
    entries,
    getBranch() {
      return entries;
    },
    getEntries() {
      return entries;
    },
    appendCompaction(
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      _fromHook,
      _metadata,
      tokensAfter,
    ) {
      const id = randomUUID();
      const parentId =
        entries.length > 0 && typeof entries.at(-1)?.id === "string"
          ? entries.at(-1).id
          : null;
      const entry = {
        type: "compaction",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        summary,
        firstKeptEntryId,
        tokensBefore,
        ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
        ...(details !== undefined ? { details } : {}),
      };
      entries.push(entry);
      return id;
    },
  };
}

/**
 * Build openTranscriptStore / openSessionManager deps for engine tests.
 *
 * @param {object[]} entries
 * @param {{
 *   agentId?: string;
 *   sessionId?: string;
 *   sessionKey?: string;
 *   storePath?: string;
 * }} [identity]
 */
export function createFakeSqliteStoreDeps(entries, identity = {}) {
  const manager = createFakeSessionManager(entries);
  const target = {
    agentId: identity.agentId ?? "main",
    sessionId: identity.sessionId ?? "test-session",
    sessionKey: identity.sessionKey ?? "agent:main:dashboard:test",
    storePath: identity.storePath ?? "/tmp/fake-sessions.json",
  };

  return {
    manager,
    target,
    openSessionManager: async () => manager,
    openTranscriptStore: async () => ({
      kind: /** @type {'sqlite'} */ ("sqlite"),
      sessionFile: target.sessionKey,
      target,
      entries: manager.getBranch(),
      appendCompaction: async (params) => {
        const entryId = manager.appendCompaction(
          params.summary,
          params.firstKeptEntryId,
          params.tokensBefore,
          params.details,
          false,
          undefined,
          params.tokensAfter,
        );
        const entry = manager.entries.find((e) => e.id === entryId);
        return { ok: true, entry, entryId: String(entryId) };
      },
      estimateBytes: async () => Buffer.byteLength(JSON.stringify(manager.entries), "utf8"),
    }),
  };
}
