// Gitignore-aware recursive directory walker with nested ignore support
// Returns filtered file paths respecting project and per-directory ignore patterns

import { readdir, readFile, lstat } from "fs/promises";
import { join, relative, resolve } from "path";
import ignore, { type Ignore } from "ignore";
import { resolveProjectPath } from "./path-guard.js";

export interface WalkOptions {
  targetPath?: string;
  depthLimit?: number;
  rootDir: string;
}

export interface FileEntry {
  path: string;
  relativePath: string;
  isDirectory: boolean;
  depth: number;
}

interface IgnoreLayer {
  ig: Ignore;
  dir: string;
}

const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  ".contextpro",
  ".contextplus",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

async function loadIgnoreFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function buildLocalLayer(dir: string): Promise<IgnoreLayer | null> {
  const ig = ignore();
  let hasRules = false;
  const gitignoreContent = await loadIgnoreFile(join(dir, ".gitignore"));
  if (gitignoreContent) { ig.add(gitignoreContent); hasRules = true; }
  const contextProIgnore = await loadIgnoreFile(join(dir, ".contextproignore"));
  if (contextProIgnore) { ig.add(contextProIgnore); hasRules = true; }
  const legacyContextPlusIgnore = await loadIgnoreFile(join(dir, ".contextplusignore"));
  if (legacyContextPlusIgnore) { ig.add(legacyContextPlusIgnore); hasRules = true; }
  return hasRules ? { ig, dir } : null;
}

function isIgnoredByLayers(fullPath: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  for (const layer of layers) {
    const relToLayer = relative(layer.dir, fullPath).replace(/\\/g, "/");
    if (layer.ig.ignores(relToLayer)) return true;
    if (isDir && layer.ig.ignores(relToLayer + "/")) return true;
  }
  return false;
}

async function walkRecursive(
  dir: string,
  rootDir: string,
  parentLayers: IgnoreLayer[],
  depth: number,
  maxDepth: number,
  results: FileEntry[],
): Promise<void> {
  if (maxDepth > 0 && depth > maxDepth) return;

  const layers = [...parentLayers];
  const localLayer = await buildLocalLayer(dir);
  if (localLayer) layers.push(localLayer);

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (ALWAYS_IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);

    const stats = await lstat(fullPath).catch(() => null);
    if (!stats || stats.isSymbolicLink()) continue;

    const isDir = entry.isDirectory();
    if (isIgnoredByLayers(fullPath, isDir, layers)) continue;

    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    results.push({ path: fullPath, relativePath: relPath, isDirectory: isDir, depth });

    if (isDir) await walkRecursive(fullPath, rootDir, layers, depth + 1, maxDepth, results);
  }
}

export async function walkDirectory(options: WalkOptions): Promise<FileEntry[]> {
  const rootDir = resolve(options.rootDir);
  const startDir = options.targetPath ? resolveProjectPath(rootDir, options.targetPath, "targetPath") : rootDir;
  const results: FileEntry[] = [];

  const stats = await lstat(startDir).catch(() => null);
  if (!stats) return results;

  await walkRecursive(startDir, rootDir, [], 0, options.depthLimit ?? 0, results);
  return results;
}

export function groupByDirectory(entries: FileEntry[]): Map<string, FileEntry[]> {
  const groups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const dir = entry.relativePath.includes("/")
      ? entry.relativePath.substring(0, entry.relativePath.lastIndexOf("/"))
      : ".";
    const existing = groups.get(dir) ?? [];
    existing.push(entry);
    groups.set(dir, existing);
  }
  return groups;
}
