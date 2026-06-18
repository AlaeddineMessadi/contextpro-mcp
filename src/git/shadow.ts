// Shadow restore-point manager for safe AI change tracking
// Backups files via JSON manifest before edits; no real git history pollution

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";

const DATA_DIR = ".contextpro/backups";

export interface RestorePoint {
  id: string;
  timestamp: number;
  files: string[];
  message: string;
}

async function ensureDataDir(rootDir: string): Promise<string> {
  const dataPath = join(rootDir, DATA_DIR);
  await mkdir(dataPath, { recursive: true });
  return dataPath;
}

async function loadManifest(rootDir: string): Promise<RestorePoint[]> {
  const manifestPath = join(rootDir, DATA_DIR, "restore-points.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/shadow] manifest read failed: ${message}\n`);
    }
    return [];
  }
}

async function saveManifest(rootDir: string, points: RestorePoint[]): Promise<void> {
  const dataPath = await ensureDataDir(rootDir);
  await writeFile(join(dataPath, "restore-points.json"), JSON.stringify(points, null, 2));
}

export async function createRestorePoint(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  const dataPath = await ensureDataDir(rootDir);
  const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = join(dataPath, "backups", id);
  await mkdir(backupDir, { recursive: true });
  const safeFiles = files.map((file) => toProjectRelativePath(rootDir, file, "restore file"));

  for (const file of safeFiles) {
    const fullPath = resolveProjectPath(rootDir, file, "restore file");
    try {
      const content = await readFile(fullPath, "utf-8");
      const backupPath = join(backupDir, file.replace(/[\\/]/g, "__"));
      await writeFile(backupPath, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/shadow] backup failed for ${file}: ${message}\n`);
      }
    }
  }

  const point: RestorePoint = { id, timestamp: Date.now(), files: safeFiles, message };
  const manifest = await loadManifest(rootDir);
  manifest.push(point);
  if (manifest.length > 100) manifest.splice(0, manifest.length - 100);
  await saveManifest(rootDir, manifest);

  return point;
}

export async function restorePoint(rootDir: string, pointId: string): Promise<string[]> {
  const manifest = await loadManifest(rootDir);
  const point = manifest.find((p) => p.id === pointId);
  if (!point) throw new Error(`Restore point ${pointId} not found`);

  const backupDir = join(rootDir, DATA_DIR, "backups", pointId);
  const restoredFiles: string[] = [];

  for (const file of point.files) {
    const targetPath = resolveProjectPath(rootDir, file, "restore file");
    const backupPath = join(backupDir, file.replace(/[\\/]/g, "__"));
    try {
      const content = await readFile(backupPath, "utf-8");
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      restoredFiles.push(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/shadow] restore failed for ${file}: ${message}\n`);
    }
  }

  return restoredFiles;
}

export async function listRestorePoints(rootDir: string): Promise<RestorePoint[]> {
  return loadManifest(rootDir);
}
