import { resolveEnvVars, asNonEmptyString } from "./env.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * @typedef {object} LlmResolvedConfig
 * @property {string} model
 * @property {string} apiKey
 * @property {string} baseURL
 * @property {number} timeoutMs
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
  const apiKey = rawApiKey.includes("${") ? resolveEnvVars(rawApiKey) : rawApiKey;
  const baseURL = asNonEmptyString(pluginLlm?.baseURL) ?? DEFAULT_BASE_URL;
  const timeoutMs =
    typeof pluginLlm?.timeoutMs === "number" && Number.isFinite(pluginLlm.timeoutMs)
      ? Math.max(5000, Math.floor(pluginLlm.timeoutMs))
      : 120000;
  return {
    model: compactionModel,
    apiKey,
    baseURL: baseURL.replace(/\/+$/u, ""),
    timeoutMs,
  };
}

/**
 * @param {LlmResolvedConfig} config
 * @param {{ system: string; user: string; signal?: AbortSignal }} params
 * @returns {Promise<string>}
 */
export async function completeText(config, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  try {
    const slash = config.model.indexOf("/");
    const modelId = slash > 0 ? config.model.slice(slash + 1) : config.model;
    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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
