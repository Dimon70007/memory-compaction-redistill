/**
 * Edge coverage for pre-compact primary model probe.
 * Run: node --test tests/primary-probe.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRIMARY_PROBE_TIMEOUT_MS,
  resolveLlmConfig,
  probePrimaryModel,
  healthCheckModel,
  looksLikeUpstreamOverload,
  completeText,
  selectModelsToTry,
} from "../lib/llm.js";

/** @returns {Record<string, unknown>} */
function providersConfig() {
  return {
    models: {
      providers: {
        openrouter: { baseUrl: "http://or.example/v1", apiKey: "ork" },
        litellm: { baseUrl: "http://ll.example/v1", apiKey: "lk" },
      },
    },
  };
}

/**
 * @param {(url: string, init: RequestInit) => Promise<Response> | Response} impl
 * @returns {() => void}
 */
function withFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => impl(String(url), init ?? {});
  return () => {
    globalThis.fetch = original;
  };
}

describe("looksLikeUpstreamOverload edges", () => {
  it("treats 429/502/503 as overloaded regardless of body", () => {
    assert.equal(looksLikeUpstreamOverload(429, ""), true);
    assert.equal(looksLikeUpstreamOverload(502, "x"), true);
    assert.equal(looksLikeUpstreamOverload(503, "ok"), true);
  });

  it("matches body cues case-insensitively", () => {
    assert.equal(looksLikeUpstreamOverload(200, "RATE LIMIT exceeded"), true);
    assert.equal(looksLikeUpstreamOverload(200, "no Capacity left"), true);
    assert.equal(looksLikeUpstreamOverload(200, "Temporarily Unavailable"), true);
    assert.equal(looksLikeUpstreamOverload(200, "Upstream Error: boom"), true);
    assert.equal(looksLikeUpstreamOverload(200, "service overloaded"), true);
  });

  it("returns false for ordinary success bodies", () => {
    assert.equal(looksLikeUpstreamOverload(200, ""), false);
    assert.equal(looksLikeUpstreamOverload(200, '{"choices":[]}'), false);
    assert.equal(looksLikeUpstreamOverload(404, "not found"), false);
  });
});

describe("probePrimaryModel edges", () => {
  it("sends max_tokens=16 content probe to chat/completions", async () => {
    /** @type {Array<{ url: string; body: Record<string, unknown> }>} */
    const seen = [];
    const restore = withFetch(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
      return Response.json({ choices: [{ message: { content: "pong" } }] });
    });
    try {
      const result = await probePrimaryModel(
        "openrouter/nvidia/nemotron-x",
        "k",
        "http://or.example/v1",
        5000,
        providersConfig(),
      );
      assert.equal(result.healthy, true);
      assert.equal(result.reason, "ok");
      assert.ok(result.elapsedMs >= 0);
      assert.equal(seen.length, 1);
      assert.match(seen[0].url, /\/chat\/completions$/u);
      assert.equal(seen[0].body.max_tokens, 16);
      assert.equal(seen[0].body.temperature, 0);
      assert.equal(seen[0].body.model, "nvidia/nemotron-x");
      const messages = seen[0].body.messages;
      assert.ok(Array.isArray(messages));
      assert.match(String(/** @type {{ content?: string }} */ (messages[0])?.content ?? ""), /pong/iu);
    } finally {
      restore();
    }
  });

  it("fails closed on missing choices / non-string content", async () => {
    const cases = [
      { choices: [] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: {} }] },
      { choices: [{}] },
      {},
    ];
    for (const payload of cases) {
      const restore = withFetch(async () => Response.json(payload));
      try {
        const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
        assert.equal(bad.healthy, false, JSON.stringify(payload));
        assert.equal(bad.reason, "empty_content", JSON.stringify(payload));
      } finally {
        restore();
      }
    }
  });

  it("fails closed when payload embeds error object/string", async () => {
    for (const payload of [
      { error: "Upstream error from Nvidia: Service temporarily overloaded", choices: [] },
      { error: { message: "capacity exceeded" }, choices: [{ message: { content: "pong" } }] },
    ]) {
      const restore = withFetch(async () => Response.json(payload));
      try {
        const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
        assert.equal(bad.healthy, false);
        // error field → extractProbeContent returns "" → empty_content
        // (overloaded_body only when raw body text matches before content extract)
        assert.ok(
          bad.reason === "empty_content" || bad.reason === "overloaded_body",
          bad.reason,
        );
      } finally {
        restore();
      }
    }
  });

  it("flags HTTP overload statuses with http_N_overloaded", async () => {
    for (const status of [429, 502, 503]) {
      const restore = withFetch(async () => new Response("busy", { status }));
      try {
        const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
        assert.equal(bad.healthy, false);
        assert.equal(bad.reason, `http_${status}_overloaded`);
      } finally {
        restore();
      }
    }
  });

  it("flags plain HTTP errors without overloaded suffix", async () => {
    const restore = withFetch(async () => new Response("nope", { status: 500 }));
    try {
      const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
      assert.equal(bad.healthy, false);
      assert.equal(bad.reason, "http_500");
    } finally {
      restore();
    }
  });

  it("fails closed on invalid JSON with HTTP 200", async () => {
    const restore = withFetch(async () => new Response("not-json{{{", { status: 200 }));
    try {
      const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
      assert.equal(bad.healthy, false);
      assert.equal(bad.reason, "invalid_json");
    } finally {
      restore();
    }
  });

  it("fails closed on overload cue in HTTP 200 body text", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "pong" } }],
      warning: "Upstream error from Nvidia: Service temporarily overloaded",
    });
    const restore = withFetch(async () => new Response(body, { status: 200 }));
    try {
      const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
      assert.equal(bad.healthy, false);
      assert.equal(bad.reason, "overloaded_body");
    } finally {
      restore();
    }
  });

  it("maps abort to probe_timeout using short overall timeoutMs", async () => {
    const restore = withFetch(async (_url, init) => {
      const signal = init.signal;
      await new Promise((resolve, reject) => {
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
      return Response.json({});
    });
    try {
      // probeMs = min(timeoutMs, probeCap) → 80ms fail-fast
      const bad = await probePrimaryModel(
        "openrouter/x",
        "k",
        "http://or.example/v1",
        80,
        undefined,
        { probeTimeoutMs: 12_000 },
      );
      assert.equal(bad.healthy, false);
      assert.equal(bad.reason, "probe_timeout");
      assert.ok(bad.elapsedMs < 2000, `elapsedMs=${bad.elapsedMs}`);
    } finally {
      restore();
    }
  });

  it("maps network throw to probe_error", async () => {
    const restore = withFetch(async () => {
      throw new Error("fetch failed");
    });
    try {
      const bad = await probePrimaryModel("openrouter/x", "k", "http://or.example/v1", 5000);
      assert.equal(bad.healthy, false);
      assert.match(bad.reason, /^probe_error:fetch failed/u);
    } finally {
      restore();
    }
  });

  it("clamps options.probeTimeoutMs floor at 2000 via min with timeoutMs", async () => {
    const restore = withFetch(async (_url, init) => {
      const signal = init.signal;
      await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return Response.json({});
    });
    try {
      // options.probeTimeoutMs=100 → floor 2000; timeoutMs=2500 → probeMs=2000
      const started = Date.now();
      const bad = await probePrimaryModel(
        "openrouter/x",
        "k",
        "http://or.example/v1",
        2500,
        undefined,
        { probeTimeoutMs: 100 },
      );
      const elapsed = Date.now() - started;
      assert.equal(bad.healthy, false);
      assert.equal(bad.reason, "probe_timeout");
      // Should not abort at ~100ms; floor is 2000 then min(2500,2000)=2000
      assert.ok(elapsed >= 1500, `elapsed=${elapsed}`);
      assert.ok(elapsed < 4500, `elapsed=${elapsed}`);
    } finally {
      restore();
    }
  });
});

describe("healthCheckModel wraps probe", () => {
  it("returns true only when probe is healthy", async () => {
    const restore = withFetch(async () =>
      Response.json({ choices: [{ message: { content: "pong" } }] }),
    );
    try {
      assert.equal(
        await healthCheckModel("openrouter/x", "k", "http://or.example/v1", 5000),
        true,
      );
    } finally {
      restore();
    }
  });

  it("returns false on empty probe content", async () => {
    const restore = withFetch(async () =>
      Response.json({ choices: [{ message: { content: "" } }] }),
    );
    try {
      assert.equal(
        await healthCheckModel("openrouter/x", "k", "http://or.example/v1", 5000),
        false,
      );
    } finally {
      restore();
    }
  });
});

describe("resolveLlmConfig primaryProbeTimeoutMs", () => {
  it("defaults to DEFAULT_PRIMARY_PROBE_TIMEOUT_MS", () => {
    const cfg = resolveLlmConfig(
      { llm: { model: "openrouter/x", apiKey: "k", baseURL: "http://or.example/v1" } },
      {},
    );
    assert.equal(cfg.primaryProbeTimeoutMs, DEFAULT_PRIMARY_PROBE_TIMEOUT_MS);
  });

  it("clamps configured probe timeout to at least 2000", () => {
    const cfg = resolveLlmConfig(
      {
        llm: {
          model: "openrouter/x",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          primaryProbeTimeoutMs: 500,
        },
      },
      {},
    );
    assert.equal(cfg.primaryProbeTimeoutMs, 2000);
  });

  it("accepts explicit primaryProbeTimeoutMs", () => {
    const cfg = resolveLlmConfig(
      {
        llm: {
          model: "openrouter/x",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          primaryProbeTimeoutMs: 12_000,
        },
      },
      {},
    );
    assert.equal(cfg.primaryProbeTimeoutMs, 12_000);
  });
});

describe("completeText pre-compact probe edges", () => {
  it("uses primary completion after healthy probe", async () => {
    const calls = [];
    const restore = withFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (body.max_tokens === 16) {
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      }
      return Response.json({ choices: [{ message: { content: "primary-ok" } }] });
    });
    try {
      const text = await completeText(
        {
          model: "openrouter/primary",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          timeoutMs: 30_000,
          primaryProbeTimeoutMs: 5_000,
          fallbacks: ["litellm/fb1"],
          openclawConfig: providersConfig(),
        },
        { system: "s", user: "u" },
      );
      assert.equal(text, "primary-ok");
      assert.equal(calls.filter((c) => c.max_tokens === 16).length, 1);
      assert.ok(calls.some((c) => c.max_tokens !== 16 && c.model === "primary"));
      assert.ok(!calls.some((c) => c.max_tokens !== 16 && c.model === "fb1"));
    } finally {
      restore();
    }
  });

  it("skips primary on overload body and uses fallback", async () => {
    const calls = [];
    const restore = withFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (body.max_tokens === 16) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "pong" } }],
            detail: "Upstream error: overloaded",
          }),
          { status: 200 },
        );
      }
      return Response.json({ choices: [{ message: { content: "fallback-ok" } }] });
    });
    try {
      const text = await completeText(
        {
          model: "openrouter/primary",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          timeoutMs: 30_000,
          primaryProbeTimeoutMs: 5_000,
          fallbacks: ["litellm/fb1"],
          openclawConfig: providersConfig(),
        },
        { system: "s", user: "u" },
      );
      assert.equal(text, "fallback-ok");
      assert.ok(!calls.some((c) => c.max_tokens !== 16 && c.model === "primary"));
      assert.ok(calls.some((c) => c.max_tokens !== 16 && c.model === "fb1"));
    } finally {
      restore();
    }
  });

  it("skips primary on probe_timeout and uses fallback", async () => {
    const calls = [];
    const restore = withFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (body.max_tokens === 16) {
        const signal = init.signal;
        await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      return Response.json({ choices: [{ message: { content: "fallback-ok" } }] });
    });
    try {
      const text = await completeText(
        {
          model: "openrouter/primary",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          timeoutMs: 100,
          primaryProbeTimeoutMs: 12_000,
          fallbacks: ["litellm/fb1"],
          openclawConfig: providersConfig(),
        },
        { system: "s", user: "u" },
      );
      assert.equal(text, "fallback-ok");
      assert.ok(!calls.some((c) => c.max_tokens !== 16 && c.model === "primary"));
    } finally {
      restore();
    }
  });

  it("still attempts primary when probe fails and fallbacks are empty", async () => {
    assert.deepEqual(selectModelsToTry(false, "openrouter/primary", []), ["openrouter/primary"]);
    const calls = [];
    const restore = withFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (body.max_tokens === 16) {
        return Response.json({ choices: [{ message: { content: "" } }] });
      }
      return Response.json({ choices: [{ message: { content: "primary-retry-ok" } }] });
    });
    try {
      const text = await completeText(
        {
          model: "openrouter/primary",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          timeoutMs: 30_000,
          primaryProbeTimeoutMs: 5_000,
          fallbacks: [],
          openclawConfig: providersConfig(),
        },
        { system: "s", user: "u" },
      );
      assert.equal(text, "primary-retry-ok");
      assert.ok(calls.some((c) => c.max_tokens !== 16 && c.model === "primary"));
    } finally {
      restore();
    }
  });

  it("logs probe failure reason before skipping to fallbacks", async () => {
    /** @type {string[]} */
    const logs = [];
    const restore = withFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (body.max_tokens === 16) {
        return new Response("down", { status: 503 });
      }
      return Response.json({ choices: [{ message: { content: "fallback-ok" } }] });
    });
    try {
      await completeText(
        {
          model: "openrouter/primary",
          apiKey: "k",
          baseURL: "http://or.example/v1",
          timeoutMs: 30_000,
          primaryProbeTimeoutMs: 5_000,
          fallbacks: ["litellm/fb1"],
          openclawConfig: providersConfig(),
        },
        { system: "s", user: "u", log: (m) => logs.push(m) },
      );
      assert.ok(logs.some((m) => /probing primary model/u.test(m)));
      assert.ok(logs.some((m) => /not ready \(http_503_overloaded/u.test(m)));
      assert.ok(logs.some((m) => /fallback model litellm\/fb1 succeeded/u.test(m)));
    } finally {
      restore();
    }
  });
});
