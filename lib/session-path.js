/**
 * Resolve OpenClaw transcript filesystem path when host passes sessionKey-shaped
 * "sessionFile" (common on overflow / sessions.compact) or omits the path.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { asNonEmptyString } from "./env.js";
import { asRecord } from "./util.js";
import { isFilesystemTranscriptPath } from "./transcript-apply.js";

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
 * @param {string | null | undefined} sessionKey
 * @returns {string | null}
 */
export function agentIdFromSessionKey(sessionKey) {
  const key = asNonEmptyString(sessionKey);
  if (!key) {
    return null;
  }
  const parts = key.split(":");
  // agent:<agentId>:…
  if (parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  return null;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} sessionsDir
 * @param {string} sessionKey
 * @returns {Promise<string | null>}
 */
export async function lookupSessionFileFromIndex(sessionsDir, sessionKey) {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  const indexPath = join(sessionsDir, "sessions.json");
  let raw;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    return null;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entry = asRecord(/** @type {Record<string, unknown>} */ (parsed)[key]);
  if (Object.keys(entry).length === 0) {
    return null;
  }

  const direct = asNonEmptyString(entry.sessionFile) ?? asNonEmptyString(entry.storePath);
  if (direct && isFilesystemTranscriptPath(direct)) {
    return direct.trim();
  }

  const sessionId = asNonEmptyString(entry.sessionId) ?? asNonEmptyString(entry.id);
  if (sessionId) {
    const candidate = join(sessionsDir, `${sessionId}.jsonl`);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve a filesystem transcript path for compact/apply.
 *
 * @param {object} params Host compact params
 * @param {{ homeDir?: string }} [options]
 * @returns {Promise<{ sessionFile: string; resolvedFrom: string } | { sessionFile: ""; resolvedFrom: string; detail: string }>}
 */
export async function resolveFilesystemSessionFile(params, options = {}) {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const runtimeContext = asRecord(params?.runtimeContext);
  const sessionTarget = asRecord(params?.sessionTarget);

  /** @type {{ path: string; from: string }[]} */
  const candidates = [];
  const push = (value, from) => {
    const raw = asNonEmptyString(value);
    if (raw && isFilesystemTranscriptPath(raw)) {
      candidates.push({ path: raw.trim(), from });
    }
  };

  push(params?.sessionFile, "params.sessionFile");
  push(sessionTarget.storePath, "params.sessionTarget.storePath");
  push(runtimeContext.sessionFile, "runtimeContext.sessionFile");
  push(runtimeContext.transcriptPath, "runtimeContext.transcriptPath");
  push(runtimeContext.storePath, "runtimeContext.storePath");

  for (const candidate of candidates) {
    if (await pathExists(candidate.path)) {
      return { sessionFile: candidate.path, resolvedFrom: candidate.from };
    }
  }
  if (candidates.length > 0) {
    // Path declared but missing on disk — let caller surface read error.
    return { sessionFile: candidates[0].path, resolvedFrom: candidates[0].from };
  }

  const sessionKeyRaw =
    asNonEmptyString(params?.sessionKey) ||
    (isSessionKeyShaped(params?.sessionFile) ? asNonEmptyString(params.sessionFile) : null);

  const agentId =
    asNonEmptyString(params?.agentId) ||
    agentIdFromSessionKey(sessionKeyRaw) ||
    "main";
  const sessionsDir = join(homeDir, ".openclaw", "agents", agentId, "sessions");

  if (sessionKeyRaw) {
    const fromIndex = await lookupSessionFileFromIndex(sessionsDir, sessionKeyRaw);
    if (fromIndex) {
      return { sessionFile: fromIndex, resolvedFrom: "sessions.json" };
    }
  }

  const sessionId = asNonEmptyString(params?.sessionId);
  if (sessionId) {
    const byId = join(sessionsDir, `${sessionId}.jsonl`);
    if (await pathExists(byId)) {
      return { sessionFile: byId, resolvedFrom: "params.sessionId" };
    }
  }

  const shaped = isSessionKeyShaped(params?.sessionFile)
    ? String(params.sessionFile).trim()
    : "";
  return {
    sessionFile: "",
    resolvedFrom: "unresolved",
    detail: shaped
      ? `sessionKey-shaped sessionFile=${shaped} (no sessions.json hit for agent=${agentId})`
      : `no filesystem sessionFile/messages (agent=${agentId})`,
  };
}
