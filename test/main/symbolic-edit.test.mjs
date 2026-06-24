// Tests for symbolic find_symbol / replace_symbol_body / insert_*_symbol / rename_symbol
// FEATURE: Serena-parity symbolic editing coverage

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

async function setup() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ctxpro-symedit-"));
  await mkdir(join(fixtureRoot, "src"), { recursive: true });
}

async function teardown() {
  await rm(fixtureRoot, { recursive: true, force: true });
}

describe("symbolic editing tools", () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it("find_symbol returns top-level functions by name", async () => {
    const { findSymbol } = await import("../../build/tools/symbolic-edit.js");
    await writeFile(
      join(fixtureRoot, "src", "alpha.ts"),
      [
        "// Header alpha line one",
        "// Header alpha line two",
        "",
        "export function alpha(): string {",
        "  return 'a';",
        "}",
        "",
        "export function beta(x: number): number {",
        "  return x + 1;",
        "}",
        "",
      ].join("\n"),
    );
    const output = await findSymbol({ rootDir: fixtureRoot, namePathPattern: "alpha", format: "json" });
    const parsed = JSON.parse(output);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.results[0].name, "alpha");
    assert.equal(parsed.results[0].kind, "function");
    assert.ok(parsed.results[0].line >= 1);
  });

  it("find_symbol returns class methods via name path", async () => {
    const { findSymbol } = await import("../../build/tools/symbolic-edit.js");
    await writeFile(
      join(fixtureRoot, "src", "dog.ts"),
      [
        "// Class Dog",
        "// Test fixture",
        "",
        "export class Dog {",
        "  bark(): string {",
        "    return 'woof';",
        "  }",
        "  sit(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    const output = await findSymbol({ rootDir: fixtureRoot, namePathPattern: "Dog/bark", format: "json" });
    const parsed = JSON.parse(output);
    assert.ok(parsed.count >= 1);
    assert.equal(parsed.results[0].name, "bark");
  });

  it("replace_symbol_body rewrites a function in place", async () => {
    const { replaceSymbolBody } = await import("../../build/tools/symbolic-edit.js");
    const filePath = join(fixtureRoot, "src", "swap.ts");
    await writeFile(
      filePath,
      [
        "// Header one",
        "// Header two",
        "",
        "export function greet(name: string): string {",
        "  return 'hi ' + name;",
        "}",
        "",
      ].join("\n"),
    );
    await replaceSymbolBody({
      rootDir: fixtureRoot,
      relativePath: "src/swap.ts",
      namePath: "greet",
      body: [
        "export function greet(name: string): string {",
        "  return `hello, ${name}!`;",
        "}",
      ].join("\n"),
    });
    const after = await readFile(filePath, "utf-8");
    assert.ok(after.includes("hello, ${name}!"));
    assert.ok(!after.includes("'hi ' + name"));
  });

  it("insert_after_symbol appends sibling code", async () => {
    const { insertAroundSymbol } = await import("../../build/tools/symbolic-edit.js");
    const filePath = join(fixtureRoot, "src", "ins.ts");
    await writeFile(
      filePath,
      [
        "// Header one",
        "// Header two",
        "",
        "export function alpha(): number { return 1; }",
        "",
      ].join("\n"),
    );
    await insertAroundSymbol({
      rootDir: fixtureRoot,
      relativePath: "src/ins.ts",
      namePath: "alpha",
      body: "export function beta(): number { return 2; }",
      position: "after",
    });
    const after = await readFile(filePath, "utf-8");
    assert.ok(after.includes("beta(): number"));
    assert.ok(after.indexOf("alpha") < after.indexOf("beta"));
  });

  it("rename_symbol updates the defining file", async () => {
    const { renameSymbol } = await import("../../build/tools/symbolic-edit.js");
    const filePath = join(fixtureRoot, "src", "ren.ts");
    await writeFile(
      filePath,
      [
        "// Header one",
        "// Header two",
        "",
        "export function oldName(): string {",
        "  return 'old';",
        "}",
        "",
        "export function caller(): string {",
        "  return oldName();",
        "}",
        "",
      ].join("\n"),
    );
    await renameSymbol({
      rootDir: fixtureRoot,
      relativePath: "src/ren.ts",
      namePath: "oldName",
      newName: "newName",
    });
    const after = await readFile(filePath, "utf-8");
    assert.ok(after.includes("function newName"));
    assert.ok(!after.includes("function oldName"));
    assert.ok(after.includes("return newName()"));
  });

  it("rename_symbol cross-file: short file after long file (regex state regression)", async () => {
    const { renameSymbol } = await import("../../build/tools/symbolic-edit.js");
    // Reindex so the graph picks up imports / callers
    const { reindex } = await import("../../build/tools/reindex.js");

    const longFilePath = join(fixtureRoot, "src", "long-importer.ts");
    const shortFilePath = join(fixtureRoot, "src", "short-importer.ts");
    const definitionPath = join(fixtureRoot, "src", "def.ts");

    await writeFile(
      definitionPath,
      [
        "// Definition file",
        "// Holds the symbol",
        "",
        "export function helperX(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const longBody = [
      "// Long importer with lots of code first",
      "// To push regex lastIndex past short file length",
      "import { helperX } from './def';",
      "",
      ...Array.from({ length: 60 }, (_, i) => `const filler_${i} = ${i} + 1;`),
      "",
      "export function useLong(): number {",
      "  return helperX();",
      "}",
      "",
    ].join("\n");
    await writeFile(longFilePath, longBody);
    await writeFile(
      shortFilePath,
      [
        "// Short",
        "// File",
        "import { helperX } from './def';",
        "export const useShort = () => helperX();",
        "",
      ].join("\n"),
    );

    await reindex({ rootDir: fixtureRoot, force: true, noEmbed: true });

    await renameSymbol({
      rootDir: fixtureRoot,
      relativePath: "src/def.ts",
      namePath: "helperX",
      newName: "helperY",
    });

    const longAfter = await readFile(longFilePath, "utf-8");
    const shortAfter = await readFile(shortFilePath, "utf-8");
    assert.ok(longAfter.includes("helperY()"), "long file should be renamed");
    assert.ok(!longAfter.includes("helperX("), "long file should not retain old name");
    assert.ok(shortAfter.includes("helperY()"), "short file should be renamed (regex-state regression)");
    assert.ok(!shortAfter.includes("helperX("), "short file should not retain old name");
  });

  it("rejects invalid new names in rename_symbol", async () => {
    const { renameSymbol } = await import("../../build/tools/symbolic-edit.js");
    await writeFile(
      join(fixtureRoot, "src", "bad.ts"),
      "// Header\n// Header2\n\nexport function safe(): void {}\n",
    );
    await assert.rejects(
      () => renameSymbol({
        rootDir: fixtureRoot,
        relativePath: "src/bad.ts",
        namePath: "safe",
        newName: "1bad-name!",
      }),
      /Invalid new symbol name/,
    );
  });

  it("find_symbol returns null result for missing pattern", async () => {
    const { findSymbol } = await import("../../build/tools/symbolic-edit.js");
    await writeFile(
      join(fixtureRoot, "src", "lonely.ts"),
      "// Header\n// Header2\n\nexport function exists(): void {}\n",
    );
    const result = await findSymbol({
      rootDir: fixtureRoot,
      namePathPattern: "doesNotExist",
      format: "json",
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.count, 0);
  });
});
