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

  it("matches recursive test paths at zero and multiple directory depths", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    for (const dir of ["src/__tests__", "src/services/account/__tests__"]) {
      await mkdir(join(fixtureRoot, dir), { recursive: true });
      await writeFile(join(fixtureRoot, dir, "gate.test.ts"), "canUseStrictMode\n");
    }
    const options = { rootDir: fixtureRoot, pattern: "canUseFeatureRotation|canUseStrictMode", glob: "src/**/__tests__/*.test.ts,src/**/__tests__/*.test.tsx" };
    const literal = await grepProject(options);
    assert.match(literal, /0 matches.*scanned 2 of 2/);
    assert.match(literal, /pass regex: true/);
    const regex = await grepProject({ ...options, regex: true });
    assert.match(regex, /2 match\(es\) in 2 file\(s\)/);
    assert.match(regex, /src\/__tests__\/gate.test.ts/);
    assert.match(regex, /src\/services\/account\/__tests__\/gate.test.ts/);
  });

  it("returns bounded, deduplicated surrounding lines with accurate match counts", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    await writeFile(join(fixtureRoot, "context.ts"), "before\nneedle one\n  middle\nneedle two\nafter\n" + "x".repeat(500));
    const options = { rootDir: fixtureRoot, pattern: "needle", glob: "context.ts" };
    const compact = await grepProject(options);
    assert.doesNotMatch(compact, /before|middle|after/);
    const expanded = await grepProject({ ...options, contextLines: 2, contextChars: 40 });
    assert.match(expanded, /2 match\(es\) in 1 file\(s\)/);
    assert.match(expanded, /L1-  before/);
    assert.match(expanded, /L2:1  needle one/);
    assert.match(expanded, /L3-    middle/);
    assert.equal(expanded.match(/L3-/g)?.length, 1);
    assert.match(expanded, /L4:1  needle two/);
    assert.match(expanded, /L6-  x{40}…/);
    assert.doesNotMatch(expanded, /x{41}/);
  });

  it("changes the in-line character window without interpreting literal regex characters", async () => {
    const { grepProject } = await import("../../build/tools/grep.js");
    await writeFile(join(fixtureRoot, "long.ts"), "x".repeat(100) + "A|B" + "y".repeat(100));
    const options = { rootDir: fixtureRoot, pattern: "A|B", glob: "long.ts" };
    const narrow = await grepProject({ ...options, contextChars: 40 });
    const wide = await grepProject({ ...options, contextChars: 300 });
    assert.match(narrow, /1 match\(es\)/);
    assert.doesNotMatch(narrow, /pass regex/);
    assert.ok(wide.length > narrow.length);
    assert.match(wide, /x{100}A\|By{100}/);
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
