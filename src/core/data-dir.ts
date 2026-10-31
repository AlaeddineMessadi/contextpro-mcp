// Canonical ContextPro project storage and one-way migration from legacy names.

import { cp, mkdir, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { resolveProjectPath } from "./path-guard.js";

export const CONTEXTPRO_DIR = ".contextpro";
export const LEGACY_CONTEXT_DIRS = [".contextplus", ".mcp_data"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[contextpro/data-dir] stat failed for ${path}: ${message}\n`);
    return false;
  }
}

export async function migrateLegacyProjectData(rootDir: string): Promise<string | null> {
  const destination = resolveProjectPath(rootDir, CONTEXTPRO_DIR);
  if (await pathExists(destination)) return null;

  for (const legacyName of LEGACY_CONTEXT_DIRS) {
    const source = resolveProjectPath(rootDir, legacyName);
    if (!(await pathExists(source))) continue;
    try {
      await rename(source, destination);
    } catch (renameError) {
      const renameMessage = renameError instanceof Error ? renameError.message : String(renameError);
      process.stderr.write(`[contextpro/data-dir] rename ${legacyName} → ${CONTEXTPRO_DIR} failed (${renameMessage}); falling back to recursive copy\n`);
      try {
        await cp(source, destination, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
      } catch (copyError) {
        const copyMessage = copyError instanceof Error ? copyError.message : String(copyError);
        throw new Error(`Failed to migrate legacy directory ${legacyName} to ${CONTEXTPRO_DIR}: ${copyMessage}`);
      }
    }
    return legacyName;
  }

  return null;
}

export async function ensureContextProDir(rootDir: string): Promise<string | null> {
  const migratedFrom = await migrateLegacyProjectData(rootDir);
  await mkdir(resolveProjectPath(rootDir, join(CONTEXTPRO_DIR, "backups")), { recursive: true });
  await mkdir(resolveProjectPath(rootDir, join(CONTEXTPRO_DIR, "hubs")), { recursive: true });
  // Local index state must not be committed; "wx" never overwrites a user-edited file.
  try {
    await writeFile(resolveProjectPath(rootDir, join(CONTEXTPRO_DIR, ".gitignore")), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return migratedFrom;
}
