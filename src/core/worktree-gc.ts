// Garbage-collect indexes for worktrees that no longer exist.
// FEATURE: Stage-2 churn cleanup — Claude Code creates and destroys worktrees
// constantly. When a worktree is gone, drop it from the in-process router and
// remove its on-disk .contextpro/ overlay so stale indexes don't accumulate.

import { execFile } from "child_process";
import { rm } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { CONTEXTPRO_DIR } from "./data-dir.js";
import { closeDB } from "./db.js";
import { forgetWorkspace, listActiveWorkspaces } from "./workspace-router.js";

const execFileAsync = promisify(execFile);

export interface WorktreeGcResult {
  removedWorkspaces: number;
  removedDirs: string[];
}

/**
 * Live worktree roots reported by git (`git worktree list --porcelain`), including
 * the main checkout. Paths are realpath-resolved to match how the router keys them.
 */
export async function listLiveWorktrees(baseRoot: string): Promise<string[]> {
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
  } catch {
    return [resolve(baseRoot)];
  }
}

/**
 * Remove indexes for worktrees the router knows about but git no longer lists.
 * The main checkout is never removed. Best-effort and idempotent: a worktree
 * whose directory is already gone simply has its router entry dropped.
 */
export async function garbageCollectDeadWorktrees(baseRoot: string): Promise<WorktreeGcResult> {
  const base = resolve(baseRoot);
  const live = new Set(await listLiveWorktrees(base));
  const removedDirs: string[] = [];
  let removedWorkspaces = 0;

  for (const ws of listActiveWorkspaces()) {
    if (!ws.isWorktree) continue; // never GC the base checkout
    if (ws.baseRoot !== base) continue; // only this repo family
    if (live.has(ws.rootDir)) continue; // still alive

    // Dead worktree: close its DB handle, forget it, and reclaim its overlay dir.
    closeDB(ws.rootDir);
    forgetWorkspace(ws.rootDir);
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
