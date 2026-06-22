import { formatMessagesForPrompt } from "./messages.js";
import { completeText } from "./llm.js";

const PREVIOUS_SUMMARY_PREFIX =
  "Previous compaction summary to re-distill with the new conversation. Drop stale, duplicate, and superseded hypotheses. Prefer the latest explicit user decision over older assistant proposals.";

const REQUIRED_SECTIONS = [
  "## Previous decisions (carried forward)",
  "## Current decisions",
  "## Superseded / rejected",
  "## Open hypotheses (unconfirmed)",
  "## Open TODOs",
  "## Pending user asks",
  "## Session archive",
];

/**
 * @param {string | undefined} customInstructions
 * @param {string | undefined} previousSummary
 * @returns {string}
 */
function buildSystemPrompt(customInstructions, previousSummary) {
  const base = [
    "You maintain rolling session context for a coding agent.",
    "CRITICAL RULE: If <previous-compaction-summary> is provided, you MUST analyze it FIRST.",
    "Extract ALL decisions, TODOs, constraints, and pending asks from the previous summary.",
    "Then merge with new conversation, preserving ALL previous decisions unless explicitly superseded.",
    "If previous summary has decisions, your output MUST include them under '## Previous decisions (carried forward)' (updated if changed).",
    "Never drop previous decisions silently — only move to '## Superseded / rejected' with explanation.",
    "Treat earlier assistant suggestions as hypotheses until the user confirms them.",
    "When the user reverses direction, move the old choice to Superseded / rejected and keep only the current choice under Current decisions.",
    "Do not preserve tool noise, raw logs, or duplicate facts.",
    "Use exactly these markdown section headings:",
    ...REQUIRED_SECTIONS.map((heading) => `- ${heading}`),
    "Under ## Session archive, write one line: Transcript file: <path if provided in user prompt, else unknown>.",
    "Be concise but preserve identifiers, file paths, and explicit user constraints.",
  ].join("\n");
  const extra = customInstructions?.trim();
  let prompt = extra ? `${base}\n\nOperator instructions:\n${extra}` : base;
  // Дублируем ключевые факты из previousSummary в system prompt для надёжности
  const prev = previousSummary?.trim();
  if (prev) {
    // Извлекаем только секции с решениями и TODOs (компактно)
    const prevLines = prev.split("\n");
    const keyLines = [];
    let inKeySection = false;
    for (const line of prevLines) {
      if (/^##\s+(Previous decisions|Current decisions|Open TODOs|Pending user asks|Superseded)/i.test(line)) {
        inKeySection = true;
        keyLines.push(line);
        continue;
      }
      if (/^##\s+/.test(line) && !inKeySection) continue;
      if (inKeySection && line.trim()) keyLines.push(line);
      if (keyLines.length > 60) break; // Лимит для размера system prompt
    }
    if (keyLines.length > 0) {
      prompt += "\n\n=== ACTIVE PREVIOUS DECISIONS (MUST be carried forward) ===\n";
      prompt += keyLines.join("\n");
      prompt += "\n=== END PREVIOUS DECISIONS ===";
    }
  }
  return prompt;
}

/**
 * @param {import("./llm.js").LlmResolvedConfig} llmConfig
 * @returns {{ id: string; label: string; summarize: (params: {
 *   messages: unknown[];
 *   signal?: AbortSignal;
 *   customInstructions?: string;
 *   previousSummary?: string;
 *   summarizationInstructions?: { identifierPolicy?: string };
 * }) => Promise<string> }}
 */
export function createCompactionProvider(llmConfig) {
  return {
    id: "memory-compaction-redistill",
    label: "Memory compaction redistill (previous summary + history)",
    async summarize(params) {
      const conversation = formatMessagesForPrompt(params.messages ?? []);
      const previousSummary = params.previousSummary?.trim() ?? "";
      const transcriptHintMatch = params.customInstructions?.match(
        /transcript file:\s*(\S+)/iu,
      );
      const archivePath = transcriptHintMatch?.[1] ?? "unknown";
      const userParts = [];
      if (previousSummary) {
        userParts.push(
          `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_PREFIX}\n\n${previousSummary}\n</previous-compaction-summary>`,
        );
      }
      userParts.push(
        `<conversation-to-summarize>\n${conversation || "(no new messages)"}\n</conversation-to-summarize>`,
      );
      userParts.push(`Archive transcript path hint: ${archivePath}`);
      const summary = await completeText(llmConfig, {
        system: buildSystemPrompt(params.customInstructions, previousSummary),
        user: userParts.join("\n\n"),
        signal: params.signal,
      });
      return capSummary(summary, 16000);
    },
  };
}

/**
 * @param {string} summary
 * @param {number} maxChars
 * @returns {string}
 */
function capSummary(summary, maxChars) {
  if (summary.length <= maxChars) {
    return summary;
  }
  return `${summary.slice(0, maxChars - 48).trimEnd()}\n\n[Compaction summary truncated to fit budget]`;
}
