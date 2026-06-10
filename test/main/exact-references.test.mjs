import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { reindex } from "../../build/tools/reindex.js";
import { exactReferencesTool } from "../../build/tools/exact-references.js";
import { importScipIndex } from "../../build/core/scip-index.js";
import { closeDB } from "../../build/core/db.js";

const FIXTURE_DIR = join(process.cwd(), "test", "_exact_refs_fixtures");
const SCIP_FIXTURE_DIR = join(process.cwd(), "test", "_exact_refs_scip_fixtures");

describe("exact references", () => {
  it("finds TypeScript definition and usage references", async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    await mkdir(join(FIXTURE_DIR, "src"), { recursive: true });
    try {
      await writeFile(
        join(FIXTURE_DIR, "src", "math.ts"),
        "// Math\n// FEATURE: exact refs\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
      );
      await writeFile(
        join(FIXTURE_DIR, "src", "use.ts"),
        "// Use\n// FEATURE: exact refs\n\nimport { add } from './math';\n\nexport const value = add(1, 2);\n",
      );
      await reindex({ rootDir: FIXTURE_DIR, force: true });
      const result = JSON.parse(await exactReferencesTool({
        rootDir: FIXTURE_DIR,
        symbolName: "add",
        format: "json",
      }));
      assert.equal(result.confidence, "LSP_RESOLVED");
      assert.ok(result.references.some((ref) => ref.file === "src/math.ts" && ref.isDefinition));
      assert.ok(result.references.some((ref) => ref.file === "src/use.ts" && ref.context.includes("add")));
    } finally {
      closeDB(FIXTURE_DIR);
      await rm(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it("uses imported SCIP references when language-service references are unavailable", async () => {
    await rm(SCIP_FIXTURE_DIR, { recursive: true, force: true });
    await mkdir(join(SCIP_FIXTURE_DIR, "src"), { recursive: true });
    try {
      await writeFile(
        join(SCIP_FIXTURE_DIR, "src", "math.py"),
        "def add(a, b):\n    return a + b\n",
      );
      await writeFile(
        join(SCIP_FIXTURE_DIR, "src", "use.py"),
        "from math import add\nvalue = add(1, 2)\n",
      );
      await writeFile(
        join(SCIP_FIXTURE_DIR, "scip.json"),
        JSON.stringify({
          documents: [
            {
              relative_path: "src/math.py",
              symbols: [
                {
                  symbol: "local src/math.py add().",
                  display_name: "add",
                  kind: "Function",
                },
              ],
              occurrences: [
                {
                  range: [0, 4, 7],
                  symbol: "local src/math.py add().",
                  symbol_roles: 1,
                },
              ],
            },
            {
              relative_path: "src/use.py",
              occurrences: [
                {
                  range: [1, 8, 11],
                  symbol: "local src/math.py add().",
                  symbol_roles: 0,
                },
              ],
            },
          ],
        }, null, 2),
      );
      await importScipIndex(SCIP_FIXTURE_DIR, "scip.json");
      const result = JSON.parse(await exactReferencesTool({
        rootDir: SCIP_FIXTURE_DIR,
        symbolName: "add",
        format: "json",
      }));
      assert.equal(result.confidence, "SCIP_RESOLVED");
      assert.ok(result.references.some((ref) => ref.file === "src/math.py" && ref.isDefinition));
      assert.ok(result.references.some((ref) => ref.file === "src/use.py" && ref.context.includes("add")));
    } finally {
      closeDB(SCIP_FIXTURE_DIR);
      await rm(SCIP_FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  after(async () => {
    closeDB(FIXTURE_DIR);
    closeDB(SCIP_FIXTURE_DIR);
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    await rm(SCIP_FIXTURE_DIR, { recursive: true, force: true });
  });
});
