import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reindex } from "../../build/tools/reindex.js";
import { exactReferencesTool } from "../../build/tools/exact-references.js";
import { clearTypeScriptReferenceCache, findTypeScriptReferences } from "../../build/core/typescript-references.js";
import { closeDB } from "../../build/core/db.js";
import { importScipIndex } from "../../build/core/scip-index.js";

let root;
const write = (file, content) => writeFile(join(root, file), typeof content === "string" ? content : JSON.stringify(content));
const index = () => reindex({ rootDir: root, noEmbed: true, autoHubs: false });
const refs = (options = {}) => exactReferencesTool({ rootDir: root, symbolName: "add", file: "src/math.ts", line: 1, format: "json", ...options }).then(JSON.parse);

describe("reference correctness and incremental projects", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-refs-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await write("tsconfig.base.json", { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    await write("tsconfig.json", { extends: "./tsconfig.base.json", include: ["src/**/*.ts"], exclude: ["tests"] });
    await write("src/math.ts", "export function add(a: number, b: number) { return a + b; }\n");
    await write("src/relative.ts", "import { add } from './math';\nexport const a = add(1, 2) + add(3, 4);\n");
    await write("tests/math.test.ts", "import { add } from '@/math';\nexport const check = add(5, 6);\n");
    await index();
  });
  afterEach(async () => { clearTypeScriptReferenceCache(); closeDB(root); await rm(root, { recursive: true, force: true }); });

  it("resolves inherited aliases, includes indexed tests and counts calls on one line", async () => {
    const result = await refs();
    assert.equal(result.total, 6);
    assert.deepEqual(result.counts, { definition: 1, import: 2, call: 3, reference: 0 });
    assert.equal(result.references.filter(ref => ref.file === "tests/math.test.ts").length, 2);
    assert.equal(result.scope.checkedFiles, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.callsByFile, [{ file: "src/relative.ts", calls: 2 }, { file: "tests/math.test.ts", calls: 1 }]);
    assert.equal(result.callFileCount, 2);
    assert.equal(result.callFilesTruncated, false);
    const text = await exactReferencesTool({ rootDir: root, symbolName: "add", file: "src/math.ts", line: 1 });
    assert.match(text, /src\/relative.ts=2, tests\/math.test.ts=1/);
    assert.match(text, /src\/relative.ts:1:\d+ \[import\]/);
    assert.match(text, /src\/relative.ts:2:\d+ \[call\]/);
  });

  it("infers an omitted line from current property declarations, with explicit ambiguity", async () => {
    await write('src/settings.ts', [
      '// updateSettings is not a declaration here',
      'const label = "updateSettings";',
      'interface Settings {',
      '  updateSettings: (value: number) => void;',
      '}',
      'export const settings: Settings = {',
      '  updateSettings: value => { console.log(value); },',
      '};',
      'settings.updateSettings(1);',
    ].join('\n'));
    await index();
    const options = { symbolName: 'updateSettings', file: 'src/settings.ts', line: undefined };
    const inferred = await refs(options);
    const explicit = await refs({ ...options, line: 4 });
    assert.deepEqual(inferred.references, explicit.references);
    assert.equal(inferred.counts.call, 1);
    assert.equal(inferred.target.line, 4);
    assert.equal(inferred.ambiguous, true);
    assert.deepEqual(inferred.ambiguousCandidates.map(c => c.line), [4, 7]);
    assert.equal(explicit.ambiguous, false);
  });

  it("infers the identifier line from live source even when the indexed declaration moved", async () => {
    await write('src/math.ts', '// moved after indexing\nexport function\nadd(a: number, b: number) { return a + b; }\n');
    const result = await refs({ line: undefined });
    assert.equal(result.target.line, 3);
    assert.equal(result.counts.call, 3);
    assert.equal(result.ambiguous, false);
    await assert.rejects(refs({ line: 1 }), /not present on target line 1/);
  });

  it("requests an explicit occurrence when a file has no declaration instead of assuming line one", async () => {
    const text = await exactReferencesTool({ rootDir: root, file: 'src/math.ts', symbolName: 'absent' });
    assert.match(text, /No declaration.*absent.*src\/math\.ts/);
    assert.match(text, /line/);
  });

  it("names unresolved imports and unchecked files with bounded diagnostic samples", async () => {
    await write("src/broken.ts", Array.from({length: 8}, (_, i) => `import { missing } from './absent${i}';`).join('\n'));
    await mkdir(join(root, 'broken'));
    await write('broken/tsconfig.json', '{ invalid');
    await write('broken/unchecked.ts', 'export const ignored = 1;');
    await index();
    const result = await refs();
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /8 unresolved workspace imports/);
    assert.match(warnings, /src\/broken.ts: \.\/absent0/);
    assert.match(warnings, /\+3 more/);
    assert.doesNotMatch(warnings, /absent7/);
    assert.match(warnings, /could not be checked: broken\/unchecked.ts/);
    assert.equal(result.counts.call, 3);
  });

  it("does not treat existing bundler assets as unchecked code but still warns about missing assets and modules", async () => {
    await write('src/styles.module.css', '.label { color: red; }');
    await write('src/globals.css', 'body { margin: 0; }');
    await write('src/assets.ts', [
      "import styles from './styles.module.css';",
      "import './globals.css?inline';",
      "import './missing.css';",
      "import { absent } from './missing-code';",
    ].join('\n'));
    await index();
    const result = await refs();
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /2 unresolved workspace imports/);
    assert.match(warnings, /missing\.css/);
    assert.match(warnings, /missing-code/);
    assert.doesNotMatch(warnings, /styles\.module\.css|globals\.css/);
    assert.equal(result.counts.call, 3);
  });

  it("reports totals before truncation, including more than the maximum display limit", async () => {
    await write("src/relative.ts", "import { add } from './math';\n" + Array.from({ length: 600 }, () => "add(1, 2);").join("\n"));
    const result = await refs({ limit: 500 });
    assert.equal(result.total, 604);
    assert.equal(result.returned, 500);
    assert.equal(result.truncated, true);
    assert.equal(result.counts.call, 601);
    assert.deepEqual(result.callsByFile, [{ file: "src/relative.ts", calls: 600 }, { file: "tests/math.test.ts", calls: 1 }]);
    const text = await exactReferencesTool({ rootDir: root, symbolName: "add", file: "src/math.ts", line: 1, limit: 1 });
    assert.match(text, /1 returned of 604.*TRUNCATED/);
    assert.match(text, /src\/relative.ts=600, tests\/math.test.ts=1/);
    const many = await exactReferencesTool({ rootDir: root, symbolName: "add", file: "src/math.ts", line: 1, limit: 100 });
    assert.equal(many.split("  add(1, 2);").length - 1, 1);
    assert.equal((many.match(/src\/relative.ts:\d+:\d+ \[call\]/g) ?? []).length, 98);
    assert.match(many, /Identical snippets shown once per file/);
  });

  it("excludes shadowed bindings and distinguishes a callback reference from a call", async () => {
    await write("src/relative.ts", "import { add } from './math';\nexport const callback = add;\nexport function wrapper(add: () => number) { return add(); }\n");
    const result = await refs();
    assert.equal(result.counts.call, 1);
    assert.equal(result.counts.reference, 1);
    assert.ok(!result.references.some(ref => ref.context.includes("wrapper")));
  });

  it("counts direct callees rather than identifiers inside nested call expressions or keys", async () => {
    await write("src/relative.ts", [
      "import { add } from './math';",
      "const identity = (fn: typeof add) => fn;",
      "identity(add)(1, 2);",
      "const table = { add };",
      "table[add.name](1, 2);",
      "(add as typeof add)(1, 2);",
    ].join("\n"));
    const result = await refs();
    assert.equal(result.counts.call, 2); // Direct cast call and the test-file call.
    assert.ok(result.references.filter(ref => ref.context.includes("identity(add)") || ref.context.includes("table[add.name]")).every(ref => ref.kind === "reference"));
  });

  it("reuses projects while observing edited files, new callers and changed inherited config", async () => {
    const files = ["src/math.ts", "src/relative.ts", "tests/math.test.ts"].map(file => join(root, file));
    const lookup = () => findTypeScriptReferences({ rootDir: root, files, file: files[0], line: 1, symbol: "add" });
    assert.equal(lookup().reusedProjects, 0);
    assert.equal(lookup().reusedProjects, 1);
    const file = join(root, "src/relative.ts");
    const before = await stat(file);
    await write("src/relative.ts", "import { add } from './math';\nexport const a = add(1, 2) + Math.max(3, 4);\n");
    await utimes(file, before.atime, before.mtime);
    assert.equal(lookup().references.filter(ref => ref.kind === "call").length, 2);
    await write("src/extra.ts", "import { add } from './math';\nadd(7, 8);\n");
    files.push(join(root, "src/extra.ts"));
    assert.equal(lookup().references.filter(ref => ref.kind === "call").length, 3);
    await write("src/other.ts", "export function add(a: number, b: number) { return a - b; }\n");
    await write("tsconfig.base.json", { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/other.ts"] } } });
    assert.ok(!lookup().references.some(ref => ref.file === "tests/math.test.ts"));
  });

  it("rejects a missing target token instead of resolving an unrelated token", async () => {
    await assert.rejects(refs({ line: 2 }), /outside the source|not present/);
  });

  it("follows re-export aliases to their call sites", async () => {
    await write("src/barrel.ts", "export { add as plus } from './math';\n");
    await write("tests/math.test.ts", "import { plus } from '../src/barrel';\nexport const check = plus(5, 6);\n");
    await index();
    const result = await refs();
    assert.equal(result.counts.call, 3);
    assert.ok(result.references.some(ref => ref.file === "tests/math.test.ts" && ref.kind === "call"));
  });

  it("does not claim a guessed configuration resolved a malformed project", async () => {
    await write("tsconfig.json", '{ "compilerOptions": ');
    const result = await refs();
    assert.equal(result.scope.checkedFiles, 0);
    assert.ok(result.warnings.some(warning => warning.includes("Invalid configuration")));
  });

  it("falls back from empty compiler results to SCIP without hiding configuration or freshness warnings", async () => {
    const symbol = "local src/math.ts add().";
    await write("scip.json", { documents: [
      { relative_path: "src/math.ts", symbols: [{ symbol, display_name: "add", kind: "Function" }],
        occurrences: [{ range: [0, 16, 19], symbol, symbol_roles: 1 }] },
      { relative_path: "src/relative.ts", occurrences: [{ range: [1, 17, 20], symbol, symbol_roles: 0 }] },
    ] });
    await importScipIndex(root, "scip.json");
    assert.equal((await refs()).confidence, "LSP_RESOLVED");
    await write("tsconfig.json", '{ "compilerOptions": ');
    const result = await refs({ limit: 1 });
    assert.equal(result.confidence, "SCIP_RESOLVED");
    assert.equal(result.total, 2);
    assert.equal(result.returned, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.references[0].confidence, "SCIP_RESOLVED");
    assert.equal(result.scope.kind, "imported_scip");
    assert.equal(result.scope.freshness, "unverified");
    assert.ok(result.warnings.some(warning => warning.includes("Invalid configuration")));
    assert.ok(result.warnings.some(warning => warning.includes("fallback")));
    assert.ok(result.warnings.some(warning => warning.includes("current source revision")));
    const text = await exactReferencesTool({ rootDir: root, symbolName: "add", file: "src/math.ts", line: 1 });
    assert.match(text, /SCIP_RESOLVED/);
    assert.match(text, /Invalid configuration/);
    assert.match(text, /current source revision/);
  });

  it("uses separate configurations for referenced workspace projects", async () => {
    await write("tsconfig.json", { files: [], references: [{ path: "./src" }, { path: "./tests" }] });
    await write("src/tsconfig.json", { compilerOptions: { composite: true }, include: ["*.ts"] });
    await write("tests/tsconfig.json", { compilerOptions: { baseUrl: ".", paths: { "@/*": ["../src/*"] } }, references: [{ path: "../src" }], include: ["*.ts"] });
    const result = await refs();
    assert.equal(result.total, 6);
    assert.equal(result.scope.configs.length, 2);
    const limited = await refs({ limit: 1 });
    assert.deepEqual(limited.references, result.references.slice(0, 1));
    assert.equal(limited.total, result.total);
    assert.deepEqual(limited.counts, result.counts);
    assert.deepEqual(limited.callsByFile, result.callsByFile);
  });

  it("invalidates a consumer when a referenced project's configuration changes", async () => {
    await write("tsconfig.json", { files: [], references: [{ path: "./src" }, { path: "./tests" }] });
    const config = destination => ({ compilerOptions: { composite: true, baseUrl: ".", paths: { "@impl": [destination] } }, include: ["*.ts"] });
    await write("src/tsconfig.json", config("math.ts"));
    await write("tests/tsconfig.json", { references: [{ path: "../src" }], include: ["*.ts"] });
    await write("src/other.ts", "export function add(a: number, b: number) { return a - b; }\n");
    await write("src/bridge.ts", "export { add } from '@impl';\n");
    await write("tests/math.test.ts", "import { add } from '../src/bridge';\nadd(1, 2);\n");
    const files = ["src/math.ts", "src/relative.ts", "src/other.ts", "src/bridge.ts", "tests/math.test.ts"].map(file => join(root, file));
    const lookup = () => findTypeScriptReferences({ rootDir: root, files, file: files[0], line: 1, symbol: "add" });
    assert.ok(lookup().references.some(ref => ref.file === "tests/math.test.ts"));
    await write("src/tsconfig.json", config("other.ts"));
    assert.ok(!lookup().references.some(ref => ref.file === "tests/math.test.ts"));
  });
});
