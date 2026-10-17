/**
 * OpenClaw JSONL transcript apply helpers (TASK-047 Iteration A).
 *
 * Ports/adapts SessionManager.appendCompaction semantics + tool-safe cut selection
 * without requiring a live gateway SessionManager in tests.
 */
import { appendFile, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True when value looks like a filesystem transcript path (not a sessionKey).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFilesystemTranscriptPath(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("agent:")) {
    return false;
  }
  // sessionKey-shaped: colons, no path separators, not a .jsonl basename
  if (trimmed.includes(":") && !trimmed.includes("/") && !trimmed.includes("\\")) {
    return false;
  }
  return (
    isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.endsWith(".jsonl") ||
    trimmed.startsWith(".")
  );
}

/**
 * Opaque OpenClaw jsonl locator embedded in compaction summaries.
 *
 * @param {{
 *   agentId: string;
 *   sessionId: string;
 *   sessionFile: string;
 *   fromEntryId: string;
 *   toEntryId: string;
 *   parentSessionFile?: string | null;
 * }} params
 * @returns {string}
 */
export function buildOcJsonlRef(params) {
  const agent = String(params.agentId || "main").trim() || "main";
  const sid = String(params.sessionId || "").trim() || "unknown";
  const file = basename(params.sessionFile);
  const from = String(params.fromEntryId || "").trim();
  const to = String(params.toEntryId || "").trim();
  let ref = `oc:jsonl:v1:agent=${agent}:sid=${sid}:file=${file}:from=${from}:to=${to}`;
  if (isNonEmptyString(params.parentSessionFile)) {
    ref += `:parent=${basename(params.parentSessionFile)}`;
  }
  return ref;
}

/**
 * @param {string} raw
 * @param {{ strict?: boolean }} [options]
 * @returns {object[]}
 */
export function parseTranscriptLines(raw, options = {}) {
  const strict = options.strict === true;
  const entries = [];
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/u)) {
    lineNo += 1;
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object") {
        entries.push(entry);
      } else if (strict) {
        throw new Error(`corrupt_jsonl_line:${lineNo}: not an object`);
      }
    } catch (err) {
      if (strict) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("corrupt_jsonl_line:")) {
          throw err;
        }
        throw new Error(`corrupt_jsonl_line:${lineNo}: ${message}`);
      }
      /* skip corrupt lines in non-strict mode */
    }
  }
  return entries;
}

/**
 * @param {object} entry
 * @returns {object | undefined}
 */
function messageFromEntry(entry) {
  if (!entry || entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return undefined;
  }
  return entry.message;
}

/**
 * Rough token estimate for a transcript message entry (~4 chars/token).
 *
 * @param {object} entry
 * @returns {number}
 */
export function estimateEntryTokens(entry) {
  const message = messageFromEntry(entry);
  if (!message) {
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
 * @param {object} message
 * @returns {boolean}
 */
function isCutPointMessage(message) {
  const role = message?.role;
  if (role === "assistant" || role === "toolResult") {
    return false;
  }
  return role === "user" || role === "system" || role === "bashExecution";
}

/**
 * @param {object} message
 * @returns {string[]}
 */
function extractToolCallIds(message) {
  if (!Array.isArray(message?.content)) {
    return [];
  }
  const ids = [];
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block.type === "toolCall" || block.type === "toolUse" || block.type === "functionCall") &&
      typeof block.id === "string" &&
      block.id
    ) {
      ids.push(block.id);
    }
  }
  return ids;
}

/**
 * @param {object} message
 * @returns {string | null}
 */
function extractToolResultId(message) {
  if (message?.role !== "toolResult") {
    return null;
  }
  for (const key of ["toolCallId", "toolUseId", "tool_call_id", "tool_use_id", "callId", "call_id"]) {
    const value = message[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Choose firstKeptEntryId that preserves toolCall/toolResult pairing
 * (adapted from OpenClaw findCutPoint + pairing rules).
 *
 * @param {object[]} entries
 * @param {{ keepRecentTokens?: number; estimateTokens?: (entry: object) => number }} [options]
 * @returns {string | null}
 */
export function selectToolSafeFirstKeptEntryId(entries, options = {}) {
  const estimate = options.estimateTokens ?? estimateEntryTokens;
  const keepRecentTokens =
    typeof options.keepRecentTokens === "number" && options.keepRecentTokens > 0
      ? options.keepRecentTokens
      : 20_000;

  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === "compaction" || entries[i]?.type === "reset") {
      startIndex = i + 1;
      break;
    }
  }
  const endIndex = entries.length;
  if (startIndex >= endIndex) {
    return null;
  }

  /** @type {number | undefined} */
  let cutIndex;
  for (let i = startIndex; i < endIndex; i += 1) {
    const message = messageFromEntry(entries[i]);
    if (message && isCutPointMessage(message)) {
      cutIndex = i;
    }
  }
  if (cutIndex === undefined) {
    const firstMessage = entries.slice(startIndex).find((e) => e.type === "message" && e.id);
    return firstMessage?.id ?? null;
  }

  let accumulated = 0;
  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const message = messageFromEntry(entry);
    if (!message) {
      continue;
    }
    if (isCutPointMessage(message)) {
      cutIndex = i;
    }
    accumulated += estimate(entry);
    if (accumulated >= keepRecentTokens) {
      break;
    }
  }

  // Walk back so we never start on a toolResult (orphan) or mid tool pair.
  while (cutIndex > startIndex) {
    const entry = entries[cutIndex];
    const message = messageFromEntry(entry);
    if (!message) {
      cutIndex -= 1;
      continue;
    }
    if (message.role === "toolResult") {
      const toolId = extractToolResultId(message);
      let foundAssistant = false;
      for (let j = cutIndex - 1; j >= startIndex; j -= 1) {
        const prev = messageFromEntry(entries[j]);
        if (!prev) {
          continue;
        }
        if (prev.role === "assistant" && (!toolId || extractToolCallIds(prev).includes(toolId))) {
          cutIndex = j;
          foundAssistant = true;
          break;
        }
        if (prev.role === "user") {
          cutIndex = j;
          foundAssistant = true;
          break;
        }
      }
      if (!foundAssistant) {
        cutIndex = startIndex;
      }
      continue;
    }
    if (message.role === "assistant") {
      // Prefer turn-start user message when present.
      for (let j = cutIndex - 1; j >= startIndex; j -= 1) {
        const prev = messageFromEntry(entries[j]);
        if (prev?.role === "user") {
          cutIndex = j;
          break;
        }
        if (prev?.role === "assistant" || prev?.role === "toolResult") {
          continue;
        }
        break;
      }
    }
    break;
  }

  // Ensure every toolResult in the kept window has its toolCall also kept.
  for (;;) {
    const kept = entries.slice(cutIndex, endIndex);
    const pending = new Set();
    let needsMove = false;
    for (const entry of kept) {
      const message = messageFromEntry(entry);
      if (!message) {
        continue;
      }
      if (message.role === "assistant") {
        for (const id of extractToolCallIds(message)) {
          pending.add(id);
        }
      } else if (message.role === "toolResult") {
        const id = extractToolResultId(message);
        if (id && !pending.has(id)) {
          needsMove = true;
          break;
        }
        if (id) {
          pending.delete(id);
        }
      }
    }
    if (!needsMove || cutIndex <= startIndex) {
      break;
    }
    cutIndex -= 1;
  }

  const cutEntry = entries[cutIndex];
  return typeof cutEntry?.id === "string" ? cutEntry.id : null;
}

/**
 * @param {object[]} entries
 * @returns {{ messages: object[]; messageEntries: object[]; header: object | null; lastEntryId: string | null }}
 */
export function extractActiveMessages(entries) {
  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === "compaction" || entries[i]?.type === "reset") {
      startIndex = i + 1;
      break;
    }
  }
  const messageEntries = [];
  const messages = [];
  for (let i = startIndex; i < entries.length; i += 1) {
    const entry = entries[i];
    const message = messageFromEntry(entry);
    if (!message) {
      continue;
    }
    messageEntries.push(entry);
    messages.push(message);
  }
  const header = entries.find((e) => e?.type === "session") ?? null;
  let lastEntryId = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (typeof entries[i]?.id === "string") {
      lastEntryId = entries[i].id;
      break;
    }
  }
  return { messages, messageEntries, header, lastEntryId };
}

/**
 * @param {string} sessionFile
 * @param {{ strict?: boolean }} [options] When `strict: true`, any corrupt JSONL line throws.
 * @returns {Promise<{ entries: object[]; raw: string }>}
 */
export async function loadTranscript(sessionFile, options = {}) {
  const raw = await readFile(sessionFile, "utf8");
  return { entries: parseTranscriptLines(raw, options), raw };
}

/**
 * Append a type:compaction entry (SessionManager.appendCompaction shape).
 *
 * @param {{
 *   sessionFile: string;
 *   summary: string;
 *   firstKeptEntryId: string;
 *   tokensBefore: number;
 *   tokensAfter?: number;
 *   details?: unknown;
 *   fromHook?: boolean;
 * }} params
 * @returns {Promise<{ ok: true; entry: object; entryId: string }>}
 */
export async function appendCompactionToJsonl(params) {
  const sessionFile = params.sessionFile.trim();
  if (!isFilesystemTranscriptPath(sessionFile)) {
    throw new Error("appendCompaction: sessionFile is not a filesystem path");
  }
  if (!isNonEmptyString(params.summary)) {
    throw new Error("appendCompaction: summary required");
  }
  if (!isNonEmptyString(params.firstKeptEntryId)) {
    throw new Error("appendCompaction: firstKeptEntryId required");
  }

  const { entries } = await loadTranscript(sessionFile);
  let parentId = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (typeof entries[i]?.id === "string") {
      parentId = entries[i].id;
      break;
    }
  }

  const entry = {
    type: "compaction",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    summary: params.summary,
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: params.tokensBefore,
    ...(params.tokensAfter !== undefined ? { tokensAfter: params.tokensAfter } : {}),
    ...(params.details !== undefined ? { details: params.details } : {}),
    ...(params.fromHook !== undefined ? { fromHook: params.fromHook } : {}),
  };

  await appendFile(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  return { ok: true, entry, entryId: entry.id };
}

/**
 * Create OpenClaw-style successor transcript with parentSession header.
 *
 * @param {{
 *   sessionFile: string;
 *   agentId?: string;
 *   compactionEntry: object;
 *   firstKeptEntryId: string;
 *   successorSessionId?: string;
 *   successorSessionFile?: string;
 * }} params
 * @returns {Promise<{ sessionId: string; sessionFile: string }>}
 */
export async function rotateSuccessorTranscript(params) {
  const oldPath = params.sessionFile.trim();
  if (!isFilesystemTranscriptPath(oldPath)) {
    throw new Error("rotateSuccessor: sessionFile is not a filesystem path");
  }
  const { entries } = await loadTranscript(oldPath);
  const firstKeptIndex = entries.findIndex((e) => e.id === params.firstKeptEntryId);
  if (firstKeptIndex < 0) {
    throw new Error("rotateSuccessor: firstKeptEntryId not found in transcript");
  }

  const oldHeader = entries.find((e) => e?.type === "session") ?? {};
  const successorSessionId = params.successorSessionId ?? randomUUID();
  const successorSessionFile =
    params.successorSessionFile ?? join(dirname(oldPath), `${successorSessionId}.jsonl`);

  const header = {
    type: "session",
    version: typeof oldHeader.version === "number" ? oldHeader.version : 2,
    id: successorSessionId,
    timestamp: new Date().toISOString(),
    cwd: typeof oldHeader.cwd === "string" ? oldHeader.cwd : process.cwd(),
    parentSession: oldPath,
  };

  const kept = entries.slice(firstKeptIndex).filter((e) => e?.type !== "session");
  const compaction = { ...params.compactionEntry, parentId: header.id };
  const lines = [header, compaction, ...kept.filter((e) => e.id !== compaction.id)];

  await mkdir(dirname(successorSessionFile), { recursive: true });
  await writeFile(successorSessionFile, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return { sessionId: successorSessionId, sessionFile: successorSessionFile };
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseByteSize(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/u);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  const mult =
    unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(amount * mult);
}

/**
 * @param {string} sessionFile
 * @returns {Promise<number>}
 */
export async function transcriptByteSize(sessionFile) {
  const info = await stat(sessionFile);
  return info.size;
}

/**
 * Embed ref footer into summary once.
 *
 * @param {string} summary
 * @param {string} ref
 * @returns {string}
 */
export function embedRefInSummary(summary, ref) {
  const trimmed = summary.trim();
  if (trimmed.includes("oc:jsonl:v1:")) {
    return trimmed;
  }
  return `${trimmed}\n\n<!-- history-ref ${ref} -->\n${ref}`;
}
