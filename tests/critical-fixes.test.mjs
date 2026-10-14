/**
 * Offline unit tests for code-review Critical C1–C4.
 * Run: node --test tests/critical-fixes.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  selectModelsToTry,
  resolveAttemptCredentials,
  completeText,
  healthCheckModel,
} from "../lib/llm.js";
import { extractFactsFromSummary } from "../lib/lancedb-sync.js";
import { createSessionRecoveryStore, estimateMessagesTokens } from "../lib/session-recovery.js";

describe("C1: skip unreachable primary", () => {
  it("selectModelsToTry omits primary when unhealthy and fallbacks exist", () => {
    assert.deepEqual(
      selectModelsToTry(false, "litellm/primary", ["openrouter/fb1", "openrouter/fb2"]),
      ["openrouter/fb1", "openrouter/fb2"],
    );
  });

  it("selectModelsToTry keeps primary first when healthy", () => {
    assert.deepEqual(
      selectModelsToTry(true, "litellm/primary", ["openrouter/fb1"]),
      ["litellm/primary", "openrouter/fb1"],
    );
  });

  it("selectModelsToTry keeps primary alone when unhealthy and no fallbacks", () => {
    assert.deepEqual(selectModelsToTry(false, "litellm/primary", []), ["litellm/primary"]);
  });

  it("completeText does not call primary when health check fails and fallbacks exist", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), model: body.model, max_tokens: body.max_tokens });
      // health check: max_tokens === 1
      if (body.max_tokens === 1) {
        return new Response("down", { status: 503 });
      }
      if (body.model === "fb1") {
        return Response.json({
          choices: [{ message: { content: "fallback-ok" } }],
        });
      }
      return new Response("fail", { status: 500 });
    };
    try {
      const text = await completeText(
        {
          model: "litellm/primary",
          apiKey: "k",
          baseURL: "http://primary.example/v1",
          timeoutMs: 5000,
          fallbacks: ["openrouter/fb1"],
          openclawConfig: {
            models: {
              providers: {
                openrouter: { baseUrl: "http://or.example/v1", apiKey: "ork" },
                litellm: { baseUrl: "http://primary.example/v1", apiKey: "lk" },
              },
            },
          },
        },
        { system: "s", user: "u" },
      );
      assert.equal(text, "fallback-ok");
      const completionCalls = calls.filter((c) => c.max_tokens !== 1);
      assert.equal(completionCalls.length, 1);
      assert.equal(completionCalls[0].model, "fb1");
      assert.ok(!completionCalls.some((c) => c.model === "primary"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("I1+I2: per-model credentials", () => {
  it("healthCheckModel uses detectApiKey for litellm (not plugin openrouter key)", async () => {
    const keys = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      keys.push(init?.headers?.Authorization);
      return new Response("down", { status: 503 });
    };
    const prev = process.env.LITELLM_MASTER_KEY;
    process.env.LITELLM_MASTER_KEY = "litellm-secret";
    try {
      await healthCheckModel(
        "litellm/qwen",
        "openrouter-default-key",
        "https://openrouter.ai/api/v1",
        5000,
        {
          models: {
            providers: {
              litellm: { baseUrl: "http://litellm.local/v1", apiKey: "${LITELLM_MASTER_KEY}" },
            },
          },
        },
      );
      assert.equal(keys[0], "Bearer litellm-secret");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev === undefined) delete process.env.LITELLM_MASTER_KEY;
      else process.env.LITELLM_MASTER_KEY = prev;
    }
  });

  it("resolveAttemptCredentials applies fallbackConfig only to matching model", () => {
    const cfg = {
      apiKey: "primary-key",
      baseURL: "http://primary/v1",
      timeoutMs: 10000,
      fallbackConfig: {
        model: "openrouter/fb-or",
        baseUrl: "http://or-fallback/v1",
        apiKey: "or-key",
        timeoutMs: 8000,
      },
      openclawConfig: {
        models: {
          providers: {
            litellm: { baseUrl: "http://litellm/v1", apiKey: "ll-key" },
            openrouter: { baseUrl: "http://or/v1", apiKey: "or-auto" },
          },
        },
      },
    };
    const matched = resolveAttemptCredentials("openrouter/fb-or", false, cfg);
    assert.equal(matched.baseURL, "http://or-fallback/v1");
    assert.equal(matched.apiKey, "or-key");

    const other = resolveAttemptCredentials("litellm/other-fb", false, cfg);
    assert.equal(other.baseURL, "http://litellm/v1");
    assert.equal(other.apiKey, "ll-key");
  });
});

describe("C2: session-scoped previousSummary recovery", () => {
  /** @type {string} */
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcr-c2-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not return another session's compaction summary", async () => {
    const sessionsDir = join(root, ".openclaw", "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const otherFile = join(sessionsDir, "agent-main-telegram-default-999999999.jsonl");
    const ownFile = join(sessionsDir, "agent-main-telegram-default-111111111.jsonl");
    const compactionLine = (summary) =>
      JSON.stringify({ type: "compaction", summary, tokensBefore: 1, timestamp: "t" });
    // Other session: newer mtime, has compaction
    await writeFile(
      otherFile,
      `${JSON.stringify({ type: "session" })}\n${compactionLine("OTHER_SESSION_DECISIONS")}\n`,
    );
    // Own session: older, no compaction yet (post-rotation child)
    await writeFile(ownFile, `${JSON.stringify({ type: "session" })}\n`);
    // Ensure other is newer
    const { utimes } = await import("node:fs/promises");
    await utimes(ownFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await utimes(otherFile, new Date(), new Date());

    const store = createSessionRecoveryStore({ homeDir: root });
    store.remember("agent:main:telegram:default:111111111", ownFile);

    const recovered = await store.recover({
      sessionKey: "agent:main:telegram:default:111111111",
      agentId: "main",
      hintSessionFile: ownFile,
    });
    assert.equal(recovered, null);

    // Remember other session separately — must not leak into first key
    store.remember("agent:main:telegram:default:999999999", otherFile);
    const leaked = await store.recover({
      sessionKey: "agent:main:telegram:default:111111111",
      agentId: "main",
      hintSessionFile: ownFile,
    });
    assert.equal(leaked, null);

    const other = await store.recover({
      sessionKey: "agent:main:telegram:default:999999999",
      agentId: "main",
      hintSessionFile: otherFile,
    });
    assert.equal(other, "OTHER_SESSION_DECISIONS");
  });

  it("uses agentId sessions dir, not hardcoded main, when scanning", async () => {
    const agentDir = join(root, ".openclaw", "agents", "fin-pm", "sessions");
    await mkdir(agentDir, { recursive: true });
    const file = join(agentDir, "agent-fin-pm-main-sessA.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "session" })}\n${JSON.stringify({
        type: "compaction",
        summary: "FIN_PM_SUMMARY",
        tokensBefore: 1,
      })}\n`,
    );
    const store = createSessionRecoveryStore({ homeDir: root });
    const recovered = await store.recover({
      sessionKey: "agent:fin-pm:main:sessA",
      agentId: "fin-pm",
    });
    assert.equal(recovered, "FIN_PM_SUMMARY");
  });
});

describe("C3: assemble token estimate", () => {
  it("estimateMessagesTokens is > 0 for non-empty messages", () => {
    const n = estimateMessagesTokens([
      { role: "user", content: "hello world this is a longer message" },
      { role: "assistant", content: "response with more tokens here" },
    ]);
    assert.ok(n > 0);
  });

  it("estimateMessagesTokens is 0 for empty", () => {
    assert.equal(estimateMessagesTokens([]), 0);
  });
});

describe("C4: FACTS_SYSTEM on LLM fact fallback", () => {
  it("calls completeText with FACTS_SYSTEM (JSON), not flush NO_REPLY prompt", async () => {
    /** @type {{ system: string; user: string }[]} */
    const calls = [];
    const llmConfig = {
      model: "m",
      apiKey: "k",
      baseURL: "http://x",
      timeoutMs: 5000,
      fallbacks: [],
      completeText: async (_cfg, params) => {
        calls.push(params);
        return '```json\n{"currentDecisions":["keep A"],"superseded":[],"openTodos":["todo"],"archiveTranscript":"/tmp/a.jsonl"}\n```';
      },
    };
    // Summary without markdown sections → triggers LLM fallback
    const facts = await extractFactsFromSummary(
      llmConfig,
      "Plain prose without section headings about decision A.",
      "/tmp/a.jsonl",
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, /Return strict JSON only/i);
    assert.doesNotMatch(calls[0].system, /NO_REPLY/);
    assert.deepEqual(facts.currentDecisions, ["keep A"]);
    assert.deepEqual(facts.openTodos, ["todo"]);
  });
});
