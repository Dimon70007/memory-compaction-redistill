# OpenClaw mock harness — attribution

**Purpose:** Offline simulation of OpenClaw **2026.9.9** `ownsCompaction` host lifecycle and active-window projection. No dependency on installed `openclaw` package or `/home/clawbox/**` at test runtime.

## Concepts adapted (not copied wholesale)

| Concept | OpenClaw idea (2026.9.9) | This mock |
|---------|--------------------------|-----------|
| ownsCompaction compact | Host calls `ContextEngine.compact` then `maintain` then `after_compaction` | `runOwnsCompactionLifecycle` |
| Active window after compaction | Model-visible = summary + messages from `firstKeptEntryId` | `projectActiveWindow(entries)` |
| Tool-safe cut | Do not orphan `toolResult` without its `toolCall` | Uses plugin `selectToolSafeFirstKeptEntryId` (engine) |
| Successor rotate | New `.jsonl` with `parentSession` = predecessor abs path | Asserted via engine rotate + lifecycle return |
| `after_compaction` sessionFile | Filesystem path only | Handler / skip guard; sessionKey-shaped rejected |

## Non-goals

- Importing from `node_modules/openclaw` or clawbox study trees at runtime
- Live gateway, litellm, or OpenRouter
- Byte-identical reproduction of OpenClaw SessionManager internals

Study notes for TASK-047 live under the parent repo (`logs/task047-lossless-claw-truncate.md`, TASK-047 Appendix C–D). This directory is an **adapted reimplementation** for offline proofs.
