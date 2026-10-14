# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Install docs: clone from `git@github.com:Dimon70007/memory-compaction-redistill.git` into `$HOME/workspace/skills/` (not local `cp -a`).

### Added

- **Staging multi-pass (opt-in):** `staging.enabled` + required `staging.chunkMaxChars`. On fact-extract degrade → chunk residue under `memory/compaction-staging/<session>/` (no LanceDB). Next compact with non-empty queue: A chunks → B main → C merge; delete consumed chunks only after LanceDB ack. Empty queue = unchanged single compact.
- Offline unit suite `tests/critical-fixes.test.mjs` covering C1–C4 (+ I1/I2 credential helpers).
- `lib/session-recovery.js` — session-scoped recovery store + `estimateMessagesTokens`.
- `lib/staging.js`, `lib/multi-pass-compact.js` + tests for staging / multi-pass.
- Fallback model chain for compaction LLM calls: reads `agents.defaults.model.fallbacks` (or plugin `llm.fallbacks`) and tries models in order when the primary fails.
- Primary-model health check (capped at 10s) before compaction requests, with logging of attempts and fallback decisions.
- Per-provider base URL / API key detection for `openrouter`, `litellm`, and other providers from `models.providers.*`.
- Optional plugin `llm.fallback` object (`baseUrl`, `apiKey`, `model`, `timeoutMs`) for explicit fallback credentials.
- T047: recover `previousSummary` after transcript rotation via in-memory last session file and filesystem scan of recent compaction entries.
- Context engine registration with `ownsCompaction: true` for OpenClaw 9.9 discovery/full runtime modes.
- Compaction prompt upgrades: Hybrid Variant B decision format, identifier-preservation rules, decision-detection patterns, and good/bad few-shot examples.
- Async post-compaction quality metrics (carry-forward rate, identifier preservation, section completeness).
- Markdown-first fact extraction from compaction summaries before LanceDB sync (no LLM when sections parse cleanly).
- Integration test coverage for model normalization, provider resolution, health checks, fallback simulation, and LiteLLM round-trip (`tests/fallback-integration-test.mjs`).
- README section documenting fallback behavior, config example, and how to run the integration test.

### Fixed

- **C1:** unreachable primary is skipped when fallbacks exist (no full `timeoutMs` wait on a dead primary).
- **C2:** T047 `previousSummary` recovery is session-scoped (`Map` by `sessionKey`); filesystem scan uses `agentId` sessions dir and only filenames matching that session (fixes cross-chat contamination / wrong Telegram session id).
- **C3:** context-engine `assemble` returns a real token estimate; `autoRecall` is an empty passthrough (no longer `estimatedTokens: 0`).
- **C4:** LLM fact-extraction fallback uses `FACTS_SYSTEM` (strict JSON), not flush/`NO_REPLY` prompts.
- **I1/I2:** health-check uses per-provider `detectApiKey`; explicit `llm.fallback` applies only to the matching model.
- Paths in docs/examples/tests use `$HOME` instead of `$HOME`; few-shot session path is a generic placeholder.
- Fact extract returns `degraded` instead of stuffing raw summary into LanceDB via `fallbackFacts`.

### Changed

- Compaction provider registration is gated to real runtime modes (`full` / `discovery`); setup/discovery noop modes skip provider registration.
- `after_compaction` still writes workspace snapshots and LanceDB sync; now also captures the session file for T047 recovery and logs quality metrics.
- Plugin config schema no longer rejects unknown properties with `additionalProperties: false` (schema for `llm.fallbacks` / `llm.fallback` still pending).
- Env placeholder resolution error messages now report the unresolved template string.

### Notes / known gaps (from code review)

- Critical C1–C4 addressed above; remaining Important items (I3 live-test drift, I5 few-shot size, I7 schema, I8 silentDrops) still open.

## [0.1.0] - prior

### Added

- Initial OpenClaw compaction provider with previous-summary redistill.
- `after_compaction` hook: workspace markdown snapshot + memory-lancedb-pro sync.
- Decision carry-forward verification and registration race guard (T031).
