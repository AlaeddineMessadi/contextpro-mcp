import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startEmbeddingTracker } from "../../build/core/embedding-tracker.js";
import { getDB, closeDB } from "../../build/core/db.js";

for (const failure of ["startup", "runtime"]) {
  it(`reconciles without filesystem events after watcher ${failure} failure`, async t => {
    const root = await mkdtemp(join(tmpdir(), "contextpro-watch-failure-"));
    const previous = process.env.CONTEXTPRO_REINDEX_NO_EMBED;
    process.env.CONTEXTPRO_REINDEX_NO_EMBED = "true";
    const watcher = new EventEmitter();
    let closed = false;
    watcher.close = () => { closed = true; };
    let stop;
    t.mock.timers.enable({ apis: ["setInterval"] });
    try {
      const db = await getDB(root);
      stop = startEmbeddingTracker({ rootDir: root, reconcileIntervalMs: 5000, watchFactory: () => {
        if (failure === "startup") throw new Error("watch unavailable");
        return watcher;
      } });
      if (failure === "runtime") { watcher.emit("error", new Error("watch dropped")); assert.equal(closed, true); }
      // Both the first poll and a subsequent edit without a watcher signal heal.
      for (let i = 0; i < 2; i++) {
        const path = `added${i}.ts`;
        await writeFile(join(root, path), `export const added${i} = ${i};\n`);
        t.mock.timers.tick(5000);
        for (let tries = 0; tries < 200 && !db.getFile(path); tries++) await delay(10);
        assert.ok(db.getFile(path), `poll must index ${path}`);
        // The row is written before the sweep's final status bookkeeping.
        for (let tries = 0; tries < 200 && db.getMeta("index_status") === "indexing"; tries++) await delay(10);
      }
    } finally {
      stop?.(); t.mock.timers.reset(); closeDB(root);
      if (previous === undefined) delete process.env.CONTEXTPRO_REINDEX_NO_EMBED; else process.env.CONTEXTPRO_REINDEX_NO_EMBED = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
