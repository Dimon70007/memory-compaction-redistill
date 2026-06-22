/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function resolveEnvVars(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function asNonEmptyString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
