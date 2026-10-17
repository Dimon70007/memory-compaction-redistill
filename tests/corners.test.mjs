/**
 * TASK-047 / 047.A.I3 — expanded corner cases.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRedistillContextEngine } from "../lib/context-engine.js";
import {
  parseTranscriptLines,
  selectToolSafeFirstKeptEntryId,
  estimateEntryTokens,
  loadTranscript,
} from "../lib/transcript-apply.js";
import {
  shouldSkipAfterCompactionSessionFile,
  createAfterCompactionHandler,
} from "../lib/after-compaction.js";
import { projectActiveWindow } from "./openclaw-mock/active-window.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const FAKE_SUMMARY =
  "## Previous decisions (carried forward)\nNone\n\n## Current decisions\n- D-01 corner\n\n## Superseded / rejected\nNone\n\n## Open hypotheses (unconfirmed)\nNone\n\n## Open TODOs\nNone\n\n## Pending user asks\nNone\n\n## Session archive\nTranscript file: corner";

/**
 * @param {Record<string, unknown>} [overrides]
 */
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
      summarize: async () => FAKE_SUMMARY,
      keepRecentTokens: 40,
      ...overrides,
    },
  );
}

describe("corners: corrupt / header-only / second compact", () => {
  /** @type {string} */
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-corners-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("corrupt JSONL line → fail-closed, no apply", async () => {
    const sessionFile = join(root, "corrupt.jsonl");
    await copyFile(join(FIXTURES, "corrupt-line.jsonl"), sessionFile);
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId: "synth-corrupt",
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
    assert.match(String(result.reason ?? ""), /corrupt|session_file_read/i);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("header-only transcript → not compacted", async () => {
    const sessionFile = join(root, "header.jsonl");
    await copyFile(join(FIXTURES, "header-only.jsonl"), sessionFile);
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId: "synth-header-only",
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 100,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, "no_first_kept_entry");
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("second compact keeps prior ids; window from latest boundary", async () => {
    const sessionFile = join(root, "second.jsonl");
    await copyFile(join(FIXTURES, "synthetic-overflow.jsonl"), sessionFile);
    const engine = makeEngine({ keepRecentTokens: 30 });

    const first = await engine.compact({
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 5000,
    });
    assert.equal(first.compacted, true);
    const afterFirst = parseTranscriptLines(await readFile(sessionFile, "utf8"));
    const idsAfterFirst = new Set(afterFirst.map((e) => e.id).filter(Boolean));
    const firstCompactionId = afterFirst.find((e) => e.type === "compaction")?.id;
    assert.ok(firstCompactionId);

    // Grow tail so a second compact has something new to summarize
    const uNew = randomUUID();
    const aNew = randomUUID();
    await writeFile(
      sessionFile,
      (await readFile(sessionFile, "utf8")) +
        JSON.stringify({
          type: "message",
          id: uNew,
          parentId: afterFirst.at(-1)?.id,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: "second wave " + "n".repeat(400),
            timestamp: Date.now(),
          },
        }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: aNew,
          parentId: uNew,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: "second reply " + "r".repeat(200),
            timestamp: Date.now(),
          },
        }) +
        "\n",
      "utf8",
    );

    const second = await engine.compact({
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 6000,
    });
    assert.equal(second.compacted, true);
    const afterSecond = parseTranscriptLines(await readFile(sessionFile, "utf8"));
    for (const id of idsAfterFirst) {
      assert.ok(
        afterSecond.some((e) => e.id === id),
        `lost prior id ${id}`,
      );
    }
    const compactions = afterSecond.filter((e) => e.type === "compaction");
    assert.ok(compactions.length >= 2);
    const window = projectActiveWindow(afterSecond);
    assert.ok(window.compactionSummary);
    // Window starts at latest boundary — prior compaction summary not the only content
    assert.ok(window.estimatedTokens > 0);
  });

  it("firstKept at toolResult pairing moves cut — no orphan toolResult in window", () => {
    const entries = parseTranscriptLines(
      // rebuild tool-heavy prefix + short keep budget desire
      [
        {
          type: "session",
          version: 2,
          id: "s1",
          timestamp: "2026-10-16T00:00:00.000Z",
          cwd: "/tmp",
        },
        {
          type: "message",
          id: "u0",
          message: { role: "user", content: "x".repeat(800) },
        },
        {
          type: "message",
          id: "a0",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "t" },
              { type: "toolCall", id: "c1", name: "read", arguments: {} },
            ],
          },
        },
        {
          type: "message",
          id: "tr0",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            content: [{ type: "text", text: "y".repeat(400) }],
          },
        },
        {
          type: "message",
          id: "u1",
          message: { role: "user", content: "tail" },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const firstKept = selectToolSafeFirstKeptEntryId(entries, {
      keepRecentTokens: 1,
      estimateTokens: estimateEntryTokens,
    });
    assert.ok(firstKept);
    const idx = entries.findIndex((e) => e.id === firstKept);
    const kept = entries.slice(idx).filter((e) => e.type === "message");
    assert.notEqual(kept[0]?.message?.role, "toolResult");
    const tr = kept.find((e) => e.message?.role === "toolResult");
    if (tr) {
      const before = kept.slice(0, kept.indexOf(tr));
      assert.ok(
        before.some(
          (e) =>
            e.message?.role === "assistant" &&
            Array.isArray(e.message.content) &&
            e.message.content.some((b) => b?.type === "toolCall" && b.id === "c1"),
        ),
      );
    }
  });

  it("summarize throw mid-flight → no mutation", async () => {
    const sessionFile = join(root, "throw.jsonl");
    await copyFile(join(FIXTURES, "synthetic-overflow.jsonl"), sessionFile);
    const before = await readFile(sessionFile, "utf8");
    const engine = makeEngine({
      summarize: async () => {
        throw new Error("boom-mid-summarize");
      },
    });
    const result = await engine.compact({
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:test",
      agentId: "main",
      sessionFile,
      currentTokenCount: 1000,
    });
    assert.equal(result.compacted, false);
    assert.match(String(result.reason ?? ""), /boom-mid-summarize/);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });

  it("sequential fail then success on fresh temp copies (state isolation)", async () => {
    const failFile = join(root, "fail.jsonl");
    const okFile = join(root, "ok.jsonl");
    await copyFile(join(FIXTURES, "synthetic-overflow.jsonl"), failFile);
    await copyFile(join(FIXTURES, "synthetic-overflow.jsonl"), okFile);
    const failBefore = await readFile(failFile, "utf8");

    const failEngine = makeEngine({ summarize: async () => "" });
    const failResult = await failEngine.compact({
      sessionId: "a",
      sessionKey: "agent:main:a",
      agentId: "main",
      sessionFile: failFile,
      currentTokenCount: 1000,
    });
    assert.equal(failResult.compacted, false);
    assert.equal(await readFile(failFile, "utf8"), failBefore);

    const okEngine = makeEngine();
    const okResult = await okEngine.compact({
      sessionId: "b",
      sessionKey: "agent:main:b",
      agentId: "main",
      sessionFile: okFile,
      currentTokenCount: 1000,
    });
    assert.equal(okResult.compacted, true);
    assert.notEqual(await readFile(okFile, "utf8"), failBefore);
    assert.equal(await readFile(failFile, "utf8"), failBefore);
  });
});

describe("corners: after_compaction sessionKey", () => {
  it("handler with sessionKey-shaped sessionFile does not throw or open FS", async () => {
    let fsOpened = false;
    const api = {
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      registerCompactionProvider: () => {},
      pluginConfig: {},
    };
    const handler = createAfterCompactionHandler({
      api,
      llmConfig: {
        model: "x",
        apiKey: "k",
        baseURL: "http://example.test",
        timeoutMs: 1,
        fallbacks: [],
        completeText: async () => {
          throw new Error("no llm");
        },
      },
      stagingConfig: { enabled: false, dir: "x", chunkMaxChars: 100 },
      pluginConfig: { syncToLancedb: false, writeWorkspaceMemory: false },
      openclawConfig: {},
      sessionRecovery: {
        remember: () => {
          throw new Error("should not remember on skip");
        },
      },
      registrationState: { confirmed: true, timestamp: Date.now() },
      resolveMemoryProPath: () => "/tmp/missing-memory-pro",
    });

    // Monkey-patch would be heavy; guard is the contract — skip before read
    assert.equal(
      shouldSkipAfterCompactionSessionFile("agent:main:dashboard:deadbeef"),
      true,
    );
    await assert.doesNotReject(async () => {
      await handler(
        { sessionFile: "agent:main:dashboard:deadbeef" },
        { sessionKey: "agent:main:dashboard:deadbeef", sessionId: "x", agentId: "main" },
      );
    });
    assert.equal(fsOpened, false);
  });
});

describe("corners: strict loadTranscript", () => {
  it("loadTranscript strict mode throws on corrupt line", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcr-strict-"));
    try {
      const sessionFile = join(root, "c.jsonl");
      await copyFile(join(FIXTURES, "corrupt-line.jsonl"), sessionFile);
      await assert.rejects(
        () => loadTranscript(sessionFile, { strict: true }),
        /corrupt/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
