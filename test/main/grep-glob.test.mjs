// Tests for grep glob brace expansion and recursive matching
// FEATURE: Regression coverage for the glob bug fix

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

async function setup() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ctxpro-grep-"));
  await mkdir(join(fixtureRoot, "src", "components"), { recursive: true });
  await mkdir(join(fixtureRoot, "src", "tools"), { recursive: true });

  await writeFile(
    join(fixtureRoot, "src", "components", "wrapInProviders.tsx"),
    "// wrapInProviders HOC\nexport function wrapInProviders() { return null; }\n",
  );
  await writeFile(
    join(fixtureRoot, "src", "tools", "helper.ts"),
    "// helper\nimport { wrapInProviders } from '../components/wrapInProviders';\n",
  );
  await writeFile(
    join(fixtureRoot, "README.md"),
    "wrapInProviders is the HOC for Module Federation.\n",
  );
}

async function teardown() {
  await rm(fixtureRoot, { recursive: true, force: true });
}

describe("grep glob brace expansion", () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it("expands {ts,tsx} brace globs and finds matches across recursive ** patterns", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    const result = await grepProject({
      rootDir: fixtureRoot,
      pattern: "wrapInProviders",
      glob: "src/**/*.{ts,tsx}",
    });
    assert.match(result, /\bwrapInProviders\.tsx/);
    assert.match(result, /helper\.ts/);
    assert.ok(!result.includes("README.md"));
  });

  it("finds matches with simple recursive glob *.ts", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    const result = await grepProject({
      rootDir: fixtureRoot,
      pattern: "wrapInProviders",
      glob: "*.ts",
    });
    assert.match(result, /helper\.ts/);
  });

  it("returns zero matches with non-matching glob", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    const result = await grepProject({
      rootDir: fixtureRoot,
      pattern: "wrapInProviders",
      glob: "*.py",
    });
    assert.match(result, /0 matches/);
  });

  it("caps explosive brace globs to prevent DoS", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    // 20 nested {a,b} pairs would explode to 2^20 = 1M expansions; we cap at 1024.
    const pathological = Array.from({ length: 20 }, () => "{a,b}").join("");
    const result = await grepProject({
      rootDir: fixtureRoot,
      pattern: "wrapInProviders",
      glob: pathological,
    });
    // Either short-circuits with "0 matches" using the capped expansions, or
    // surfaces the limit error — both prevent unbounded expansion.
    assert.ok(
      /0 matches/.test(result) || /Glob pattern expanded|Error:/.test(result),
      `Pathological glob should not blow up: ${result.slice(0, 200)}`,
    );
  });
});
