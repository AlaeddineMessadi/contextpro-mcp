// Root selection and guardrails — refuse project roots that would index or write into home, its ancestors or /
// FEATURE: Multi-project trust — reject dangerous cwd fallbacks and support explicit --root binding

import { homedir } from "os";
import { existsSync, realpathSync } from "fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "path";

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
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
  if (dirname(normalized) === normalized) return true;
  // Home and every folder that contains it (/home, /Users hold every user's home folder).
  if (isInside(normalized, home)) return true;
  if (isInside(home, normalized)) return relative(home, normalized).split(sep).length <= 1;
  return false;
}

// A Git repository directly in the home folder (~/myapp) is a project; ~/Downloads is not.
function isHomeChildRepository(rootDir: string): boolean {
  const normalized = normalize(rootDir);
  const home = normalize(homedir());
  return normalized !== home && dirname(normalized) === home && existsSync(join(normalized, ".git"));
}

function allowUnsafeRootEnabled(): boolean {
  const raw = (process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT ?? process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// Stop every git child process from climbing into a home-folder repo (dotfiles) from a non-repo folder below it.
// A "/" ceiling (HOME=/ in some containers) is kept: git 2.43 still finds /workspace from below it.
if (!allowUnsafeRootEnabled()) {
  const home = normalize(homedir());
  const existing = process.env.GIT_CEILING_DIRECTORIES ?? "";
  if (!existing.split(delimiter).includes(home)) process.env.GIT_CEILING_DIRECTORIES = existing ? `${existing}${delimiter}${home}` : home;
}

export function validateSelectedRoot(selection: RootSelection): RootSelection {
  if (!isUnsafeRoot(selection.rootDir)) return selection;
  if (allowUnsafeRootEnabled()) return selection;
  if (isHomeChildRepository(selection.rootDir)) return selection;
  const sourceHint = selection.source === "flag" ? "--root" : selection.source === "positional" ? "positional argument" : "process.cwd()";
  throw new Error(
    `Unsafe project root "${selection.rootDir}" (source: ${sourceHint}). ContextPro refuses to start at the filesystem root, your home folder, a folder that contains your home folder, or a folder directly inside your home folder that is not a Git repository, because it would create .contextpro/ and SQLite databases there. Pass --root <project-path> to a real project, or set CONTEXTPRO_ALLOW_UNSAFE_ROOT=true to override.`,
  );
}
