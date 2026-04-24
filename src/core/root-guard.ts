// Root selection and guardrails — keep one MCP process pinned to one safe project root
// FEATURE: Multi-project trust — reject dangerous cwd fallbacks and support explicit --root binding

import { homedir } from "os";
import { relative, resolve } from "path";

export interface RootSelection {
  rootDir: string;
  source: "cwd" | "positional" | "flag";
}

function normalize(pathValue: string): string {
  return resolve(pathValue);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

export function selectRootDir(cwd: string, positional: string[], flagRoot?: string): RootSelection {
  if (flagRoot && flagRoot.trim().length > 0) {
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
  if (isInside(home, normalized)) {
    const rel = relative(home, normalized);
    return rel.split("/").filter(Boolean).length <= 1;
  }
  return false;
}

export function validateSelectedRoot(selection: RootSelection): RootSelection {
  if (selection.source !== "cwd") return selection;
  if (!isUnsafeRoot(selection.rootDir)) return selection;
  const allowUnsafe = (process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT ?? "").trim().toLowerCase();
  if (allowUnsafe === "1" || allowUnsafe === "true" || allowUnsafe === "yes") return selection;
  throw new Error(
    `Unsafe implicit root "${selection.rootDir}". Context+ will not start from process.cwd() when cwd is filesystem root or home-level. Pass --root <project-path> or a positional project path, or set CONTEXTPLUS_ALLOW_UNSAFE_ROOT=true to override.`,
  );
}
