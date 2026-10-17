/**
 * Resolve OpenClaw transcript filesystem path when host passes sessionKey-shaped
 * "sessionFile" (common on overflow / sessions.compact) or omits the path.
 *
 * Important: `sessionTarget.storePath` / runtime store paths often point at the
 * **sessions store** (`…/sessions` or `…/sessions/sessions.json`), NOT a transcript.
 * Never load those as JSONL.
 */
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
 * True when path is an OpenClaw session transcript JSONL (not sessions.json / dirs).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTranscriptJsonlPath(value) {
  if (!isFilesystemTranscriptPath(value)) {
    return false;
  }
  const trimmed = String(value).trim();
  const base = basename(trimmed).toLowerCase();
  if (base === "sessions.json") {
    return false;
  }
  if (!base.endsWith(".jsonl")) {
    return false;
  }
  // Skip obvious non-transcript companions
  if (base.includes(".trajectory") || base.includes(".reset.")) {
    return false;
  }
  return true;
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
 * Map storePath → sessions directory (handles …/sessions.json and …/sessions).
 *
 * @param {string} storePath
 * @returns {Promise<string | null>}
 */
export async function sessionsDirFromStorePath(storePath) {
  const trimmed = storePath.trim();
  if (!trimmed) {
    return null;
  }
  const base = basename(trimmed).toLowerCase();
  if (base === "sessions.json") {
    return dirname(trimmed);
  }
  try {
    const info = await stat(trimmed);
    if (info.isDirectory()) {
      return trimmed;
    }
  } catch {
    // fall through
  }
  // If path looks like a sessions dir name even when missing
  if (base === "sessions") {
    return trimmed;
  }
  return null;
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

  const direct = asNonEmptyString(entry.sessionFile) ?? asNonEmptyString(entry.transcriptPath);
  if (direct && isTranscriptJsonlPath(direct)) {
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
  const transcriptCandidates = [];
  /** @type {string[]} */
  const storeHints = [];

  const pushTranscript = (value, from) => {
    const raw = asNonEmptyString(value);
    if (raw && isTranscriptJsonlPath(raw)) {
      transcriptCandidates.push({ path: raw.trim(), from });
    }
  };
  const pushStoreHint = (value) => {
    const raw = asNonEmptyString(value);
    if (!raw) {
      return;
    }
    // sessions.json / sessions dir / any non-jsonl store path
    if (!isTranscriptJsonlPath(raw) && isFilesystemTranscriptPath(raw)) {
      storeHints.push(raw.trim());
    }
  };

  pushTranscript(params?.sessionFile, "params.sessionFile");
  pushTranscript(sessionTarget.sessionFile, "params.sessionTarget.sessionFile");
  pushTranscript(runtimeContext.sessionFile, "runtimeContext.sessionFile");
  pushTranscript(runtimeContext.transcriptPath, "runtimeContext.transcriptPath");

  // storePath is usually the sessions store — never treat as transcript JSONL.
  pushStoreHint(sessionTarget.storePath);
  pushStoreHint(runtimeContext.storePath);
  pushStoreHint(params?.sessionFile); // if somehow a path to sessions.json

  for (const candidate of transcriptCandidates) {
    if (await pathExists(candidate.path)) {
      return { sessionFile: candidate.path, resolvedFrom: candidate.from };
    }
  }
  if (transcriptCandidates.length > 0) {
    return {
      sessionFile: transcriptCandidates[0].path,
      resolvedFrom: transcriptCandidates[0].from,
    };
  }

  const sessionKeyRaw =
    asNonEmptyString(params?.sessionKey) ||
    (isSessionKeyShaped(params?.sessionFile) ? asNonEmptyString(params.sessionFile) : null) ||
    asNonEmptyString(sessionTarget.sessionKey);

  const agentId =
    asNonEmptyString(params?.agentId) ||
    asNonEmptyString(sessionTarget.agentId) ||
    agentIdFromSessionKey(sessionKeyRaw) ||
    "main";

  /** @type {string[]} */
  const sessionsDirs = [];
  for (const hint of storeHints) {
    const dir = await sessionsDirFromStorePath(hint);
    if (dir && !sessionsDirs.includes(dir)) {
      sessionsDirs.push(dir);
    }
  }
  const defaultDir = join(homeDir, ".openclaw", "agents", agentId, "sessions");
  if (!sessionsDirs.includes(defaultDir)) {
    sessionsDirs.push(defaultDir);
  }

  const sessionId =
    asNonEmptyString(params?.sessionId) ||
    asNonEmptyString(sessionTarget.sessionId) ||
    null;

  for (const sessionsDir of sessionsDirs) {
    if (sessionKeyRaw) {
      const fromIndex = await lookupSessionFileFromIndex(sessionsDir, sessionKeyRaw);
      if (fromIndex) {
        return { sessionFile: fromIndex, resolvedFrom: "sessions.json" };
      }
    }
    if (sessionId) {
      const byId = join(sessionsDir, `${sessionId}.jsonl`);
      if (await pathExists(byId)) {
        return { sessionFile: byId, resolvedFrom: "sessionId+store" };
      }
    }
  }

  const shaped = isSessionKeyShaped(params?.sessionFile)
    ? String(params.sessionFile).trim()
    : "";
  const storeNote = storeHints.length > 0 ? ` storeHints=${storeHints.join(",")}` : "";
  return {
    sessionFile: "",
    resolvedFrom: "unresolved",
    detail: shaped
      ? `sessionKey-shaped sessionFile=${shaped} (no sessions.json hit for agent=${agentId})${storeNote}`
      : `no filesystem transcript .jsonl (agent=${agentId})${storeNote}`,
  };
}
