// Per-request workspace resolution for multi-worktree support.
// FEATURE: One MCP process serves many git worktrees — resolve the workspace a
// request belongs to (its own root + the shared base checkout) lazily and cache it,
// so parallel agents in different worktrees each hit the correct index.

import { resolve } from "path";
import { realpath, stat } from "fs/promises";
import { closeDB } from "./db.js";
import { detectWorktreeInfo } from "./project-config.js";
import { validateSelectedRoot } from "./root-guard.js";
import { seedWorktreeFromBase } from "./worktree-seed.js";

export interface ResolvedWorkspace {
  /** The working-tree root this request targets (a worktree or the main checkout). */
  rootDir: string;
  /** The main checkout that owns the shared git object store and base index. */
  baseRoot: string;
  /** Absolute path to the shared .git directory. */
  gitCommonDir: string;
  /** True when rootDir is a linked worktree rather than the main checkout. */
  isWorktree: boolean;
  /** When this workspace was first resolved (ISO 8601). */
  resolvedAt: string;
}

const workspaces = new Map<string, ResolvedWorkspace>();

const isDirectory = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false);

function normalizeRequestRoot(requestRoot: string | undefined, defaultRoot?: string): string {
  const candidate = requestRoot && requestRoot.trim().length > 0 ? requestRoot : defaultRoot;
  if (!candidate || candidate.trim().length === 0) {
    throw new Error("workspace-router: no request root and no default root provided");
  }
  return resolve(candidate);
}

/**
 * Resolve the workspace a request belongs to. Lazy and cached: the first request
 * for a given worktree pays git-detection cost; later requests reuse the entry.
 *
 * Precedence: explicit `requestRoot` (e.g. a tool's `root` argument or the MCP
 * client's roots capability) → `defaultRoot` (the server's boot root). The result
 * is validated through the same unsafe-root guard used at startup.
 */
export async function resolveWorkspace(
  requestRoot: string | undefined,
  defaultRoot?: string,
  beforeInitialize?: (workspace: ResolvedWorkspace) => Promise<void>,
): Promise<ResolvedWorkspace> {
  const requested = normalizeRequestRoot(requestRoot, defaultRoot);
  // Startup canonicalizes symlinks too. Keep one identity/cache entry for an
  // alias and its real directory, including projects without Git metadata.
  const normalized = await realpath(requested).catch(() => requested);
  // Before the cache: a deleted root must not be served from cache, nor have .contextpro recreated in it.
  if (!(await isDirectory(normalized))) {
    const stale = workspaces.get(requested);
    if (stale && !(await isDirectory(stale.rootDir))) {
      // Same teardown as gc: a checkout re-created at this path must not reuse the deleted index's handle.
      closeDB(stale.rootDir);
      forgetWorkspace(stale.rootDir);
      (await import("./index-reconcile.js")).forgetReconcileStatCache(stale.rootDir);
    } else {
      workspaces.delete(requested); // a deleted subfolder of a live checkout: keep the checkout's entry
    }
    throw new Error(`Project root "${requested}" does not exist or is not a directory. Pass an existing absolute directory as root.`);
  }
  const cached = workspaces.get(normalized);
  if (cached) {
    // Routing must be checked for every request: worktrees may have appeared
    // since this metadata was cached, or the prior caller passed an explicit root.
    if (beforeInitialize) await beforeInitialize(cached);
    workspaces.set(requested, cached);
    return cached;
  }

  // Guard before touching git or the filesystem for storage.
  const source = requestRoot ? "flag" : "cwd";
  validateSelectedRoot({ rootDir: normalized, source });

  const info = await detectWorktreeInfo(normalized);
  // Git may widen the request to its toplevel (e.g. a dotfiles repo in HOME); re-check that root and never narrow.
  try {
    validateSelectedRoot({ rootDir: info.worktreeRoot, source });
  } catch (error) {
    throw new Error(`Request root widened from ${normalized} to its Git toplevel ${info.worktreeRoot}. ${(error as Error).message}`);
  }
  const workspace: ResolvedWorkspace = {
    rootDir: info.worktreeRoot,
    baseRoot: info.baseRoot,
    gitCommonDir: info.gitCommonDir,
    isWorktree: info.isWorktree,
    resolvedAt: new Date().toISOString(),
  };
  // A rejected request must not create or copy an index into a guessed checkout.
  if (beforeInitialize) await beforeInitialize(workspace);

  // Stage-2 churn optimization: a brand-new worktree clones the base checkout's
  // already-built index so the follow-up incremental reindex only touches its
  // diff. Best-effort — failure just means the worktree reindexes from scratch.
  if (info.isWorktree) {
    try {
      await seedWorktreeFromBase(info.worktreeRoot, info.baseRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/workspace-router] base-index seed failed for ${info.worktreeRoot}: ${message}\n`);
    }
  }

  // Cache under the request path, canonical path and resolved worktree root,
  // since git may realpath the toplevel to a different string than the request.
  workspaces.set(requested, workspace);
  workspaces.set(normalized, workspace);
  workspaces.set(workspace.rootDir, workspace);
  return workspace;
}

/** All workspaces resolved so far this process, de-duplicated by rootDir. */
export function listActiveWorkspaces(): ResolvedWorkspace[] {
  const byRoot = new Map<string, ResolvedWorkspace>();
  for (const ws of workspaces.values()) {
    byRoot.set(ws.rootDir, ws);
  }
  return [...byRoot.values()];
}

/** Drop a single workspace from the cache (e.g. on worktree teardown). */
export function forgetWorkspace(rootDir: string): void {
  const requested = resolve(rootDir);
  const normalized = workspaces.get(requested)?.rootDir ?? requested;
  for (const [key, ws] of workspaces) {
    if (key === normalized || ws.rootDir === normalized) workspaces.delete(key);
  }
}

/** Clear the entire router cache. Intended for tests. */
export function resetWorkspaceRouter(): void {
  workspaces.clear();
}
