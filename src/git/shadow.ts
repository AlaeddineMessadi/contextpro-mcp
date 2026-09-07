// Shadow restore-point manager for safe AI change tracking
// Backups files via JSON manifest before edits; no real git history pollution

import { readFile, mkdir, readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { assertMutationPath, assertSourceUnchanged, captureSource, publishSource, withSourceMutation } from "../core/source-mutation.js";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";

const DATA_DIR = ".contextpro/backups";

export interface RestorePoint {
  id: string;
  timestamp: number;
  files: string[];
  message: string;
  fileHashes?: Record<string, string>;
  // Session tag = pid:bootTime. Lets `checkpoints`/`restore` distinguish this session's points
  // from points another agent created in the same project directory.
  session?: string;
  // True when the captured file did not exist (tombstone); restoring deletes the file rather
  // than writing empty content.
  tombstoneFiles?: string[];
}

// A stable-per-process session id. process.pid plus a coarse start marker so two sequential
// runs with a recycled PID don't collide within the same project.
const SESSION_ID = `${process.pid}-${Math.floor(Date.now() / 1000 / 60)}`;

async function ensureDataDir(rootDir: string): Promise<string> {
  const dataPath = assertMutationPath(rootDir, DATA_DIR);
  await mkdir(dataPath, { recursive: true });
  return dataPath;
}

function hashPath(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex").slice(0, 32);
}

const manifestMutex = new Map<string, Promise<void>>();

async function withManifestLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  return withSourceMutation(rootDir, () => withManifestLockLocal(rootDir, fn));
}

async function withManifestLockLocal<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolveProjectPath(rootDir, ".", "rootDir");
  const previous = manifestMutex.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => { release = resolve; });
  // Store the chained promise in a variable so the identity check in `finally` can match it.
  // (Calling previous.then() twice allocates two distinct promises — the old code could never
  // match and leaked one Map entry per concurrent call.)
  const chained = previous.then(() => next);
  manifestMutex.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Only clear the entry if no later caller has queued behind us (i.e. we're still the tail).
    if (manifestMutex.get(key) === chained) {
      manifestMutex.delete(key);
    }
  }
}

async function loadManifest(rootDir: string): Promise<RestorePoint[]> {
  const manifestPath = resolveProjectPath(rootDir, join(DATA_DIR, "restore-points.json"));
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      process.stderr.write(`[contextpro/shadow] manifest is not an array; treating as empty\n`);
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/shadow] manifest read failed (will treat as empty): ${message}\n`);
    }
    return [];
  }
}

async function saveManifestAtomic(rootDir: string, points: RestorePoint[]): Promise<void> {
  const dataPath = await ensureDataDir(rootDir);
  const snapshot = captureSource(rootDir, join(dataPath, "restore-points.json"));
  await publishSource(rootDir, snapshot, JSON.stringify(points, null, 2));
}

export async function createRestorePoint(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  return withSourceMutation(rootDir, () => createRestorePointLocked(rootDir, files, message));
}

async function createRestorePointLocked(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  const dataPath = await ensureDataDir(rootDir);
  const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = assertMutationPath(rootDir, join(dataPath, "backups", id));
  await mkdir(backupDir, { recursive: true });
  const safeFiles = files.map((file) => toProjectRelativePath(rootDir, file, "restore file"));
  const fileHashes: Record<string, string> = {};
  const tombstoneFiles: string[] = [];

  for (const file of safeFiles) {
    const fullPath = resolveProjectPath(rootDir, file, "restore file");
    try {
      const source = captureSource(rootDir, fullPath);
      if (source.content === null) { tombstoneFiles.push(file); continue; }
      const content = source.content;
      // Hash-based backup filename guarantees uniqueness regardless of how the original relative
      // path looks (slashes, dots, very long path segments). Maps stored in fileHashes for
      // restoreFromPoint to resolve.
      const slug = hashPath(file);
      const backupPath = join(backupDir, `${slug}.bak`);
      await publishSource(rootDir, captureSource(rootDir, backupPath), content);
      fileHashes[file] = slug;
    } catch (error) {
      throw new Error(`Backup failed for ${file}; source was not modified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const point: RestorePoint = {
    id,
    timestamp: Date.now(),
    files: safeFiles,
    message,
    fileHashes,
    session: SESSION_ID,
    ...(tombstoneFiles.length > 0 ? { tombstoneFiles } : {}),
  };
  await withManifestLock(rootDir, async () => {
    const manifest = await loadManifest(rootDir);
    manifest.push(point);
    if (manifest.length > 100) manifest.splice(0, manifest.length - 100);
    await saveManifestAtomic(rootDir, manifest);
  });

  return point;
}

// What a restore would do to one file, computed without writing anything.
export interface RestoreFilePlan {
  file: string;
  // "overwrite": current content replaced by the backup; "create": file absent now, will be written;
  // "delete": the checkpoint captured non-existence (tombstone), so restore removes the file;
  // "missing-backup": the manifest references a backup that can't be found — restore would skip it.
  action: "overwrite" | "create" | "delete" | "missing-backup";
  // True when this action destroys uncommitted current content (overwrite or delete of an existing file).
  destructive: boolean;
}

export interface RestorePlan {
  pointId: string;
  message: string;
  timestamp: number;
  plans: RestoreFilePlan[];
}

async function readBackupForFile(backupDir: string, file: string, point: RestorePoint): Promise<string | null> {
  const newSlug = point.fileHashes?.[file];
  if (newSlug && !/^[a-f0-9]{32}$/.test(newSlug)) throw new Error(`Invalid restore backup hash for ${file}`);
  const candidates = newSlug
    ? [join(backupDir, `${newSlug}.bak`), join(backupDir, file.replace(/[\\/]/g, "__"))]
    : [join(backupDir, file.replace(/[\\/]/g, "__")), join(backupDir, `${hashPath(file)}.bak`)];
  for (const backupPath of candidates) {
    resolveProjectPath(backupDir, backupPath);
    try {
      return await readFile(backupPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/shadow] read backup failed for ${file}: ${message}\n`);
      }
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// Build the plan from an already-resolved point. Separated so restorePoint can resolve the target
// point ONCE up front and reuse it — never re-loading the manifest after the safety snapshot (whose
// LRU trim could otherwise evict the target's manifest entry and spuriously fail the restore).
async function planRestoreForPoint(rootDir: string, point: RestorePoint): Promise<RestorePlan> {
  const backupDir = resolveProjectPath(rootDir, join(DATA_DIR, "backups", point.id));
  const tombstones = new Set(point.tombstoneFiles ?? []);
  const plans: RestoreFilePlan[] = [];

  for (const file of point.files) {
    const targetPath = resolveProjectPath(rootDir, file, "restore file");
    const existsNow = await fileExists(targetPath);
    if (tombstones.has(file)) {
      // Restoring a tombstone DELETES the file. Destructive only if the file currently exists.
      plans.push({ file, action: "delete", destructive: existsNow });
      continue;
    }
    const backup = await readBackupForFile(backupDir, file, point);
    if (backup === null) {
      plans.push({ file, action: "missing-backup", destructive: false });
      continue;
    }
    plans.push({
      file,
      action: existsNow ? "overwrite" : "create",
      destructive: existsNow, // overwriting an existing file destroys its current content
    });
  }

  return { pointId: point.id, message: point.message, timestamp: point.timestamp, plans };
}

async function resolvePoint(rootDir: string, pointId: string): Promise<RestorePoint> {
  const manifest = await loadManifest(rootDir);
  if (!/^rp-[a-zA-Z0-9-]+$/.test(pointId)) throw new Error(`Invalid restore point id: ${pointId}`);
  const point = manifest.find((p) => p.id === pointId);
  if (!point) throw new Error(`Restore point ${pointId} not found`);
  return point;
}

// Compute, without writing, exactly what restoring `pointId` would do to each file. Used both for the
// `preview` dry-run and internally so the live restore can report a destructive-action count.
export async function planRestore(rootDir: string, pointId: string): Promise<RestorePlan> {
  return planRestoreForPoint(rootDir, await resolvePoint(rootDir, pointId));
}

export interface RestoreOptions {
  // When true, no files are written — returns the plan only (dry run).
  preview?: boolean;
  // When false, skip taking a pre-restore safety snapshot. Default true (always snapshot).
  safetySnapshot?: boolean;
}

export interface RestoreResult {
  preview: boolean;
  plan: RestorePlan;
  restoredFiles: string[];
  // The id of the auto-snapshot taken before clobbering, so the user can undo a wrong restore.
  safetyPointId: string | null;
}

export async function restorePoint(
  rootDir: string,
  pointId: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (options.preview) return { preview: true, plan: await planRestore(rootDir, pointId), restoredFiles: [], safetyPointId: null };
  return withSourceMutation(rootDir, () => restorePointLocked(rootDir, pointId, options));
}

async function restorePointLocked(rootDir: string, pointId: string, options: RestoreOptions): Promise<RestoreResult> {
  // Resolve the target point ONCE, before anything mutates the manifest. We reuse this captured
  // reference for the actual restore so the safety snapshot's LRU trim can never evict it out from
  // under us. The backup files on disk for this point are not touched by the trim either.
  const point = await resolvePoint(rootDir, pointId);
  const plan = await planRestoreForPoint(rootDir, point);

  if (options.preview) {
    return { preview: true, plan, restoredFiles: [], safetyPointId: null };
  }

  const snapshots = new Map(point.files.map((file) => [file, captureSource(rootDir, file)]));
  const backupDir = resolveProjectPath(rootDir, join(DATA_DIR, "backups", pointId));
  const tombstones = new Set(point.tombstoneFiles ?? []);
  const staged = new Map<string, string | null>();
  for (const file of point.files) {
    const content = tombstones.has(file) ? null : await readBackupForFile(backupDir, file, point);
    if (content === null && !tombstones.has(file)) throw new Error(`Restore failed: backup missing for ${file}. No files were modified.`);
    staged.set(file, content);
  }
  for (const snapshot of snapshots.values()) assertSourceUnchanged(rootDir, snapshot);

  // SAFETY: snapshot the CURRENT state of every file this restore touches, BEFORE we overwrite or
  // delete anything. A wrong restore is then reversible — `restore <safetyPointId>` undoes it.
  // (A pre-restore snapshot of a file that doesn't exist now becomes a tombstone, which correctly
  // re-deletes it on undo — symmetric with the original state.)
  let safetyPointId: string | null = null;
  if (options.safetySnapshot !== false && plan.plans.length > 0) {
    const safety = await createRestorePoint(rootDir, plan.plans.map((p) => p.file), `Pre-restore safety snapshot (before restoring ${pointId})`);
    safetyPointId = safety.id;
  }

  const restoredFiles: string[] = [];
  const completed: string[] = [];
  try {
    for (const [file, content] of staged) {
      await publishSource(rootDir, snapshots.get(file)!, content);
      completed.push(file);
      restoredFiles.push(content === null ? `${file} (deleted — file did not exist at checkpoint time)` : file);
    }
  } catch (error) {
    throw new Error(`Restore failed: ${error instanceof Error ? error.message : String(error)} Updated files: ${completed.join(", ") || "none"}. Pending files: ${[...staged.keys()].filter((file) => !completed.includes(file)).join(", ")}. Safety restore point: ${safetyPointId ?? "disabled"}.`);
  }

  return { preview: false, plan, restoredFiles, safetyPointId };
}

export function currentSessionId(): string {
  return SESSION_ID;
}

export async function listRestorePoints(rootDir: string): Promise<RestorePoint[]> {
  return loadManifest(rootDir);
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else total += await stat(full).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/**
 * Delete orphaned backup directories — point folders under .contextpro/backups/backups/ whose id is
 * no longer in the restore-points manifest (trimmed by the 100-entry cap in createRestorePoint).
 * The on-disk backups were never cleaned when their manifest entry was evicted, so they leak.
 * Returns how many point directories were removed and how many bytes were reclaimed.
 */
// A backup dir younger than this is never reclaimed, closing the createRestorePoint/GC race:
// createRestorePoint materializes the backup dir+files BEFORE pushing the manifest entry, so a
// just-created point's dir can momentarily look unreferenced. A grace window prevents deleting it.
const RESTORE_GC_MIN_AGE_MS = 60_000;

export async function garbageCollectRestorePoints(rootDir: string): Promise<{ deletedPoints: number; freedBytes: number }> {
  let deletedPoints = 0;
  let freedBytes = 0;
  // Run the whole reconcile-and-delete under the lock so a concurrent createRestorePoint (which takes
  // the lock to push its manifest entry) can't interleave with our delete decisions.
  await withManifestLock(rootDir, async () => {
    const manifest = await loadManifest(rootDir);
    const liveIds = new Set(manifest.map((p) => p.id));
    const now = Date.now();
    const backupsRoot = join(rootDir, DATA_DIR, "backups");
    const entries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || liveIds.has(entry.name)) continue;
      const pointDir = join(backupsRoot, entry.name);
      const dirStat = await stat(pointDir).catch(() => null);
      // Grace period: skip a freshly-created backup dir whose manifest push may still be in flight.
      if (!dirStat || now - dirStat.mtimeMs < RESTORE_GC_MIN_AGE_MS) continue;
      const size = await dirSizeBytes(pointDir);
      const removed = await rm(pointDir, { recursive: true, force: true }).then(() => true).catch(() => false);
      if (removed) {
        deletedPoints += 1;
        freedBytes += size;
      }
    }
  });
  return { deletedPoints, freedBytes };
}
