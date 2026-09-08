// Per-request workspace resolution for multi-worktree support.
// FEATURE: One MCP process serves many git worktrees — resolve the workspace a
// request belongs to (its own root + the shared base checkout) lazily and cache it,
// so parallel agents in different worktrees each hit the correct index.

import { resolve } from "path";
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
  const normalized = normalizeRequestRoot(requestRoot, defaultRoot);
  const cached = workspaces.get(normalized);
  if (cached) {
    // Routing must be checked for every request: worktrees may have appeared
    // since this metadata was cached, or the prior caller passed an explicit root.
    if (beforeInitialize) await beforeInitialize(cached);
    return cached;
  }

  // Guard before touching git or the filesystem for storage.
  validateSelectedRoot({ rootDir: normalized, source: requestRoot ? "flag" : "cwd" });

  const info = await detectWorktreeInfo(normalized);
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

  // Cache under both the request-normalized path and the resolved worktree root,
  // since git may realpath the toplevel to a different string than the request.
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
  const normalized = resolve(rootDir);
  for (const [key, ws] of workspaces) {
    if (key === normalized || ws.rootDir === normalized) workspaces.delete(key);
  }
}

/** Clear the entire router cache. Intended for tests. */
export function resetWorkspaceRouter(): void {
  workspaces.clear();
}
