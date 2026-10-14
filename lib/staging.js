import { mkdir, writeFile, readdir, readFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { asNonEmptyString } from "./env.js";

/**
 * @typedef {object} StagingConfig
 * @property {boolean} enabled
 * @property {string} dir
 * @property {number} [chunkMaxChars]
 */

/**
 * @param {Record<string, unknown>} pluginConfig
 * @returns {StagingConfig}
 */
export function resolveStagingConfig(pluginConfig) {
  const staging =
    pluginConfig.staging && typeof pluginConfig.staging === "object" && !Array.isArray(pluginConfig.staging)
      ? /** @type {Record<string, unknown>} */ (pluginConfig.staging)
      : {};
  const enabled = staging.enabled === true;
  const dir = asNonEmptyString(staging.dir) ?? "memory/compaction-staging";
  if (!enabled) {
    return { enabled: false, dir };
  }
  const rawMax = staging.chunkMaxChars;
  if (typeof rawMax !== "number" || !Number.isFinite(rawMax) || rawMax < 1) {
    throw new Error(
      "memory-compaction-redistill: staging.enabled requires staging.chunkMaxChars (positive number); refusing silent default",
    );
  }
  return {
    enabled: true,
    dir,
    chunkMaxChars: Math.floor(rawMax),
  };
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function sessionKeyToDirName(sessionKey) {
  return sessionKey.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 120) || "unknown";
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @returns {string}
 */
export function stagingSessionDir(params) {
  return join(params.workspaceDir, params.stagingDir, sessionKeyToDirName(params.sessionKey));
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @param {string} params.residue
 * @param {number} params.chunkMaxChars
 * @returns {Promise<string[]>} chunk ids written
 */
export async function writeResidueChunks(params) {
  const residue = params.residue ?? "";
  if (!residue.trim()) {
    return [];
  }
  const max = params.chunkMaxChars;
  if (typeof max !== "number" || max < 1) {
    throw new Error("writeResidueChunks: chunkMaxChars required");
  }
  const dir = stagingSessionDir(params);
  await mkdir(dir, { recursive: true });
  const existing = await listStagingChunks(params);
  let nextIndex = existing.length + 1;
  /** @type {string[]} */
  const ids = [];
  for (let offset = 0; offset < residue.length; offset += max) {
    const piece = residue.slice(offset, offset + max);
    const id = `chunk-${String(nextIndex).padStart(4, "0")}`;
    nextIndex += 1;
    await writeFile(join(dir, `${id}.md`), piece, "utf8");
    ids.push(id);
  }
  return ids;
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @returns {Promise<Array<{ id: string; content: string; path: string }>>}
 */
export async function listStagingChunks(params) {
  const dir = stagingSessionDir(params);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const chunkNames = names.filter((n) => /^chunk-\d{4}\.md$/u.test(n)).sort();
  /** @type {Array<{ id: string; content: string; path: string }>} */
  const out = [];
  for (const name of chunkNames) {
    const path = join(dir, name);
    const content = await readFile(path, "utf8");
    out.push({ id: name.replace(/\.md$/u, ""), content, path });
  }
  return out;
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @param {string[]} params.chunkIds
 * @returns {Promise<void>}
 */
export async function deleteStagingChunks(params) {
  const dir = stagingSessionDir(params);
  for (const id of params.chunkIds) {
    const safe = /^chunk-\d{4}$/u.test(id) ? id : null;
    if (!safe) continue;
    await unlink(join(dir, `${safe}.md`)).catch(() => {});
  }
  // drop empty session dir + stale manifest if no chunks left
  const left = await listStagingChunks(params);
  if (left.length === 0) {
    await unlink(join(dir, "consumed.json")).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @param {string[]} params.chunkIds
 * @returns {Promise<void>}
 */
export async function writeConsumedManifest(params) {
  const dir = stagingSessionDir(params);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "consumed.json"),
    JSON.stringify({ chunkIds: params.chunkIds, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

/**
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.stagingDir
 * @param {string} params.sessionKey
 * @returns {Promise<string[]>}
 */
export async function readConsumedManifest(params) {
  const path = join(stagingSessionDir(params), "consumed.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(raw?.chunkIds)) {
      return [];
    }
    return raw.chunkIds.filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}
