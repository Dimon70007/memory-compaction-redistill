/**
 * Active-window projection adapted from OpenClaw 2026.9.9 compaction semantics.
 * See ATTRIBUTION.md.
 */

/**
 * @param {object} message
 * @returns {number}
 */
function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") {
    return 0;
  }
  let chars = 0;
  const content = message.content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (typeof block.text === "string") {
        chars += block.text.length;
      }
      if (typeof block.name === "string") {
        chars += block.name.length;
      }
      if (block.arguments !== undefined) {
        try {
          chars += JSON.stringify(block.arguments).length;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Project model-visible active window from transcript entries.
 *
 * After the latest `compaction` / `reset` boundary: synthetic summary checkpoint
 * (if compaction has summary) + message entries from `firstKeptEntryId` onward.
 * Without a boundary: all message entries.
 *
 * @param {object[]} entries
 * @returns {{
 *   messages: object[];
 *   estimatedTokens: number;
 *   estimatedBytes: number;
 *   compactionSummary: string | null;
 *   firstKeptEntryId: string | null;
 * }}
 */
export function projectActiveWindow(entries) {
  /** @type {object[]} */
  const list = Array.isArray(entries) ? entries : [];

  let boundaryIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "compaction" || list[i]?.type === "reset") {
      boundaryIndex = i;
      break;
    }
  }

  /** @type {object[]} */
  const messages = [];
  /** @type {string | null} */
  let compactionSummary = null;
  /** @type {string | null} */
  let firstKeptEntryId = null;

  if (boundaryIndex >= 0) {
    const boundary = list[boundaryIndex];
    if (boundary?.type === "compaction" && typeof boundary.summary === "string") {
      compactionSummary = boundary.summary;
      messages.push({
        role: "user",
        content: boundary.summary,
      });
    }
    firstKeptEntryId =
      typeof boundary?.firstKeptEntryId === "string" ? boundary.firstKeptEntryId : null;

    let startIndex = boundaryIndex + 1;
    if (firstKeptEntryId) {
      const keptIdx = list.findIndex((e) => e?.id === firstKeptEntryId);
      if (keptIdx >= 0) {
        startIndex = keptIdx;
      }
    }

    for (let i = startIndex; i < list.length; i += 1) {
      const entry = list[i];
      if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") {
        continue;
      }
      messages.push(entry.message);
    }
  } else {
    for (const entry of list) {
      if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") {
        continue;
      }
      messages.push(entry.message);
    }
  }

  let estimatedTokens = 0;
  let estimatedBytes = 0;
  for (const message of messages) {
    estimatedTokens += estimateMessageTokens(message);
    try {
      estimatedBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      estimatedBytes += 0;
    }
  }

  return {
    messages,
    estimatedTokens,
    estimatedBytes,
    compactionSummary,
    firstKeptEntryId,
  };
}
