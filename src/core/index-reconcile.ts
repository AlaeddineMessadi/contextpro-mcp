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

import { readFile, stat } from "fs/promises";
import { getDB, hashContent } from "./db.js";
import { walkDirectory } from "./walker.js";
import { isSupportedFile } from "./parser.js";
import { resolveProjectPath } from "./path-guard.js";
import { refreshFilesStructural } from "../tools/reindex.js";

// Per-root cache of last-seen {mtimeMs, size} per file. The reconcile sweep used to
// read + sha256 EVERY file every tick — expensive CPU/battery churn on each sweep,
// multiplied across sessions. With this, we only hash a file when its mtime or size
// actually changed since we last saw it; unchanged files are skipped entirely.
// In-memory only (no schema change); the first sweep seeds it, later sweeps are cheap.
const fileStatCache = new Map<string, Map<string, { mtimeMs: number; size: number }>>();

function statCacheFor(rootDir: string): Map<string, { mtimeMs: number; size: number }> {
  let m = fileStatCache.get(rootDir);
  if (!m) { m = new Map(); fileStatCache.set(rootDir, m); }
  return m;
}

/** Drop a root's stat cache (e.g. on worktree GC) so it can't leak memory. */
export function forgetReconcileStatCache(rootDir: string): void {
  fileStatCache.delete(rootDir);
}

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
  const statCache = statCacheFor(rootDir);

  let scanned = 0;
  for (const entry of entries) {
    if (entry.isDirectory || !isSupportedFile(entry.path)) continue;
    diskPaths.add(entry.relativePath);

    // Yield to the event loop periodically so the sweep never feels hung.
    if (++scanned % 64 === 0) await new Promise((resolve) => setImmediate(resolve));

    const indexedHash = indexedHashes.get(entry.relativePath);
    if (indexedHash === undefined) {
      // Brand-new file the index has never seen.
      drifted.push(entry.relativePath);
      continue;
    }

    try {
      const fullPath = resolveProjectPath(rootDir, entry.relativePath, "reconcile file");
      // CHEAP pre-filter: stat first. If mtime+size match what we last saw for an
      // already-indexed file, its content can't have changed — skip the expensive
      // readFile + sha256 entirely. This is what makes idle sweeps near-free.
      const st = await stat(fullPath);
      const prev = statCache.get(entry.relativePath);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        continue; // unchanged since last sweep — no hashing needed
      }

      // mtime/size changed (or first time we've seen it this session): hash to
      // confirm a real content change before marking drift, then remember the stat.
      const content = await readFile(fullPath, "utf-8");
      statCache.set(entry.relativePath, { mtimeMs: st.mtimeMs, size: st.size });
      if (hashContent(content) !== indexedHash) drifted.push(entry.relativePath);
    } catch {
      // Unreadable (race with deletion / permissions) — let prune or the next
      // sweep handle it rather than treating an error as drift.
      statCache.delete(entry.relativePath);
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
