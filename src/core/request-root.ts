// Resolve the effective project root for a single tool request.
// FEATURE: Multi-worktree routing — a tool may carry an optional `root` argument
// (or inherit the server's boot root); this resolves it to a workspace and hands
// back the args with `root` stripped so handlers see their normal shape.

import { isAbsolute } from "path";
import { resolveWorkspace, type ResolvedWorkspace } from "./workspace-router.js";
import { resolveAutoRoot, type RootsProvider } from "./roots-detect.js";
import { requireExplicitRootForSharedWorktrees } from "./worktree-root-guard.js";

export interface RequestRootResolution extends ResolvedWorkspace {
  /** Original args minus the `root` field, ready to forward to the handler. */
  handlerArgs: Record<string, unknown>;
}

export interface ResolveRequestRootOptions {
  /** Queries the MCP client's advertised workspace roots for auto-detection. */
  rootsProvider?: RootsProvider;
  /** The cwd to attribute the request to when several client roots exist. */
  requestCwd?: string;
  /** Vetoes the picked client root, which then yields to the default root. */
  acceptClientRoot?: (root: string) => boolean | Promise<boolean>;
  /** Where the server started, named in the error when there is no default root. */
  launchDir?: string;
}

/** No explicit root, no usable client root, and the server started without a default root. */
export class NoProjectRootError extends Error {}

/**
 * Resolve the workspace a request targets. Precedence:
 *   explicit `args.root` → MCP client roots (auto-detected) → server boot root.
 * Throws NoProjectRootError when none applies (the server started unbound).
 * The returned `handlerArgs` has `root` removed so existing handlers are unaffected.
 */
export async function resolveRequestRoot(
  args: Record<string, unknown> | undefined,
  defaultRoot: string | undefined,
  options: ResolveRequestRootOptions = {},
): Promise<RequestRootResolution> {
  const safeArgs = args ?? {};
  const rawRoot = safeArgs.root;
  const explicitRoot = typeof rawRoot === "string" && rawRoot.trim().length > 0 ? rawRoot : undefined;
  // A relative root would resolve against the server's cwd, and count as explicit for the worktree guard.
  if (explicitRoot && !isAbsolute(explicitRoot)) {
    const shown = explicitRoot.length > 120 ? `${explicitRoot.slice(0, 117)}...` : explicitRoot;
    throw new Error(`root must be an absolute path, got "${shown}". Pass the absolute directory of the checkout you are working in.`);
  }

  // Auto-detect from the client's roots only when no explicit root was passed and
  // a provider is available; otherwise fall straight through to the boot root.
  const effectiveRoot = options.rootsProvider
    ? await resolveAutoRoot(explicitRoot, defaultRoot, options.rootsProvider, options.requestCwd ?? defaultRoot, options.acceptClientRoot)
    : explicitRoot;
  if (!effectiveRoot && !defaultRoot) {
    throw new NoProjectRootError(`No project root: the server started in ${options.launchDir ?? "a folder"}, which ContextPro will not index. `
      + "Pass root:<absolute project path>, start the client in the project, or add --root to this project's MCP config.");
  }

  const workspace = await resolveWorkspace(
    effectiveRoot, defaultRoot, explicitRoot ? undefined : requireExplicitRootForSharedWorktrees,
  );
  const { root: _omit, ...handlerArgs } = safeArgs;
  return { ...workspace, handlerArgs };
}
