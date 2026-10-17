import { resolveEnvVars, asNonEmptyString } from "./env.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Default cap for primary pre-compact probe (fail fast → fallback). */
export const DEFAULT_PRIMARY_PROBE_TIMEOUT_MS = 12_000;

/**
 * @typedef {object} LlmResolvedConfig
 * @property {string} model
 * @property {string} apiKey
 * @property {string} baseURL
 * @property {number} timeoutMs
 * @property {number} [primaryProbeTimeoutMs]
 * @property {string[]} fallbacks
 * @property {(msg: string) => void} log
 * @property {unknown} [openclawConfig]
 */

/**
 * @param {unknown} pluginConfig
 * @param {unknown} openclawConfig
 * @returns {LlmResolvedConfig}
 */
export function resolveLlmConfig(pluginConfig, openclawConfig) {
  const pluginLlm =
    pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
      ? /** @type {{ llm?: Record<string, unknown> }} */ (pluginConfig).llm
      : undefined;
  const compactionModel = asNonEmptyString(
    pluginLlm?.model ??
      /** @type {{ agents?: { defaults?: { compaction?: { model?: string } } } }} */ (
        openclawConfig
      )?.agents?.defaults?.compaction?.model,
  );
  if (!compactionModel) {
    throw new Error("memory-compaction-redistill: set plugins.entries.memory-compaction-redistill.config.llm.model or agents.defaults.compaction.model");
  }
  const rawApiKey =
    asNonEmptyString(pluginLlm?.apiKey) ??
    process.env.OPENROUTER_API_KEY ??
    process.env.OPENAI_API_KEY;
  if (!rawApiKey) {
    throw new Error("memory-compaction-redistill: missing LLM apiKey (config or OPENROUTER_API_KEY)");
  }
  let apiKey;
  try {
    apiKey = rawApiKey.includes("${") ? resolveEnvVars(rawApiKey) : rawApiKey;
  } catch {
    // env var not set — try direct env fallback
    apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("memory-compaction-redistill: LLM apiKey env var not set and no fallback available");
    }
  }
  const baseURL = asNonEmptyString(pluginLlm?.baseURL) ?? DEFAULT_BASE_URL;
  const timeoutMs =
    typeof pluginLlm?.timeoutMs === "number" && Number.isFinite(pluginLlm.timeoutMs)
      ? Math.max(5000, Math.floor(pluginLlm.timeoutMs))
      : 120000;
  const primaryProbeTimeoutMs =
    typeof pluginLlm?.primaryProbeTimeoutMs === "number" &&
    Number.isFinite(pluginLlm.primaryProbeTimeoutMs)
      ? Math.max(2000, Math.floor(pluginLlm.primaryProbeTimeoutMs))
      : DEFAULT_PRIMARY_PROBE_TIMEOUT_MS;

  // Read fallback models: explicit plugin config > global agents.defaults.model.fallbacks
  const pluginFallbacksRaw = Array.isArray(pluginLlm?.fallbacks)
    ? pluginLlm.fallbacks.filter((f) => typeof f === "string" && f.trim() && f !== compactionModel)
    : null;
  const defaultModel = /** @type {{ fallbacks?: string[] }} */ (
    /** @type {{ agents?: { defaults?: { model?: { fallbacks?: string[] } } } }} */ (
      openclawConfig
    )?.agents?.defaults?.model
  );
  const globalFallbacks = Array.isArray(defaultModel?.fallbacks)
    ? defaultModel.fallbacks.filter((f) => typeof f === "string" && f.trim() && f !== compactionModel)
    : [];
  const fallbacks = pluginFallbacksRaw ?? globalFallbacks;

  // Explicit fallback config: { baseURL|baseUrl, apiKey, model, timeoutMs }
  // Allows overriding provider settings for fallback models
  const fallbackConfig = pluginLlm?.fallback && typeof pluginLlm.fallback === "object" && !Array.isArray(pluginLlm.fallback)
    ? {
        baseUrl: asNonEmptyString(pluginLlm.fallback.baseURL) ?? asNonEmptyString(pluginLlm.fallback.baseUrl),
        apiKey: asNonEmptyString(pluginLlm.fallback.apiKey),
        model: asNonEmptyString(pluginLlm.fallback.model),
        timeoutMs: typeof pluginLlm.fallback.timeoutMs === "number" && Number.isFinite(pluginLlm.fallback.timeoutMs)
          ? Math.max(5000, Math.floor(pluginLlm.fallback.timeoutMs))
          : undefined,
      }
    : undefined;

  return {
    model: compactionModel,
    apiKey,
    baseURL: baseURL.replace(/\/+$/u, ""),
    timeoutMs,
    primaryProbeTimeoutMs,
    fallbacks,
    fallbackConfig,
    log: (msg) => {},
    openclawConfig,
  };
}

/**
 * Extract model ID from full provider/model string.
 * E.g. "openrouter/owl-alpha" -> "owl-alpha"
 * E.g. "litellm/gemma4-26b-a4b" -> "gemma4-26b-a4b"
 * E.g. "gemma4-26b-a4b" -> "gemma4-26b-a4b" (no prefix)
 *
 * @param {string} fullModel
 * @returns {string}
 */
function extractModelId(fullModel) {
  // Strip provider prefix for all models
  // E.g. "openrouter/owl-alpha" -> "owl-alpha"
  // E.g. "litellm/gemma4-26b-a4b" -> "gemma4-26b-a4b"
  // E.g. "nvidia/nemotron-3-ultra-550b-a55b:free" -> "nvidia/nemotron-3-ultra-550b-a55b:free"
  const slash = fullModel.indexOf("/");
  return slash > 0 ? fullModel.slice(slash + 1) : fullModel;
}

/**
 * Normalize model ID: add provider prefix if missing.
 * Recognizes known provider prefixes and adds them if the model ID lacks one.
 *
 * @param {string} model
 * @returns {string}
 */
function normalizeModelId(model) {
  if (model.includes("/")) return model; // Already has prefix
  // Check if it matches a known model in config
  // For now, assume litellm if it looks like a local model name
  const knownProviders = ["openrouter", "litellm", "anthropic", "google", "meta-llama", "nvidia"];
  // If model name contains known provider substring, infer provider
  for (const provider of knownProviders) {
    if (model.toLowerCase().includes(provider.replace(/-/g, ""))) {
      return `${provider}/${model}`;
    }
  }
  // Default: assume litellm for unknown models without prefix
  return `litellm/${model}`;
}

/**
 * Ordered models to attempt after primary health check.
 * Unhealthy primary is skipped when fallbacks exist (C1).
 *
 * @param {boolean} primaryHealthy
 * @param {string} primaryModel
 * @param {string[]} fallbacks
 * @returns {string[]}
 */
export function selectModelsToTry(primaryHealthy, primaryModel, fallbacks) {
  const fb = Array.isArray(fallbacks) ? fallbacks.filter((m) => typeof m === "string" && m.trim()) : [];
  if (primaryHealthy) {
    return [primaryModel, ...fb];
  }
  if (fb.length > 0) {
    return [...fb];
  }
  return [primaryModel];
}

/**
 * Whether explicit plugin llm.fallback applies to this model (I2).
 *
 * @param {string} model
 * @param {{ model?: string } | undefined} fallbackConfig
 * @returns {boolean}
 */
export function fallbackConfigMatchesModel(model, fallbackConfig) {
  if (!fallbackConfig?.model) {
    return false;
  }
  const configured = fallbackConfig.model.trim();
  if (!configured) {
    return false;
  }
  if (model === configured) {
    return true;
  }
  return extractModelId(model) === extractModelId(configured);
}

/**
 * Resolve baseURL/apiKey/timeout for one attempt in the fallback chain.
 *
 * @param {string} model
 * @param {boolean} isPrimary
 * @param {{
 *   apiKey: string;
 *   baseURL: string;
 *   timeoutMs: number;
 *   fallbackConfig?: {
 *     baseUrl?: string;
 *     apiKey?: string;
 *     model?: string;
 *     timeoutMs?: number;
 *   };
 *   openclawConfig?: unknown;
 * }} config
 * @returns {{ baseURL: string; apiKey: string; timeoutMs: number }}
 */
export function resolveAttemptCredentials(model, isPrimary, config) {
  const fallbackConfig = config.fallbackConfig;
  if (!isPrimary && fallbackConfig?.baseUrl && fallbackConfigMatchesModel(model, fallbackConfig)) {
    return {
      baseURL: fallbackConfig.baseUrl.replace(/\/+$/u, ""),
      apiKey: fallbackConfig.apiKey ?? config.apiKey,
      timeoutMs: fallbackConfig.timeoutMs ?? config.timeoutMs,
    };
  }
  return {
    baseURL: detectBaseURL(model, config.baseURL, config.openclawConfig),
    apiKey: detectApiKey(model, config.apiKey, config.openclawConfig),
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Detect base URL from model string by looking up the provider config.
 * Normalizes model ID first to handle models without provider prefix.
 *
 * @param {string} model
 * @param {string} defaultBaseURL
 * @param {unknown} [openclawConfig]
 * @returns {string}
 */
export function detectBaseURL(model, defaultBaseURL, openclawConfig) {
  const normalizedModel = normalizeModelId(model);
  const provider = normalizedModel.split("/")[0];
  const providerConfig = /** @type {{ baseUrl?: string }} */ (
    /** @type {{ models?: { providers?: Record<string, { baseUrl?: string }> } }} */ (
      openclawConfig
    )?.models?.providers?.[provider]
  );
  if (providerConfig?.baseUrl) {
    return providerConfig.baseUrl.replace(/\/+$/u, "");
  }
  return defaultBaseURL;
}

/**
 * Detect API key from model string by looking up the provider config.
 * Normalizes model ID first to handle models without provider prefix.
 *
 * @param {string} model
 * @param {string} defaultApiKey
 * @param {unknown} [openclawConfig]
 * @returns {string}
 */
export function detectApiKey(model, defaultApiKey, openclawConfig) {
  const normalizedModel = normalizeModelId(model);
  const provider = normalizedModel.split("/")[0];
  const providerConfig = /** @type {{ apiKey?: string }} */ (
    /** @type {{ models?: { providers?: Record<string, { apiKey?: string }> } }} */ (
      openclawConfig
    )?.models?.providers?.[provider]
  );
  const configKey = providerConfig?.apiKey;
  if (configKey) {
    try {
      return configKey.includes("${") ? resolveEnvVars(configKey) : configKey;
    } catch {
      // env var not set — fall through to env/default
    }
  }
  // Fallback to env vars for known providers
  if (provider === "litellm") {
    return process.env.LITELLM_MASTER_KEY ?? defaultApiKey;
  }
  return defaultApiKey;
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function extractProbeContent(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const root = /** @type {Record<string, unknown>} */ (payload);
  if (typeof root.error === "string" && root.error.trim()) {
    return "";
  }
  if (root.error && typeof root.error === "object") {
    const errObj = /** @type {Record<string, unknown>} */ (root.error);
    const msg = typeof errObj.message === "string" ? errObj.message : "";
    if (msg.trim()) {
      return "";
    }
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return "";
  }
  const message = /** @type {Record<string, unknown>} */ (first).message;
  if (message && typeof message === "object") {
    const content = /** @type {Record<string, unknown>} */ (message).content;
    if (typeof content === "string") {
      return content.trim();
    }
  }
  return "";
}

/**
 * @param {number} status
 * @param {string} bodyText
 * @returns {boolean}
 */
export function looksLikeUpstreamOverload(status, bodyText) {
  const text = String(bodyText || "").toLowerCase();
  if (status === 429 || status === 503 || status === 502) {
    return true;
  }
  return (
    text.includes("overloaded") ||
    text.includes("temporarily unavailable") ||
    text.includes("capacity") ||
    text.includes("rate limit") ||
    text.includes("upstream error")
  );
}

/**
 * Pre-compact probe of the primary model: require HTTP OK + non-empty content
 * within a short timeout. Empty/overloaded responses skip primary → fallbacks.
 *
 * @param {string} model
 * @param {string} apiKey
 * @param {string} baseURL
 * @param {number} timeoutMs overall LLM timeout (probe is capped)
 * @param {unknown} [openclawConfig]
 * @param {{ probeTimeoutMs?: number }} [options]
 * @returns {Promise<{ healthy: boolean; reason: string; elapsedMs: number }>}
 */
export async function probePrimaryModel(
  model,
  apiKey,
  baseURL,
  timeoutMs,
  openclawConfig,
  options = {},
) {
  const started = Date.now();
  const probeCap =
    typeof options.probeTimeoutMs === "number" && Number.isFinite(options.probeTimeoutMs)
      ? Math.max(2000, Math.floor(options.probeTimeoutMs))
      : DEFAULT_PRIMARY_PROBE_TIMEOUT_MS;
  const probeMs = Math.min(timeoutMs, probeCap);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeMs);
  try {
    const modelId = extractModelId(model);
    const modelBaseURL = detectBaseURL(model, baseURL, openclawConfig);
    const modelApiKey = detectApiKey(model, apiKey, openclawConfig);
    const response = await fetch(`${modelBaseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${modelApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        // >1 so healthy models return a token; max_tokens=1 often yields empty content.
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      const reason = looksLikeUpstreamOverload(response.status, bodyText)
        ? `http_${response.status}_overloaded`
        : `http_${response.status}`;
      return { healthy: false, reason, elapsedMs: Date.now() - started };
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return {
        healthy: false,
        reason: "invalid_json",
        elapsedMs: Date.now() - started,
      };
    }
    if (looksLikeUpstreamOverload(response.status, bodyText)) {
      return {
        healthy: false,
        reason: "overloaded_body",
        elapsedMs: Date.now() - started,
      };
    }
    const content = extractProbeContent(payload);
    if (!content) {
      return {
        healthy: false,
        reason: "empty_content",
        elapsedMs: Date.now() - started,
      };
    }
    return { healthy: true, reason: "ok", elapsedMs: Date.now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    const reason =
      name === "AbortError" || /aborted/i.test(msg) ? "probe_timeout" : `probe_error:${msg.slice(0, 80)}`;
    return { healthy: false, reason, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Quick health check: send a minimal request to verify the model is usable.
 * Returns true only when the probe gets non-empty completion content.
 *
 * @param {string} model
 * @param {string} apiKey
 * @param {string} baseURL
 * @param {number} timeoutMs
 * @param {unknown} [openclawConfig]
 * @param {{ probeTimeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function healthCheckModel(
  model,
  apiKey,
  baseURL,
  timeoutMs,
  openclawConfig,
  options = {},
) {
  const result = await probePrimaryModel(
    model,
    apiKey,
    baseURL,
    timeoutMs,
    openclawConfig,
    options,
  );
  return result.healthy;
}

/**
 * Call a single model with timeout and error handling.
 *
 * @param {string} model
 * @param {string} apiKey
 * @param {string} baseURL
 * @param {{ system: string; user: string; signal?: AbortSignal }} params
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function callModel(model, apiKey, baseURL, params, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
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
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const payload = /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */ (
      await response.json()
    );
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("LLM returned empty content");
    }
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Complete text with fallback support.
 * Tries the primary model first, then falls back to secondary models.
 * Before starting, does a quick health check on the primary model.
 * If the primary is unreachable, skips directly to fallbacks.
 *
 * @param {LlmResolvedConfig} config
 * @param {{ system: string; user: string; signal?: AbortSignal; log?: (msg: string) => void }} params
 * @returns {Promise<string>}
 */
export async function completeText(config, params) {
  const { model: primaryModel, apiKey, baseURL, timeoutMs, fallbacks } = config;
  const log = params.log ?? (() => {});
  const probeTimeoutMs =
    typeof config.primaryProbeTimeoutMs === "number" &&
    Number.isFinite(config.primaryProbeTimeoutMs)
      ? config.primaryProbeTimeoutMs
      : DEFAULT_PRIMARY_PROBE_TIMEOUT_MS;

  // Fail-fast primary probe (content + overload aware) before long compaction summarize.
  log(
    `memory-compaction-redistill: probing primary model ${primaryModel} (timeoutMs=${probeTimeoutMs})...`,
  );
  const probe = await probePrimaryModel(
    primaryModel,
    apiKey,
    baseURL,
    timeoutMs,
    config.openclawConfig,
    { probeTimeoutMs },
  );
  const primaryHealthy = probe.healthy;

  if (!primaryHealthy) {
    log(
      `memory-compaction-redistill: primary model ${primaryModel} not ready (${probe.reason}, ${probe.elapsedMs}ms), skipping to fallbacks`,
    );
  } else {
    log(
      `memory-compaction-redistill: primary model ${primaryModel} probe ok (${probe.elapsedMs}ms)`,
    );
  }

  const modelsToTry = selectModelsToTry(primaryHealthy, primaryModel, fallbacks);

  /** @type {string[]} */
  const errors = [];

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    const isPrimary = model === primaryModel;

    let modelBaseURL;
    let modelApiKey;
    let modelTimeoutMs;
    try {
      const creds = resolveAttemptCredentials(model, isPrimary, config);
      modelBaseURL = creds.baseURL;
      modelApiKey = creds.apiKey;
      modelTimeoutMs = creds.timeoutMs;
      if (!isPrimary && fallbackConfigMatchesModel(model, config.fallbackConfig)) {
        log(`memory-compaction-redistill: using explicit fallback config for ${model}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: config error: ${errMsg}`);
      log(`memory-compaction-redistill: model ${model} config error: ${errMsg}`);
      continue;
    }

    log(`memory-compaction-redistill: trying model ${model} (attempt ${i + 1}/${modelsToTry.length})...`);

    try {
      const result = await callModel(model, modelApiKey, modelBaseURL, {
        system: params.system,
        user: params.user,
        signal: params.signal,
      }, modelTimeoutMs);

      if (!isPrimary) {
        log(`memory-compaction-redistill: fallback model ${model} succeeded`);
      }
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: ${errMsg}`);
      log(`memory-compaction-redistill: model ${model} failed: ${errMsg}`);
      continue;
    }
  }

  // All models failed
  const errorSummary = errors.join("; ");
  throw new Error(`All LLM models failed. Errors: ${errorSummary}`);
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/iu);
  const candidate = fence ? fence[1].trim() : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}
