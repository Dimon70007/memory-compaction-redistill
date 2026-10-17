/**
 * Unit tests for OpenClaw 2026.9.9 session identity helpers (A.I4).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentIdFromSessionKey,
  buildOcStoreRef,
  classifySessionFile,
  isNonFilesystemSessionLocator,
  isSessionKeyShaped,
  parseSqliteSessionFileMarker,
  preferTranscriptKind,
  resolveSessionTranscriptTargetFromParams,
} from "../lib/session-access.js";

describe("session-access classify / markers", () => {
  it("classifies sessionKey, sqlite marker, jsonl, none", () => {
    assert.equal(
      classifySessionFile("agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976"),
      "session-key",
    );
    assert.equal(
      classifySessionFile(
        "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/home/x/.openclaw/agents/main/sessions/sessions.json",
      ),
      "sqlite-marker",
    );
    assert.equal(classifySessionFile("/tmp/abc.jsonl"), "jsonl");
    assert.equal(classifySessionFile(""), "none");
    assert.equal(classifySessionFile(null), "none");
  });

  it("parses sqlite marker and rejects malformed", () => {
    const parsed = parseSqliteSessionFileMarker(
      "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/tmp/sessions/sessions.json",
    );
    assert.deepEqual(parsed, {
      agentId: "main",
      sessionId: "94b9984a-321b-4b6c-9d96-4345f1fb3e62",
      storePath: "/tmp/sessions/sessions.json",
    });
    assert.equal(parseSqliteSessionFileMarker("sqlite:broken"), null);
    assert.equal(parseSqliteSessionFileMarker("agent:main:x"), null);
  });

  it("isNonFilesystemSessionLocator covers sessionKey and sqlite marker", () => {
    assert.equal(isNonFilesystemSessionLocator("agent:main:x"), true);
    assert.equal(
      isNonFilesystemSessionLocator("sqlite:main:sid:/tmp/sessions.json"),
      true,
    );
    assert.equal(isNonFilesystemSessionLocator("/tmp/x.jsonl"), false);
    assert.equal(isSessionKeyShaped("agent:team-lead:main"), true);
    assert.equal(agentIdFromSessionKey("agent:team-lead:main"), "team-lead");
  });
});

describe("session-access resolveSessionTranscriptTargetFromParams", () => {
  it("prefers typed sessionTarget", () => {
    const t = resolveSessionTranscriptTargetFromParams({
      sessionFile: "agent:main:dashboard:x",
      sessionTarget: {
        agentId: "main",
        sessionId: "sid-1",
        sessionKey: "agent:main:dashboard:x",
        storePath: "/tmp/sessions.json",
        threadId: "t1",
      },
    });
    assert.deepEqual(t, {
      agentId: "main",
      sessionId: "sid-1",
      sessionKey: "agent:main:dashboard:x",
      storePath: "/tmp/sessions.json",
      threadId: "t1",
    });
  });

  it("fills from runtimeContext.sessionTarget", () => {
    const t = resolveSessionTranscriptTargetFromParams({
      sessionFile: "agent:main:dashboard:x",
      runtimeContext: {
        sessionTarget: {
          agentId: "main",
          sessionId: "sid-rt",
          sessionKey: "agent:main:dashboard:x",
          storePath: "/tmp/rt-sessions.json",
        },
      },
    });
    assert.equal(t?.sessionId, "sid-rt");
    assert.equal(t?.storePath, "/tmp/rt-sessions.json");
  });

  it("fills agentId/sessionId/storePath from sqlite: marker + sessionKey", () => {
    const t = resolveSessionTranscriptTargetFromParams({
      sessionFile:
        "sqlite:main:94b9984a-321b-4b6c-9d96-4345f1fb3e62:/tmp/sessions/sessions.json",
      sessionKey: "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
    });
    assert.equal(t?.agentId, "main");
    assert.equal(t?.sessionId, "94b9984a-321b-4b6c-9d96-4345f1fb3e62");
    assert.equal(t?.storePath, "/tmp/sessions/sessions.json");
    assert.equal(
      t?.sessionKey,
      "agent:main:dashboard:86a91739-3efb-4a8f-bafc-6d4e85bc3976",
    );
  });

  it("returns null when storePath missing (no silent invent)", () => {
    const t = resolveSessionTranscriptTargetFromParams({
      sessionFile: "agent:main:dashboard:x",
      sessionKey: "agent:main:dashboard:x",
      sessionId: "sid-1",
      agentId: "main",
    });
    assert.equal(t, null);
  });

  it("returns null when sessionId missing", () => {
    const t = resolveSessionTranscriptTargetFromParams({
      sessionKey: "agent:main:x",
      sessionTarget: { storePath: "/tmp/s.json", sessionKey: "agent:main:x" },
    });
    assert.equal(t, null);
  });
});

describe("session-access preferTranscriptKind + refs", () => {
  it("prefers sqlite for transcriptStorage, sessionKey, marker", () => {
    assert.equal(
      preferTranscriptKind({
        runtimeContext: { transcriptStorage: { kind: "sqlite" } },
        sessionFile: "/tmp/x.jsonl",
      }),
      "sqlite",
    );
    assert.equal(
      preferTranscriptKind({ sessionFile: "agent:main:dashboard:x" }),
      "sqlite",
    );
    assert.equal(
      preferTranscriptKind({
        sessionFile: "sqlite:main:sid:/tmp/sessions.json",
      }),
      "sqlite",
    );
  });

  it("prefers jsonl for real abs .jsonl path", () => {
    assert.equal(preferTranscriptKind({ sessionFile: "/tmp/chat.jsonl" }), "jsonl");
  });

  it("buildOcStoreRef emits sqlite vs jsonl locators", () => {
    assert.equal(
      buildOcStoreRef({
        kind: "sqlite",
        agentId: "main",
        sessionId: "sid",
        fromEntryId: "a",
        toEntryId: "b",
      }),
      "oc:sqlite:v1:agent=main:sid=sid:from=a:to=b",
    );
    assert.match(
      buildOcStoreRef({
        kind: "jsonl",
        agentId: "main",
        sessionId: "sid",
        sessionFile: "/tmp/foo.jsonl",
        fromEntryId: "a",
        toEntryId: "b",
        parentSessionFile: "/tmp/parent.jsonl",
      }),
      /^oc:jsonl:v1:agent=main:sid=sid:file=foo\.jsonl:from=a:to=b:parent=parent\.jsonl$/,
    );
  });
});
