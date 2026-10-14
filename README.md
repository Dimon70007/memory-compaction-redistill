# memory-compaction-redistill

OpenClaw plugin that **compresses long chat sessions** without losing decisions:

1. **Compact** — LLM builds a structured summary (Hybrid Variant B) from previous summary + new messages.
2. **After compact** — writes a markdown snapshot under the workspace and (optionally) stores decisions in **memory-lancedb-pro** LanceDB.

Install with the OpenClaw CLI ([plugins install docs](https://docs.openclaw.ai/cli/plugins/install)) — no manual `git clone` into `skills/` required.

---

## Prerequisites

| Need | Why |
|---|---|
| OpenClaw CLI + gateway | `openclaw plugins install` and runtime load |
| Access to this GitHub repo | Private install uses your GitHub credentials (SSH agent / `gh` / HTTPS token) |
| LLM credentials in the **gateway process** env | See [Environment](#4-environment-variables) |
| Optional: `memory-lancedb-pro` installed | Only if `syncToLancedb: true` |

---

## Quick start (install + wire)

### 1. Install via OpenClaw

Pin a branch or commit (recommended for production):

```bash
# latest master
openclaw plugins install git:github.com/Dimon70007/memory-compaction-redistill@master

# or pin an exact commit (reproducible)
# openclaw plugins install git:github.com/Dimon70007/memory-compaction-redistill@473272a

# reinstall / replace existing install
# openclaw plugins install git:github.com/Dimon70007/memory-compaction-redistill@master --force
```

OpenClaw clones the repo, validates `openclaw.plugin.json`, and records the install (including resolved commit) so later updates work.

Update later:

```bash
openclaw plugins update memory-compaction-redistill
```

Inspect:

```bash
openclaw plugins list
openclaw plugins inspect memory-compaction-redistill --runtime --json
```

**Dev alternative** (local checkout / this monorepo submodule):

```bash
openclaw plugins install --link /path/to/memory-compaction-redistill
```

### 2. Backup and edit OpenClaw config

```bash
cp -a ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M)
```

Edit `~/.openclaw/openclaw.json` (merge the blocks below; keep your existing providers/agents).

If install left the plugin **disabled** because config was missing, add `plugins.entries…config` first, then:

```bash
openclaw plugins enable memory-compaction-redistill
```

### 3. Minimal config (copy-paste)

Replace `YOUR_LITELLM_BASE_URL` if you use a local LiteLLM fallback (example: `http://<litellm-host>:4000/v1`).  
If you only use OpenRouter, you can omit `llm.fallback` / use another OpenRouter free model instead.

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "provider": "memory-compaction-redistill",
        "model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
        "timeoutSeconds": 600,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 30000
        }
      }
    }
  },
  "plugins": {
    "allow": [
      "memory-compaction-redistill",
      "memory-lancedb-pro"
    ],
    "entries": {
      "memory-compaction-redistill": {
        "enabled": true,
        "config": {
          "syncToLancedb": true,
          "writeWorkspaceMemory": true,
          "memorySubdir": "memory/compaction-sync",
          "staging": {
            "enabled": true,
            "dir": "memory/compaction-staging",
            "chunkMaxChars": 8000
          },
          "llm": {
            "model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "${OPENROUTER_API_KEY}",
            "timeoutMs": 600000,
            "temperature": 0.2,
            "fallbacks": ["litellm/qwen3.8-27b"],
            "fallback": {
              "model": "litellm/qwen3.8-27b",
              "baseURL": "YOUR_LITELLM_BASE_URL",
              "apiKey": "${LITELLM_MASTER_KEY}",
              "timeoutMs": 600000,
              "temperature": 0.2
            }
          }
        }
      }
    }
  }
}
```

Also ensure the model id you pick exists under `models.providers.openrouter.models` (and LiteLLM, if used) **and** in `agents.defaults.modelPolicy.allow` if you use an allowlist.

If LanceDB lives outside the default lookup path, set an absolute `memoryLancedbProPath` in this plugin’s `config`.

### 4. Environment variables

Must be visible to the **OpenClaw gateway process** (systemd/user unit, launchd, or shell that starts the gateway) — not only in a random `.env` file:

| Variable | Used for |
|---|---|
| `OPENROUTER_API_KEY` | Primary compaction model (OpenRouter) |
| `LITELLM_MASTER_KEY` | Fallback local model (if configured) |

### 5. Restart gateway

```bash
openclaw doctor
openclaw gateway restart
# or your unit, e.g.:
# systemctl --user restart openclaw-gateway
```

### 6. Verify

```bash
openclaw plugins inspect memory-compaction-redistill --runtime --json

journalctl --user -u openclaw-gateway -n 100 --no-pager | rg memory-compaction-redistill
# expect: compaction provider registered / context engine registered

# after a real compaction fires:
ls -lt "$HOME/workspace/memory/compaction-sync/" | head
rg '"type":"compaction"' ~/.openclaw/agents/*/sessions/*.jsonl | tail -5
```

---

## Customize for your setup

### Change the compaction model

1. Pick a model on [OpenRouter free models](https://openrouter.ai/models?q=free) (or a paid / local id).
2. Set **both**:
   - `agents.defaults.compaction.model`
   - `plugins.entries.memory-compaction-redistill.config.llm.model`
3. Point `llm.baseURL` / `llm.apiKey` at that provider.
4. Optional quality fallback: `llm.fallbacks` + `llm.fallback` (per-model credentials). When primary fails health-check, it is **skipped** and fallbacks run.

**Recommended default:** free primary `nvidia/nemotron-3-ultra-550b-a55b:free`, quality fallback local `litellm/qwen3.8-27b`.

### Staging (optional, recommended)

If fact extraction cannot produce structured decisions (bad summary shape / LLM down), the plugin can **save residue to disk** and later re-compact it in small chunks — **without** stuffing raw text into LanceDB.

| Key | Meaning |
|---|---|
| `staging.enabled` | `false` by default; set `true` to opt in |
| `staging.chunkMaxChars` | **Required** when enabled (e.g. `8000`). Missing → fail closed |
| `staging.dir` | Default `memory/compaction-staging` under workspace |

- Empty staging queue → normal compact path unchanged.
- Chunks deleted **only after** a successful LanceDB sync.

### LanceDB sync off

```json
"syncToLancedb": false
```

Markdown snapshots still write if `writeWorkspaceMemory: true`. With sync off, prefer `staging.enabled: false` (cleanup is gated on LanceDB ack).

### Paths

| Artifact | Typical location |
|---|---|
| Plugin install (OpenClaw-managed) | under `~/.openclaw/` extensions / plugin install record (see `openclaw plugins inspect`) |
| Markdown snapshots | `<workspace>/memory/compaction-sync/` |
| Staging chunks | `<workspace>/memory/compaction-staging/<session>/` |
| Session transcripts | `~/.openclaw/agents/<agent>/sessions/*.jsonl` |

---

## How it fits OpenClaw

```text
gateway decides to compact
  → memory-compaction-redistill (provider / context engine) → LLM summary
  → gateway writes type:"compaction" into session JSONL
  → plugin after_compaction → snapshot ± LanceDB (± staging on degrade)
```

`agents.defaults.compaction.memoryFlush` is an **OpenClaw core** pre-compact step (writes durable notes). It is separate from this plugin’s summarizer prompts.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Install fails / disabled | GitHub auth; `openclaw.plugin.json` present; add `config` then `openclaw plugins enable memory-compaction-redistill` |
| Plugin never in logs | `plugins.allow`, `enabled: true`, `openclaw plugins list`, restart gateway |
| Compact uses wrong model | Both `compaction.model` and `config.llm.model`; allowlist / provider catalog |
| Auth / 401 | Env vars on **gateway** process; `${OPENROUTER_API_KEY}` placeholders resolve at runtime |
| `staging.enabled` crash on start | Set positive `staging.chunkMaxChars` |
| LanceDB errors | Install/enable memory-lancedb-pro; set `memoryLancedbProPath`; or `syncToLancedb: false` |
| Need newer code | `openclaw plugins update memory-compaction-redistill` (or reinstall with `@<commit> --force`) |

---

## Developer tests (optional)

From a local checkout / linked install:

```bash
cd /path/to/memory-compaction-redistill
npm test
```

Live integration (needs keys + network):

```bash
export OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
export OPENROUTER_API_KEY=…
export LITELLM_MASTER_KEY=…   # if testing LiteLLM path
node tests/fallback-integration-test.mjs
```

---

## License

MIT
