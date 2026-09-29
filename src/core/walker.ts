// Gitignore-aware recursive directory walker with nested ignore support
// Returns filtered file paths respecting project and per-directory ignore patterns

import { readdir, readFile, lstat, open } from "fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "path";
import ignore, { type Ignore } from "ignore";
import { resolveProjectPath } from "./path-guard.js";
import { isAlwaysIgnoredDir } from "./ignore-dirs.js";

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

// These dot-directories contain authored workflows/test source, not runtime
// state. Keep other hidden entries excluded and honor ordinary ignore layers.
const SOURCE_DOT_DIRECTORIES = new Set([".github", ".maestro"]);

/** Recognize Graft's generated wiring cards, rather than excluding every
 * authored package/directory named graft. Never follow a marker symlink. */
async function isGeneratedGraftDirectory(dir: string): Promise<boolean> {
  if (basename(dir) !== "graft") return false;
  const marker = join(dir,"INDEX.md");
  const stats = await lstat(marker).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  let handle;
  try {
    handle = await open(marker,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return false;
    const prefix = Buffer.alloc(1024);
    const {bytesRead} = await handle.read(prefix,0,prefix.length,0);
    return /^# graft [—-] repo map\r?\n/.test(prefix.subarray(0,bytesRead).toString("utf8"));
  } catch { return false; }
  finally { await handle?.close(); }
}

// The comprehensive, framework-aware ignore set lives in ./ignore-dirs.ts so it can
// be reused and tested independently. The walker also honors `.gitignore` layers.

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
    // Only recognized source directories bypass the hidden-entry exclusion;
    // dotfiles such as .env and ignored workflow artifacts remain excluded.
    if (isAlwaysIgnoredDir(entry.name)
      || (entry.name.startsWith(".") && !(entry.isDirectory() && SOURCE_DOT_DIRECTORIES.has(entry.name)))) continue;

    const fullPath = join(dir, entry.name);

    const stats = await lstat(fullPath).catch(() => null);
    if (!stats || stats.isSymbolicLink()) continue;

    const isDir = entry.isDirectory();
    if (isDir && await isGeneratedGraftDirectory(fullPath)) continue;
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

  // A scoped walk must apply the same cache policy to its ancestors, even when
  // it starts at a cache file or a directory below graft/.
  for (let dir = stats.isDirectory() ? startDir : dirname(startDir); dir !== rootDir;) {
    if (await isGeneratedGraftDirectory(dir)) return results;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (stats.isFile()) {
    const relPath = relative(rootDir, startDir).replace(/\\/g, "/");
    results.push({ path: startDir, relativePath: relPath, isDirectory: false, depth: 0 });
    return results;
  }

  // If a caller scopes the walk INTO an always-ignored directory (e.g.
  // targetPath="vendor" or ".venv"), honor the ignore policy for the start dir
  // itself — walkRecursive only filters children, so without this a scoped
  // reindex/grep would still traverse the heavy folder. The project root is
  // exempt (never refuse to scan the project just because its folder name
  // collides with an ignored name).
  if (startDir !== rootDir && isAlwaysIgnoredDir(basename(startDir))) {
    return results;
  }

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
