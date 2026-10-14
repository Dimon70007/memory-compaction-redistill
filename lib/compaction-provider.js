import { formatMessagesForPrompt } from "./messages.js";
import { completeText } from "./llm.js";
import { runCompactWithStaging } from "./multi-pass-compact.js";

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

const FORBIDDEN_SECTIONS = [
  "## Goal",
  "## Summary",
  "## Overview",
  "## Context",
  "## Conversation Summary",
];

// ============================================================================
// FEW-SHOT EXAMPLES FOR COMPACTION QUALITY
// ============================================================================

const GOOD_COMPACTION_EXAMPLE = `## Previous decisions (carried forward)

- **D-01** \`truncateAfterCompaction: false\` — **Config** | 2026-09-26 | ✅ Accepted
  - *Why:* Cron job \`91838730\` wiped session daily at 6 AM (\`truncateAfterCompaction: true\` + T031 bug)
  - *Refs:* \`agents.defaults.compaction\`, \`memory/2026-09-26.md\`

- **D-02** T031 recovery: \`recoverPreviousSummary()\` scans sessions dir on restart — **Fix** | 2026-09-26 | ✅ Accepted
  - *Why:* In-memory session recovery map lost on gateway restart → 0/3 decisions carried
  - *Refs:* \`memory-compaction-redistill/lib/session-recovery.js\`

- **H-01** Switch compaction model to \`qwen/qwen3.6-35b-a3b\` (262k ctx, $0.15/M) — **Model** | 2026-09-26 | ⏳ Proposed
  - *Why:* Current \`ling-3.0-flash-fin:free\` carries 11% decisions (1/9)
  - *Refs:* OpenRouter, T031 verification logs

## Current decisions

- **D-03** Update compaction prompt to Hybrid format (Variant B) with identifier preservation — **Prompt** | 2026-09-26 | ✅ Accepted
  - *Why:* Improve decision carry-forward rate from 11% to ≥80%
  - *Refs:* \`compaction-provider.js\`, user request

## Superseded / rejected

- **D-00** \`truncateAfterCompaction: true\` — **Config** | 2026-09-25 | ❌ Superseded by D-01
  - *Reason:* Caused daily session wipe via cron job

## Open hypotheses (unconfirmed)

- **H-02** Local qwen3.6-35B-A3B via Ollama could replace OpenRouter for compaction — **Model** | 2026-09-26 | ⏳ Proposed
  - *Note:* Requires 24GB+ VRAM, not currently available

## Open TODOs

- [ ] Add async quality metrics logging after each compaction
- [ ] Verify T031 recovery works on next gateway restart
- [ ] Test new prompt with next auto-compaction trigger

## Pending user asks

- None

## Session archive

Transcript file: $HOME/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`;

const BAD_COMPACTION_EXAMPLE = `## Previous decisions (carried forward)

- We decided to change the config to fix the session wipe issue
- Fixed a bug where memory wasn't recovering after restart
- Maybe we should use a better model for compaction

## Current decisions

- Updated the prompt to be better
- Changed the model

## Superseded / rejected

- Old config was bad

## Open hypotheses (unconfirmed)

- Better model might help

## Open TODOs

- Fix things
- Improve quality

## Pending user asks

- User wanted better compaction

## Session archive

Transcript file: unknown`;

// ============================================================================
// IDENTIFIER PRESERVATION RULES
// ============================================================================

const IDENTIFIER_PRESERVATION_RULES = `
CRITICAL — IDENTIFIER PRESERVATION (MUST preserve verbatim, never paraphrase):
- Cron job IDs: \`91838730-9f44-4e4d-9008-04b35aca9fb9\` format
- File paths: \`$HOME/workspace/...\`, \`memory/2026-09-26.md\`
- Config keys: \`agents.defaults.compaction.truncateAfterCompaction\`, \`keepRecentTokens\`
- Task IDs: \`T031\`, \`T047\`, \`T080\` format
- Memory IDs: UUIDs or 8+ char prefixes
- Session IDs: \`378ed55c-26c9-4612-82e7-428ddebd230d\`
- Tickers: \`USDRUBF\`, \`UVXY\`, \`AAPL\`
- Model names: \`qwen/qwen3.6-35b-a3b\`, \`openrouter/inclusionai/ling-3.0-flash-fin:free\`
- Plugin names: \`memory-lancedb-pro\`, \`memory-compaction-redistill\`
- Git commit hashes, PR numbers, issue numbers

NEVER merge two identifiers into one. NEVER shorten. NEVER replace with "the config" or "the file".`;

// ============================================================================
// DECISION DETECTION PATTERNS
// ============================================================================

const DECISION_DETECTION_PATTERNS = `
DECISION DETECTION — Explicitly mark as DECISION (carry forward) when user says:
- "ставим задачу", "создаём задачу", "задача на Канбан" → **Task**
- "решили", "фиксируем", "утверждаем", "одобряем" → **Decision**
- "конфиг изменён", "поменяли настройку", "обновили конфиг" → **Config**
- "корневая причина", "root cause", "баг в" → **Fix**
- "cron ID", "task ID", "memory ID", "session ID" → **Identifier** (always preserve)
- "переключаемся на", "меняем модель на", "используем" → **Model/Tool**
- "бюджет", "лимит", "порог" → **Constraint**

ASSISTANT PROPOSALS = HYPOTHESES (mark as HYP-XX, do NOT carry as decisions):
- "предлагаю", "можно попробовать", "стоит рассмотреть", "возможно лучше"
- "я думаю", "наверное", "вероятно", "кажется"
- Any assistant suggestion not confirmed by the user

USER REVERSAL = Move old to Superseded / rejected with explanation:
- "нет, не так", "отмена", "вернёмся к", "лучше так"
- Explicit contradiction of previous decision`;

/**
 * @param {string | undefined} customInstructions
 * @param {string | undefined} previousSummary
 * @returns {string}
 */
function buildSystemPrompt(customInstructions, previousSummary) {
  const base = [
    "You maintain rolling session context for a coding agent.",
    "",
    "═══════════════════════════════════════════════════════════════════",
    "CRITICAL RULE #1: If <previous-compaction-summary> is provided, you MUST analyze it FIRST.",
    "Extract ALL decisions, TODOs, constraints, and pending asks from the previous summary.",
    "Then merge with new conversation, preserving ALL previous decisions unless explicitly superseded.",
    "If previous summary has decisions, your output MUST include them under '## Previous decisions (carried forward)' (updated if changed).",
    "Never drop previous decisions silently — only move to '## Superseded / rejected' with explanation.",
    "═══════════════════════════════════════════════════════════════════",
    "",
    "CRITICAL RULE #2: Your output MUST contain EXACTLY these 7 sections (no more, no less):",
    ...REQUIRED_SECTIONS.map((heading) => `- ${heading}`),
    "",
    "FORBIDDEN SECTIONS (DO NOT include any of these):",
    ...FORBIDDEN_SECTIONS.map((heading) => `- ${heading}`),
    "",
    "If a section has no content, write 'None' under it - do not omit the section.",
    "Under ## Session archive, write one line: Transcript file: <path if provided in user prompt, else unknown>.",
    "",
    "=== PREVIOUS DECISIONS FORMAT (Hybrid Variant B) ===",
    "Each decision as bullet with: **ID** \`key=value\` — **Type** | YYYY-MM-DD | Status",
    "  - *Why:* one-line reason with identifiers (cron IDs, file paths, config keys)",
    "  - *Refs:* code/config/memory references",
    "Types: Config | Fix | Task | Decision | Model | Constraint | Fact",
    "Status: ✅ Accepted | ❌ Superseded | ⏳ Proposed | 🔄 In Progress",
    "Hypotheses use H-XX prefix, decisions use D-XX prefix.",
    "",
    IDENTIFIER_PRESERVATION_RULES,
    "",
    DECISION_DETECTION_PATTERNS,
    "",
    "=== FEW-SHOT EXAMPLES ===",
    "GOOD compaction (follow this style):",
    GOOD_COMPACTION_EXAMPLE,
    "",
    "BAD compaction (avoid this style - loses identifiers, merges decisions, vague):",
    BAD_COMPACTION_EXAMPLE,
    "",
    "Be concise but preserve identifiers, file paths, and explicit user constraints.",
  ].join("\n");
  const extra = customInstructions?.trim();
  let prompt = extra ? `${base}\n\nOperator instructions:\n${extra}` : base;
  // Дублируем ключевые факты из previousSummary в system prompt для надёжности
  const prev = previousSummary?.trim();
  if (prev) {
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
      if (keyLines.length > 80) break;
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
 * @param {((ctx?: { sessionKey?: string; agentId?: string; hintSessionFile?: string }) => Promise<string | null>) | undefined} [recoverPreviousSummary]
 * @param {import("./staging.js").StagingConfig} [stagingConfig]
 * @returns {{ id: string; label: string; summarize: (params: {
 *   messages: unknown[];
 *   signal?: AbortSignal;
 *   customInstructions?: string;
 *   previousSummary?: string;
 *   sessionKey?: string;
 *   agentId?: string;
 *   workspaceDir?: string;
 *   summarizationInstructions?: { identifierPolicy?: string };
 * }) => Promise<string> }}
 */
export function createCompactionProvider(llmConfig, recoverPreviousSummary, stagingConfig) {
  const staging = stagingConfig ?? { enabled: false, dir: "memory/compaction-staging" };
  return {
    id: "memory-compaction-redistill",
    label: "Memory compaction redistill (previous summary + history)",
    async summarize(params) {
      const complete = llmConfig.completeText ?? completeText;

      const summarizeMain = async () => {
        const conversation = formatMessagesForPrompt(params.messages ?? []);
        const transcriptHintMatch = params.customInstructions?.match(
          /transcript file:\s*(\S+)/iu,
        );
        const archivePath = transcriptHintMatch?.[1] ?? "unknown";
        let previousSummary = params.previousSummary?.trim() ?? "";
        if (!previousSummary && typeof recoverPreviousSummary === "function") {
          try {
            const recovered = await recoverPreviousSummary({
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              hintSessionFile: archivePath !== "unknown" ? archivePath : undefined,
            });
            if (recovered?.trim()) {
              previousSummary = recovered.trim();
              llmConfig.log?.(
                `memory-compaction-redistill: T047 recovered previousSummary from parent session (${previousSummary.length} chars) — carrying forward decisions`,
              );
            }
          } catch {
            /* recovery is best-effort */
          }
        }
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
        userParts.push(
          "CRITICAL: Your response MUST contain ALL 7 section headings exactly as listed in the system prompt. If a section has no content, write 'None' under it. Do not skip any section.",
        );
        userParts.push(
          "CRITICAL: Use Hybrid Variant B format for '## Previous decisions (carried forward)' — ID, key=value, Type, Date, Status, Why, Refs.",
        );
        userParts.push(
          "CRITICAL: DO NOT include any FORBIDDEN sections (## Goal, ## Summary, ## Overview, ## Context, ## Conversation Summary).",
        );
        const summary = await complete(llmConfig, {
          system: buildSystemPrompt(params.customInstructions, previousSummary),
          user: userParts.join("\n\n"),
          signal: params.signal,
          log: llmConfig.log,
        });
        return capSummary(summary, 16000);
      };

      const compactText = async (system, user) =>
        complete(llmConfig, {
          system,
          user,
          signal: params.signal,
          log: llmConfig.log,
        });

      const result = await runCompactWithStaging({
        stagingConfig: staging,
        workspaceDir: params.workspaceDir ?? "",
        sessionKey: params.sessionKey ?? "",
        summarizeMain,
        compactText,
        log: llmConfig.log,
      });
      return capSummary(result.summary, 16000);
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