// Shared MCP connections cannot infer which subagent worktree made a request.
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResolvedWorkspace } from "./workspace-router.js";

const MAX_ADMIN_ENTRIES = 64;
const MAX_DISPLAY_ROOTS = 4;
const MAX_DISPLAY_PATH = 240;

function displayPath(path: string): string {
  return path.length <= MAX_DISPLAY_PATH ? path : `${path.slice(0, MAX_DISPLAY_PATH - 3)}...`;
}

/**
 * Inspect Git's small worktree registry, not the source tree. Do not cache its
 * contents: another agent can add/remove a worktree while the MCP stays alive.
 * Explicit-root requests never call this function.
 */
export async function requireExplicitRootForSharedWorktrees(workspace: ResolvedWorkspace): Promise<void> {
  // Linked checkouts always require explicit routing. The main checkout cannot
  // be located reliably from a separate Git store (or a bare repository), so
  // the absence of another registered path does not prove this root is intended.
  if (workspace.isWorktree) {
    throw new Error(
      `Ambiguous worktree: this MCP connection would use ${displayPath(workspace.rootDir)}. `
      + "Linked worktrees require an explicit root, including checkouts attached to separate or bare Git stores. "
      + "Pass root as the absolute directory of the checkout you are editing on every tool call.",
    );
  }
  const roots = new Set([workspace.rootDir]);
  let registry;
  try {
    registry = await opendir(join(workspace.gitCommonDir, "worktrees"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw new Error(`Cannot verify worktree routing for ${displayPath(workspace.rootDir)}. Pass root as the absolute working directory for this request.`);
  }

  let inspected = 0;
  let bounded = false;
  try {
    for await (const entry of registry) {
      if (++inspected > MAX_ADMIN_ENTRIES) { bounded = true; break; }
      if (!entry.isDirectory()) continue;
      const adminDir = join(workspace.gitCommonDir, "worktrees", entry.name);
      try {
        const gitFile = (await readFile(join(adminDir, "gitdir"), "utf8")).trim();
        if (!gitFile) continue;
        const resolvedGitFile = resolve(adminDir, gitFile);
        // Ignore prunable registry entries after a checkout was removed manually.
        const checkoutGit = await stat(resolvedGitFile);
        if (!checkoutGit.isFile()) continue;
        const checkout = await realpath(dirname(resolvedGitFile));
        roots.add(checkout);
        if (roots.size >= MAX_DISPLAY_ROOTS) { bounded = true; break; }
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        // Unreadable registry metadata cannot prove this connection unambiguous.
        bounded = true;
        break;
      }
    }
  } catch {
    bounded = true;
  }

  if (roots.size <= 1 && !bounded) return;
  const candidates = [...roots].slice(0, MAX_DISPLAY_ROOTS).map(displayPath).join(" | ");
  throw new Error(
    `Ambiguous worktree: this MCP connection would use ${displayPath(workspace.rootDir)}, `
    + "but this repository has other or unverified linked worktrees. "
    + "Pass root as the absolute directory of the checkout you are editing on every tool call; "
    + "reindexing without root could refresh a different checkout. "
    + `Candidates: ${candidates}${bounded ? " | ..." : ""}`,
  );
}
