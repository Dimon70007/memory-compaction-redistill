import { dirname, join, basename } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { readLatestCompaction, readSessionHeaderParent } from "./session-transcript.js";

/**
 * Rough chat-token estimate (~4 chars/token). Used by context-engine assemble.
 *
 * @param {unknown[]} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }
  let chars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = /** @type {{ content?: unknown }} */ (message).content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && typeof /** @type {{ text?: unknown }} */ (part).text === "string") {
          chars += /** @type {{ text: string }} */ (part).text.length;
        }
      }
    }
  }
  return Math.max(0, Math.ceil(chars / 4));
}

/**
 * @param {string} sessionKey
 * @returns {string[]}
 */
function sessionKeyTokens(sessionKey) {
  return sessionKey
    .split(/[^a-zA-Z0-9]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/**
 * True when a transcript filename plausibly belongs to this sessionKey.
 *
 * @param {string} filePath
 * @param {string} sessionKey
 * @returns {boolean}
 */
export function sessionFileMatchesKey(filePath, sessionKey) {
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  const base = basename(filePath).toLowerCase();
  const tokens = sessionKeyTokens(key);
  if (tokens.length === 0) {
    return false;
  }
  // Require the most specific trailing token (often chat/user id) plus agent-ish prefix.
  const trailing = tokens[tokens.length - 1].toLowerCase();
  if (!base.includes(trailing)) {
    return false;
  }
  const hits = tokens.filter((t) => base.includes(t.toLowerCase())).length;
  return hits >= Math.min(2, tokens.length);
}

/**
 * @typedef {object} SessionRecoveryOptions
 * @property {string} [homeDir]
 */

/**
 * Session-scoped T047 previousSummary recovery (avoids cross-chat contamination).
 *
 * @param {SessionRecoveryOptions} [options]
 */
export function createSessionRecoveryStore(options = {}) {
  /** @type {Map<string, string>} */
  const lastFileBySessionKey = new Map();
  const homeDir = options.homeDir ?? process.env.HOME ?? "";

  /**
   * @param {string} sessionKey
   * @param {string} sessionFile
   */
  function remember(sessionKey, sessionFile) {
    const key = sessionKey.trim();
    const file = sessionFile.trim();
    if (!key || !file) {
      return;
    }
    lastFileBySessionKey.set(key, file);
  }

  /**
   * @param {string} sessionsDir
   * @param {string} sessionKey
   * @returns {Promise<string | null>}
   */
  async function findLatestCompactedSessionFile(sessionsDir, sessionKey) {
    try {
      const entries = await readdir(sessionsDir);
      const jsonlFiles = entries
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
        .map((f) => join(sessionsDir, f))
        .filter((f) => sessionFileMatchesKey(f, sessionKey));
      const withMtime = await Promise.all(
        jsonlFiles.map(async (f) => {
          const s = await stat(f).catch(() => null);
          return s ? { file: f, mtime: s.mtimeMs } : null;
        }),
      );
      const valid = withMtime.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      for (const entry of valid) {
        if (!entry) continue;
        const record = await readLatestCompaction(entry.file);
        if (record?.summary) {
          return entry.file;
        }
      }
    } catch {
      // directory may not exist
    }
    return null;
  }

  /**
   * @param {object} params
   * @param {string} [params.sessionKey]
   * @param {string} [params.agentId]
   * @param {string} [params.hintSessionFile]
   * @returns {Promise<string | null>}
   */
  async function recover(params) {
    const sessionKey = (params.sessionKey ?? "").trim();
    const agentId = (params.agentId ?? "main").trim() || "main";
    const hint = (params.hintSessionFile ?? "").trim();

    const candidates = [];
    if (sessionKey && lastFileBySessionKey.has(sessionKey)) {
      candidates.push(lastFileBySessionKey.get(sessionKey));
    }

    for (const file of candidates) {
      if (!file) continue;
      try {
        let record = await readLatestCompaction(file);
        if (!record?.summary) {
          const parent = await readSessionHeaderParent(file);
          if (parent) {
            record = await readLatestCompaction(parent);
          }
        }
        if (record?.summary) {
          return record.summary;
        }
      } catch {
        // try scan
      }
    }

    if (!sessionKey) {
      return null;
    }

    const sessionsDir = hint
      ? dirname(hint)
      : join(homeDir, ".openclaw", "agents", agentId, "sessions");
    const fallbackFile = await findLatestCompactedSessionFile(sessionsDir, sessionKey);
    if (fallbackFile) {
      const record = await readLatestCompaction(fallbackFile);
      if (record?.summary) {
        return record.summary;
      }
    }
    return null;
  }

  return { remember, recover };
}
