// Per-request root context using AsyncLocalStorage.
// FEATURE: Multi-worktree routing — withRequestActivity establishes the resolved
// root for the duration of a tool call so handlers read it without threading the
// value through every signature. Falls back to the server's boot root when no
// request context is active (CLI paths, tests, direct calls).

import { AsyncLocalStorage } from "async_hooks";

interface RequestContext {
  rootDir: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `rootDir` as the active request root. */
export function runWithRequestRoot<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ rootDir }, fn);
}

/** The active request root, or `fallback` when no request context is established. */
export function currentRoot(fallback: string): string {
  return storage.getStore()?.rootDir ?? fallback;
}
