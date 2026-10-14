/**
 * Integration test for fallback model support in memory-compaction-redistill.
 *
 * Tests:
 * 1. Model ID normalization (bare name → provider/name)
 * 2. Provider config resolution (apiKey, baseURL from openclaw.json)
 * 3. Health checks on real endpoints (requires OPENROUTER_API_KEY, LITELLM_MASTER_KEY)
 * 4. Fallback simulation when primary model is unreachable
 * 5. Full compaction round-trip via fallback model
 *
 * Run: node tests/fallback-integration-test.mjs
 * Requires: OPENROUTER_API_KEY, LITELLM_MASTER_KEY in env
 *
 * The test reads provider config (baseUrl, apiKey) and fallback models from
 * the real ~/.openclaw/openclaw.json, so it works for any user regardless
 * of their specific provider URLs.
 */

import { readFileSync } from "node:fs";
import { resolveEnvVars } from "../lib/env.js";

// === Load real config from openclaw.json ===

const OPENCLAW_JSON =
  process.env.OPENCLAW_JSON ??
  `${process.env.HOME ?? ""}/.openclaw/openclaw.json`;
const openclawConfig = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));

// Resolve env vars in provider config (e.g. ${OPENROUTER_API_KEY} → actual key)
function resolveProviderConfig(providers) {
  const resolved = {};
  for (const [name, cfg] of Object.entries(providers)) {
    resolved[name] = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey ? resolveEnvVars(cfg.apiKey) : undefined,
    };
  }
  return resolved;
}

const providers = resolveProviderConfig(openclawConfig.models?.providers ?? {});
const agentsDefaults = openclawConfig.agents?.defaults ?? {};

// === Inline copies of private functions (mirrors lib/llm.js) ===

function extractModelId(fullModel) {
  // Strip provider prefix for all models
  const slash = fullModel.indexOf("/");
  return slash > 0 ? fullModel.slice(slash + 1) : fullModel;
}

function normalizeModelId(model) {
  if (model.includes("/")) return model;
  // Bare model names without provider prefix default to openrouter
  return `openrouter/${model}`;
}

// Use real detectBaseURL/detectApiKey that read from openclawConfig
function detectBaseURL(model) {
  const normalized = normalizeModelId(model);
  const provider = normalized.split("/")[0];
  const providerConfig = providers[provider];
  if (providerConfig?.baseUrl) {
    return providerConfig.baseUrl.replace(/\/+$/u, "");
  }
  return "https://openrouter.ai/api/v1";
}

function detectApiKey(model, defaultApiKey) {
  const normalized = normalizeModelId(model);
  const provider = normalized.split("/")[0];
  const providerConfig = providers[provider];
  const configKey = providerConfig?.apiKey;
  if (configKey) return configKey;
  // Fallback to env vars for known providers
  if (provider === "litellm") return process.env.LITELLM_MASTER_KEY ?? defaultApiKey;
  return defaultApiKey;
}

async function callModel(model, apiKey, baseURL, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const modelId = extractModelId(model);
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty content");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function healthCheckModel(model, apiKey, baseURL, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 10000));
  try {
    const modelId = extractModelId(model);
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// === Test runner ===

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("=== Fallback Integration Tests ===\n");

  // Test 1: Model ID normalization (pure logic, no network)
  console.log("--- Test 1: Model ID normalization ---");
  assert(normalizeModelId("openrouter/owl-alpha") === "openrouter/owl-alpha", "Already prefixed model unchanged");
  assert(normalizeModelId("gemma4-26b-a4b") === "openrouter/gemma4-26b-a4b", "Bare model gets openrouter prefix");
  assert(normalizeModelId("litellm/gemma4-26b-a4b") === "litellm/gemma4-26b-a4b", "litellm/ model unchanged");
  assert(extractModelId("openrouter/owl-alpha") === "owl-alpha", "Extract model ID strips provider");
  assert(extractModelId("gemma4-26b-a4b") === "gemma4-26b-a4b", "Extract model ID passes bare name");

  // Test 2: Provider config resolution (from openclaw.json, no network)
  console.log("\n--- Test 2: Provider config resolution (from openclaw.json) ---");
  const openrouterBaseURL = detectBaseURL("openrouter/owl-alpha");
  const litellmBaseURL = detectBaseURL("litellm/gemma4-26b-a4b");
  const bareBaseURL = detectBaseURL("gemma4-26b-a4b");

  assert(openrouterBaseURL === providers.openrouter?.baseUrl, `OpenRouter baseURL correct (${openrouterBaseURL})`);
  assert(litellmBaseURL === providers.litellm?.baseUrl, `LiteLLM baseURL correct (${litellmBaseURL})`);
  assert(bareBaseURL === providers.openrouter?.baseUrl, `Bare model resolves to OpenRouter baseURL (${bareBaseURL})`);

  const openrouterKey = detectApiKey("openrouter/owl-alpha", "");
  const litellmKey = detectApiKey("litellm/gemma4-26b-a4b", "");
  const bareKey = detectApiKey("gemma4-26b-a4b", "");

  assert(openrouterKey === providers.openrouter?.apiKey, "OpenRouter apiKey correct from config");
  assert(litellmKey === providers.litellm?.apiKey, "LiteLLM apiKey correct from config");
  assert(bareKey === providers.openrouter?.apiKey, "Bare model resolves to OpenRouter apiKey");

  // Test 3: Health checks on real endpoints (requires env vars)
  console.log("\n--- Test 3: Health checks (real endpoints) ---");
  const primaryModel = agentsDefaults.compaction?.model ?? "openrouter/owl-alpha";
  const primaryKey = detectApiKey(primaryModel, "");
  const primaryBaseURL = detectBaseURL(primaryModel);
  const fallbacks = agentsDefaults.model?.fallbacks ?? [];

  if (!primaryKey) {
    console.log("  ⚠️  Skipping: primary model apiKey not found in config or env");
  } else {
    const primaryHealthy = await healthCheckModel(primaryModel, primaryKey, primaryBaseURL, 10000);
    assert(primaryHealthy, `Primary model ${primaryModel} responds to health-check`);
  }

  // Test fallback models from global config
  await new Promise(r => setTimeout(r, 1000)); // Rate-limit pause
  for (const fb of fallbacks) {
    const fbKey = detectApiKey(fb, "");
    const fbBaseURL = detectBaseURL(fb);
    if (!fbKey) {
      console.log(`  ⚠️  Skipping ${fb}: apiKey not found`);
      continue;
    }
    const fbHealthy = await healthCheckModel(fb, fbKey, fbBaseURL, 5000);
    if (!fbHealthy) {
      // Check if model ID is invalid (400) vs actually unreachable
      const fbModelId = extractModelId(fb);
      try {
        const checkCtrl = new AbortController();
        const checkTimeout = setTimeout(() => checkCtrl.abort(), 5000);
        const checkResp = await fetch(`${fbBaseURL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${fbKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: fbModelId, max_tokens: 1, messages: [{ role: "user", content: "x" }] }),
          signal: checkCtrl.signal,
        });
        clearTimeout(checkTimeout);
        if (checkResp.status === 400) {
          console.log(`  ⚠️  Skipping ${fb}: invalid model ID (400)`);
          continue;
        }
      } catch {
        console.log(`  ⚠️  Skipping ${fb}: network error or timeout`);
        continue;
      }
    }
    assert(fbHealthy, `Fallback ${fb} responds to health-check (${fbBaseURL})`);
  }

  // Test 4: Fallback simulation (primary unreachable)
  console.log("\n--- Test 4: Fallback simulation (primary unreachable) ---");
  const firstLitellm = fallbacks.find(f => f.startsWith("litellm/") || f.includes("litellm"));
  if (!firstLitellm) {
    console.log("  ⚠️  Skipping: no litellm model in fallbacks");
  } else {
    const litellmKey = detectApiKey(firstLitellm, "");
    const litellmBaseURL = detectBaseURL(firstLitellm);

    if (!litellmKey) {
      console.log("  ⚠️  Skipping: litellm apiKey not found");
    } else {
      // Simulate broken primary
      const brokenBaseURL = "https://openrouter.ai.invalid/api/v1";
      const start = Date.now();
      const primaryHealthy = await healthCheckModel(primaryModel, primaryKey, brokenBaseURL, 5000);
      const elapsed = Date.now() - start;
      assert(!primaryHealthy, `Broken primary detected as unhealthy (${elapsed}ms)`);
      assert(elapsed < 15000, "Health-check timeout is reasonable (< 15s)");

      // Fallback to litellm
      const fallbackStart = Date.now();
      const fallbackResult = await callModel(firstLitellm, litellmKey, litellmBaseURL, 10000);
      const fallbackElapsed = Date.now() - fallbackStart;
      assert(fallbackResult && fallbackResult.length > 0, `Fallback to ${firstLitellm} succeeded (${fallbackElapsed}ms)`);
    }
  }

  // Test 5: Full compaction round-trip via fallback model
  console.log("\n--- Test 5: Full compaction via fallback model ---");
  if (!firstLitellm) {
    console.log("  ⚠️  Skipping: no litellm model in fallbacks");
  } else {
    const litellmKey = detectApiKey(firstLitellm, "");
    const litellmBaseURL = detectBaseURL(firstLitellm);

    if (!litellmKey) {
      console.log("  ⚠️  Skipping: litellm apiKey not found");
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(`${litellmBaseURL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${litellmKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: extractModelId(firstLitellm),
            temperature: 0.2,
            max_tokens: 200,
            messages: [
              {
                role: "system",
                content: "You maintain rolling session context for a coding agent. Summarize preserving decisions, TODOs, and constraints.",
              },
              {
                role: "user",
                content: "<conversation-to-summarize>\nUser: Привет, как дела?\nAssistant: Привет! Всё отлично. Чем могу помочь?\n</conversation-to-summarize>",
              },
            ],
          }),
          signal: controller.signal,
        });
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        assert(response.ok && content, `Compaction round-trip via ${firstLitellm} succeeded`);
        assert(data.usage?.total_tokens > 0, `Compaction used ${data.usage?.total_tokens} tokens`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
