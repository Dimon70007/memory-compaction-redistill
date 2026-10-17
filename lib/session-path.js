/**
 * Resolve OpenClaw transcript filesystem path for compact/apply.
 *
 * Port of OpenClaw host logic (2026.6.11 study tree):
 * - `resolveSessionFilePathOptions` / `resolveSessionFilePath`
 *   (`src/config/sessions/paths.ts`)
 * - `resolveSessionTranscriptCandidates` + first existing
 *   (`src/gateway/session-transcript-files.fs.ts`, `sessions.compact`)
 *
 * Host normally resolves before calling ContextEngine.compact. When overflow/UI
 * pass sessionKey-shaped sessionFile or only storePath + ids, mirror the same
 * formula: exact sessions.json[sessionKey] → entry → `${sessionsDir}/${sessionId}.jsonl`.
 * Never treat storePath (sessions.json) as a transcript.
 */
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
 * Map storePath → sessions directory (OpenClaw: dirname(storePath) when store is sessions.json).
 *
 * @param {string} storePath
 * @returns {Promise<string | null>}
 */
export async function sessionsDirFromStorePath(storePath) {
  const trimmed = storePath.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = resolve(trimmed);
  const base = basename(resolved).toLowerCase();
  if (base === "sessions.json") {
    return dirname(resolved);
  }
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return resolved;
    }
  } catch {
    // fall through
  }
  if (base === "sessions") {
    return resolved;
  }
  return null;
}

/**
 * OpenClaw `resolveSessionTranscriptPathInDir` (no topicId — plugin compact path).
 *
 * @param {string} sessionId
 * @param {string} sessionsDir
 * @returns {string}
 */
export function resolveSessionTranscriptPathInDir(sessionId, sessionsDir) {
  return join(resolve(sessionsDir), `${sessionId.trim()}.jsonl`);
}

/**
 * OpenClaw `resolveSessionFilePath` — prefer entry.sessionFile under sessionsDir, else sessionId.jsonl.
 * Does not check existence (host/candidates layer does).
 *
 * @param {string} sessionId
 * @param {{ sessionFile?: string | null } | null | undefined} entry
 * @param {{ sessionsDir: string }} opts
 * @returns {string}
 */
export function resolveSessionFilePath(sessionId, entry, opts) {
  const sessionsDir = resolve(opts.sessionsDir);
  const candidate = asNonEmptyString(entry?.sessionFile);
  if (candidate) {
    if (isTranscriptJsonlPath(candidate)) {
      if (isAbsolute(candidate)) {
        return resolve(candidate);
      }
      return join(sessionsDir, candidate);
    }
    if (candidate.endsWith(".jsonl") && !candidate.includes("/") && !candidate.includes("\\")) {
      return join(sessionsDir, candidate);
    }
  }
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

/**
 * @param {string} sessionsDir
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function loadSessionsIndex(sessionsDir) {
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
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Exact-key store lookup (OpenClaw: sessions.json[sessionKey] → SessionEntry).
 *
 * @param {string} sessionsDir
 * @param {string} sessionKey
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function lookupSessionEntryFromIndex(sessionsDir, sessionKey) {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  const parsed = await loadSessionsIndex(sessionsDir);
  if (!parsed) {
    return null;
  }
  const entry = asRecord(parsed[key]);
  if (Object.keys(entry).length === 0) {
    return null;
  }
  return entry;
}

/**
 * Build candidate transcript paths like OpenClaw `resolveSessionTranscriptCandidates`
 * (store dir + agent default dir; entry.sessionFile then sessionId.jsonl).
 *
 * @param {{
 *   sessionId?: string | null;
 *   sessionKey?: string | null;
 *   entry?: Record<string, unknown> | null;
 *   sessionsDirs: string[];
 * }} params
 * @returns {string[]}
 */
export function buildTranscriptCandidates(params) {
  /** @type {string[]} */
  const candidates = [];
  const push = (path) => {
    const p = asNonEmptyString(path);
    if (p && isTranscriptJsonlPath(p) && !candidates.includes(p)) {
      candidates.push(p);
    }
  };

  const sessionId =
    asNonEmptyString(params.sessionId) ||
    asNonEmptyString(params.entry?.sessionId) ||
    asNonEmptyString(params.entry?.id) ||
    null;

  for (const sessionsDir of params.sessionsDirs) {
    const entry = params.entry;
    if (sessionId) {
      push(resolveSessionFilePath(sessionId, entry, { sessionsDir }));
      push(resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
    } else if (entry && asNonEmptyString(entry.sessionFile)) {
      // Rare: entry has sessionFile but no sessionId
      const sid = "unknown";
      try {
        push(resolveSessionFilePath(sid, entry, { sessionsDir }));
      } catch {
        // ignore
      }
    }
  }

  return candidates;
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
  const explicitTranscripts = [];
  /** @type {string[]} */
  const storeHints = [];

  const pushExplicit = (value, from) => {
    const raw = asNonEmptyString(value);
    if (raw && isTranscriptJsonlPath(raw)) {
      explicitTranscripts.push({ path: raw.trim(), from });
    }
  };
  const pushStoreHint = (value) => {
    const raw = asNonEmptyString(value);
    if (!raw) {
      return;
    }
    if (!isTranscriptJsonlPath(raw) && isFilesystemTranscriptPath(raw)) {
      storeHints.push(raw.trim());
    }
  };

  pushExplicit(params?.sessionFile, "params.sessionFile");
  pushExplicit(sessionTarget.sessionFile, "params.sessionTarget.sessionFile");
  pushExplicit(runtimeContext.sessionFile, "runtimeContext.sessionFile");
  pushExplicit(runtimeContext.transcriptPath, "runtimeContext.transcriptPath");

  pushStoreHint(sessionTarget.storePath);
  pushStoreHint(runtimeContext.storePath);
  pushStoreHint(params?.sessionFile);

  for (const candidate of explicitTranscripts) {
    if (await pathExists(candidate.path)) {
      return { sessionFile: candidate.path, resolvedFrom: candidate.from };
    }
  }
  if (explicitTranscripts.length > 0) {
    return {
      sessionFile: explicitTranscripts[0].path,
      resolvedFrom: explicitTranscripts[0].from,
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

  let sessionId =
    asNonEmptyString(params?.sessionId) ||
    asNonEmptyString(sessionTarget.sessionId) ||
    asNonEmptyString(sessionTarget.id) ||
    asNonEmptyString(runtimeContext.sessionId) ||
    null;

  /** @type {Record<string, unknown> | null} */
  let entry = null;
  if (sessionKeyRaw) {
    for (const sessionsDir of sessionsDirs) {
      entry = await lookupSessionEntryFromIndex(sessionsDir, sessionKeyRaw);
      if (entry) {
        const entrySid = asNonEmptyString(entry.sessionId) ?? asNonEmptyString(entry.id);
        if (entrySid) {
          sessionId = entrySid;
        }
        break;
      }
    }
  }

  const candidates = buildTranscriptCandidates({
    sessionId,
    sessionKey: sessionKeyRaw,
    entry,
    sessionsDirs,
  });

  /** @type {string[]} */
  const tried = [];
  for (const path of candidates) {
    tried.push(path);
    if (await pathExists(path)) {
      return {
        sessionFile: path,
        resolvedFrom: entry ? "sessions.json" : "sessionId.jsonl",
      };
    }
  }

  const shaped = isSessionKeyShaped(params?.sessionFile)
    ? String(params.sessionFile).trim()
    : "";
  const storeNote = storeHints.length > 0 ? ` storeHints=${storeHints.join(",")}` : "";
  const idNote = ` sessionKey=${sessionKeyRaw ?? "∅"} sessionId=${sessionId ?? "∅"}`;
  const triedNote =
    tried.length > 0 ? ` tried=${tried.map((p) => `${p}(exists=false)`).join(",")}` : "";

  if (!sessionKeyRaw && !sessionId) {
    return {
      sessionFile: "",
      resolvedFrom: "unresolved",
      detail: `missing sessionKey/sessionId to resolve transcript under store${storeNote}`,
    };
  }
  return {
    sessionFile: "",
    resolvedFrom: "unresolved",
    detail: shaped
      ? `sessionKey-shaped sessionFile=${shaped} (no OpenClaw path hit for agent=${agentId})${storeNote}${idNote}${triedNote}`
      : `no filesystem transcript .jsonl (agent=${agentId})${storeNote}${idNote}${triedNote}`,
  };
}
