// Root selection and guardrails — keep one MCP process pinned to one safe project root
// FEATURE: Multi-project trust — reject dangerous cwd fallbacks and support explicit --root binding

import { homedir } from "os";
import { existsSync, realpathSync } from "fs";
import { join, relative, resolve } from "path";

export interface RootSelection {
  rootDir: string;
  source: "cwd" | "positional" | "flag";
}

function normalize(pathValue: string): string {
  const resolved = resolve(pathValue);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

// A client that does not expand ${workspaceFolder} passes it literally; the launch directory is a better guess.
export function isUnexpandedVariable(pathValue: string): boolean {
  return /\$\{[^}]+\}/.test(pathValue);
}

export function selectRootDir(cwd: string, positional: string[], flagRoot?: string): RootSelection {
  if (flagRoot && flagRoot.trim().length > 0 && !isUnexpandedVariable(flagRoot)) {
    return { rootDir: normalize(flagRoot), source: "flag" };
  }
  if (positional.length > 0) {
    return { rootDir: normalize(positional[0]), source: "positional" };
  }
  return { rootDir: normalize(cwd), source: "cwd" };
}

export function isUnsafeRoot(rootDir: string): boolean {
  const normalized = normalize(rootDir);
  const home = normalize(homedir());
  if (normalized === "/") return true;
  if (normalized === home) return true;
  if (isInside(home, normalized) && normalized !== home) {
    const rel = relative(home, normalized);
    return rel.split("/").filter(Boolean).length <= 1;
  }
  return false;
}

// A Git repository directly in the home folder (~/myapp) is a project; ~/Downloads is not.
function isHomeChildRepository(rootDir: string): boolean {
  const normalized = normalize(rootDir);
  return normalized !== "/" && normalized !== normalize(homedir()) && existsSync(join(normalized, ".git"));
}

function allowUnsafeRootEnabled(): boolean {
  const raw = (process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT ?? process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function validateSelectedRoot(selection: RootSelection): RootSelection {
  if (!isUnsafeRoot(selection.rootDir)) return selection;
  if (allowUnsafeRootEnabled()) return selection;
  if (isHomeChildRepository(selection.rootDir)) return selection;
  const sourceHint = selection.source === "flag" ? "--root" : selection.source === "positional" ? "positional argument" : "process.cwd()";
  throw new Error(
    `Unsafe project root "${selection.rootDir}" (source: ${sourceHint}). ContextPro refuses to start at the filesystem root, your home folder, or a folder directly inside it that is not a Git repository, because it would create .contextpro/ and SQLite databases there. Pass --root <project-path> to a real project, or set CONTEXTPRO_ALLOW_UNSAFE_ROOT=true to override.`,
  );
}
