// Seed a fresh worktree from a consistent SQLite snapshot of the base checkout.
import { link, mkdir, mkdtemp, rm, stat } from "fs/promises";
import { join, resolve } from "path";
import { CONTEXTPRO_DIR } from "./data-dir.js";
import { loadNativeStorageBindings } from "./db-native.js";
import { resolveProjectPath } from "./path-guard.js";

export interface SeedResult {
  seeded: boolean;
  reason?: "same-root" | "no-base-index" | "worktree-index-exists";
  bytesCopied?: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function indexDbPath(root: string): string {
  return resolveProjectPath(root, join(CONTEXTPRO_DIR, "index.db"), "worktree seed index");
}

/**
 * SQLite's online backup includes committed WAL pages and yields a consistent
 * snapshot even if the base is open in another process. Initialize the private
 * snapshot before an exclusive hard-link publication: readers never see a
 * partial database, and concurrent first requests cannot overwrite one another
 * or a database initialized by getDB in the meantime.
 */
export async function seedWorktreeFromBase(worktreeRoot: string, baseRoot: string): Promise<SeedResult> {
  const worktree = resolve(worktreeRoot);
  const base = resolve(baseRoot);
  if (worktree === base) return { seeded: false, reason: "same-root" };

  const baseDb = indexDbPath(base);
  resolveProjectPath(base, join(CONTEXTPRO_DIR, "index.db-wal"), "base index WAL");
  resolveProjectPath(base, join(CONTEXTPRO_DIR, "index.db-shm"), "base index SHM");
  if (!(await pathExists(baseDb))) return { seeded: false, reason: "no-base-index" };
  const worktreeDb = indexDbPath(worktree);
  if (await pathExists(worktreeDb)) return { seeded: false, reason: "worktree-index-exists" };

  const destinationDir = resolveProjectPath(worktree, CONTEXTPRO_DIR, "worktree index directory");
  await mkdir(destinationDir, { recursive: true });
  const stagingDir = await mkdtemp(join(destinationDir, ".seed-"));
  const snapshotPath = join(stagingDir, "index.db");
  try {
    const { Database, sqliteVec } = loadNativeStorageBindings();
    const source = new Database(baseDb, { readonly: true, fileMustExist: true });
    try {
      sqliteVec.load(source);
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }

    const snapshot = new Database(snapshotPath);
    try {
      sqliteVec.load(snapshot);
      // Finish all writes in the main file before publication, without WAL/SHM
      // sidecars whose names would still refer to the private staging location.
      snapshot.pragma("journal_mode = DELETE");
      snapshot.transaction(() => {
        const status = snapshot.prepare("SELECT value FROM meta WHERE key = 'index_status'").get() as { value: string } | undefined;
        const write = snapshot.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
        for (const [key, value] of [
          ["index_status", "idle"],
          ["index_owner_pid", ""],
          ["index_started_at", ""],
          ["index_finished_at", ""],
          ["index_target_path", ""],
          ["last_index_error", ""],
        ]) write.run(key, value);
        // An active base writer may have only partly completed its logical
        // multi-file pass. Force structural repair on the first freshness check.
        if (status?.value === "indexing") write.run("extractor_stamp", "");
      })();
    } finally {
      snapshot.close();
    }

    const { size } = await stat(snapshotPath);
    try {
      await link(snapshotPath, worktreeDb);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { seeded: false, reason: "worktree-index-exists" };
      }
      throw error;
    }
    return { seeded: true, bytesCopied: size };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
