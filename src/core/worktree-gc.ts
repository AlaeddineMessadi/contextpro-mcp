// Garbage-collect indexes for worktrees that no longer exist.
// FEATURE: Stage-2 churn cleanup — Claude Code creates and destroys worktrees
// constantly. When a worktree is gone, drop it from the in-process router and
// remove its on-disk .contextpro/ overlay so stale indexes don't accumulate.

import { execFile } from "child_process";
import { rm, stat } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { CONTEXTPRO_DIR } from "./data-dir.js";
import { closeDB } from "./db.js";
import { forgetWorkspace, listActiveWorkspaces } from "./workspace-router.js";
import { forgetReconcileStatCache } from "./index-reconcile.js";

const execFileAsync = promisify(execFile);

export interface WorktreeGcResult {
  removedWorkspaces: number;
  removedDirs: string[];
  /** Set when git could not list worktrees; nothing was removed or forgotten. */
  error?: string;
}

/**
 * Live worktree roots reported by git (`git worktree list --porcelain`), including
 * the main checkout. Paths are realpath-resolved to match how the router keys them.
 * Returns null when git cannot list them (callers must not treat that as "none live");
 * the failure message is passed to onError.
 */
export async function listLiveWorktrees(
  baseRoot: string,
  onError?: (message: string) => void,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: baseRoot,
      timeout: 8000,
    });
    const roots: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        roots.push(resolve(line.slice("worktree ".length).trim()));
      }
    }
    return roots;
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove indexes for worktrees the router knows about but git no longer lists.
 * The main checkout is never removed. If git cannot list worktrees nothing is
 * touched, and a worktree whose checkout `.git` still exists is never touched
 * even when git does not list it (pruned admin entry). Best-effort and idempotent.
 */
export async function garbageCollectDeadWorktrees(baseRoot: string): Promise<WorktreeGcResult> {
  const base = resolve(baseRoot);
  let gitError = "";
  const liveRoots = await listLiveWorktrees(base, (m) => { gitError = m; });
  if (!liveRoots) {
    return { removedWorkspaces: 0, removedDirs: [], error: `git worktree list failed: ${gitError}`.replace(/\s+/g, " ").slice(0, 200) };
  }
  const live = new Set(liveRoots);
  const removedDirs: string[] = [];
  let removedWorkspaces = 0;

  for (const ws of listActiveWorkspaces()) {
    if (!ws.isWorktree) continue; // never GC the base checkout
    if (ws.baseRoot !== base) continue; // only this repo family
    if (live.has(ws.rootDir)) continue; // still alive
    if (await exists(join(ws.rootDir, ".git"))) continue; // checkout on disk: git just lost track of it

    // Dead worktree: close its DB handle, forget it, and reclaim its overlay dir.
    closeDB(ws.rootDir);
    forgetWorkspace(ws.rootDir);
    forgetReconcileStatCache(ws.rootDir);
    removedWorkspaces += 1;
    const overlayDir = join(ws.rootDir, CONTEXTPRO_DIR);
    try {
      await rm(overlayDir, { recursive: true, force: true });
      removedDirs.push(overlayDir);
    } catch {
      // The worktree directory may already be gone; nothing to reclaim.
    }
  }

  return { removedWorkspaces, removedDirs };
}
