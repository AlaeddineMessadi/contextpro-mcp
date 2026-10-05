// Shared pre-query freshness gate for structural code intelligence.
// FEATURE: Every graph reader observes current files without refresh stampedes.

import { resolve } from "path";
import { getDB } from "./db.js";
import { quickRefresh, reindex } from "../tools/reindex.js";
import { requestFreshness } from "./request-context.js";
import { sharedCompute } from "./local-daemon.js";

export interface IndexFreshnessResult {
  checked: boolean;
  refreshed: boolean;
  fullReindex: boolean;
  staleCount: number;
  waitedForIndexing: boolean;
  durationMs: number;
  warning: string | null;
}

const refreshes = new Map<string, Promise<IndexFreshnessResult>>();

function autoRefreshDisabled(): boolean {
  const raw = (process.env.CONTEXTPRO_AUTO_REFRESH ?? process.env.CONTEXTPLUS_AUTO_REFRESH ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

async function runFreshnessCheck(rootDir: string): Promise<IndexFreshnessResult> {
  const shared = await sharedCompute<IndexFreshnessResult>("freshness", { rootDir });
  if (shared) return shared.value;
  const startedAt = Date.now();
  if (autoRefreshDisabled()) {
    return {
      checked: false,
      refreshed: false,
      fullReindex: false,
      staleCount: 0,
      waitedForIndexing: false,
      durationMs: 0,
      warning: "Automatic index refresh is disabled by CONTEXTPRO_AUTO_REFRESH.",
    };
  }

  try {
    const quick = await quickRefresh(rootDir, { includeEmbeddings: false });
    let refreshed = quick.refreshed;
    let fullReindex = quick.fullReindex === true;
    let warning = quick.indexingTimedOut
      ? "Index refresh timed out waiting for another process; serving the last complete index."
      : null;

    if (!quick.complete && !quick.indexingTimedOut) {
      const db = await getDB(rootDir);
      const generationBefore = db.getIndexGeneration();
      await reindex({ rootDir, noEmbed: true, autoHubs: false });
      refreshed = db.getIndexGeneration() > generationBefore;
      fullReindex = refreshed;
      const confirmation = await quickRefresh(rootDir, { includeEmbeddings: false });
      refreshed = refreshed || confirmation.refreshed;
      fullReindex = fullReindex || confirmation.fullReindex === true;
      if (!confirmation.complete) {
        warning = "A large source change was detected but the fallback reindex did not complete; serving the last complete index.";
      }
    }

    return {
      checked: true,
      refreshed,
      fullReindex,
      staleCount: quick.staleCount,
      waitedForIndexing: quick.waitedForIndexing === true,
      durationMs: Date.now() - startedAt,
      warning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[contextpro/freshness] refresh failed; serving last complete index: ${message}\n`);
    return {
      checked: true,
      refreshed: false,
      fullReindex: false,
      staleCount: 0,
      waitedForIndexing: false,
      durationMs: Date.now() - startedAt,
      warning: `Automatic index refresh failed: ${message}`,
    };
  }
}

/**
 * Coalesce concurrent checks inside this process. Cross-process writers are
 * coordinated by the SQLite compare-and-set lock in quickRefresh/reindex.
 */
export async function ensureFreshIndex(rootDir: string): Promise<IndexFreshnessResult> {
  const normalizedRoot = resolve(rootDir);
  const request = requestFreshness();
  const existing = request?.get(normalizedRoot) ?? refreshes.get(normalizedRoot);
  if (existing) { request?.set(normalizedRoot, existing); return existing; }
  const pending = runFreshnessCheck(normalizedRoot);
  refreshes.set(normalizedRoot, pending);
  request?.set(normalizedRoot, pending);
  try {
    return await pending;
  } finally {
    if (refreshes.get(normalizedRoot) === pending) refreshes.delete(normalizedRoot);
  }
}
