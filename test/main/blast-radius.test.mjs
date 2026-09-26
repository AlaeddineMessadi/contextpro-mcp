import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { getBlastRadius } from "../../build/tools/blast-radius.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_blast_fixtures");

async function setup() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
}

describe("blast-radius", async () => {
  await setup();

  describe("getBlastRadius", () => {
    it("finds symbol usages across files", async () => {
      await writeFile(
        join(FIXTURE_DIR, "util.ts"),
        "export function helper() {\n  return 1;\n}\n",
      );
      await writeFile(
        join(FIXTURE_DIR, "main.ts"),
        "import { helper } from './util';\nconsole.log(helper());\n",
      );
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "helper",
      });
      assert.ok(result.includes("helper"));
      assert.ok(result.includes("usages") || result.includes("usage"));
    });

    it("reports zero usages for unknown symbol", async () => {
      await writeFile(join(FIXTURE_DIR, "a.ts"), "function foo() {}\n");
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "nonExistent",
      });
      assert.match(result, /No textual usage candidates found/);
      assert.match(result, /does not prove the symbol is unused/);
    });

    it("counts calls inside exported declarations without counting the function declaration", async () => {
      await writeFile(join(FIXTURE_DIR, "exported.ts"), [
        "import { gate } from './gate';",
        "export function run() { return gate(); }",
        "export const gateResult = gate();",
        "export { gate };",
        "export function gate() { return true; }",
      ].join("\n"));
      const result = await getBlastRadius({ rootDir: FIXTURE_DIR, symbolName: "gate", kind: "call", mode: "detailed" });
      assert.match(result, /call=2, import=2/);
      assert.equal((result.match(/\[call\]/g) ?? []).length, 2);
      assert.match(result, /L2 \[call\]/);
      assert.match(result, /L3 \[call\]/);
    });

    it("excludes definition line when fileContext is provided", async () => {
      await writeFile(join(FIXTURE_DIR, "def.ts"), "function greet() {}\n");
      await writeFile(join(FIXTURE_DIR, "use.ts"), "greet();\n");
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "greet",
        fileContext: "def.ts",
      });
      assert.ok(!result.includes("def.ts") || result.includes("use.ts"));
    });

    it("keeps calls after regex literals visible and classifies regex mentions as literal text", async () => {
      await writeFile(join(FIXTURE_DIR, "regex.ts"), [
        'const quotes = /["\'`]/;',
        'const decoy = /afterRegexCall\\(\\)/;',
        'for (const item of afterRegexCall()) consume(item);',
      ].join('\n'));
      const result = await getBlastRadius({rootDir:FIXTURE_DIR, symbolName:'afterRegexCall', mode:'detailed'});
      assert.match(result, /call=1, import=0, type-reference=0, mock\/stub=0, comment\/string=1/);
      assert.match(result, /L3 \[call\]/);
      assert.match(result, /L2 \[comment\/string\]/);
    });

    it("shows low usage warning for single usage", async () => {
      await writeFile(join(FIXTURE_DIR, "single.ts"), "function rare() {}\n");
      await writeFile(join(FIXTURE_DIR, "once.ts"), "rare();\n");
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "rare",
        fileContext: "single.ts",
      });
      assert.ok(result.includes("LOW USAGE") || result.includes("1 time"));
    });

    it("shows line numbers and context", async () => {
      await writeFile(
        join(FIXTURE_DIR, "ctx.ts"),
        "const x = 1;\nconst y = doWork(x);\nconst z = doWork(y);\n",
      );
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "doWork",
      });
      assert.ok(result.includes("L"));
    });

    it("counts usages in multiple files", async () => {
      await writeFile(
        join(FIXTURE_DIR, "m1.ts"),
        "import { shared } from './s';\nshared();\n",
      );
      await writeFile(
        join(FIXTURE_DIR, "m2.ts"),
        "import { shared } from './s';\nshared();\n",
      );
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "shared",
      });
      assert.ok(result.includes("2 files") || result.includes("usages"));
    });

    it("scans workspace even when graph has not been indexed yet", async () => {
      await writeFile(
        join(FIXTURE_DIR, "lazy.ts"),
        "export function lazyHelper() {\n  return 1;\n}\n",
      );
      await writeFile(
        join(FIXTURE_DIR, "consumer.ts"),
        "import { lazyHelper } from './lazy';\nconsole.log(lazyHelper());\n",
      );
      const result = await getBlastRadius({
        rootDir: FIXTURE_DIR,
        symbolName: "lazyHelper",
        fileContext: "lazy.ts",
      });
      assert.ok(result.includes("consumer.ts"));
      assert.ok(!result.includes("not used"));
    });

    it("groups summary output by enclosing symbol and classifies usage kinds", async () => {
      await writeFile(join(FIXTURE_DIR, "attributed.ts"), [
        "import { tracedHelper } from './util';",
        "function runTask() {",
        "  tracedHelper();",
        "}",
        "// tracedHelper() is documented here",
        "vi.mocked(tracedHelper);",
        "",
      ].join("\n"));
      const result = await getBlastRadius({ rootDir: FIXTURE_DIR, symbolName: "tracedHelper" });
      assert.match(result, /imports <- <module>/);
      assert.match(result, /calls <- runTask/);
      assert.match(result, /comments\/strings <- <module>/);
      assert.match(result, /mocks\/stubs <- <module>/);
    });

    it("keeps every line in detailed mode with kind and enclosing range", async () => {
      await writeFile(join(FIXTURE_DIR, "details.ts"), [
        "function detailedCaller() {",
        "  detailedTarget();",
        "}",
        "const note = 'detailedTarget';",
        "",
      ].join("\n"));
      const result = await getBlastRadius({ rootDir: FIXTURE_DIR, symbolName: "detailedTarget", mode: "detailed" });
      assert.match(result, /L2 \[call\] in detailedCaller \(L1-L3\)/);
      assert.match(result, /L4 \[comment\/string\] in <module>/);
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});

it('reports 13 call-containing lines explicitly and can exclude other mentions', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { closeDB } = await import('../../build/core/db.js');
  const root = await mkdtemp(join(tmpdir(), 'contextpro-counts-'));
  try {
    await writeFile(join(root, 'api.ts'), 'export function canEditItem() { return true; }\n');
    await writeFile(join(root, 'use.ts'), 'import { canEditItem } from "./api";\n// canEditItem is mentioned here\n' + Array.from({length:13}, () => 'canEditItem();').join('\n'));
    const output = await getBlastRadius({rootDir:root,symbolName:'canEditItem',fileContext:'api.ts',kind:'call',mode:'detailed'});
    assert.match(output,/13 usages in 1 files/);
    assert.match(output,/Counts by matching line: call=13, import=1/);
    assert.equal((output.match(/\[call\]/g) ?? []).length,13);
    assert.doesNotMatch(output,/\[comment\/string\]|\[import\]/);
    assert.match(output,/not binding-resolved/);
  } finally { closeDB(root); await rm(root,{recursive:true,force:true}); }
});
