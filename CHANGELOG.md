# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Compaction provider registration is gated to real runtime modes (`full` / `discovery`); setup/discovery noop modes skip provider registration.
- `after_compaction` still writes workspace snapshots and LanceDB sync; now also captures the session file for T047 recovery and logs quality metrics.
- Plugin config schema no longer rejects unknown properties with `additionalProperties: false` (schema for `llm.fallbacks` / `llm.fallback` still pending).
- Env placeholder resolution error messages now report the unresolved template string.

### Notes / known gaps (from code review)

- Health-check failure currently still attempts the primary model with full timeout before fallbacks (intended skip not implemented).
- T047 filesystem recovery hardcodes `agents/main` and is process-global (not session-scoped).
- LLM fact-extraction fallback uses flush-style prompts that ask for markdown/`NO_REPLY` while the parser expects JSON.

## [0.1.0] - prior

### Added

- Initial OpenClaw compaction provider with previous-summary redistill.
- `after_compaction` hook: workspace markdown snapshot + memory-lancedb-pro sync.
- Decision carry-forward verification and registration race guard (T031).
