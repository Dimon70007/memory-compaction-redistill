import { formatMessagesForPrompt } from "./messages.js";
import { completeText } from "./llm.js";

const PREVIOUS_SUMMARY_PREFIX =
  "Previous compaction summary to re-distill with the new conversation. Drop stale, duplicate, and superseded hypotheses. Prefer the latest explicit user decision over older assistant proposals.";

const REQUIRED_SECTIONS = [
  "## Current decisions",
  "## Superseded / rejected",
  "## Open hypotheses (unconfirmed)",
  "## Open TODOs",
  "## Pending user asks",
  "## Session archive",
];

/**
 * @param {string | undefined} customInstructions
 * @returns {string}
 */
function buildSystemPrompt(customInstructions) {
  const base = [
    "You maintain rolling session context for a coding agent.",
    "Merge the previous compaction summary with newly summarized conversation text.",
    "Treat earlier assistant suggestions as hypotheses until the user confirms them.",
    "When the user reverses direction, move the old choice to Superseded / rejected and keep only the current choice under Current decisions.",
    "Do not preserve tool noise, raw logs, or duplicate facts.",
    "Use exactly these markdown section headings:",
    ...REQUIRED_SECTIONS.map((heading) => `- ${heading}`),
    "Under ## Session archive, write one line: Transcript file: <path if provided in user prompt, else unknown>.",
    "Be concise but preserve identifiers, file paths, and explicit user constraints.",
  ].join("\n");
  const extra = customInstructions?.trim();
  return extra ? `${base}\n\nOperator instructions:\n${extra}` : base;
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
        system: buildSystemPrompt(params.customInstructions),
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
