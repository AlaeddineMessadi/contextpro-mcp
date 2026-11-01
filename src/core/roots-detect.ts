// Auto-detect the request's worktree root from the MCP client's `roots` capability.
// FEATURE: Zero-config multi-worktree routing — when an agent does not pass an
// explicit `root`, ask the client which workspace roots it has open and pick the
// one this request belongs to. Degrades silently to the server's boot root when
// the client advertises no usable roots (or lacks the capability entirely).

import { execFile } from "child_process";
import { isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);

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
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Choose the workspace root a request belongs to from the client's advertised list.
 *  - 0 roots → undefined (caller falls back to boot root).
 *  - 1 root  → that root (the common single-workspace / single-worktree case).
 *  - N roots → the one whose directory contains `requestCwd`; undefined if none
 *    (or no `requestCwd`), since guessing the wrong worktree is worse than falling back.
 */
export function selectRootFromList(rootUris: string[], requestCwd?: string): string | undefined {
  const paths = rootUris.map(fileUriToPath).filter((p): p is string => p !== null);
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];
  if (!requestCwd) return undefined;

  // Multiple roots: pick the most specific one that contains the request cwd.
  const containing = paths
    .filter((p) => isInside(p, requestCwd))
    .sort((a, b) => b.length - a.length);
  return containing[0];
}

/**
 * Resolve the effective root for a request. Precedence:
 *   explicit `root` arg → client roots (via provider) → boot root.
 * Provider errors, empty results and a client root `accept` rejects all fall through
 * to the boot root (undefined when the server started without one).
 */
export async function resolveAutoRoot(
  explicitRoot: string | undefined,
  bootRoot: string | undefined,
  rootsProvider: RootsProvider,
  requestCwd: string | undefined,
  accept?: (root: string) => boolean | Promise<boolean>,
): Promise<string | undefined> {
  if (explicitRoot && explicitRoot.trim().length > 0) return explicitRoot;
  try {
    const uris = await rootsProvider();
    const picked = selectRootFromList(uris, requestCwd);
    if (picked && (!accept || await accept(picked))) return picked;
  } catch {
    // Client lacks the roots capability or the request failed — use the boot root.
  }
  return bootRoot;
}

const ROOTS_CACHE_TTL_MS = 5000;
const ROOTS_REQUEST_TIMEOUT_MS = 2000;

/**
 * The client's advertised roots, cached briefly (a client can change them mid-session)
 * and shared by concurrent calls. A failed or unanswered request counts as "no roots"
 * for the cache lifetime, so a silent client stalls one call, not every call.
 */
export function createClientRoots(server: Pick<Server, "getClientCapabilities" | "listRoots" | "setNotificationHandler">): {
  list: RootsProvider;
  /** Whether `dir` is inside a Git work tree, cached per path for the roots-cache lifetime. */
  isGitWorkTree: (dir: string) => Promise<boolean>;
} {
  let cache: { uris: string[]; at: number; gitWorkTree: Map<string, Promise<boolean>> } | null = null;
  let pending: Promise<string[]> | null = null;
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => { cache = null; pending = null; });

  const list = async (): Promise<string[]> => {
    if (cache && Date.now() - cache.at < ROOTS_CACHE_TTL_MS) return cache.uris;
    if (!server.getClientCapabilities()?.roots) return [];
    if (pending) return pending;
    const request: Promise<string[]> = server.listRoots(undefined, { timeout: ROOTS_REQUEST_TIMEOUT_MS }).then(
      (result) => (result.roots ?? []).map((r) => r.uri).filter((u): u is string => typeof u === "string"),
      () => [],
    ).then((uris) => {
      // A list_changed notification during the request made this answer stale: do not cache it.
      if (pending === request) {
        cache = { uris, at: Date.now(), gitWorkTree: new Map() };
        pending = null;
      }
      return uris;
    });
    pending = request;
    return request;
  };

  const isGitWorkTree = (dir: string): Promise<boolean> => {
    let answer = cache?.gitWorkTree.get(dir);
    if (!answer) {
      answer = execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, timeout: 4000 })
        .then(({ stdout }) => stdout.trim() === "true", () => false);
      cache?.gitWorkTree.set(dir, answer);
    }
    return answer;
  };

  return { list, isGitWorkTree };
}
