// Auto-detect the request's worktree root from the MCP client's `roots` capability.
// FEATURE: Zero-config multi-worktree routing — when an agent does not pass an
// explicit `root`, ask the client which workspace roots it has open and pick the
// one this request belongs to. Degrades silently to the server's boot root when
// the client advertises no usable roots (or lacks the capability entirely).

import { resolve } from "path";
import { fileURLToPath } from "url";

/** A function that returns the client's advertised root URIs (file:// strings). */
export type RootsProvider = () => Promise<string[]>;

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * Choose the workspace root a request belongs to from the client's advertised list.
 *  - 0 roots → undefined (caller falls back to boot root).
 *  - 1 root  → that root (the common single-workspace / single-worktree case).
 *  - N roots → the one whose directory contains `requestCwd`; undefined if none,
 *    since guessing the wrong worktree is worse than falling back.
 */
export function selectRootFromList(rootUris: string[], requestCwd: string): string | undefined {
  const paths = rootUris.map(fileUriToPath).filter((p): p is string => p !== null);
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];

  // Multiple roots: pick the most specific one that contains the request cwd.
  const containing = paths
    .filter((p) => isInside(p, requestCwd))
    .sort((a, b) => b.length - a.length);
  return containing[0];
}

/**
 * Resolve the effective root for a request. Precedence:
 *   explicit `root` arg → client roots (via provider) → boot root.
 * Provider errors and empty results both fall through to the boot root.
 */
export async function resolveAutoRoot(
  explicitRoot: string | undefined,
  bootRoot: string,
  rootsProvider: RootsProvider,
  requestCwd: string,
): Promise<string> {
  if (explicitRoot && explicitRoot.trim().length > 0) return explicitRoot;
  try {
    const uris = await rootsProvider();
    const picked = selectRootFromList(uris, requestCwd);
    if (picked) return picked;
  } catch {
    // Client lacks the roots capability or the request failed — use the boot root.
  }
  return bootRoot;
}
