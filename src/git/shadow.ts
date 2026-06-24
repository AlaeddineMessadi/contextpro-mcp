// Shadow restore-point manager for safe AI change tracking
// Backups files via JSON manifest before edits; no real git history pollution

import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createHash } from "crypto";
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
  const dataPath = join(rootDir, DATA_DIR);
  await mkdir(dataPath, { recursive: true });
  return dataPath;
}

function hashPath(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex").slice(0, 32);
}

const manifestMutex = new Map<string, Promise<void>>();

async function withManifestLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
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
  const manifestPath = join(rootDir, DATA_DIR, "restore-points.json");
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
  const target = join(dataPath, "restore-points.json");
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(points, null, 2));
  await rename(tmp, target).catch(async (err) => {
    // On Windows rename can fail when the target exists in some FS scenarios; fall back to unlink+rename.
    if ((err as NodeJS.ErrnoException).code === "EEXIST" || (err as NodeJS.ErrnoException).code === "EPERM") {
      await unlink(target).catch(() => undefined);
      await rename(tmp, target);
    } else {
      throw err;
    }
  });
}

export async function createRestorePoint(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  const dataPath = await ensureDataDir(rootDir);
  const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = join(dataPath, "backups", id);
  await mkdir(backupDir, { recursive: true });
  const safeFiles = files.map((file) => toProjectRelativePath(rootDir, file, "restore file"));
  const fileHashes: Record<string, string> = {};
  const tombstoneFiles: string[] = [];

  for (const file of safeFiles) {
    const fullPath = resolveProjectPath(rootDir, file, "restore file");
    try {
      const content = await readFile(fullPath, "utf-8");
      // Hash-based backup filename guarantees uniqueness regardless of how the original relative
      // path looks (slashes, dots, very long path segments). Maps stored in fileHashes for
      // restoreFromPoint to resolve.
      const slug = hashPath(file);
      const backupPath = join(backupDir, `${slug}.bak`);
      await writeFile(backupPath, content);
      fileHashes[file] = slug;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The file doesn't exist yet — this is a tombstone. Restoring it should DELETE the file.
        tombstoneFiles.push(file);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/shadow] backup failed for ${file}: ${message}\n`);
      }
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
  const candidates = newSlug
    ? [join(backupDir, `${newSlug}.bak`), join(backupDir, file.replace(/[\\/]/g, "__"))]
    : [join(backupDir, file.replace(/[\\/]/g, "__")), join(backupDir, `${hashPath(file)}.bak`)];
  for (const backupPath of candidates) {
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

// Compute, without writing, exactly what restoring `pointId` would do to each file. Used both for the
// `preview` dry-run and internally so the live restore can report a destructive-action count.
export async function planRestore(rootDir: string, pointId: string): Promise<RestorePlan> {
  const manifest = await loadManifest(rootDir);
  const point = manifest.find((p) => p.id === pointId);
  if (!point) throw new Error(`Restore point ${pointId} not found`);

  const backupDir = join(rootDir, DATA_DIR, "backups", pointId);
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

  return { pointId, message: point.message, timestamp: point.timestamp, plans };
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
  const plan = await planRestore(rootDir, pointId);

  if (options.preview) {
    return { preview: true, plan, restoredFiles: [], safetyPointId: null };
  }

  // SAFETY: snapshot the CURRENT state of every file this restore touches, BEFORE we overwrite or
  // delete anything. A wrong restore is then reversible — `restore <safetyPointId>` undoes it.
  // (A pre-restore snapshot of a file that doesn't exist now becomes a tombstone, which correctly
  // re-deletes it on undo — symmetric with the original state.)
  let safetyPointId: string | null = null;
  if (options.safetySnapshot !== false && plan.plans.length > 0) {
    const safety = await createRestorePoint(rootDir, plan.plans.map((p) => p.file), `Pre-restore safety snapshot (before restoring ${pointId})`);
    safetyPointId = safety.id;
  }

  const manifest = await loadManifest(rootDir);
  const point = manifest.find((p) => p.id === pointId);
  if (!point) throw new Error(`Restore point ${pointId} not found`);
  const backupDir = join(rootDir, DATA_DIR, "backups", pointId);
  const tombstones = new Set(point.tombstoneFiles ?? []);
  const restoredFiles: string[] = [];

  for (const file of point.files) {
    const targetPath = resolveProjectPath(rootDir, file, "restore file");
    if (tombstones.has(file)) {
      await unlink(targetPath).catch(() => undefined);
      restoredFiles.push(`${file} (deleted — file did not exist at checkpoint time)`);
      continue;
    }
    const content = await readBackupForFile(backupDir, file, point);
    if (content === null) {
      process.stderr.write(`[contextpro/shadow] restore failed for ${file}: backup not found in any expected location\n`);
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    restoredFiles.push(file);
  }

  return { preview: false, plan, restoredFiles, safetyPointId };
}

export function currentSessionId(): string {
  return SESSION_ID;
}

export async function listRestorePoints(rootDir: string): Promise<RestorePoint[]> {
  return loadManifest(rootDir);
}
