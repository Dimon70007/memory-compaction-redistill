# memory-compaction-redistill

OpenClaw plugin that **compresses long chat sessions** without losing decisions:

1. **Compact** — LLM builds a structured summary (Hybrid Variant B) from previous summary + new messages.
2. **After compact** — writes a markdown snapshot under the workspace and (optionally) stores decisions in **memory-lancedb-pro** LanceDB.

**Preferred install for this project:** clone into the agent workspace `skills/`
directory and load via `plugins.load.paths` (sibling layout with
`memory-lancedb-pro`). Managed `openclaw plugins install git:…` works but lands
under `~/.openclaw/git/…` and breaks the default relative
`memoryLancedbProPath` (`../memory-lancedb-pro`).

Docs use placeholders only — no host account paths, LAN IPs, or secret values.

---

## Prerequisites

| Need | Why |
|---|---|
| OpenClaw CLI + gateway | runtime load + restart |
| Access to this GitHub repo | `git clone` (SSH agent / HTTPS credentials) |
| LLM credentials in the **gateway process** env | See [Environment](#4-environment-variables) |
| Optional: `memory-lancedb-pro` under the same `skills/` | Only if `syncToLancedb: true` |

---

## Quick start (install + wire)

### 1. Install into workspace `skills/` (path-load)

```bash
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/workspace}"
SKILLS="$WORKSPACE/skills"
mkdir -p "$SKILLS"

openclaw plugins uninstall memory-compaction-redistill 2>/dev/null || true

git clone --branch master --single-branch \
  git@github.com:Dimon70007/memory-compaction-redistill.git \
  "$SKILLS/memory-compaction-redistill"

cd "$SKILLS/memory-compaction-redistill"
npm install

# optional: record path install without copying into managed roots
openclaw plugins install -l "$SKILLS/memory-compaction-redistill"
```

Ensure config has a single load path covering all path-loaded plugins, and
pin the OpenClaw **2026.9.x** startup slots (path-load alone is not enough —
utility/context engines only boot when selected by a slot or
`activation.onStartup`):

```json
"plugins": {
  "load": { "paths": ["<workspace>/skills"] },
  "slots": {
    "memory": "memory-lancedb-pro",
    "contextEngine": "memory-compaction-redistill"
  }
}
```

With both plugins under the same `skills/`, leave `memoryLancedbProPath` unset
(default `../memory-lancedb-pro`) or set it explicitly to
`"<workspace>/skills/memory-lancedb-pro"`.

Inspect:

```bash
openclaw plugins list
openclaw plugins inspect memory-compaction-redistill --runtime --json
```

**Managed alternative** (OpenClaw default roots — not `skills/`):

```bash
openclaw plugins install git:github.com/Dimon70007/memory-compaction-redistill@master
# then set absolute memoryLancedbProPath to the memory-lancedb-pro install root
```

**Dev link** from a monorepo submodule checkout:

```bash
openclaw plugins install -l /path/to/memory-compaction-redistill
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

Use your own model ids and OpenAI-compatible endpoints. Omit `llm.fallback` if you have a single provider. Do **not** commit real API keys — only `${ENV_VAR}` placeholders whose names you choose.

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "provider": "memory-compaction-redistill",
        "model": "<provider>/<model-id>",
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
    "slots": {
      "memory": "memory-lancedb-pro",
      "contextEngine": "memory-compaction-redistill"
    },
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
            "model": "<provider>/<model-id>",
            "baseURL": "<openai-compatible-base-url>",
            "apiKey": "${LLM_API_KEY}",
            "timeoutMs": 600000,
            "temperature": 0.2,
            "fallbacks": ["<provider>/<fallback-model-id>"],
            "fallback": {
              "model": "<provider>/<fallback-model-id>",
              "baseURL": "<fallback-openai-compatible-base-url>",
              "apiKey": "${LLM_FALLBACK_API_KEY}",
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

Also ensure chosen model ids exist in your OpenClaw model catalog / allowlist if you use one.

If LanceDB lives outside the default lookup path, set an absolute `memoryLancedbProPath` in this plugin’s `config`.

### 4. Environment variables

Must be visible to the **OpenClaw gateway process** (systemd/user unit, launchd, or shell that starts the gateway) — not only in a random `.env` file. Name the variables yourself; examples below are placeholders only:

| Variable (example name) | Used for |
|---|---|
| `LLM_API_KEY` | Primary compaction endpoint |
| `LLM_FALLBACK_API_KEY` | Fallback endpoint (if configured) |

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

Pick a primary model you trust for long summarization, plus an optional fallback on a second endpoint.

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
| Plugin (path-load) | `<workspace>/skills/memory-compaction-redistill/` |
| Sibling memory plugin | `<workspace>/skills/memory-lancedb-pro/` |
| Plugin (managed git, if used) | under `~/.openclaw/git/…` (see `openclaw plugins inspect`) |
| Markdown snapshots | `<workspace>/memory/compaction-sync/` |
| Staging chunks | `<workspace>/memory/compaction-staging/<session>/` |
| Session transcripts | `~/.openclaw/agents/<agent>/sessions/*.jsonl` |

---

## How it fits OpenClaw

With `ownsCompaction: true` (required), the **engine** must apply reduction — the host does not call built-in `appendCompaction` for this slot:

```text
gateway overflow/timeout/queued compact (often without params.messages)
  → ContextEngine.compact
      → load live sessionFile JSONL when messages absent
      → LLM summarize (provider / staging multi-pass)
      → tool-safe firstKeptEntryId + oc:jsonl:v1 ref in summary
      → appendCompaction (active window = summary + fresh tail)
      → optional successor rotate when file still > maxActiveTranscriptBytes
  → host adoptCompactionTranscript if successor sessionId/sessionFile returned
  → maintain() → { changed, bytesFreed, rewrittenEntries }
  → after_compaction (filesystem sessionFile only) → snapshot ± LanceDB
```

Fail-closed: empty/abort/apply error → `compacted: false`, **no** transcript mutation.

`agents.defaults.compaction.memoryFlush` is an **OpenClaw core** pre-compact step (writes durable notes). It is separate from this plugin’s summarizer prompts.

Recommend `agents.defaults.compaction.truncateAfterCompaction: true` for queued `/compact` host rotate when the host still honors it; overflow shrink relies on engine `appendCompaction` (+ engine rotate when the JSONL file remains oversized).

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Install fails / disabled | GitHub auth; `openclaw.plugin.json` present; add `config` then `openclaw plugins enable memory-compaction-redistill` |
| Plugin never in logs | `plugins.allow`, `enabled: true`, `openclaw plugins list`, restart gateway |
| Compact uses wrong model | Both `compaction.model` and `config.llm.model`; allowlist / provider catalog |
| Auth / 401 | Env vars on **gateway** process; `${LLM_API_KEY}` (or your chosen names) resolve at runtime |
| `staging.enabled` crash on start | Set positive `staging.chunkMaxChars` |
| LanceDB errors | Install/enable memory-lancedb-pro; set `memoryLancedbProPath`; or `syncToLancedb: false` |
| Need newer code | `cd <workspace>/skills/memory-compaction-redistill && git pull --ff-only && npm install` then restart gateway (or managed `plugins update` if that install mode was used) |
| Compact “succeeds” but tokens/bytes unchanged | Engine must apply (`appendCompaction`). Check submodule version has TASK-047 apply path; `npm test` includes `tests/transcript-apply.test.mjs`. Do not deploy stub `skills/` copy without apply. |
| `maintain` TypeError on `.changed` | Engine must return `{ changed, bytesFreed, rewrittenEntries }` — fixed in TASK-047 |
| `after_compaction` ENOENT on `agent:…` | Handler ignores non-filesystem `sessionFile` (sessionKey-shaped) |

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
export LLM_API_KEY=…              # whatever names your config references
export LLM_FALLBACK_API_KEY=…     # only if testing fallback
node tests/fallback-integration-test.mjs
```

---

## License

MIT
