/**
 * Staging chunk store tests.
 * Run: node --test tests/staging.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveStagingConfig,
  writeResidueChunks,
  listStagingChunks,
  deleteStagingChunks,
  writeConsumedManifest,
  readConsumedManifest,
  sessionKeyToDirName,
} from "../lib/staging.js";

describe("resolveStagingConfig", () => {
  it("disabled by default without staging block", () => {
    const cfg = resolveStagingConfig({});
    assert.equal(cfg.enabled, false);
  });

  it("fails closed when enabled without chunkMaxChars", () => {
    assert.throws(
      () => resolveStagingConfig({ staging: { enabled: true } }),
      /chunkMaxChars/,
    );
  });

  it("accepts enabled + chunkMaxChars", () => {
    const cfg = resolveStagingConfig({
      staging: { enabled: true, chunkMaxChars: 100, dir: "memory/staging-x" },
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.chunkMaxChars, 100);
    assert.equal(cfg.dir, "memory/staging-x");
  });
});

describe("write/list/delete staging chunks", () => {
  /** @type {string} */
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-stg-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("splits residue into ordered chunks by chars", async () => {
    const ids = await writeResidueChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "agent:main:telegram:default:1",
      residue: "abcdefghij",
      chunkMaxChars: 4,
    });
    assert.deepEqual(ids, ["chunk-0001", "chunk-0002", "chunk-0003"]);
    const listed = await listStagingChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "agent:main:telegram:default:1",
    });
    assert.equal(listed.length, 3);
    assert.equal(listed[0].id, "chunk-0001");
    assert.equal(listed[0].content, "abcd");
    assert.equal(listed[2].content, "ij");
  });

  it("deleteStagingChunks removes only listed ids", async () => {
    await writeResidueChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
      residue: "12345678",
      chunkMaxChars: 4,
    });
    await deleteStagingChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
      chunkIds: ["chunk-0001"],
    });
    const listed = await listStagingChunks({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "chunk-0002");
  });

  it("consumed manifest round-trip", async () => {
    await writeConsumedManifest({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
      chunkIds: ["chunk-0001", "chunk-0002"],
    });
    const ids = await readConsumedManifest({
      workspaceDir: root,
      stagingDir: "memory/compaction-staging",
      sessionKey: "s1",
    });
    assert.deepEqual(ids, ["chunk-0001", "chunk-0002"]);
  });

  it("sessionKeyToDirName is filesystem-safe", () => {
    assert.equal(sessionKeyToDirName("agent:main:x/y"), "agent_main_x_y");
  });
});
