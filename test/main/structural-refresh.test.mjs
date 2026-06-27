import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";

async function loadReindex() {
  return import("../../build/tools/reindex.js");
}

describe("refreshFilesStructural — per-file structural update", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-structural-"));
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("indexes symbols for a newly created file without a directory walk", async () => {
    await writeFile(join(root, "alpha.ts"), "export function alphaFn(): number { return 1; }\n");
    const mod = await loadReindex();
    const result = await mod.refreshFilesStructural(root, ["alpha.ts"]);
    assert.equal(result.indexed, 1);

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const file = db.getFile("alpha.ts");
    assert.ok(file, "alpha.ts should be indexed");
    const symbols = db.getSymbolsByFile(file.id).map((s) => s.name);
    assert.ok(symbols.includes("alphaFn"), `expected alphaFn in ${JSON.stringify(symbols)}`);
  });

  it("reflects an edit: removed symbol gone, added symbol present", async () => {
    await writeFile(join(root, "beta.ts"), "export function oldOne(): void {}\n");
    const mod = await loadReindex();
    await mod.refreshFilesStructural(root, ["beta.ts"]);

    await writeFile(join(root, "beta.ts"), "export function newOne(): void {}\n");
    const result = await mod.refreshFilesStructural(root, ["beta.ts"]);
    assert.equal(result.indexed, 1);

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const file = db.getFile("beta.ts");
    const symbols = db.getSymbolsByFile(file.id).map((s) => s.name);
    assert.ok(symbols.includes("newOne"), "new symbol should be present");
    assert.ok(!symbols.includes("oldOne"), "old symbol should be gone");
  });

  it("rebuilds the import edge between two changed files", async () => {
    await writeFile(join(root, "dep.ts"), "export const dep = 1;\n");
    await writeFile(join(root, "main.ts"), "import { dep } from './dep.js';\nexport const useDep = dep;\n");
    const mod = await loadReindex();
    await mod.refreshFilesStructural(root, ["dep.ts", "main.ts"]);

    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const mainFile = db.getFile("main.ts");
    const imports = db.getImportsFrom(mainFile.id);
    assert.ok(imports.length >= 1, `expected an import edge from main.ts, got ${imports.length}`);
  });

  it("is a no-op for an empty file list", async () => {
    const mod = await loadReindex();
    const result = await mod.refreshFilesStructural(root, []);
    assert.equal(result.indexed, 0);
  });

  it("skips unsupported / unreadable files without throwing", async () => {
    const mod = await loadReindex();
    const result = await mod.refreshFilesStructural(root, ["does-not-exist.ts", "image.png"]);
    assert.equal(result.indexed, 0);
    assert.ok(result.skipped >= 1);
  });
});
