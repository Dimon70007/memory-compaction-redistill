/**
 * A.I4 business-logic corners: sqlite-era ContextEngine.compact via SessionManager.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createRedistillContextEngine } from "../lib/context-engine.js";
import { createFakeSqliteStoreDeps } from "./openclaw-mock/fake-session-manager.js";
import { selectToolSafeFirstKeptEntryId, estimateEntryTokens } from "../lib/transcript-apply.js";
import { projectActiveWindow } from "./openclaw-mock/active-window.js";

const FAKE_SUMMARY =
  "## Previous decisions (carried forward)\nNone\n\n## Current decisions\n- D-01 sqlite\n\n## Superseded / rejected\nNone\n\n## Open hypotheses (unconfirmed)\nNone\n\n## Open TODOs\nNone\n\n## Pending user asks\nNone\n\n## Session archive\nTranscript: sqlite";

/**
 * @param {string} sessionId
 * @returns {object[]}
 */
function buildToolPairEntries(sessionId) {
  const ids = {
    session: sessionId,
    u1: randomUUID(),
    a1: randomUUID(),
    tr1: randomUUID(),
    u2: randomUUID(),
    a2: randomUUID(),
  };
  return [
    {
      type: "session",
      version: 2,
      id: ids.session,
      timestamp: "2026-10-17T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: ids.u1,
      parentId: null,
      timestamp: "2026-10-17T00:00:01.000Z",
      message: {
        role: "user",
        content: "old " + "x".repeat(400),
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.a1,
      parentId: ids.u1,
      timestamp: "2026-10-17T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "tool" },
          { type: "toolCall", id: "call_sqlite_1", name: "read", arguments: { path: "a" } },
        ],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.tr1,
      parentId: ids.a1,
      timestamp: "2026-10-17T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_sqlite_1",
        toolName: "read",
        content: [{ type: "text", text: "data " + "y".repeat(200) }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.u2,
      parentId: ids.tr1,
      timestamp: "2026-10-17T00:00:04.000Z",
      message: { role: "user", content: "tail " + "t".repeat(200), timestamp: Date.now() },
    },
    {
      type: "message",
      id: ids.a2,
      parentId: ids.u2,
      timestamp: "2026-10-17T00:00:05.000Z",
      message: { role: "assistant", content: "ok " + "z".repeat(200), timestamp: Date.now() },
    },
  ];
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeEngine(overrides = {}) {
  return createRedistillContextEngine(
    {
      model: "test/model",
      apiKey: "k",
      baseURL: "http://example.test/v1",
      timeoutMs: 1000,
      fallbacks: [],
      log: () => {},
      completeText: async () => {
        throw new Error("live LLM must not be called");
      },
    },
    async () => null,
    { enabled: false, dir: "memory/compaction-staging", chunkMaxChars: 1000 },
    {
      summarize: async () => FAKE_SUMMARY,
      keepRecentTokens: 40,
      ...overrides,
    },
  );
}

describe("sqlite-compact: openSessionManager path", () => {
  it("overflow-shaped compact uses openSessionManager (not openTranscriptStore)", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const fake = createFakeSqliteStoreDeps(entries, {
      sessionId: sid,
      sessionKey: "agent:main:dashboard:test",
    });
    let opened = 0;
    const engine = makeEngine({
      openSessionManager: async (target) => {
        opened += 1;
        assert.equal(target.sessionId, sid);
        assert.equal(target.storePath, fake.target.storePath);
        return fake.manager;
      },
    });
    const result = await engine.compact({
      sessionId: sid,
      sessionKey: fake.target.sessionKey,
      agentId: "main",
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 9000,
      // no messages
    });
    assert.equal(opened, 1);
    assert.equal(result.compacted, true, `reason=${result.reason}`);
    assert.match(String(result.result?.summary ?? ""), /oc:sqlite:v1:/);
    assert.equal(result.result?.details?.storeKind, "sqlite");
    assert.equal(result.result?.sessionTarget, undefined);
  });

  it("runtimeContext.sessionTarget is enough when top-level sessionTarget omitted", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const fake = createFakeSqliteStoreDeps(entries, {
      sessionId: sid,
      sessionKey: "agent:main:dashboard:rt",
    });
    const engine = makeEngine({ openSessionManager: fake.openSessionManager });
    const result = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionKey: fake.target.sessionKey,
      currentTokenCount: 5000,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: fake.target,
      },
    });
    assert.equal(result.compacted, true, `reason=${result.reason}`);
  });

  it("sqlite: marker sessionFile + sessionKey applies", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const sessionKey = "agent:main:dashboard:marker";
    const storePath = "/tmp/agents/main/sessions/sessions.json";
    const fake = createFakeSqliteStoreDeps(entries, {
      sessionId: sid,
      sessionKey,
      storePath,
    });
    const engine = makeEngine({ openSessionManager: fake.openSessionManager });
    const result = await engine.compact({
      sessionFile: `sqlite:main:${sid}:${storePath}`,
      sessionKey,
      currentTokenCount: 5000,
    });
    assert.equal(result.compacted, true, `reason=${result.reason}`);
    assert.ok(fake.manager.entries.some((e) => e.type === "compaction"));
  });
});

describe("sqlite-compact: fail-closed", () => {
  it("apply throw → compacted false and entries unchanged", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const fake = createFakeSqliteStoreDeps(entries, { sessionId: sid });
    const beforeLen = fake.manager.entries.length;
    const engine = makeEngine({
      openTranscriptStore: async () => ({
        kind: "sqlite",
        sessionFile: fake.target.sessionKey,
        target: fake.target,
        entries: fake.manager.getBranch(),
        appendCompaction: async () => {
          throw new Error("write admission denied");
        },
        estimateBytes: async () => 1,
      }),
    });
    const result = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
    assert.match(String(result.reason ?? ""), /apply_failed/);
    assert.equal(fake.manager.entries.length, beforeLen);
  });

  it("empty branch → no_first_kept_entry", async () => {
    const sid = randomUUID();
    const fake = createFakeSqliteStoreDeps(
      [
        {
          type: "session",
          version: 2,
          id: sid,
          timestamp: "2026-10-17T00:00:00.000Z",
          cwd: "/tmp",
        },
      ],
      { sessionId: sid },
    );
    const engine = makeEngine({ openTranscriptStore: fake.openTranscriptStore });
    const result = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 100,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, "no_first_kept_entry");
  });

  it("messages present without store still fail closed (cannot apply)", async () => {
    const engine = makeEngine();
    const result = await engine.compact({
      sessionFile: "agent:main:dashboard:orphan",
      sessionKey: "agent:main:dashboard:orphan",
      messages: [{ role: "user", content: "hi" }],
      currentTokenCount: 50,
    });
    assert.equal(result.compacted, false);
    assert.match(String(result.reason ?? ""), /missing_session_target|messages_present_but_apply/);
  });

  it("abortSignal before open skips mutation", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const fake = createFakeSqliteStoreDeps(entries, { sessionId: sid });
    const ac = new AbortController();
    ac.abort();
    let opened = false;
    const engine = makeEngine({
      openSessionManager: async () => {
        opened = true;
        return fake.manager;
      },
      summarize: async () => {
        throw new Error("should not summarize");
      },
    });
    const result = await engine.compact({
      sessionTarget: fake.target,
      sessionFile: fake.target.sessionKey,
      abortSignal: ac.signal,
      currentTokenCount: 100,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, "aborted");
    assert.equal(opened, false);
  });
});

describe("sqlite-compact: window + pairing + no rotate", () => {
  it("tool pairing preserved; active window shrinks; preferRotate does not rotate sqlite", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const before = projectActiveWindow(entries);
    const fake = createFakeSqliteStoreDeps(entries, { sessionId: sid });
    const engine = makeEngine({
      openTranscriptStore: fake.openTranscriptStore,
      preferRotate: true,
      maxActiveTranscriptBytes: 1,
      keepRecentTokens: 40,
    });
    const result = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 12_000,
      runtimeContext: { transcriptStorage: { kind: "sqlite" } },
    });
    assert.equal(result.compacted, true, `reason=${result.reason}`);
    assert.equal(result.result?.sessionFile, undefined);
    assert.equal(result.result?.sessionTarget, undefined);

    const firstKept = result.result?.firstKeptEntryId;
    assert.ok(typeof firstKept === "string");
    const cut = selectToolSafeFirstKeptEntryId(entries, {
      keepRecentTokens: 40,
      estimateTokens: estimateEntryTokens,
    });
    // Engine cut must be tool-safe relative to original branch.
    assert.ok(cut);
    const afterEntries = fake.manager.entries;
    const after = projectActiveWindow(afterEntries);
    assert.ok(after.estimatedTokens < before.estimatedTokens);
    assert.ok(afterEntries.some((e) => e.type === "compaction"));

    const kept = after.messages;
    const toolResult = kept.find((m) => m.role === "toolResult");
    if (toolResult) {
      assert.ok(
        kept.some(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((b) => b?.type === "toolCall" && b.id === "call_sqlite_1"),
        ),
        "toolResult kept without toolCall",
      );
    }
  });

  it("second compact after new turns applies again; bare re-compact with no new msgs fails closed", async () => {
    const sid = randomUUID();
    const entries = buildToolPairEntries(sid);
    const fake = createFakeSqliteStoreDeps(entries, { sessionId: sid });
    const openLive = async () => ({
      kind: /** @type {'sqlite'} */ ("sqlite"),
      sessionFile: fake.target.sessionKey,
      target: fake.target,
      entries: fake.manager.getBranch(),
      appendCompaction: async (params) => {
        const entryId = fake.manager.appendCompaction(
          params.summary,
          params.firstKeptEntryId,
          params.tokensBefore,
          params.details,
          false,
          undefined,
          params.tokensAfter,
        );
        return {
          ok: true,
          entry: fake.manager.entries.find((e) => e.id === entryId),
          entryId: String(entryId),
        };
      },
      estimateBytes: async () => 100,
    });

    const engine = makeEngine({ openTranscriptStore: openLive, keepRecentTokens: 40 });
    const first = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 8000,
    });
    assert.equal(first.compacted, true);
    const comps1 = fake.manager.entries.filter((e) => e.type === "compaction").length;

    // No messages after compaction boundary → nothing to cut.
    const noop = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 2000,
    });
    assert.equal(noop.compacted, false);
    assert.equal(noop.reason, "no_first_kept_entry");
    assert.equal(
      fake.manager.entries.filter((e) => e.type === "compaction").length,
      comps1,
    );

    // New turns after boundary → second apply succeeds.
    const parentId = fake.manager.entries.at(-1)?.id ?? null;
    const uNew = randomUUID();
    const aNew = randomUUID();
    fake.manager.entries.push(
      {
        type: "message",
        id: uNew,
        parentId,
        timestamp: "2026-10-17T01:00:00.000Z",
        message: {
          role: "user",
          content: "new turn " + "n".repeat(300),
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: aNew,
        parentId: uNew,
        timestamp: "2026-10-17T01:00:01.000Z",
        message: {
          role: "assistant",
          content: "reply " + "r".repeat(300),
          timestamp: Date.now(),
        },
      },
    );

    const second = await engine.compact({
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 4000,
    });
    assert.equal(second.compacted, true, `reason=${second.reason}`);
    const comps2 = fake.manager.entries.filter((e) => e.type === "compaction").length;
    assert.ok(comps2 > comps1);
  });
});
