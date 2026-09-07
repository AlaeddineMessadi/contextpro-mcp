// Shared source mutation coordination and optimistic atomic publication.
// FEATURE: Cross-process serialization, conflict detection and mode-preserving writes.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ensureContextProDir } from "./data-dir.js";
import { canonicalProjectPath, resolveProjectPath } from "./path-guard.js";

const held = new AsyncLocalStorage<{ root: string; active: boolean }>();
const queues = new Map<string, Promise<void>>();

/** Root scope makes multi-file edits and nested backup operations deadlock-free. */
export async function withSourceMutation<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const root = canonicalProjectPath(resolve(rootDir));
  const current = held.getStore();
  if (current?.root === root && current.active) return operation();
  const previous = queues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((done) => { release = done; });
  const queued = previous.then(() => tail);
  queues.set(root, queued);
  await previous;
  let acquired = false;
  const lock = join(root, ".contextpro", "source-mutation.lock");
  const owner = join(lock, "owner.json");
  const token = randomUUID();
  try {
    // Migrate before lock-directory creation; otherwise the new .contextpro directory
    // would suppress migration of an existing .contextplus/.mcp_data index forever.
    await ensureContextProDir(root);
    assertMutationPath(root, ".contextpro/source-mutation.lock");
    await mkdir(dirname(lock), { recursive: true });
    const deadline = Date.now() + 15_000;
    while (!acquired) {
      if (Date.now() >= deadline) throw new Error(`Source mutation lock timeout: ${lock}. Another process is editing; retry after it finishes. An ownerless lock requires manual recovery.`);
      assertMutationPath(root, ".contextpro/source-mutation.lock");
      try {
        await mkdir(lock);
        acquired = true;
        await writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
      } catch (error) {
        if (acquired || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Only the contender that removes the dead owner's file may remove its directory.
        // Never recursively remove a lock: that could delete a successor's ownership.
        try {
          const value = JSON.parse(await readFile(owner, "utf8"));
          if (Number.isInteger(value.pid) && value.pid > 0) {
            try { process.kill(value.pid, 0); } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                const recovery = `${lock}.recovery`;
                try {
                  await mkdir(recovery);
                  try {
                    const latest = JSON.parse(readFileSync(owner, "utf8"));
                    try { process.kill(latest.pid, 0); } catch (dead) {
                      if ((dead as NodeJS.ErrnoException).code === "ESRCH") {
                        unlinkSync(owner);
                        rmdirSync(lock);
                      }
                    }
                  } finally { await rmdir(recovery); }
                } catch { /* Another contender is recovering; retry. */ }
                continue;
              }
            }
          }
        } catch { /* Incomplete ownership fails closed until timeout. */ }
        if (Date.now() >= deadline) throw new Error(`Source mutation lock timeout: ${lock}. Another process is editing; retry after it finishes. An ownerless lock requires manual recovery.`);
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    const scope = { root, active: true };
    try { return await held.run(scope, operation); } finally { scope.active = false; }
  } finally {
    if (acquired) {
      try {
        const value = JSON.parse(await readFile(owner, "utf8"));
        if (value.token === token) { await unlink(owner); await rmdir(lock); }
      } catch { /* Retain unexpected ownership rather than deleting another process's lock. */ }
    }
    release();
    if (queues.get(root) === queued) queues.delete(root);
  }
}

/** Source mutations reject symlinks below the root, including symlinked parents. */
export function assertMutationPath(rootDir: string, inputPath: string): string {
  const candidate = resolveProjectPath(rootDir, inputPath);
  const root = resolve(rootDir);
  let cursor = root;
  for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Source mutation refuses symlink: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return candidate;
}

export interface SourceSnapshot {
  path: string;
  content: string | null;
  hash: string | null;
  mode: number | null;
  identity: string | null;
}

export function captureSource(rootDir: string, inputPath: string): SourceSnapshot {
  const path = assertMutationPath(rootDir, inputPath);
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const content = readFileSync(fd, "utf8");
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error(`Source mutation requires a regular file: ${path}`);
      return { path, content, hash: createHash("sha256").update(content).digest("hex"), mode: Number(stat.mode) & 0o7777, identity: `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}` };
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, content: null, hash: null, mode: null, identity: null };
  }
}

export function assertSourceUnchanged(rootDir: string, snapshot: SourceSnapshot): void {
  const current = captureSource(rootDir, snapshot.path);
  if (current.hash !== snapshot.hash || current.identity !== snapshot.identity) {
    throw new Error(`Source conflict: ${snapshot.path} changed after it was read. No overwrite performed; read current content and retry.`);
  }
}

/** Publish only against the captured revision. Each file is atomic, a multi-file batch is not. */
export async function publishSource(rootDir: string, snapshot: SourceSnapshot, content: string | null): Promise<void> {
  assertSourceUnchanged(rootDir, snapshot);
  if (content === null) {
    if (snapshot.content !== null) unlinkSync(assertMutationPath(rootDir, snapshot.path));
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true });
  assertMutationPath(rootDir, snapshot.path);
  const temp = join(dirname(snapshot.path), `.contextpro-write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), snapshot.mode ?? 0o666);
    writeFileSync(fd, content, "utf8");
    if (snapshot.mode !== null) chmodSync(temp, snapshot.mode);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // No asynchronous yield between final identity/containment checks and atomic rename.
    assertSourceUnchanged(rootDir, snapshot);
    renameSync(temp, snapshot.path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
