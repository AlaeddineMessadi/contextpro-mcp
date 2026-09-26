import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getDB, closeDB, hashContent } from "../../build/core/db.js";
import { reconcileIndex, forgetReconcileStatCache } from "../../build/core/index-reconcile.js";
import { refreshFilesStructural, quickRefresh, reindex } from "../../build/tools/reindex.js";
import { buildProjectGraph, invalidateProjectGraphCache } from "../../build/core/project-graph.js";
import { getExtractorStamp } from "../../build/core/extractor-stamp.js";

let root;
let previousNoEmbed;
const structural = (paths, options = {}) => refreshFilesStructural(root, paths, { includeEmbeddings: false, ...options });

describe("index consistency regressions", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-consistency-"));
    previousNoEmbed = process.env.CONTEXTPRO_REINDEX_NO_EMBED;
    process.env.CONTEXTPRO_REINDEX_NO_EMBED = "1";
  });
  afterEach(async () => {
    if (previousNoEmbed === undefined) delete process.env.CONTEXTPRO_REINDEX_NO_EMBED;
    else process.env.CONTEXTPRO_REINDEX_NO_EMBED = previousNoEmbed;
    forgetReconcileStatCache(root);
    invalidateProjectGraphCache(root);
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  for (const mode of ['stat', 'hash']) {
    it(`excludes oversized SQL before quick-refresh reads and drops old indexed contents (${mode})`, async () => {
      const previous = process.env.CONTEXTPRO_MAX_FILE_SIZE;
      const previousMode = process.env.CONTEXTPRO_REFRESH;
      process.env.CONTEXTPRO_MAX_FILE_SIZE = '1024';
      process.env.CONTEXTPRO_REFRESH = mode;
      try {
        await writeFile(join(root, 'small.ts'), 'export const small = true;\n');
        await writeFile(join(root, 'dump.sql'), 'create table old_dump (id int);\n');
        await reindex({rootDir:root, noEmbed:true});
        const db = await getDB(root);
        assert.ok(db.getFile('dump.sql'));
        await writeFile(join(root, 'dump.sql'), '-- large dump\n'.repeat(200));
        await writeFile(join(root, 'new.sql'), '-- new dump\n'.repeat(200));
        const originalRead = fs.readFile;
        let dumpReads = 0;
        fs.readFile = async (...args) => {
          if ([join(root, 'dump.sql'), join(root, 'new.sql')].includes(String(args[0]))) dumpReads++;
          return originalRead(...args);
        };
        syncBuiltinESMExports();
        let result;
        try { result = await quickRefresh(root, {includeEmbeddings:false}); }
        finally { fs.readFile = originalRead; syncBuiltinESMExports(); }
        assert.equal(dumpReads, 0, 'oversized content must never be read');
        assert.equal(result.complete, true);
        assert.equal(db.getFile('dump.sql'), null);
        assert.equal(db.getFile('new.sql'), null);
        assert.deepEqual(db.searchFileText('old_dump', 10, true), []);
        assert.equal((await quickRefresh(root, {includeEmbeddings:false})).staleCount, 0);
        await writeFile(join(root, 'dump.sql'), 'create table restored (id int);\n');
        assert.equal((await quickRefresh(root, {includeEmbeddings:false})).complete, true);
        assert.ok(db.getFile('dump.sql'));
      } finally {
        if (previous === undefined) delete process.env.CONTEXTPRO_MAX_FILE_SIZE;
        else process.env.CONTEXTPRO_MAX_FILE_SIZE = previous;
        if (previousMode === undefined) delete process.env.CONTEXTPRO_REFRESH;
        else process.env.CONTEXTPRO_REFRESH = previousMode;
      }
    });
  }

  it('rechecks the size cap after acquiring the refresh lock', async () => {
    const previous = process.env.CONTEXTPRO_MAX_FILE_SIZE;
    process.env.CONTEXTPRO_MAX_FILE_SIZE = '1024';
    try {
      await writeFile(join(root, 'dump.sql'), 'select 1;');
      await reindex({rootDir:root, noEmbed:true});
      await writeFile(join(root, 'dump.sql'), 'select 2;');
      const db = await getDB(root);
      const original = db.getStaleFiles;
      let scans = 0;
      db.getStaleFiles = function (...args) {
        if (++scans === 2) writeFileSync(join(root, 'dump.sql'), '-- grew while waiting\n'.repeat(200));
        return original.apply(this, args);
      };
      try { assert.equal((await quickRefresh(root, {includeEmbeddings:false})).complete, true); }
      finally { db.getStaleFiles = original; }
      assert.equal(db.getFile('dump.sql'), null);
    } finally {
      if (previous === undefined) delete process.env.CONTEXTPRO_MAX_FILE_SIZE;
      else process.env.CONTEXTPRO_MAX_FILE_SIZE = previous;
    }
  });

  it("drains capped changes to already-indexed files across repeated stat-cache sweeps", async () => {
    const paths = ["one.ts", "two.ts", "three.ts"];
    for (const path of paths) await writeFile(join(root, path), "export function before() {}\n");
    await structural(paths);
    await reconcileIndex(root);
    for (const path of paths) await writeFile(join(root, path), "export function after() {}\n");
    for (let pending = 2; pending >= 0; pending--) {
      const result = await reconcileIndex(root, { maxFiles: 1 });
      assert.equal(result.refreshed, 1);
      assert.equal(result.pending, pending);
    }
    const db = await getDB(root);
    for (const path of paths) assert.deepEqual(db.getSymbolsByFile(db.getFile(path).id).map((symbol) => symbol.name), ["after"]);
    assert.equal((await reconcileIndex(root)).drifted, 0);
  });

  it("rolls back a failed structural write and retries without another disk edit", async () => {
    await writeFile(join(root, "retry.ts"), "export function before() {}\n");
    await structural(["retry.ts"]);
    await reconcileIndex(root);
    const content = "export function after() {}\n";
    await writeFile(join(root, "retry.ts"), content);
    const db = await getDB(root);
    const upsertSymbols = db.upsertSymbols;
    db.upsertSymbols = () => { throw new Error("injected write failure"); };
    try {
      const failed = await reconcileIndex(root);
      assert.equal(failed.refreshed, 0);
      assert.equal(failed.pending, 1);
      assert.deepEqual(failed.changedSymbols, []);
      assert.notEqual(db.getFile("retry.ts").content_hash, hashContent(content));
    } finally { db.upsertSymbols = upsertSymbols; }
    assert.equal((await reconcileIndex(root)).refreshed, 1);
    assert.equal(db.getFile("retry.ts").content_hash, hashContent(content));
  });

  it("invalidates cached graphs for a deletion-only sweep", async () => {
    await writeFile(join(root, "gone.ts"), "export function gone() {}\n");
    await structural(["gone.ts"]);
    const before = await buildProjectGraph(root);
    assert.ok(before.nodes.some((node) => node.path === "gone.ts"));
    await rm(join(root, "gone.ts"));
    const result = await reconcileIndex(root);
    assert.equal(result.removed, 1);
    assert.ok(result.changedSymbols.includes("-gone.ts:gone"));
    const after = await buildProjectGraph(root);
    assert.ok(after.indexGeneration > before.indexGeneration);
    assert.ok(!after.nodes.some((node) => node.path === "gone.ts"));
    assert.equal((await reconcileIndex(root)).drifted, 0);
  });

  it("waits for another writer before removing files and rechecks recreation", async () => {
    await writeFile(join(root, "recreated.ts"), "export const old = 1;\n");
    await structural(["recreated.ts"]);
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    await rm(join(root, "recreated.ts"));
    db.setMetaBatch([["index_status", "indexing"], ["index_owner_pid", String(process.pid)], ["index_started_at", String(Date.now())]]);
    const pending = reconcileIndex(root);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(db.getFile("recreated.ts"), "reconcile must not delete through another writer's lock");
    assert.equal(db.getIndexGeneration(), generation);
    await writeFile(join(root, "recreated.ts"), "export const restored = 2;\n");
    db.setMeta("index_status", "idle");
    assert.equal((await pending).removed, 0, "stale deletion observation must be rechecked");
    assert.equal((await reconcileIndex(root)).refreshed, 1);
  });

  for (const mode of ["structural", "quick", "scoped-reindex"]) {
    it(`repairs incoming imports of an unchanged source when a dependency appears (${mode})`, async () => {
      await writeFile(join(root, "main.ts"), "import { dep } from './dep.js';\nexport const use = dep;\n");
      await structural(["main.ts"]);
      const db = await getDB(root);
      db.setMeta("extractor_stamp", getExtractorStamp());
      const source = db.getFile("main.ts");
      assert.equal(db.getImportsFrom(source.id)[0].target_file_id, null);
      await writeFile(join(root, "dep.ts"), "export const dep = 1;\n");
      if (mode === "structural") await structural(["dep.ts"]);
      else if (mode === "quick") await quickRefresh(root, { includeEmbeddings: false });
      else await reindex({ rootDir: root, targetPath: "dep.ts", noEmbed: true });
      assert.equal(db.getImportersOf(db.getFile("dep.ts").id)[0].source_file_id, source.id);
      assert.equal(db.getFile("main.ts").indexed_at, source.indexed_at, "unchanged importer must not be reparsed");
    });
  }

  it("repairs resolution precedence on create/delete/recreate without reparsing importers", async () => {
    await mkdir(join(root, "dep"));
    await writeFile(join(root, "main.ts"), "import { dep } from './dep';\nexport const use = dep;\n");
    await writeFile(join(root, "dep", "index.ts"), "export const dep = 1;\n");
    await structural(["main.ts", "dep/index.ts"]);
    const db = await getDB(root);
    const source = db.getFile("main.ts");
    const target = () => db.getImportsFrom(source.id)[0].target_file_id;
    assert.equal(target(), db.getFile("dep/index.ts").id);
    await writeFile(join(root, "dep.ts"), "export const dep = 2;\n");
    await structural(["dep.ts"]);
    assert.equal(target(), db.getFile("dep.ts").id);
    await rm(join(root, "dep.ts"));
    await reconcileIndex(root);
    assert.equal(target(), db.getFile("dep/index.ts").id);
    await rm(join(root, "dep", "index.ts"));
    await reconcileIndex(root);
    assert.equal(target(), null);
    await writeFile(join(root, "dep.ts"), "export const dep = 3;\n");
    await structural(["dep.ts"]);
    assert.equal(target(), db.getFile("dep.ts").id);
    assert.equal(db.getFile("main.ts").indexed_at, source.indexed_at);
  });

  it("does not scan stored incoming edges on ordinary content-only refreshes", async () => {
    await writeFile(join(root, "stable.ts"), "export const value = 1;\n");
    await structural(["stable.ts"]);
    const db = await getDB(root);
    const getAllImports = db.getAllImports;
    db.getAllImports = () => { throw new Error("unnecessary incoming edge scan"); };
    try {
      await writeFile(join(root, "stable.ts"), "export const value = 2;\n");
      assert.equal((await structural(["stable.ts"])).indexed, 1);
    } finally { db.getAllImports = getAllImports; }
  });
  for (const mode of ["structural", "quick", "full-reindex"]) {
    it(`rolls back imports, symbols and hash together when import writing fails (${mode})`, async () => {
      const oldContent = "import { a } from './a';\nexport const before = a;\n";
      const newContent = "import { b } from './b';\nexport const after = b;\n";
      await writeFile(join(root, "a.ts"), "export const a = 1;\n");
      await writeFile(join(root, "b.ts"), "export const b = 2;\n");
      await writeFile(join(root, "entry.ts"), oldContent);
      await reindex({ rootDir: root, noEmbed: true });
      const db = await getDB(root);
      const oldFile = db.getFile("entry.ts");
      const generation = db.getIndexGeneration();
      const oldImports = db.getImportsFrom(oldFile.id);
      const oldSymbols = db.getSymbolsByFile(oldFile.id);
      await writeFile(join(root, "entry.ts"), newContent);
      const original = db.upsertImport;
      db.upsertImport = () => { throw new Error("injected import write failure"); };
      try {
        if (mode === "structural") assert.equal((await structural(["entry.ts"])).indexed, 0);
        else if (mode === "quick") assert.equal((await quickRefresh(root, { includeEmbeddings: false })).complete, false);
        else await reindex({ rootDir: root, noEmbed: true });
      } finally { db.upsertImport = original; }
      assert.equal(db.getFile("entry.ts").content_hash, hashContent(oldContent));
      assert.deepEqual(db.getImportsFrom(oldFile.id), oldImports);
      assert.deepEqual(db.getSymbolsByFile(oldFile.id), oldSymbols);
      if (mode === "full-reindex") {
        assert.ok(db.getIndexGeneration() > generation, "degraded reindex must invalidate cached context");
        assert.equal(db.getMeta("index_repair_required"), "1");
        const { getIndexState } = await import("../../build/core/context-metadata.js");
        assert.equal((await getIndexState(root)).state, "stale");
      } else {
        assert.equal(db.getIndexGeneration(), generation);
      }
      const retried = await quickRefresh(root, { includeEmbeddings: false });
      assert.equal(retried.complete, true);
      assert.equal(retried.staleCount, mode === "full-reindex" ? 3 : 1);
      if (mode === "full-reindex") {
        assert.equal(retried.fullReindex, true);
        assert.equal(db.getMeta("index_repair_required"), "");
      }
      assert.equal(db.getFile("entry.ts").content_hash, hashContent(newContent));
      assert.equal(db.getImportsFrom(oldFile.id)[0].target_file_id, db.getFile("b.ts").id);
      assert.deepEqual(db.getSymbolsByFile(oldFile.id).map((symbol) => symbol.name), ["after"]);
    });
  }

  it("marks a failed incoming-edge finalization stale and repairs it despite matching source hashes", async () => {
    await writeFile(join(root, "entry.ts"), "import { b } from './b';\nexport const value = b;\n");
    await reindex({ rootDir: root, noEmbed: true });
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    const original = db.updateImportTarget;
    db.updateImportTarget = () => { throw new Error("injected edge finalization failure"); };
    try {
      await assert.rejects(structural(["b.ts"]), /injected edge finalization failure/);
    } finally { db.updateImportTarget = original; }
    assert.ok(db.getFile("b.ts"), "the completed file transaction remains valid");
    assert.ok(db.getIndexGeneration() > generation, "partial-pass cache results must be invalidated");
    assert.equal(db.getMeta("index_repair_required"), "1");
    const { getIndexState } = await import("../../build/core/context-metadata.js");
    assert.equal((await getIndexState(root)).state, "stale");
    const result = await quickRefresh(root, { includeEmbeddings: false });
    assert.equal(result.fullReindex, true);
    assert.equal(result.complete, true);
    assert.equal(db.getMeta("index_repair_required"), "");
    assert.equal(db.getImportsFrom(db.getFile("entry.ts").id)[0].target_file_id, db.getFile("b.ts").id);
  });

});
