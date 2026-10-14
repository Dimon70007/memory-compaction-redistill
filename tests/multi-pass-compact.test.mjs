/**
 * Multi-pass compact: empty staging = single path; non-empty = A→B→C.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeResidueChunks, listStagingChunks, readConsumedManifest } from "../lib/staging.js";
import { runCompactWithStaging } from "../lib/multi-pass-compact.js";

describe("runCompactWithStaging", () => {
  /** @type {string} */
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-mp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("empty staging calls summarizeMain once only (happy path)", async () => {
    let mainCalls = 0;
    let compactCalls = 0;
    const result = await runCompactWithStaging({
      stagingConfig: { enabled: true, dir: "memory/compaction-staging", chunkMaxChars: 100 },
      workspaceDir: root,
      sessionKey: "s1",
      summarizeMain: async () => {
        mainCalls += 1;
        return "## Previous decisions (carried forward)\n\n- D-01 main\n\n## Current decisions\n\n- None\n\n## Superseded / rejected\n\n- None\n\n## Open hypotheses (unconfirmed)\n\n- None\n\n## Open TODOs\n\n- None\n\n## Pending user asks\n\n- None\n\n## Session archive\n\nTranscript file: unknown";
      },
      compactText: async () => {
        compactCalls += 1;
        return "should-not-run";
      },
    });
    assert.equal(result.mode, "single");
    assert.equal(mainCalls, 1);
    assert.equal(compactCalls, 0);
    assert.match(result.summary, /D-01 main/);
  });

  it("non-empty staging runs chunk + main + merge and writes consumed manifest", async () => {
    await writeResidueChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
      residue: "OLD_RESIDUE_DECISION",
      chunkMaxChars: 100,
    });
    /** @type {string[]} */
    const systems = [];
    const result = await runCompactWithStaging({
      stagingConfig: { enabled: true, dir: "memory/compaction-staging", chunkMaxChars: 100 },
      workspaceDir: root,
      sessionKey: "s1",
      summarizeMain: async () => "MAIN_SUMMARY",
      compactText: async (system, user) => {
        systems.push(system.slice(0, 40));
        if (user.includes("OLD_RESIDUE")) return "CHUNK_MINI";
        if (user.includes("MAIN_SUMMARY") || user.includes("Ordered notes")) {
          return "## Previous decisions (carried forward)\n\n- from staging\n\n## Current decisions\n\n- from main\n\n## Superseded / rejected\n\n- None\n\n## Open hypotheses (unconfirmed)\n\n- None\n\n## Open TODOs\n\n- None\n\n## Pending user asks\n\n- None\n\n## Session archive\n\nTranscript file: unknown";
        }
        return "OTHER";
      },
    });
    assert.equal(result.mode, "multi");
    assert.deepEqual(result.consumedIds, ["chunk-0001"]);
    assert.match(result.summary, /from staging/);
    const consumed = await readConsumedManifest({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
    });
    assert.deepEqual(consumed, ["chunk-0001"]);
    // chunks still on disk until LanceDB ack
    const left = await listStagingChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
    });
    assert.equal(left.length, 1);
    assert.ok(systems.length >= 2);
  });

  it("staging disabled ignores chunks on disk (does not break main path)", async () => {
    await writeResidueChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
      residue: "SHOULD_IGNORE",
      chunkMaxChars: 100,
    });
    let compactCalls = 0;
    const result = await runCompactWithStaging({
      stagingConfig: { enabled: false, dir: "memory/compaction-staging" },
      workspaceDir: root,
      sessionKey: "s1",
      summarizeMain: async () => "ONLY_MAIN",
      compactText: async () => {
        compactCalls += 1;
        return "x";
      },
    });
    assert.equal(result.mode, "single");
    assert.equal(result.summary, "ONLY_MAIN");
    assert.equal(compactCalls, 0);
  });
});
