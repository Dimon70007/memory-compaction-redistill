/**
 * Resolve sessionKey-shaped host sessionFile → JSONL path.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  agentIdFromSessionKey,
  isSessionKeyShaped,
  resolveFilesystemSessionFile,
} from "../lib/session-path.js";

describe("session-path resolve", () => {
  /** @type {string} */
  let home;
  /** @type {string} */
  let sessionsDir;
  /** @type {string} */
  let sessionId;
  /** @type {string} */
  let jsonlPath;
  const sessionKey = "agent:team-lead:telegram:group:-1003808706444:topic:2";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mcr-spath-"));
    sessionsDir = join(home, ".openclaw", "agents", "team-lead", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    sessionId = randomUUID();
    jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(
      jsonlPath,
      `${JSON.stringify({ type: "session", version: 2, id: sessionId, timestamp: new Date().toISOString(), cwd: "/tmp" })}\n` +
        `${JSON.stringify({ type: "message", id: randomUUID(), message: { role: "user", content: "hi" } })}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [sessionKey]: { sessionId, updatedAt: Date.now() },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("detects sessionKey-shaped values", () => {
    assert.equal(isSessionKeyShaped(sessionKey), true);
    assert.equal(isSessionKeyShaped(jsonlPath), false);
    assert.equal(agentIdFromSessionKey(sessionKey), "team-lead");
  });

  it("resolves via sessions.json when host passes sessionKey as sessionFile", async () => {
    const resolved = await resolveFilesystemSessionFile(
      {
        sessionFile: sessionKey,
        sessionKey,
        agentId: "team-lead",
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, jsonlPath);
    assert.equal(resolved.resolvedFrom, "sessions.json");
  });

  it("prefers real filesystem sessionFile", async () => {
    const resolved = await resolveFilesystemSessionFile(
      {
        sessionFile: jsonlPath,
        sessionKey,
        agentId: "team-lead",
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, jsonlPath);
    assert.equal(resolved.resolvedFrom, "params.sessionFile");
  });

  it("unresolved sessionKey returns empty path with detail", async () => {
    const resolved = await resolveFilesystemSessionFile(
      {
        sessionFile: "agent:team-lead:telegram:group:missing:topic:9",
        agentId: "team-lead",
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, "");
    assert.match(String(resolved.detail ?? ""), /sessionKey-shaped/);
  });

  it("does NOT treat sessionTarget.storePath=sessions.json as transcript", async () => {
    // Live bug 2026-10-17: host passed storePath → .../sessions/sessions.json
    const indexPath = join(sessionsDir, "sessions.json");
    const resolved = await resolveFilesystemSessionFile(
      {
        sessionFile: sessionKey,
        sessionKey,
        agentId: "team-lead",
        sessionTarget: { storePath: indexPath, sessionId, agentId: "team-lead" },
      },
      { homeDir: home },
    );
    assert.notEqual(resolved.sessionFile, indexPath);
    assert.ok(resolved.sessionFile.endsWith(".jsonl"));
    assert.equal(resolved.sessionFile, jsonlPath);
  });

  it("treats sessionTarget.storePath as sessions dir and looks up .jsonl", async () => {
    const resolved = await resolveFilesystemSessionFile(
      {
        sessionKey,
        agentId: "team-lead",
        sessionId,
        sessionTarget: { storePath: sessionsDir, sessionId, agentId: "team-lead" },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, jsonlPath);
    assert.ok(!resolved.sessionFile.endsWith("sessions.json"));
  });

  it("rejects non-jsonl paths as transcript candidates", async () => {
    const { isTranscriptJsonlPath } = await import("../lib/session-path.js");
    assert.equal(isTranscriptJsonlPath(jsonlPath), true);
    assert.equal(isTranscriptJsonlPath(join(sessionsDir, "sessions.json")), false);
    assert.equal(isTranscriptJsonlPath(sessionsDir), false);
    assert.equal(isTranscriptJsonlPath("/tmp/foo.trajectory-path.json"), false);
  });

  it("storePath=sessions.json + sessionKey resolves without params.sessionFile", async () => {
    // Live 2026-10-17: UI compact often sends storePath only + sessionKey/sessionId
    const indexPath = join(sessionsDir, "sessions.json");
    const resolved = await resolveFilesystemSessionFile(
      {
        agentId: "team-lead",
        sessionKey,
        sessionTarget: { storePath: indexPath, agentId: "team-lead" },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, jsonlPath);
  });

  it("storePath=sessions.json + sessionKey resolves via exact entry.sessionId (OpenClaw)", async () => {
    // OpenClaw: key → sessions.json[key] → entry.sessionId → <sid>.jsonl
    // Dashboard UUID is only in the key; jsonl basename is entry.sessionId.
    const dashboardId = "86a91739-3efb-4a8f-bafc-6d4e85bc3976";
    const dashKey = `agent:main:dashboard:${dashboardId}`;
    const realSid = sessionId;
    const mainDir = join(home, ".openclaw", "agents", "main", "sessions");
    await mkdir(mainDir, { recursive: true });
    const mainJsonl = join(mainDir, `${realSid}.jsonl`);
    await writeFile(
      mainJsonl,
      `${JSON.stringify({ type: "session", version: 2, id: realSid, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" })}\n` +
        `${JSON.stringify({ type: "message", id: randomUUID(), message: { role: "user", content: "hi" } })}\n`,
      "utf8",
    );
    await writeFile(
      join(mainDir, "sessions.json"),
      JSON.stringify({ [dashKey]: { sessionId: realSid, updatedAt: Date.now() } }),
      "utf8",
    );

    const resolved = await resolveFilesystemSessionFile(
      {
        agentId: "main",
        sessionKey: dashKey,
        // Host may also pass dashboard id as sessionId; exact key lookup wins via entry
        sessionId: dashboardId,
        sessionTarget: {
          storePath: join(mainDir, "sessions.json"),
          sessionId: dashboardId,
          agentId: "main",
        },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, mainJsonl);
    assert.equal(resolved.resolvedFrom, "sessions.json");
  });

  it("storePath only without sessionKey/sessionId fails with explicit detail", async () => {
    const resolved = await resolveFilesystemSessionFile(
      {
        agentId: "main",
        sessionTarget: { storePath: join(sessionsDir, "sessions.json") },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, "");
    assert.match(String(resolved.detail ?? ""), /sessionKey|sessionId/i);
  });

  it("resolves sessionId.jsonl even when sessions.json is unreadable/corrupt", async () => {
    // Live: index may be unreadable or non-JSON; host still sends real sessionId
    const mainDir = join(home, ".openclaw", "agents", "main", "sessions");
    await mkdir(mainDir, { recursive: true });
    const sid = "24b4a68f-5d59-42fd-a54f-bc6256bb7a8d";
    const mainJsonl = join(mainDir, `${sid}.jsonl`);
    await writeFile(
      mainJsonl,
      `${JSON.stringify({ type: "session", version: 2, id: sid, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" })}\n` +
        `${JSON.stringify({ type: "message", id: randomUUID(), message: { role: "user", content: "x" } })}\n`,
      "utf8",
    );
    await writeFile(join(mainDir, "sessions.json"), "{ not valid json\n", "utf8");

    const resolved = await resolveFilesystemSessionFile(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
        sessionId: sid,
        sessionTarget: {
          storePath: join(mainDir, "sessions.json"),
          sessionId: sid,
          agentId: "main",
        },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, mainJsonl);
  });

  it("error detail lists tried sessionId.jsonl path when missing", async () => {
    const mainDir = join(home, ".openclaw", "agents", "main", "sessions");
    await mkdir(mainDir, { recursive: true });
    await writeFile(join(mainDir, "sessions.json"), "{}\n", "utf8");
    const sid = "24b4a68f-5d59-42fd-a54f-bc6256bb7a8d";
    const resolved = await resolveFilesystemSessionFile(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
        sessionId: sid,
        sessionTarget: { storePath: join(mainDir, "sessions.json"), sessionId: sid },
      },
      { homeDir: home },
    );
    assert.equal(resolved.sessionFile, "");
    assert.match(String(resolved.detail ?? ""), /24b4a68f-5d59-42fd-a54f-bc6256bb7a8d\.jsonl/);
    assert.match(String(resolved.detail ?? ""), /missing|not found|exists=false/i);
  });
});
