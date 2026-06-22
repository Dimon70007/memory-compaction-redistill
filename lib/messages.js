/**
 * @param {unknown} message
 * @returns {string}
 */
export function extractMessageText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = /** @type {{ content?: unknown; text?: unknown; summary?: unknown }} */ (message);
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (typeof record.summary === "string") {
    return record.summary.trim();
  }
  const content = record.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = /** @type {{ type?: string; text?: string }} */ (block);
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text.trim());
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

/**
 * @param {unknown[]} messages
 * @returns {string}
 */
export function formatMessagesForPrompt(messages) {
  const lines = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = /** @type {{ role?: string }} */ (message);
    const role = asRole(record.role);
    const text = extractMessageText(message);
    if (!text) {
      continue;
    }
    lines.push(`[${role}] ${text}`);
  }
  return lines.join("\n\n");
}

/**
 * @param {string | undefined} role
 * @returns {string}
 */
function asRole(role) {
  if (!role || role.trim().length === 0) {
    return "unknown";
  }
  return role.trim();
}
