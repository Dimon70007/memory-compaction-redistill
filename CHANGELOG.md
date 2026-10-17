# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`missing_session_file` with `sessionKey` + `sessionId` but no `.jsonl`:** try `<sessionsDir>/<sessionId>.jsonl` **before** parsing `sessions.json` (index corrupt/unreadable no longer blocks a present transcript); unresolved errors include `tried=…/<sessionId>.jsonl(exists=false)`.
- **`missing_session_file… storeHints=…/sessions.json`:** resolve transcript by scanning `sessions.json` for `sessionKey` / `sessionId` / UUID suffix in the key (dashboard ids ≠ jsonl basename); clearer error when both ids missing.
- **`corrupt_jsonl_line` on `sessions.json`:** `sessionTarget.storePath` is the sessions **store** (`…/sessions` or `…/sessions.json`), not a transcript — never load it as JSONL; use it only to locate `<sessionId>.jsonl` via the index.
- **`missing_session_file_and_messages` when host passes sessionKey as `sessionFile`:** resolve filesystem transcript via `sessions.json` / `sessionId` / store hints (`lib/session-path.js`) before fail-closed.

### Added

- **CompactResult successor `sessionTarget`:** on rotate, return typed `{ agentId, sessionId, sessionKey?, storePath }` (OpenClaw preferred adopt path) alongside legacy `sessionId`/`sessionFile`; `details.tokensSaved` = `tokensBefore − tokensAfter`. Spec locked in TASK-047 §C.2.1.
- **TASK-047 / 047.A.I3 — offline OpenClaw mock harness (option C):** `tests/openclaw-mock/` host lifecycle (`compact` → `maintain` → `after_compaction`) + active-window projection (OpenClaw 2026.9.9-adapted; `ATTRIBUTION.md`). In-repo fixtures under `tests/fixtures/` (no `/home/clawbox` I/O). Expanded corners: corrupt JSONL fail-closed, header-only, second compact, tool-pair cut, sessionKey `after_compaction` skip, summarize throw, fail→success isolation, lifecycle shrink assert.
- Module split: `lib/context-engine.js`, `lib/compact-pipeline.js`, `lib/after-compaction.js`, `lib/util.js`; `index.js` is register wiring + re-exports. Strict `loadTranscript(..., { strict: true })` on compact path.

### Fixed

- **TASK-047 Iteration A — context not shrinking:** `ContextEngine.compact` now **applies** after a successful non-empty LLM summarize: tool-safe `firstKeptEntryId`, opaque `oc:jsonl:v1:…` ref in summary, `appendCompaction` on live `sessionFile`. `compacted: true` only when apply succeeds. Overflow/timeout calls without `params.messages` load the transcript from `sessionFile`. Honors `abortSignal`. Fail-closed (empty/abort/apply error → no transcript mutation). When the JSONL file still exceeds `maxActiveTranscriptBytes`, engine rotates an OpenClaw-style successor (`parentSession`) and returns successor `sessionId`/`sessionFile` for host `adoptCompactionTranscript`.
- `maintain()` always returns `{ changed, bytesFreed, rewrittenEntries }` (never `undefined`).
- `acceptedHostParams` includes `runtimeContext` and `runtimeSettings`.
- `after_compaction` opens only filesystem transcript paths (rejects sessionKey-shaped values → no ENOENT on `agent:…`).

### Added

- `lib/transcript-apply.js` — JSONL load/cut/append/rotate helpers (OpenClaw appendCompaction semantics; injectable in tests).
- Offline suite `tests/transcript-apply.test.mjs` (happy apply, sessionFile-only, fail-closed, maintain shape, tool-pair, no auto-ingest refs, rotate).

### Changed

- OpenClaw **2026.9.x** cold-start: manifest `kind` `utility` → `context-engine`; add `activation.onStartup` + `onConfigPaths` (`agents.defaults.compaction.provider`). Gateway only loads slot/activation owners — `plugins.load.paths` alone is not enough. Operators must set `plugins.slots.contextEngine=memory-compaction-redistill`.
- `llm.fallback.baseURL` accepted (was only `baseUrl`); matches OpenClaw config camelCase.
- README: install via `openclaw plugins install git:github.com/Dimon70007/memory-compaction-redistill@<ref>` ([docs](https://docs.openclaw.ai/cli/plugins/install)); update with `openclaw plugins update`; `--link` for local dev.
- README for first-time operators: copy-paste `openclaw.json`, env, verify, customize models/staging, troubleshooting.
- Removed internal code-review notes from the published tree; neutralized host-specific path examples (use `<user_directory>` / `$HOME`).

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
- Paths in docs/examples/tests use `$HOME` / `<user_directory>` placeholders instead of host-specific home paths; few-shot session path is generic.
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
