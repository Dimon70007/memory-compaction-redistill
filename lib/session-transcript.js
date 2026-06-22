import { readFile } from "node:fs/promises";

/**
 * @typedef {object} CompactionRecord
 * @property {string} summary
 * @property {number} tokensBefore
 * @property {string} firstKeptEntryId
 * @property {string} timestamp
 */

/**
 * @param {string} sessionFile
 * @returns {Promise<CompactionRecord | null>}
 */
export async function readLatestCompaction(sessionFile) {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return null;
  }
  const raw = await readFile(trimmed, "utf8");
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.type !== "compaction" || typeof entry.summary !== "string") {
        continue;
      }
      return {
        summary: entry.summary,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
        firstKeptEntryId:
          typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : "",
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * @param {string} sessionFile
 * @returns {Promise<string | null>}
 */
export async function readSessionHeaderParent(sessionFile) {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return null;
  }
  const raw = await readFile(trimmed, "utf8");
  const firstLine = raw.split(/\r?\n/u).find((line) => line.trim().length > 0);
  if (!firstLine) {
    return null;
  }
  try {
    const header = JSON.parse(firstLine);
    if (header?.type !== "session") {
      return null;
    }
    return typeof header.parentSession === "string" ? header.parentSession : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} sessionFile
 * @param {string | null | undefined} parentSession
 * @returns {string}
 */
export function resolveArchiveTranscriptPath(sessionFile, parentSession) {
  const parent = typeof parentSession === "string" ? parentSession.trim() : "";
  if (parent.length > 0) {
    return parent;
  }
  return typeof sessionFile === "string" ? sessionFile.trim() : "";
}
