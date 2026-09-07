// Project path containment helpers for file-facing MCP tools
// FEATURE: Multi-project safety — reject paths that escape the selected workspace root

import { isAbsolute, relative, resolve, dirname, basename, join } from "path";
import { lstatSync, realpathSync } from "node:fs";

export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

/** Resolve existing links and the nearest existing ancestor of a new path. */
export function canonicalProjectPath(path: string): string {
  try {
    lstatSync(path); // A dangling link must fail, not be treated as a new regular file.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalProjectPath(parent), basename(path));
  }
  return realpathSync(path);
}

export function resolveProjectPath(rootDir: string, inputPath: string | undefined, label: string = "path"): string {
  const root = resolve(rootDir);
  const candidate = inputPath && inputPath.trim().length > 0 ? resolve(root, inputPath) : root;
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path escapes project root: ${label}=${JSON.stringify(inputPath ?? "")}`);
  }
  if (!isPathInside(canonicalProjectPath(root), canonicalProjectPath(candidate))) {
    throw new Error(`Path escapes project root through symlink: ${label}=${JSON.stringify(inputPath ?? "")}`);
  }
  return candidate;
}

export function toProjectRelativePath(rootDir: string, inputPath: string, label: string = "path"): string {
  const fullPath = resolveProjectPath(rootDir, inputPath, label);
  return relative(resolve(rootDir), fullPath).replace(/\\/g, "/") || ".";
}
