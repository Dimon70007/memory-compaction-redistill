/**
 * Integration test for fallback model support in memory-compaction-redistill.
 *
 * Tests:
 * 1. All configured models respond to health-check
 * 2. When primary model is unreachable, fallback to litellm works
 * 3. Model ID normalization (bare name → provider/name)
 * 4. Provider config (apiKey, baseURL) resolved from openclawConfig
 * 5. Full compaction LiteLLM round-trip
 *
 * Run: node tests/fallback-integration-test.mjs
 * Requires: OPENROUTER_API_KEY, LITELLM_MASTER_KEY in env
 *
 * Note: The `config.fallbacks` array below mirrors what would be in
 * `agents.defaults.model.fallbacks` in openclaw.json. The plugin reads
 * fallback models from the global config, not from plugin-level config.
 */

// === Inline copies of private functions (mirrors lib/llm.js) ===

function extractModelId(fullModel) {
  const slash = fullModel.indexOf("/");
  return slash > 0 ? fullModel.slice(slash + 1) : fullModel;
}

function normalizeModelId(model) {
  if (model.includes("/")) return model;
  const knownProviders = ["openrouter", "litellm", "anthropic", "google", "meta-llama", "nvidia"];
  for (const provider of knownProviders) {
    if (model.toLowerCase().includes(provider.replace(/-/g, ""))) {
      return `${provider}/${model}`;
    }
  }
  return `litellm/${model}`;
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

// === Configuration (mirrors openclaw.json) ===

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY;

const config = {
  model: "openrouter/owl-alpha",
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  timeoutMs: 120000,
  fallbacks: [
    "openrouter/poolside/laguna-xs.2:free",
    "litellm/gemma4-26b-a4b",
    "openrouter/poolside/laguna-m.1:free",
  ],
};

const providers = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
  },
  litellm: {
    baseUrl: "http://<litellm-host>:4000/v1",
    apiKey: LITELLM_MASTER_KEY,
  },
};

function detectBaseURL(model) {
  const normalized = normalizeModelId(model);
  const provider = normalized.split("/")[0];
  return providers[provider]?.baseUrl ?? config.baseURL;
}

function detectApiKey(model) {
  const normalized = normalizeModelId(model);
  const provider = normalized.split("/")[0];
  return providers[provider]?.apiKey ?? config.apiKey;
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

  // Test 1: Model ID normalization
  console.log("--- Test 1: Model ID normalization ---");
  assert(normalizeModelId("openrouter/owl-alpha") === "openrouter/owl-alpha", "Already prefixed model unchanged");
  assert(normalizeModelId("gemma4-26b-a4b") === "litellm/gemma4-26b-a4b", "Bare model gets litellm prefix");
  assert(normalizeModelId("litellm/gemma4-26b-a4b") === "litellm/gemma4-26b-a4b", "litellm/ model unchanged");
  assert(extractModelId("openrouter/owl-alpha") === "owl-alpha", "Extract model ID strips provider");
  assert(extractModelId("gemma4-26b-a4b") === "gemma4-26b-a4b", "Extract model ID passes bare name");

  // Test 2: Provider config resolution
  console.log("\n--- Test 2: Provider config resolution ---");
  assert(detectBaseURL("openrouter/owl-alpha") === "https://openrouter.ai/api/v1", "OpenRouter baseURL correct");
  assert(detectBaseURL("litellm/gemma4-26b-a4b") === "http://<litellm-host>:4000/v1", "LiteLLM baseURL correct");
  assert(detectBaseURL("gemma4-26b-a4b") === "http://<litellm-host>:4000/v1", "Bare model resolves to LiteLLM baseURL");
  assert(detectApiKey("openrouter/owl-alpha") === OPENROUTER_API_KEY, "OpenRouter apiKey correct");
  assert(detectApiKey("litellm/gemma4-26b-a4b") === LITELLM_MASTER_KEY, "LiteLLM apiKey correct");
  assert(detectApiKey("gemma4-26b-a4b") === LITELLM_MASTER_KEY, "Bare model resolves to LiteLLM apiKey");

  // Test 3: Health checks on real endpoints
  console.log("\n--- Test 3: Health checks (real endpoints) ---");
  if (!OPENROUTER_API_KEY || !LITELLM_MASTER_KEY) {
    console.log("  ⚠️  Skipping: OPENROUTER_API_KEY or LITELLM_MASTER_KEY not set");
  } else {
    const litellmHealthy = await healthCheckModel("litellm/gemma4-26b-a4b", LITELLM_MASTER_KEY, "http://<litellm-host>:4000/v1", 5000);
    assert(litellmHealthy, "LiteLLM gemma4-26b-a4b responds to health-check");

    const openrouterHealthy = await healthCheckModel("openrouter/owl-alpha", OPENROUTER_API_KEY, "https://openrouter.ai/api/v1", 10000);
    assert(openrouterHealthy, "OpenRouter owl-alpha responds to health-check");
  }

  // Test 4: Fallback when primary is unreachable
  console.log("\n--- Test 4: Fallback simulation (primary unreachable) ---");
  if (!LITELLM_MASTER_KEY) {
    console.log("  ⚠️  Skipping: LITELLM_MASTER_KEY not set");
  } else {
    // Simulate broken OpenRouter
    const brokenBaseURL = "https://openrouter.ai.invalid/api/v1";
    const start = Date.now();
    const primaryHealthy = await healthCheckModel("openrouter/owl-alpha", OPENROUTER_API_KEY, brokenBaseURL, 5000);
    const elapsed = Date.now() - start;
    assert(!primaryHealthy, `Broken primary detected as unhealthy (${elapsed}ms)`);
    assert(elapsed < 15000, "Health-check timeout is reasonable (< 15s)");

    // Fallback to litellm
    const fallbackStart = Date.now();
    const fallbackResult = await callModel("litellm/gemma4-26b-a4b", LITELLM_MASTER_KEY, "http://<litellm-host>:4000/v1", 10000);
    const fallbackElapsed = Date.now() - fallbackStart;
    assert(fallbackResult && fallbackResult.length > 0, `Fallback to litellm succeeded (${fallbackElapsed}ms)`);
  }

  // Test 5: Full compaction round-trip via LiteLLM
  console.log("\n--- Test 5: Full compaction via LiteLLM ---");
  if (!LITELLM_MASTER_KEY) {
    console.log("  ⚠️  Skipping: LITELLM_MASTER_KEY not set");
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("http://<litellm-host>:4000/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma4-26b-a4b",
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
      assert(response.ok && content, "LiteLLM compaction round-trip succeeded");
      assert(data.usage?.total_tokens > 0, `Compaction used ${data.usage?.total_tokens} tokens`);
    } finally {
      clearTimeout(timeout);
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
