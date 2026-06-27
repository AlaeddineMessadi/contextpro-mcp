// Worktree overlay diff computation for Stage-2 shared-base indexing.
// FEATURE: Constant worktree churn — instead of re-indexing every file in a new
// worktree (≈95% identical to the base checkout), index only the files that
// actually differ. This computes that diff set; the base index supplies the rest.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface WorktreeDiffSet {
  /** Tracked files that differ from the base checkout's HEAD (modified). */
  changed: string[];
  /** Files present in the worktree but not in the base index (added/untracked). */
  added: string[];
  /** Files deleted in the worktree relative to base (to drop from the overlay). */
  deleted: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

function nonEmptyLines(raw: string): string[] {
  return raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Compute the set of files in `worktreeRoot` that diverge from `baseRoot`'s
 * committed tree. Combines three git views:
 *  - committed-on-branch divergence: `git diff --name-status <base HEAD>...HEAD`
 *  - uncommitted working-tree changes: `git status --porcelain`
 *  - untracked files: surfaced by porcelain `??`
 *
 * Paths are returned worktree-relative (POSIX separators), matching how the
 * indexer keys files.
 */
export async function computeWorktreeDiffSet(worktreeRoot: string, baseRoot: string): Promise<WorktreeDiffSet> {
  const changed = new Set<string>();
  const added = new Set<string>();
  const deleted = new Set<string>();

  // Base HEAD to diff branch commits against. Empty when base has no commits.
  const baseHead = (await git(baseRoot, ["rev-parse", "HEAD"])).trim();
  if (baseHead.length > 0) {
    // Three-dot: changes on the worktree branch since it forked from base HEAD.
    const branchDiff = await git(worktreeRoot, ["diff", "--name-status", `${baseHead}...HEAD`]);
    for (const line of nonEmptyLines(branchDiff)) {
      const [status, ...rest] = line.split(/\s+/);
      const path = rest[rest.length - 1];
      if (!path) continue;
      if (status.startsWith("D")) deleted.add(path);
      else if (status.startsWith("A")) added.add(path);
      else changed.add(path);
    }
  }

  // Uncommitted + untracked working-tree state.
  const porcelain = await git(worktreeRoot, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;
    if (code === "??") added.add(path);
    else if (code.includes("D")) deleted.add(path);
    else added.has(path) || changed.add(path);
  }

  // Deleted wins: a file deleted then re-added is "added", but a pure delete
  // must not also appear as changed.
  for (const path of deleted) {
    changed.delete(path);
    added.delete(path);
  }

  return {
    changed: [...changed],
    added: [...added],
    deleted: [...deleted],
  };
}

/** Worktree-relative paths to (re)index into the overlay: changed ∪ added. */
export function overlayFiles(set: WorktreeDiffSet): string[] {
  return [...new Set([...set.changed, ...set.added])];
}
