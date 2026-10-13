/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function resolveEnvVars(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }
  let missing = false;
  const result = value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      missing = true;
      return "";
    }
    return envValue;
  });
  if (missing) {
    throw new Error(`Environment variable in ${value} is not set`);
  }
  return result;
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
