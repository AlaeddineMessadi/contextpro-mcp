// Self-healing index reconciliation — a periodic FS<->index diff that catches
// drift the FS-watch events miss.
//
// FEATURE: fs.watch is unreliable in practice — it does not recurse on Linux,
// drops events under heavy churn, and misses atomic renames and out-of-band git
// operations. A purely event-driven tracker therefore goes stale during a
// fast-moving session and forces a manual full reindex. This module reconciles
// the index against the real filesystem: new and content-drifted files are
// re-indexed through the same per-file structural pass the tracker already uses,
// and files deleted on disk are pruned. Work is capped per sweep so a large
// backlog drains over several cheap sweeps instead of one long stall.

import { readFile } from "fs/promises";
import { getDB, hashContent } from "./db.js";
import { walkDirectory } from "./walker.js";
import { isSupportedFile } from "./parser.js";
import { resolveProjectPath } from "./path-guard.js";
import { refreshFilesStructural } from "../tools/reindex.js";

export interface ReconcileOptions {
  /** Maximum number of drifted files to refresh in a single sweep. */
  maxFiles?: number;
}

export interface ReconcileResult {
  /** Drifted files this sweep actually re-indexed (new + content-changed). */
  refreshed: number;
  /** Index entries pruned because the file no longer exists on disk. */
  removed: number;
  /** Total drifted files detected this sweep (may exceed `refreshed` when capped). */
  drifted: number;
  /** Drifted files left for a future sweep after the per-sweep cap was applied. */
  pending: number;
  /** `+path:name` / `-path:name` markers for symbols changed by the refresh. */
  changedSymbols: string[];
}

const DEFAULT_MAX_FILES = 40;

function clampMaxFiles(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_MAX_FILES;
  return Math.floor(value as number);
}

/**
 * Diff the on-disk source tree against the index and heal the difference.
 *
 * Returns counts so a caller (the embedding tracker) can decide whether to sweep
 * again sooner to drain a backlog. Reads file content only for the candidate set
 * required to compute hashes; callers gate *how often* this runs (e.g. skip while
 * idle) — this function always does the full diff when invoked.
 */
export async function reconcileIndex(
  rootDir: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const maxFiles = clampMaxFiles(options.maxFiles);
  const db = await getDB(rootDir);

  // Index side: path -> stored content hash.
  const indexedHashes = new Map<string, string>();
  for (const file of db.getAllFiles()) {
    if (isSupportedFile(file.path)) indexedHashes.set(file.path, file.content_hash);
  }

  // Filesystem side: every supported source file currently on disk.
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const diskPaths = new Set<string>();
  const drifted: string[] = [];

  let scanned = 0;
  for (const entry of entries) {
    if (entry.isDirectory || !isSupportedFile(entry.path)) continue;
    diskPaths.add(entry.relativePath);

    // Yield to the event loop periodically. The hash scan is otherwise a long
    // synchronous-feeling stretch (readFile + sha256 per file); yielding lets
    // concurrent tool calls and transport heartbeats interleave so the sweep
    // never makes the server feel hung on a large repo.
    if (++scanned % 64 === 0) await new Promise((resolve) => setImmediate(resolve));

    const indexedHash = indexedHashes.get(entry.relativePath);
    if (indexedHash === undefined) {
      // Brand-new file the index has never seen.
      drifted.push(entry.relativePath);
      continue;
    }

    // Known file: re-index only if its content hash drifted from the index.
    try {
      const fullPath = resolveProjectPath(rootDir, entry.relativePath, "reconcile file");
      const content = await readFile(fullPath, "utf-8");
      if (hashContent(content) !== indexedHash) drifted.push(entry.relativePath);
    } catch {
      // Unreadable (race with deletion / permissions) — let prune or the next
      // sweep handle it rather than treating an error as drift.
    }
  }

  // Prune index entries whose files are gone from disk.
  const removedPaths = db.getRemovedFiles(diskPaths).filter((path) => isSupportedFile(path));
  for (const path of removedPaths) db.deleteFile(path);

  // Refresh up to the per-sweep cap; the remainder is reported as pending so the
  // tracker can schedule a prompt follow-up sweep.
  const batch = drifted.slice(0, maxFiles);
  const pending = Math.max(0, drifted.length - batch.length);

  let refreshed = 0;
  let changedSymbols: string[] = [];
  if (batch.length > 0) {
    const result = await refreshFilesStructural(rootDir, batch);
    refreshed = result.indexed;
    changedSymbols = result.changedSymbols;
  }

  return {
    refreshed,
    removed: removedPaths.length,
    drifted: drifted.length,
    pending,
    changedSymbols,
  };
}
