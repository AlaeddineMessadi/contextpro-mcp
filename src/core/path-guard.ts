// Project path containment helpers for file-facing MCP tools
// FEATURE: Multi-project safety — reject paths that escape the selected workspace root

import { isAbsolute, relative, resolve } from "path";

export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveProjectPath(rootDir: string, inputPath: string | undefined, label: string = "path"): string {
  const root = resolve(rootDir);
  const candidate = inputPath && inputPath.trim().length > 0 ? resolve(root, inputPath) : root;
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path escapes project root: ${label}=${JSON.stringify(inputPath ?? "")}`);
  }
  return candidate;
}

export function toProjectRelativePath(rootDir: string, inputPath: string, label: string = "path"): string {
  const fullPath = resolveProjectPath(rootDir, inputPath, label);
  return relative(resolve(rootDir), fullPath).replace(/\\/g, "/") || ".";
}
