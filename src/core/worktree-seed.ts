// Seed a fresh worktree's index from the shared base checkout.
// FEATURE: Stage-2 churn optimization — when a new worktree is indexed for the
// first time, clone the base checkout's already-built index.db instead of parsing
// and embedding ~95% identical files from scratch. The subsequent incremental
// reindex then only touches the worktree's diff (see worktree-overlay.ts).

import { copyFile, mkdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { CONTEXTPRO_DIR } from "./data-dir.js";
import { checkpointDB } from "./db.js";

export interface SeedResult {
  seeded: boolean;
  reason?: "same-root" | "no-base-index" | "worktree-index-exists";
  bytesCopied?: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function indexDbPath(root: string): string {
  return join(root, CONTEXTPRO_DIR, "index.db");
}

/**
 * Copy the base checkout's index.db into `worktreeRoot` when the worktree has no
 * index yet. Idempotent and safe: never overwrites an existing worktree index,
 * and no-ops when the worktree IS the base or the base has nothing to clone.
 *
 * Only the main index.db is copied. SQLite WAL/SHM side-files are intentionally
 * not copied — a checkpointed base leaves all committed data in index.db, and the
 * fresh worktree connection starts its own WAL. Callers should ensure the base DB
 * is checkpointed (closed or `PRAGMA wal_checkpoint`) before seeding for a fully
 * current snapshot; an incremental reindex on the worktree reconciles any gap.
 */
export async function seedWorktreeFromBase(worktreeRoot: string, baseRoot: string): Promise<SeedResult> {
  const worktree = resolve(worktreeRoot);
  const base = resolve(baseRoot);
  if (worktree === base) return { seeded: false, reason: "same-root" };

  const baseDb = indexDbPath(base);
  if (!(await pathExists(baseDb))) return { seeded: false, reason: "no-base-index" };

  const worktreeDb = indexDbPath(worktree);
  if (await pathExists(worktreeDb)) return { seeded: false, reason: "worktree-index-exists" };

  // Flush the base WAL so the copied file reflects all committed rows.
  checkpointDB(base);
  await mkdir(join(worktree, CONTEXTPRO_DIR), { recursive: true });
  await copyFile(baseDb, worktreeDb);
  const { size } = await stat(worktreeDb);
  return { seeded: true, bytesCopied: size };
}
