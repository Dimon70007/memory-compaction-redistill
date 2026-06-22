# memory-compaction-redistill

OpenClaw companion plugin for **hypothesis-aware session compaction**:

1. Registers compaction provider `memory-compaction-redistill` — merges **previous compaction summary + new chat history** (re-distill, supersession-aware).
2. On `after_compaction` — writes `memory/compaction-sync/YYYY-MM-DD-<sessionId>.md` and stores current decisions in **memory-lancedb-pro** LanceDB with a pointer to the archived session JSONL.

## Install (<user_directory>)

```bash
cp -a skills/memory-compaction-redistill $HOME/workspace/skills/
```

Ensure `openclaw.json` contains:

- `plugins.allow`: includes `memory-compaction-redistill`
- `plugins.entries.memory-compaction-redistill.enabled`: `true`
- `agents.defaults.compaction.provider`: `"memory-compaction-redistill"`
- `agents.defaults.compaction.mode`: `"safeguard"` (forced when provider is set)

Restart gateway after copy.

## Config (`plugins.entries.memory-compaction-redistill.config`)

| Key | Default | Purpose |
|---|---|---|
| `llm.model` | falls back to `agents.defaults.compaction.model` | Summarization + fact extraction |
| `llm.apiKey` | `${OPENROUTER_API_KEY}` | OpenAI-compatible API key |
| `memoryLancedbProPath` | `../memory-lancedb-pro` | Path to sibling plugin for LanceDB imports |
| `syncToLancedb` | `true` | Store decisions after compaction |
| `writeWorkspaceMemory` | `true` | Write `memory/compaction-sync/*.md` |
| `memorySubdir` | `memory/compaction-sync` | Workspace relative dir |

## Files after compaction

| Artifact | Location |
|---|---|
| Compaction summary (kernel) | `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl` → entry `type: "compaction"` |
| Full pre-rotation history | predecessor JSONL (`parentSession` in successor header) when `truncateAfterCompaction: true` |
| Human-readable snapshot | `<workspace>/memory/compaction-sync/YYYY-MM-DD-<sessionId>.md` |
| Searchable decisions | LanceDB via memory-lancedb-pro (`source: session-summary`, includes archive path) |

## Verify

```bash
rg '"type":"compaction"' ~/.openclaw/agents/main/sessions/*.jsonl | tail -3
ls -lt $HOME/workspace/memory/compaction-sync/
journalctl -u openclaw-gateway --since "10 min ago" | rg memory-compaction-redistill
```

## Notes

- Does **not** change `autoRecall` settings.
- Requires **memory-lancedb-pro** installed at `memoryLancedbProPath` for LanceDB sync.
- If LanceDB sync fails, workspace markdown snapshot is still written.


# Information
В репозитории собран плагин и подключён в `openclaw.json`. **autoRecall не трогали.**

## Что сделано

### 1. Плагин `skills/memory-compaction-redistill/`

| Компонент | Назначение |
|---|---|
| **Compaction provider** `memory-compaction-redistill` | Re-distill: **предыдущий summary + новая история**; секции Current decisions / Superseded / Open hypotheses / TODOs / Session archive |
| **Hook `after_compaction`** | После compact: markdown в `memory/compaction-sync/` + запись в LanceDB через memory-lancedb-pro с `source: session-summary` и путём к архивному JSONL |

### 2. Обновлён `openclaw.json`

```256:272:openclaw.json
      "compaction": {
        "mode": "safeguard",
        "provider": "memory-compaction-redistill",
        "model": "openrouter/owl-alpha",
        "identifierPolicy": "off",
        "notifyUser": true,
        "customInstructions": "Re-distill the previous compaction summary with new messages. ...",
        ...
        "truncateAfterCompaction": true,
        "postIndexSync": "async"
      }
```

Плагин в `plugins.allow` / `plugins.entries` с путём `$HOME/workspace/skills/memory-lancedb-pro`.

## Деплой на <user_directory>

```bash
cp -a skills/memory-compaction-redistill $HOME/workspace/skills/
# openclaw.json → ~/.openclaw/openclaw.json (или merge вручную)
# restart gateway
```

## Проверка после compact

```bash
rg '"type":"compaction"' ~/.openclaw/agents/main/sessions/*.jsonl | tail -3
ls -lt $HOME/workspace/memory/compaction-sync/
journalctl -u openclaw-gateway --since "10 min ago" | rg memory-compaction-redistill
```

## Цепочка при compact

1. **memoryFlush** (lancedb-pro) — pre-compaction flush в `memory/YYYY-MM-DD.md`
2. **Provider** — re-distill с учётом supersession (Python→TS и т.п.)
3. **after_compaction** — snapshot + LanceDB (`archiveTranscript` → полный JSONL до rotation)
4. **autoRecall** — без изменений, срабатывает редко по вашим порогам

Если LanceDB sync упадёт (нет `dist/` у memory-lancedb-pro), markdown snapshot всё равно пишется — смотрите лог `LanceDB sync failed`.
