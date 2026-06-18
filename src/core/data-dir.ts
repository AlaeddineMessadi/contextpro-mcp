// Canonical ContextPro project storage and one-way migration from legacy names.

import { cp, mkdir, rename, rm, stat } from "fs/promises";
import { join } from "path";

export const CONTEXTPRO_DIR = ".contextpro";
export const LEGACY_CONTEXT_DIRS = [".contextplus", ".mcp_data"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function migrateLegacyProjectData(rootDir: string): Promise<string | null> {
  const destination = join(rootDir, CONTEXTPRO_DIR);
  if (await pathExists(destination)) return null;

  for (const legacyName of LEGACY_CONTEXT_DIRS) {
    const source = join(rootDir, legacyName);
    if (!(await pathExists(source))) continue;
    try {
      await rename(source, destination);
    } catch {
      await cp(source, destination, { recursive: true, errorOnExist: false, force: false });
      await rm(source, { recursive: true, force: true });
    }
    return legacyName;
  }

  return null;
}

export async function ensureContextProDir(rootDir: string): Promise<string | null> {
  const migratedFrom = await migrateLegacyProjectData(rootDir);
  await mkdir(join(rootDir, CONTEXTPRO_DIR, "backups"), { recursive: true });
  await mkdir(join(rootDir, CONTEXTPRO_DIR, "hubs"), { recursive: true });
  return migratedFrom;
}
