/**
 * TASK-047 / 047.A.I3 — offline OpenClaw mock lifecycle.
 * FS only under os.tmpdir() + in-repo fixtures. Zero /home/clawbox I/O.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { createRedistillContextEngine } from "../../lib/context-engine.js";
import { parseTranscriptLines } from "../../lib/transcript-apply.js";
import {
  shouldSkipAfterCompactionSessionFile,
} from "../../lib/after-compaction.js";
import { projectActiveWindow } from "./active-window.js";
import { runOwnsCompactionLifecycle } from "./host.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const FAKE_SUMMARY =
  "## Previous decisions (carried forward)\nNone\n\n## Current decisions\n- D-01 mock shrink\n\n## Superseded / rejected\nNone\n\n## Open hypotheses (unconfirmed)\nNone\n\n## Open TODOs\nNone\n\n## Pending user asks\nNone\n\n## Session archive\nTranscript file: mock";

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

describe("openclaw-mock active-window projection", () => {
  it("before compaction estimates tokens from all messages", async () => {
    const raw = await readFile(join(FIXTURES, "synthetic-overflow.jsonl"), "utf8");
    const entries = parseTranscriptLines(raw);
    const window = projectActiveWindow(entries);
    assert.ok(window.estimatedTokens > 50);
    assert.ok(window.messages.length >= 6);
    assert.equal(window.compactionSummary, null);
  });

  it("after compaction window is summary + tail from firstKeptEntryId", async () => {
    const raw = await readFile(join(FIXTURES, "synthetic-overflow.jsonl"), "utf8");
    const entries = parseTranscriptLines(raw);
    const firstKept = "msg-u-tail-3";
    entries.push({
      type: "compaction",
      id: "comp-1",
      parentId: "msg-a-tail-3",
      timestamp: "2026-10-16T12:01:00.000Z",
      summary: "SHORT SUMMARY",
      firstKeptEntryId: firstKept,
      tokensBefore: 900,
      tokensAfter: 40,
    });
    const window = projectActiveWindow(entries);
    assert.equal(window.compactionSummary, "SHORT SUMMARY");
    assert.ok(window.estimatedTokens < 100);
    const roles = window.messages.map((m) => m.role);
    assert.equal(roles[0], "user"); // synthetic summary checkpoint
    assert.ok(roles.includes("user") && roles.includes("assistant"));
    assert.ok(!window.messages.some((m) => m.content === "OLD PREFIX context block A"));
  });
});

describe("openclaw-mock ownsCompaction lifecycle", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let sessionFile;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-lifecycle-"));
    sessionFile = join(root, "synth-overflow-001.jsonl");
    await copyFile(join(FIXTURES, "synthetic-overflow.jsonl"), sessionFile);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("success shrinks projected active window tokens and bytes", async () => {
    const engine = makeEngine();
    /** @type {object[]} */
    const afterEvents = [];
    const life = await runOwnsCompactionLifecycle(engine, {
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:dashboard:mock",
      agentId: "main",
      sessionFile,
      currentTokenCount: 8000,
      afterCompaction: async (event) => {
        afterEvents.push(event);
      },
    });

    assert.equal(life.result.ok, true);
    assert.equal(life.result.compacted, true);
    assert.equal(life.maintain.changed, false);
    assert.equal(typeof life.maintain.bytesFreed, "number");
    assert.ok(
      life.activeWindowAfter.estimatedTokens < life.activeWindowBefore.estimatedTokens,
    );
    assert.ok(life.transcriptBytesAfter >= life.transcriptBytesBefore); // append grows file; window shrinks
    assert.ok(
      life.activeWindowAfter.estimatedBytes < life.activeWindowBefore.estimatedBytes,
    );

    const pathForWindow = life.activeSessionFile;
    const entries = parseTranscriptLines(await readFile(pathForWindow, "utf8"));
    assert.ok(entries.some((e) => e.type === "compaction"));
    assert.equal(afterEvents.length, 1);
    assert.equal(afterEvents[0].sessionFile, pathForWindow);
  });

  it("fail-closed leaves fixture bytes identical", async () => {
    const beforeBytes = (await stat(sessionFile)).size;
    const beforeRaw = await readFile(sessionFile, "utf8");
    const engine = makeEngine({ summarize: async () => "   " });
    const life = await runOwnsCompactionLifecycle(engine, {
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:dashboard:mock",
      agentId: "main",
      sessionFile,
      currentTokenCount: 8000,
    });
    assert.equal(life.result.compacted, false);
    assert.equal(await readFile(sessionFile, "utf8"), beforeRaw);
    assert.equal((await stat(sessionFile)).size, beforeBytes);
    assert.equal(life.activeWindowAfter.estimatedTokens, life.activeWindowBefore.estimatedTokens);
  });

  it("rotate: predecessor keeps prior entry ids; successor parentSession is abs temp path", async () => {
    const entries = parseTranscriptLines(await readFile(sessionFile, "utf8"));
    // Inflate so rotate threshold fires
    entries[1].message.content = "Z".repeat(50_000);
    await writeFile(
      sessionFile,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const idsBefore = new Set(entries.map((e) => e.id).filter(Boolean));
    const sizeBefore = (await stat(sessionFile)).size;

    const engine = makeEngine({
      maxActiveTranscriptBytes: 1024,
      preferRotate: true,
    });
    const life = await runOwnsCompactionLifecycle(engine, {
      sessionId: "synth-overflow-001",
      sessionKey: "agent:main:dashboard:mock",
      agentId: "main",
      sessionFile,
      currentTokenCount: 50_000,
    });
    assert.equal(life.result.compacted, true);
    assert.ok(life.result.result?.sessionFile);
    assert.notEqual(life.activeSessionFile, sessionFile);

    const pred = parseTranscriptLines(await readFile(sessionFile, "utf8"));
    for (const id of idsBefore) {
      assert.ok(
        pred.some((e) => e.id === id),
        `predecessor missing id ${id}`,
      );
    }
    assert.ok((await stat(sessionFile)).size >= sizeBefore);

    const succ = parseTranscriptLines(await readFile(life.activeSessionFile, "utf8"));
    assert.equal(succ[0]?.type, "session");
    assert.equal(succ[0]?.parentSession, sessionFile);
    assert.ok(sessionFile.startsWith(root));
  });
});

describe("after_compaction path guard (mock)", () => {
  it("sessionKey-shaped sessionFile skips without throw", () => {
    assert.equal(
      shouldSkipAfterCompactionSessionFile(
        "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
      ),
      true,
    );
  });

  it("filesystem path is not skipped", () => {
    assert.equal(
      shouldSkipAfterCompactionSessionFile(join(tmpdir(), "x.jsonl")),
      false,
    );
  });
});
