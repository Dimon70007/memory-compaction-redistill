/**
 * Unit/integration tests for SessionManager bridge + resolveTranscriptStore (A.I4).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  openJsonlTranscriptStore,
  openSqliteTranscriptStore,
  resolveTranscriptStore,
} from "../lib/session-manager-bridge.js";
import { createFakeSessionManager } from "./openclaw-mock/fake-session-manager.js";

/**
 * @param {string} sessionId
 * @returns {object[]}
 */
function miniEntries(sessionId) {
  const u1 = randomUUID();
  const a1 = randomUUID();
  return [
    {
      type: "session",
      version: 2,
      id: sessionId,
      timestamp: "2026-10-17T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: u1,
      parentId: null,
      timestamp: "2026-10-17T00:00:01.000Z",
      message: { role: "user", content: "hello " + "x".repeat(80), timestamp: Date.now() },
    },
    {
      type: "message",
      id: a1,
      parentId: u1,
      timestamp: "2026-10-17T00:00:02.000Z",
      message: { role: "assistant", content: "hi " + "y".repeat(80), timestamp: Date.now() },
    },
  ];
}

describe("openSqliteTranscriptStore", () => {
  it("loads branch via getBranch and appendCompaction writes entry", async () => {
    const sid = randomUUID();
    const entries = miniEntries(sid);
    const manager = createFakeSessionManager(entries);
    const target = {
      agentId: "main",
      sessionId: sid,
      sessionKey: "agent:main:dashboard:test",
      storePath: "/tmp/fake/sessions.json",
    };
    const store = await openSqliteTranscriptStore(target, {
      openSessionManager: async (t) => {
        assert.equal(t.sessionKey, target.sessionKey);
        return manager;
      },
    });
    assert.equal(store.kind, "sqlite");
    assert.equal(store.sessionFile, target.sessionKey);
    assert.equal(store.entries.length, 3);
    const applied = await store.appendCompaction({
      summary: "SUM oc:sqlite:v1:agent=main:sid=x:from=a:to=b",
      firstKeptEntryId: entries[1].id,
      tokensBefore: 100,
      tokensAfter: 10,
      details: { provider: "test" },
    });
    assert.equal(applied.ok, true);
    assert.ok(manager.entries.some((e) => e.type === "compaction"));
    assert.ok((await store.estimateBytes()) > 0);
  });

  it("falls back to getEntries when getBranch absent", async () => {
    const sid = randomUUID();
    const entries = miniEntries(sid);
    const store = await openSqliteTranscriptStore(
      {
        agentId: "main",
        sessionId: sid,
        sessionKey: "agent:main:x",
        storePath: "/tmp/s.json",
      },
      {
        openSessionManager: async () => ({
          getEntries: () => entries,
          appendCompaction: () => randomUUID(),
        }),
      },
    );
    assert.equal(store.entries.length, 3);
  });

  it("rejects non-array branch", async () => {
    await assert.rejects(
      () =>
        openSqliteTranscriptStore(
          {
            agentId: "main",
            sessionId: "s",
            sessionKey: "agent:main:x",
            storePath: "/tmp/s.json",
          },
          {
            openSessionManager: async () => ({
              getBranch: () => ({ not: "array" }),
              appendCompaction: () => "x",
            }),
          },
        ),
      /session_manager_invalid_branch/,
    );
  });

  it("without injectable manager fails closed (no host openclaw in tests)", async () => {
    await assert.rejects(
      () =>
        openSqliteTranscriptStore({
          agentId: "main",
          sessionId: "s",
          sessionKey: "agent:main:x",
          storePath: "/tmp/s.json",
        }),
      /session_manager_unavailable/,
    );
  });
});

describe("openJsonlTranscriptStore", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let jsonl;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-bridge-jsonl-"));
    const sid = randomUUID();
    jsonl = join(root, `${sid}.jsonl`);
    await writeFile(
      jsonl,
      miniEntries(sid).map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("opens real .jsonl path", async () => {
    const store = await openJsonlTranscriptStore(jsonl);
    assert.equal(store.kind, "jsonl");
    assert.ok(store.entries.length >= 2);
  });

  it("rejects sessionKey-shaped path", async () => {
    await assert.rejects(
      () => openJsonlTranscriptStore("agent:main:dashboard:x"),
      /not_jsonl_transcript_path/,
    );
  });
});

describe("resolveTranscriptStore", () => {
  it("uses injected openTranscriptStore", async () => {
    const resolved = await resolveTranscriptStore(
      { sessionFile: "agent:main:x" },
      {
        openTranscriptStore: async () => ({
          kind: "sqlite",
          sessionFile: "agent:main:x",
          entries: [],
          appendCompaction: async () => ({ ok: true, entry: {}, entryId: "e" }),
          estimateBytes: async () => 1,
        }),
      },
    );
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.store.kind, "sqlite");
    }
  });

  it("maps openTranscriptStore throw to fail-closed reason", async () => {
    const resolved = await resolveTranscriptStore(
      {},
      {
        openTranscriptStore: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /transcript_store_open/);
    }
  });

  it("sessionKey without sessionTarget → missing_session_target (no jsonl invent)", async () => {
    const resolved = await resolveTranscriptStore({
      sessionFile: "agent:main:dashboard:x",
      sessionKey: "agent:main:dashboard:x",
      sessionId: randomUUID(),
      agentId: "main",
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /missing_session_target/);
      assert.ok(!resolved.reason.includes("sessions/"));
    }
  });

  it("opens sqlite via openSessionManager when target complete", async () => {
    const sid = randomUUID();
    const entries = miniEntries(sid);
    const manager = createFakeSessionManager(entries);
    const resolved = await resolveTranscriptStore(
      {
        sessionFile: "agent:main:dashboard:x",
        sessionKey: "agent:main:dashboard:x",
        sessionId: sid,
        agentId: "main",
        sessionTarget: {
          agentId: "main",
          sessionId: sid,
          sessionKey: "agent:main:dashboard:x",
          storePath: "/tmp/fake/sessions.json",
        },
      },
      { openSessionManager: async () => manager },
    );
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.store.kind, "sqlite");
      assert.equal(resolved.store.entries.length, 3);
    }
  });

  it("resolves target from sqlite: marker + sessionKey", async () => {
    const sid = "94b9984a-321b-4b6c-9d96-4345f1fb3e62";
    const entries = miniEntries(sid);
    const manager = createFakeSessionManager(entries);
    const resolved = await resolveTranscriptStore(
      {
        sessionFile: `sqlite:main:${sid}:/tmp/sessions/sessions.json`,
        sessionKey: "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
      },
      { openSessionManager: async () => manager },
    );
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.store.target?.sessionId, sid);
      assert.equal(resolved.store.target?.storePath, "/tmp/sessions/sessions.json");
    }
  });

  it("legacy jsonl path opens filesystem store", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcr-bridge-resolve-"));
    try {
      const sid = randomUUID();
      const path = join(root, `${sid}.jsonl`);
      await writeFile(
        path,
        miniEntries(sid).map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8",
      );
      const resolved = await resolveTranscriptStore({ sessionFile: path });
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.store.kind, "jsonl");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("complete target without injectable manager → session_manager_unavailable", async () => {
    const resolved = await resolveTranscriptStore({
      sessionTarget: {
        agentId: "main",
        sessionId: randomUUID(),
        sessionKey: "agent:main:x",
        storePath: "/tmp/s.json",
      },
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /session_manager_unavailable/);
    }
  });
});
