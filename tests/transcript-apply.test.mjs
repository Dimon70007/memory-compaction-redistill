/**
 * TASK-047 Iteration A — offline apply/rotate + engine contract tests.
 * Run: node --test tests/transcript-apply.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  buildOcJsonlRef,
  isFilesystemTranscriptPath,
  selectToolSafeFirstKeptEntryId,
  parseTranscriptLines,
  appendCompactionToJsonl,
  rotateSuccessorTranscript,
  estimateEntryTokens,
} from "../lib/transcript-apply.js";
import { createRedistillContextEngine } from "../index.js";
import { estimateMessagesTokens } from "../lib/session-recovery.js";
import { createFakeSqliteStoreDeps } from "./openclaw-mock/fake-session-manager.js";
import {
  classifySessionFile,
  isNonFilesystemSessionLocator,
  parseSqliteSessionFileMarker,
} from "../lib/session-access.js";
import { shouldSkipAfterCompactionSessionFile } from "../lib/after-compaction.js";

/**
 * @param {object[]} entries
 * @returns {string}
 */
function toJsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * @param {string} sessionId
 * @returns {object[]}
 */
function buildFixtureEntries(sessionId) {
  const ids = {
    session: sessionId,
    u1: randomUUID(),
    a1: randomUUID(),
    tr1: randomUUID(),
    u2: randomUUID(),
    a2: randomUUID(),
    u3: randomUUID(),
    a3: randomUUID(),
  };
  return [
    {
      type: "session",
      version: 2,
      id: ids.session,
      timestamp: "2026-10-16T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: ids.u1,
      parentId: null,
      timestamp: "2026-10-16T00:00:01.000Z",
      message: {
        role: "user",
        content: "old context " + "x".repeat(400),
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.a1,
      parentId: ids.u1,
      timestamp: "2026-10-16T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.tr1,
      parentId: ids.a1,
      timestamp: "2026-10-16T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents " + "y".repeat(200) }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.u2,
      parentId: ids.tr1,
      timestamp: "2026-10-16T00:00:04.000Z",
      message: {
        role: "user",
        content: "mid " + "m".repeat(200),
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.a2,
      parentId: ids.u2,
      timestamp: "2026-10-16T00:00:05.000Z",
      message: {
        role: "assistant",
        content: "mid reply " + "r".repeat(200),
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.u3,
      parentId: ids.a2,
      timestamp: "2026-10-16T00:00:06.000Z",
      message: {
        role: "user",
        content: "fresh tail user",
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: ids.a3,
      parentId: ids.u3,
      timestamp: "2026-10-16T00:00:07.000Z",
      message: {
        role: "assistant",
        content: "fresh tail assistant",
        timestamp: Date.now(),
      },
    },
  ];
}

describe("isFilesystemTranscriptPath", () => {
  it("rejects sessionKey-shaped values", () => {
    assert.equal(
      isFilesystemTranscriptPath("agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976"),
      false,
    );
  });

  it("accepts absolute jsonl paths", () => {
    assert.equal(
      isFilesystemTranscriptPath("/home/clawbox/.openclaw/agents/main/sessions/x.jsonl"),
      true,
    );
  });
});

describe("buildOcJsonlRef", () => {
  it("embeds opaque oc:jsonl:v1 locator", () => {
    const ref = buildOcJsonlRef({
      agentId: "main",
      sessionId: "sid-1",
      sessionFile: "/tmp/agents/main/sessions/sid-1.jsonl",
      fromEntryId: "from-id",
      toEntryId: "to-id",
    });
    assert.match(ref, /^oc:jsonl:v1:agent=main:sid=sid-1:file=sid-1\.jsonl:from=from-id:to=to-id$/);
  });

  it("includes parent basename when provided", () => {
    const ref = buildOcJsonlRef({
      agentId: "main",
      sessionId: "sid-2",
      sessionFile: "/tmp/sid-2.jsonl",
      fromEntryId: "a",
      toEntryId: "b",
      parentSessionFile: "/tmp/old.jsonl",
    });
    assert.match(ref, /:parent=old\.jsonl$/);
  });
});

describe("selectToolSafeFirstKeptEntryId", () => {
  it("does not split toolCall / toolResult pair", () => {
    const sessionId = randomUUID();
    const entries = buildFixtureEntries(sessionId);
    // Tiny keep budget so cut wants to land near the toolResult
    const firstKept = selectToolSafeFirstKeptEntryId(entries, {
      keepRecentTokens: 1,
      estimateTokens: estimateEntryTokens,
    });
    assert.ok(firstKept);
    const idx = entries.findIndex((e) => e.id === firstKept);
    assert.ok(idx >= 0);
    const kept = entries.slice(idx);
    const roles = kept
      .filter((e) => e.type === "message")
      .map((e) => e.message.role);
    // Must not start with orphan toolResult
    assert.notEqual(roles[0], "toolResult");
    // If toolResult is kept, its assistant toolCall must also be kept
    const trIdx = kept.findIndex(
      (e) => e.type === "message" && e.message?.role === "toolResult",
    );
    if (trIdx >= 0) {
      const before = kept.slice(0, trIdx);
      assert.ok(
        before.some(
          (e) =>
            e.type === "message" &&
            e.message?.role === "assistant" &&
            Array.isArray(e.message.content) &&
            e.message.content.some((b) => b?.type === "toolCall" && b.id === "call_1"),
        ),
      );
    }
  });
});

describe("appendCompactionToJsonl", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let sessionFile;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-apply-"));
    const sessionId = randomUUID();
    sessionFile = join(root, `${sessionId}.jsonl`);
    await writeFile(sessionFile, toJsonl(buildFixtureEntries(sessionId)), "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends compaction entry with firstKeptEntryId", async () => {
    const before = await readFile(sessionFile, "utf8");
    const entries = parseTranscriptLines(before);
    const firstKept = selectToolSafeFirstKeptEntryId(entries, {
      keepRecentTokens: 50,
      estimateTokens: estimateEntryTokens,
    });
    const applied = await appendCompactionToJsonl({
      sessionFile,
      summary: "SUMMARY\noc:jsonl:v1:agent=main:sid=x:file=x.jsonl:from=a:to=b",
      firstKeptEntryId: firstKept,
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    assert.equal(applied.ok, true);
    const after = await readFile(sessionFile, "utf8");
    assert.ok(after.startsWith(before.trimEnd()));
    const last = parseTranscriptLines(after).at(-1);
    assert.equal(last?.type, "compaction");
    assert.equal(last?.firstKeptEntryId, firstKept);
    assert.equal(last?.tokensBefore, 1000);
    assert.match(String(last?.summary ?? ""), /oc:jsonl:v1:/);
  });
});

describe("createRedistillContextEngine compact apply", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let sessionFile;
  /** @type {string} */
  let sessionId;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-engine-"));
    sessionId = randomUUID();
    sessionFile = join(root, `${sessionId}.jsonl`);
    await writeFile(sessionFile, toJsonl(buildFixtureEntries(sessionId)), "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeEngine(overrides = {}) {
    const llmConfig = {
      model: "test/model",
      apiKey: "k",
      baseURL: "http://example.test/v1",
      timeoutMs: 1000,
      fallbacks: [],
      log: () => {},
      completeText: async () => {
        throw new Error("live LLM must not be called");
      },
    };
    return createRedistillContextEngine(
      llmConfig,
      async () => null,
      { enabled: false, dir: "memory/compaction-staging", chunkMaxChars: 1000 },
      {
        summarize: async () =>
          "## Previous decisions (carried forward)\nNone\n\n## Current decisions\n- D-01 test\n\n## Superseded / rejected\nNone\n\n## Open hypotheses (unconfirmed)\nNone\n\n## Open TODOs\nNone\n\n## Pending user asks\nNone\n\n## Session archive\nTranscript file: unknown",
        ...overrides,
      },
    );
  }

  it("acceptedHostParams includes runtimeContext and runtimeSettings", () => {
    const engine = makeEngine();
    assert.ok(engine.info.acceptedHostParams.includes("runtimeContext"));
    assert.ok(engine.info.acceptedHostParams.includes("runtimeSettings"));
    assert.equal(engine.info.ownsCompaction, true);
    assert.equal(
      engine.info.transcriptSemantics?.currentTurnFence,
      "before-current-turn-entry-v1",
    );
  });

  it("commitTurn is idempotent on advancementKey", async () => {
    const engine = makeEngine();
    const first = await engine.commitTurn({ advancementKey: "turn-1" });
    const second = await engine.commitTurn({ advancementKey: "turn-1" });
    assert.equal(first.status, "committed");
    assert.equal(second.status, "duplicate");
  });

  it("session-access: sessionKey and sqlite markers are non-filesystem", () => {
    assert.equal(classifySessionFile("agent:main:dashboard:x"), "session-key");
    assert.equal(
      classifySessionFile(
        "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/tmp/sessions/sessions.json",
      ),
      "sqlite-marker",
    );
    assert.ok(
      parseSqliteSessionFileMarker(
        "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/tmp/sessions/sessions.json",
      ),
    );
    assert.equal(
      shouldSkipAfterCompactionSessionFile("agent:main:dashboard:x"),
      true,
    );
    assert.equal(
      shouldSkipAfterCompactionSessionFile(
        "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/tmp/sessions/sessions.json",
      ),
      true,
    );
    assert.equal(isNonFilesystemSessionLocator(sessionFile), false);
  });

  it("maintain always returns changed/bytesFreed/rewrittenEntries", async () => {
    const engine = makeEngine();
    const result = await engine.maintain();
    assert.equal(typeof result?.changed, "boolean");
    assert.equal(typeof result?.bytesFreed, "number");
    assert.equal(typeof result?.rewrittenEntries, "number");
  });

  it("happy path: sessionFile-only compact applies compaction boundary", async () => {
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:dashboard:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 5000,
      // no messages — overflow-shaped
    });
    assert.equal(result.ok, true);
    assert.equal(result.compacted, true);
    assert.ok(result.result?.summary);
    assert.ok(result.result?.firstKeptEntryId);
    assert.equal(result.result?.tokensBefore, 5000);
    assert.ok(typeof result.result?.tokensAfter === "number");
    assert.ok(result.result.tokensAfter < result.result.tokensBefore);
    assert.match(result.result.summary, /oc:jsonl:v1:/);

    const after = await readFile(sessionFile, "utf8");
    assert.notEqual(after, before);
    const last = parseTranscriptLines(after).at(-1);
    assert.equal(last?.type, "compaction");
    assert.equal(last?.firstKeptEntryId, result.result.firstKeptEntryId);
  });

  it("fail-closed: empty summarize leaves transcript unchanged", async () => {
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine({ summarize: async () => "   " });
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("fail-closed: abortSignal aborts without mutation", async () => {
    const before = await readFile(sessionFile, "utf8");
    const ac = new AbortController();
    ac.abort();
    const engine = makeEngine({
      summarize: async () => {
        throw new Error("should not summarize when aborted");
      },
    });
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      abortSignal: ac.signal,
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("fail-closed: apply failure does not claim compacted", async () => {
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine({
      appendCompaction: async () => {
        throw new Error("disk full");
      },
    });
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.compacted, false);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("missing sessionFile without messages → not compacted", async () => {
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:test",
      agentId: "main",
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
  });

  it("assemble/autoRecall do not auto-ingest oc:jsonl refs", async () => {
    const engine = makeEngine();
    const messages = [
      {
        role: "user",
        content:
          "see oc:jsonl:v1:agent=main:sid=x:file=missing.jsonl:from=a:to=b for history",
      },
    ];
    const assembled = await engine.assemble({ messages });
    assert.deepEqual(assembled.messages, messages);
    assert.equal(assembled.estimatedTokens, estimateMessagesTokens(messages));
    const recall = await engine.autoRecall({ messages });
    assert.deepEqual(recall.memories, []);
  });

  it("rotateSuccessor returns successor ids when file still oversized", async () => {
    // Inflate fixture so rotate threshold triggers
    const entries = buildFixtureEntries(sessionId);
    entries[1].message.content = "Z".repeat(2_000_000);
    await writeFile(sessionFile, toJsonl(entries), "utf8");
    const sizeBefore = (await stat(sessionFile)).size;

    const engine = makeEngine({
      maxActiveTranscriptBytes: 1024,
      preferRotate: true,
    });
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 50_000,
      runtimeSettings: { maxActiveTranscriptBytes: 1024 },
    });
    assert.equal(result.compacted, true);
    assert.ok(result.result?.sessionFile);
    assert.ok(result.result?.sessionId);
    assert.notEqual(result.result.sessionFile, sessionFile);
    // OpenClaw CompactResult: prefer typed sessionTarget for adoptCompactionTranscript
    assert.ok(result.result?.sessionTarget);
    assert.equal(result.result.sessionTarget.sessionId, result.result.sessionId);
    assert.equal(result.result.sessionTarget.agentId, "main");
    assert.equal(result.result.sessionTarget.sessionKey, "agent:main:test");
    assert.equal(result.result.sessionTarget.storePath, result.result.sessionFile);
    assert.equal(typeof result.result.tokensBefore, "number");
    assert.equal(typeof result.result.tokensAfter, "number");
    assert.equal(
      result.result.details?.tokensSaved,
      Math.max(0, result.result.tokensBefore - result.result.tokensAfter),
    );
    const successorRaw = await readFile(result.result.sessionFile, "utf8");
    const successorEntries = parseTranscriptLines(successorRaw);
    assert.equal(successorEntries[0]?.type, "session");
    assert.equal(successorEntries[0]?.parentSession, sessionFile);
    assert.ok(successorEntries.some((e) => e.type === "compaction"));
    assert.ok(sizeBefore > 1024);
  });

  it("sqlite-era: sessionKey sessionFile + SessionManager applies (no JSONL)", async () => {
    const entries = buildFixtureEntries(sessionId);
    const fake = createFakeSqliteStoreDeps(entries, {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
      storePath: "/tmp/fake-agent/sessions/sessions.json",
    });
    const engine = makeEngine({
      keepRecentTokens: 40,
      openTranscriptStore: fake.openTranscriptStore,
    });
    const result = await engine.compact({
      sessionId,
      sessionKey: fake.target.sessionKey,
      agentId: "main",
      sessionFile: fake.target.sessionKey,
      sessionTarget: fake.target,
      currentTokenCount: 5000,
      runtimeContext: { transcriptStorage: { kind: "sqlite" } },
    });
    assert.equal(result.compacted, true, `reason=${result.reason}`);
    assert.match(String(result.result?.summary ?? ""), /oc:sqlite:v1:/);
    assert.equal(result.result?.details?.storeKind, "sqlite");
    assert.ok(fake.manager.entries.some((e) => e.type === "compaction"));
    // Same-session: no successor rotate on sqlite
    assert.equal(result.result?.sessionTarget, undefined);
  });

  it("sqlite-era: fail closed without SessionManager (no sessionKey→jsonl fallback)", async () => {
    const engine = makeEngine({ keepRecentTokens: 40 });
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:dashboard:test",
      agentId: "main",
      sessionFile: "agent:main:dashboard:test",
      currentTokenCount: 5000,
    });
    assert.equal(result.compacted, false);
    assert.match(String(result.reason ?? ""), /missing_session_target|session_manager/);
    assert.ok(!String(result.reason ?? "").includes("sessions/"));
  });

  it("happy path CompactResult includes size fields without sessionTarget when not rotated", async () => {
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId,
      sessionKey: "agent:main:dashboard:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 5000,
    });
    assert.equal(result.compacted, true);
    assert.equal(result.result.tokensBefore, 5000);
    assert.ok(typeof result.result.tokensAfter === "number");
    assert.ok(result.result.firstKeptEntryId);
    assert.ok(result.result.summary);
    assert.equal(result.result.details?.tokensSaved, 5000 - result.result.tokensAfter);
    assert.equal(result.result.sessionTarget, undefined);
    assert.equal(result.result.sessionFile, undefined);
  });
});

describe("rotateSuccessorTranscript helper", () => {
  it("writes parentSession and keeps compaction + tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcr-rot-"));
    try {
      const sessionId = randomUUID();
      const sessionFile = join(root, `${sessionId}.jsonl`);
      const entries = buildFixtureEntries(sessionId);
      await writeFile(sessionFile, toJsonl(entries), "utf8");
      const firstKept = entries[6].id; // u3
      const compaction = {
        type: "compaction",
        id: randomUUID(),
        parentId: entries.at(-1).id,
        timestamp: new Date().toISOString(),
        summary: "sum",
        firstKeptEntryId: firstKept,
        tokensBefore: 10,
        tokensAfter: 2,
      };
      const rotated = await rotateSuccessorTranscript({
        sessionFile,
        agentId: "main",
        compactionEntry: compaction,
        firstKeptEntryId: firstKept,
      });
      assert.ok(rotated.sessionFile);
      assert.notEqual(rotated.sessionId, sessionId);
      const parsed = parseTranscriptLines(await readFile(rotated.sessionFile, "utf8"));
      assert.equal(parsed[0].parentSession, sessionFile);
      assert.ok(parsed.some((e) => e.type === "compaction"));
      assert.ok(parsed.some((e) => e.id === firstKept));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
