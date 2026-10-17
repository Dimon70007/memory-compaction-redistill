/**
 * Session / transcript identity helpers for OpenClaw 2026.9.9.
 * Distinguishes sqlite-era sessionKey / sqlite: markers from legacy JSONL paths.
 */
import { basename, isAbsolute } from "node:path";
import { asNonEmptyString } from "./env.js";
import { asRecord } from "./util.js";
import { isFilesystemTranscriptPath } from "./transcript-apply.js";

/** @typedef {'jsonl' | 'session-key' | 'sqlite-marker' | 'none'} SessionFileKind */

const SQLITE_SESSION_FILE_MARKER_RE = /^sqlite:([^:]+):([^:]+):(.*)$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSessionKeyShaped(value) {
  if (!asNonEmptyString(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("agent:")) {
    return true;
  }
  return (
    trimmed.includes(":") &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.endsWith(".jsonl")
  );
}

/**
 * Legacy OpenClaw sqlite sessionFile marker:
 * `sqlite:<agentId>:<sessionId>:<storePath>`
 *
 * @param {unknown} sessionFile
 * @returns {{ agentId: string; sessionId: string; storePath: string } | null}
 */
export function parseSqliteSessionFileMarker(sessionFile) {
  const marker = asNonEmptyString(sessionFile);
  if (!marker?.startsWith("sqlite:")) {
    return null;
  }
  const match = SQLITE_SESSION_FILE_MARKER_RE.exec(marker);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    agentId: match[1],
    sessionId: match[2],
    storePath: match[3],
  };
}

/**
 * @param {unknown} sessionFile
 * @returns {SessionFileKind}
 */
export function classifySessionFile(sessionFile) {
  if (!asNonEmptyString(sessionFile)) {
    return "none";
  }
  const trimmed = sessionFile.trim();
  if (parseSqliteSessionFileMarker(trimmed)) {
    return "sqlite-marker";
  }
  if (isSessionKeyShaped(trimmed)) {
    return "session-key";
  }
  if (isFilesystemTranscriptPath(trimmed)) {
    return "jsonl";
  }
  return "none";
}

/**
 * True when after_compaction / FS helpers must not open the value.
 *
 * @param {unknown} sessionFile
 * @returns {boolean}
 */
export function isNonFilesystemSessionLocator(sessionFile) {
  const kind = classifySessionFile(sessionFile);
  return kind === "session-key" || kind === "sqlite-marker" || kind === "none";
}

/**
 * Build a complete SessionManager / transcript-runtime target when possible.
 *
 * @param {object} params Host compact params
 * @returns {{
 *   agentId: string;
 *   sessionId: string;
 *   sessionKey: string;
 *   storePath: string;
 *   threadId?: string | number;
 * } | null}
 */
export function resolveSessionTranscriptTargetFromParams(params) {
  const p = asRecord(params);
  const target = asRecord(p.sessionTarget);
  const runtimeTarget = asRecord(asRecord(p.runtimeContext).sessionTarget);

  const marker = parseSqliteSessionFileMarker(p.sessionFile);

  const agentId =
    asNonEmptyString(target.agentId) ??
    asNonEmptyString(runtimeTarget.agentId) ??
    asNonEmptyString(marker?.agentId) ??
    asNonEmptyString(p.agentId) ??
    agentIdFromSessionKey(
      asNonEmptyString(target.sessionKey) ??
        asNonEmptyString(runtimeTarget.sessionKey) ??
        asNonEmptyString(p.sessionKey) ??
        (isSessionKeyShaped(p.sessionFile) ? String(p.sessionFile).trim() : null),
    ) ??
    "main";

  const sessionId =
    asNonEmptyString(target.sessionId) ??
    asNonEmptyString(runtimeTarget.sessionId) ??
    asNonEmptyString(marker?.sessionId) ??
    asNonEmptyString(p.sessionId);

  const sessionKey =
    asNonEmptyString(target.sessionKey) ??
    asNonEmptyString(runtimeTarget.sessionKey) ??
    asNonEmptyString(p.sessionKey) ??
    (isSessionKeyShaped(p.sessionFile) ? String(p.sessionFile).trim() : null);

  const storePath =
    asNonEmptyString(target.storePath) ??
    asNonEmptyString(runtimeTarget.storePath) ??
    asNonEmptyString(marker?.storePath);

  if (!sessionId || !sessionKey || !storePath) {
    return null;
  }

  /** @type {{ agentId: string; sessionId: string; sessionKey: string; storePath: string; threadId?: string | number }} */
  const resolved = { agentId, sessionId, sessionKey, storePath };
  const threadId = target.threadId ?? runtimeTarget.threadId;
  if (threadId !== undefined && threadId !== null && String(threadId).trim()) {
    resolved.threadId = threadId;
  }
  return resolved;
}

/**
 * @param {string | null | undefined} sessionKey
 * @returns {string | null}
 */
export function agentIdFromSessionKey(sessionKey) {
  const key = asNonEmptyString(sessionKey);
  if (!key) {
    return null;
  }
  const parts = key.split(":");
  if (parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  return null;
}

/**
 * Opaque locator embedded in compaction summaries (sqlite-era or legacy JSONL).
 *
 * @param {{
 *   kind: 'sqlite' | 'jsonl';
 *   agentId: string;
 *   sessionId: string;
 *   sessionFile?: string;
 *   fromEntryId: string;
 *   toEntryId: string;
 *   parentSessionFile?: string | null;
 * }} params
 * @returns {string}
 */
export function buildOcStoreRef(params) {
  const agent = String(params.agentId || "main").trim() || "main";
  const sid = String(params.sessionId || "").trim() || "unknown";
  const from = String(params.fromEntryId || "").trim();
  const to = String(params.toEntryId || "").trim();
  if (params.kind === "sqlite") {
    return `oc:sqlite:v1:agent=${agent}:sid=${sid}:from=${from}:to=${to}`;
  }
  const file = basename(params.sessionFile || "session.jsonl");
  let ref = `oc:jsonl:v1:agent=${agent}:sid=${sid}:file=${file}:from=${from}:to=${to}`;
  if (asNonEmptyString(params.parentSessionFile)) {
    ref += `:parent=${basename(params.parentSessionFile)}`;
  }
  return ref;
}

/**
 * Prefer sqlite-era store when sessionFile is not a real JSONL path.
 *
 * @param {object} params
 * @returns {'sqlite' | 'jsonl' | 'unknown'}
 */
export function preferTranscriptKind(params) {
  const p = asRecord(params);
  const storage = asRecord(asRecord(p.runtimeContext).transcriptStorage);
  if (storage.kind === "sqlite") {
    return "sqlite";
  }
  const kind = classifySessionFile(p.sessionFile);
  if (kind === "session-key" || kind === "sqlite-marker") {
    return "sqlite";
  }
  if (kind === "jsonl") {
    const path = String(p.sessionFile).trim();
    if (path.endsWith(".jsonl") || isAbsolute(path)) {
      return "jsonl";
    }
  }
  if (resolveSessionTranscriptTargetFromParams(params)) {
    return "sqlite";
  }
  return kind === "jsonl" ? "jsonl" : "unknown";
}
