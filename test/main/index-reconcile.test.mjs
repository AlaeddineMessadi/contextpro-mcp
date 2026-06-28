// Reconciliation sweep tests — self-healing index drift recovery
// FEATURE: A periodic FS<->index diff that catches new/changed/removed files the
// FS-watch events miss (Linux non-recursive watch, atomic renames, churn), so a
// fast-moving session never goes stale and never needs a manual full reindex.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";

async function loadReconcile() {
  return import("../../build/core/index-reconcile.js");
}

async function indexFiles(paths) {
  const { refreshFilesStructural } = await import("../../build/tools/reindex.js");
  return refreshFilesStructural(root, paths);
}

describe("reconcileIndex — self-healing drift recovery", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-reconcile-"));
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("indexes a brand-new file that the watcher never saw", async () => {
    // Seed the index with one file so the DB exists and is non-empty.
    await writeFile(join(root, "known.ts"), "export const known = 1;\n");
    await indexFiles(["known.ts"]);

    // A second file lands on disk WITHOUT going through the tracker (simulating a
    // missed watch event / a file created before boot).
    await writeFile(join(root, "surprise.ts"), "export function surpriseFn(): number { return 2; }\n");

    const { reconcileIndex } = await loadReconcile();
    const result = await reconcileIndex(root, { maxFiles: 40 });

    assert.ok(result.refreshed >= 1, `expected at least one refreshed file, got ${result.refreshed}`);

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const file = db.getFile("surprise.ts");
    assert.ok(file, "surprise.ts should be indexed after reconcile");
    const symbols = db.getSymbolsByFile(file.id).map((s) => s.name);
    assert.ok(symbols.includes("surpriseFn"), `expected surpriseFn in ${JSON.stringify(symbols)}`);
  });

  it("prunes a file that was deleted on disk but still in the index", async () => {
    await writeFile(join(root, "keep.ts"), "export const keep = 1;\n");
    await writeFile(join(root, "gone.ts"), "export const gone = 2;\n");
    await indexFiles(["keep.ts", "gone.ts"]);

    // Delete one file out-of-band.
    await rm(join(root, "gone.ts"));

    const { reconcileIndex } = await loadReconcile();
    const result = await reconcileIndex(root, { maxFiles: 40 });

    assert.ok(result.removed >= 1, `expected at least one removed file, got ${result.removed}`);

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    assert.ok(!db.getFile("gone.ts"), "gone.ts should be pruned from the index");
    assert.ok(db.getFile("keep.ts"), "keep.ts should remain indexed");
  });

  it("re-indexes a file whose content drifted from the index hash", async () => {
    await writeFile(join(root, "drift.ts"), "export function before(): void {}\n");
    await indexFiles(["drift.ts"]);

    // Out-of-band edit — content changes but tracker never fired.
    await writeFile(join(root, "drift.ts"), "export function after(): void {}\n");

    const { reconcileIndex } = await loadReconcile();
    await reconcileIndex(root, { maxFiles: 40 });

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const file = db.getFile("drift.ts");
    const symbols = db.getSymbolsByFile(file.id).map((s) => s.name);
    assert.ok(symbols.includes("after"), "drifted content should be re-indexed");
    assert.ok(!symbols.includes("before"), "stale symbol should be gone");
  });

  it("is a clean no-op when the index already matches the filesystem", async () => {
    await writeFile(join(root, "stable.ts"), "export const stable = 1;\n");
    await indexFiles(["stable.ts"]);

    const { reconcileIndex } = await loadReconcile();
    const result = await reconcileIndex(root, { maxFiles: 40 });

    assert.equal(result.refreshed, 0, "nothing should be refreshed");
    assert.equal(result.removed, 0, "nothing should be removed");
    assert.equal(result.drifted, 0, "no drift should be detected");
  });

  it("respects maxFiles so a large backlog drains over multiple sweeps", async () => {
    await writeFile(join(root, "seed.ts"), "export const seed = 1;\n");
    await indexFiles(["seed.ts"]);

    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, `extra${i}.ts`), `export const extra${i} = ${i};\n`);
    }

    const { reconcileIndex } = await loadReconcile();
    const first = await reconcileIndex(root, { maxFiles: 4 });
    assert.ok(first.refreshed <= 4, `first sweep should refresh at most 4, got ${first.refreshed}`);
    assert.ok(first.pending > 0, "first sweep should report remaining pending work");

    // Drain the rest.
    let guard = 0;
    let pending = first.pending;
    while (pending > 0 && guard < 10) {
      const next = await reconcileIndex(root, { maxFiles: 4 });
      pending = next.pending;
      guard++;
    }

    const final = await reconcileIndex(root, { maxFiles: 40 });
    assert.equal(final.drifted, 0, "all files should eventually be indexed");
  });

  it("still detects a real edit after the mtime pre-filter has cached the file", async () => {
    // Seed + index a file so it's in the stat cache after the first sweep.
    await writeFile(join(root, "watched.ts"), "export const v = 1;\n");
    await indexFiles(["watched.ts"]);
    const { reconcileIndex, forgetReconcileStatCache } = await loadReconcile();
    forgetReconcileStatCache(root); // start from a clean cache for determinism

    // First sweep: seeds the stat cache, no drift (already indexed & matching).
    const first = await reconcileIndex(root, { maxFiles: 40 });
    assert.equal(first.drifted, 0, "freshly-indexed file should not drift");

    // Second sweep with NO change: the pre-filter should skip it → still no drift.
    const second = await reconcileIndex(root, { maxFiles: 40 });
    assert.equal(second.drifted, 0, "unchanged file must stay no-drift (pre-filter skip)");

    // Now actually edit it — mtime+size change, so the pre-filter must NOT skip it.
    await new Promise((r) => setTimeout(r, 10)); // ensure mtime advances
    await writeFile(join(root, "watched.ts"), "export const v = 2; // changed\n");
    const third = await reconcileIndex(root, { maxFiles: 40 });
    assert.equal(third.refreshed, 1, "a real edit must be detected despite the mtime cache");
  });
});
