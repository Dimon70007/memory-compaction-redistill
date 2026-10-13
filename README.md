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
| `llm.baseURL` | `https://openrouter.ai/api/v1` | API base URL |
| `llm.timeoutMs` | `120000` | Per-model request timeout (ms) |
| `memoryLancedbProPath` | `../memory-lancedb-pro` | Path to sibling plugin for LanceDB imports |
| `syncToLancedb` | `true` | Store decisions after compaction |
| `writeWorkspaceMemory` | `true` | Write `memory/compaction-sync/*.md` |
| `memorySubdir` | `memory/compaction-sync` | Workspace relative dir |

## Fallback Model Support

The plugin reads fallback models from `agents.defaults.model.fallbacks` in the global config. When the primary compaction model is unreachable, the plugin automatically tries each fallback model in order.

**How it works:**

1. **Health check** — Before compaction, a quick ping (max 10s) is sent to the primary model to verify reachability.
2. **Fallback chain** — If the primary model is unreachable, the plugin iterates through `agents.defaults.model.fallbacks` and tries each model.
3. **Provider auto-detection** — Models with `litellm/` prefix automatically use the LiteLLM provider config from `models.providers.litellm` (baseUrl, apiKey).
4. **Logging** — All model attempts, health checks, and fallback decisions are logged via `api.logger`.

**Example config:**

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/owl-alpha",
        "fallbacks": [
          "openrouter/poolside/laguna-xs.2:free",
          "litellm/gemma4-26b-a4b",
          "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"
        ]
      },
      "compaction": {
        "provider": "memory-compaction-redistill",
        "model": "openrouter/owl-alpha"
      }
    }
  },
  "plugins": {
    "entries": {
      "memory-compaction-redistill": {
        "config": {
          "llm": {
            "model": "openrouter/owl-alpha"
          }
        }
      }
    }
  }
}
```

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

## Testing

Run the integration test to verify fallback behavior:

```bash
cd skills/memory-compaction-redistill
node tests/fallback-integration-test.mjs
```

The test covers:
- Model ID normalization (bare name → provider/name)
- Provider config resolution (apiKey, baseURL from provider config)
- Health checks on real endpoints
- Fallback simulation when primary model is unreachable
- Full compaction round-trip via LiteLLM

Requires `OPENROUTER_API_KEY` and `LITELLM_MASTER_KEY` in environment.

## Notes

- Does **not** change `autoRecall` settings.
- Requires **memory-lancedb-pro** installed at `memoryLancedbProPath` for LanceDB sync.
- If LanceDB sync fails, workspace markdown snapshot is still written.
- Fallback models are read from `agents.defaults.model.fallbacks` (global config).
- Health check timeout is capped at 10s to avoid blocking compaction when the primary model is down.
