# Offline fixtures (TASK-047 / 047.A.I3)

Synthetic / anonymized OpenClaw JSONL shapes for unit + mock-host tests.

- **No** runtime dependency on `/home/clawbox/**` or live `~/.openclaw` sessions.
- Tests copy fixtures into `os.tmpdir()` before mutate.
- Content is fictional; not production chat logs.
