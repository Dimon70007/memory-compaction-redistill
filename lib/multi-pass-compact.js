import {
  listStagingChunks,
  writeConsumedManifest,
} from "./staging.js";

const CHUNK_COMPACT_SYSTEM = [
  "You compress one staging residue chunk from a prior failed/degraded compaction sync.",
  "Preserve decisions, identifiers, TODOs, and constraints verbatim where possible.",
  "Output a short markdown note with bullets. No preamble.",
].join("\n");

const MERGE_COMPACT_SYSTEM = [
  "You merge an ordered list of already-compressed notes into one Hybrid Variant B compaction summary.",
  "Order is chronological: older staging chunks first, then newer, then the main-context summary last.",
  "Output MUST contain exactly these sections:",
  "## Previous decisions (carried forward)",
  "## Current decisions",
  "## Superseded / rejected",
  "## Open hypotheses (unconfirmed)",
  "## Open TODOs",
  "## Pending user asks",
  "## Session archive",
  "Do not invent facts not present in the notes. Prefer earlier notes when conflicting unless later explicitly supersedes.",
].join("\n");

/**
 * @typedef {object} MultiPassParams
 * @property {import("./staging.js").StagingConfig} stagingConfig
 * @property {string} workspaceDir
 * @property {string} sessionKey
 * @property {() => Promise<string>} summarizeMain
 * @property {(system: string, user: string) => Promise<string>} compactText
 * @property {(msg: string) => void} [log]
 */

/**
 * Happy path: staging empty → only summarizeMain (existing compact unchanged).
 * Recovery: A (chunks) → B (main) → C (merge list) → consumed manifest.
 *
 * @param {MultiPassParams} params
 * @returns {Promise<{ summary: string; mode: "single" | "multi"; consumedIds: string[] }>}
 */
export async function runCompactWithStaging(params) {
  const log = params.log ?? (() => {});
  const stagingEnabled = params.stagingConfig.enabled === true;
  const chunks =
    stagingEnabled && params.workspaceDir && params.sessionKey
      ? await listStagingChunks({
          workspaceDir: params.workspaceDir,
          stagingDir: params.stagingConfig.dir,
          sessionKey: params.sessionKey,
        })
      : [];

  if (chunks.length === 0) {
    const summary = await params.summarizeMain();
    return { summary, mode: "single", consumedIds: [] };
  }

  log(
    `memory-compaction-redistill: multi-pass compact — ${chunks.length} staging chunk(s) for session`,
  );

  /** @type {string[]} */
  const L = [];
  /** @type {string[]} */
  const consumedIds = [];

  for (const chunk of chunks) {
    try {
      const mini = await params.compactText(
        CHUNK_COMPACT_SYSTEM,
        [`Staging chunk ${chunk.id}:`, "", chunk.content].join("\n"),
      );
      L.push(`### Staging ${chunk.id}\n${mini}`);
      consumedIds.push(chunk.id);
    } catch (err) {
      log(
        `memory-compaction-redistill: staging chunk ${chunk.id} compact failed, leaving remainder for next cycle: ${String(err)}`,
      );
      break;
    }
  }

  const mainSummary = await params.summarizeMain();
  L.push(`### Main context\n${mainSummary}`);

  if (consumedIds.length === 0) {
    // Could not process any chunk — return main-only (do not claim multi success)
    return { summary: mainSummary, mode: "single", consumedIds: [] };
  }

  const finalSummary = await params.compactText(
    MERGE_COMPACT_SYSTEM,
    ["Ordered notes to merge (oldest → newest → main):", "", ...L].join("\n\n"),
  );

  await writeConsumedManifest({
    workspaceDir: params.workspaceDir,
    stagingDir: params.stagingConfig.dir,
    sessionKey: params.sessionKey,
    chunkIds: consumedIds,
  });

  return { summary: finalSummary, mode: "multi", consumedIds };
}
