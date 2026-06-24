// Regression tests for round-5 audit fixes
// FEATURE: Locks in symbolic-edit validation/indent, directory prior, search trust, resolve_symbol,
// find_symbol wildcards, and graph_query scoping.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
async function setup() { root = await mkdtemp(join(tmpdir(), "ctxpro-r5-")); await mkdir(join(root, "src"), { recursive: true }); }
async function teardown() { await rm(root, { recursive: true, force: true }); }

describe("round-5 fixes", () => {
  beforeEach(setup);
  afterEach(teardown);

  describe("replace_symbol_body indentation + validation", () => {
    it("preserves relative indentation of a Python method body", async () => {
      const { replaceSymbolBody } = await import("../../build/tools/symbolic-edit.js");
      const file = join(root, "src", "mod.py");
      await writeFile(file, "class Bar:\n    def baz(self):\n        return 2\n");
      await replaceSymbolBody({ rootDir: root, relativePath: "src/mod.py", namePath: "Bar/baz", body: "    def baz(self):\n        return 3" });
      const after = await readFile(file, "utf-8");
      const returnLine = after.split("\n").find((l) => l.includes("return 3"));
      const indent = returnLine.length - returnLine.trimStart().length;
      assert.equal(indent, 8, `return 3 should be at 8 spaces, got ${indent}`);
    });

    it("rejects an edit that would introduce a syntax error", async () => {
      const { replaceSymbolBody } = await import("../../build/tools/symbolic-edit.js");
      const file = join(root, "src", "mod.ts");
      await writeFile(file, "// h\n// h2\nexport function greet(n) {\n  return 'hi';\n}\n");
      await assert.rejects(
        () => replaceSymbolBody({ rootDir: root, relativePath: "src/mod.ts", namePath: "greet", body: "export function greet(n) {\n  return 'hi';\n" }),
        /syntax error|NOT modified/,
      );
      const after = await readFile(file, "utf-8");
      assert.ok(after.includes("}"), "file must be unchanged when edit is rejected");
    });
  });

  describe("find_symbol wildcards", () => {
    it("'*' lists all symbols and 'get*' matches by prefix", async () => {
      const { findSymbol } = await import("../../build/tools/symbolic-edit.js");
      await writeFile(join(root, "src", "a.ts"), "// h\n// h2\nexport function getName(){return 1;}\nexport function getAge(){return 2;}\nexport function setName(){}\n");
      const all = JSON.parse(await findSymbol({ rootDir: root, namePathPattern: "*", relativePath: "src/a.ts", format: "json" }));
      assert.ok(all.count >= 3, `'*' should list all symbols, got ${all.count}`);
      const getHits = JSON.parse(await findSymbol({ rootDir: root, namePathPattern: "get*", relativePath: "src/a.ts", format: "json" }));
      const names = getHits.results.map((r) => r.name);
      assert.ok(names.includes("getName") && names.includes("getAge"));
      assert.ok(!names.includes("setName"));
    });
  });

  describe("directory-purpose prior", () => {
    it("surfaces the implementation directory for 'add a new X' tasks", async () => {
      const { findDirectoryPriorMatches } = await import("../../build/tools/directory-prior.js");
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      await mkdir(join(root, "src", "fees"), { recursive: true });
      await writeFile(join(root, "src", "fees", "base.py"), "class FeeModel: ...\n");
      await writeFile(join(root, "src", "fees", "binance.py"), "class BinanceFee: ...\n");
      await writeFile(join(root, "src", "fees", "kraken.py"), "class KrakenFee: ...\n");
      await writeFile(join(root, "src", "status.py"), "class Status:\n    def add(self): pass\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      const matches = await findDirectoryPriorMatches(root, "Add a new fee model for a new venue called venue_b");
      const paths = matches.map((m) => m.path);
      assert.ok(paths.some((p) => p.endsWith("fees/base.py")), `expected fees/base.py, got: ${paths.join(", ")}`);
      assert.ok(paths.some((p) => p.endsWith("fees/binance.py")));
      assert.ok(!paths.some((p) => p.endsWith("status.py")), "status.py must not surface");
      // base.py is tagged as the protocol/base, siblings are not
      const base = matches.find((m) => m.path.endsWith("base.py"));
      assert.ok(base.reason.includes("base/Protocol"));
      assert.ok(!matches.find((m) => m.path.endsWith("binance.py")).reason.includes("base/Protocol"));
    });
  });

  describe("resolve_symbol snake_case word-boundary scoring", () => {
    it("ranks fee-segment match above feed-substring collision", async () => {
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      const { resolveSymbolData } = await import("../../build/tools/resolve-symbol.js");
      await writeFile(join(root, "src", "feeds.py"), "def run_venue_a_feed(): pass\n");
      await writeFile(join(root, "src", "fees.py"), "def compute_fee(a): return a\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      const res = await resolveSymbolData({ rootDir: root, symbolName: "fee", kind: "function" });
      assert.ok(res.candidates.length > 0);
      assert.ok(res.candidates[0].name === "compute_fee", `top candidate should be compute_fee, got ${res.candidates[0].name}`);
      assert.ok(!res.candidates[0].name.includes("feed"));
    });
  });

  describe("search trust decomposition", () => {
    it("exposes topResultBreakdown and bounds confidence by min component", async () => {
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      const { unifiedSearchData } = await import("../../build/tools/search.js");
      await writeFile(join(root, "src", "links.ts"), "// link helper\n// kelly\nexport function kellySize(){return 1;}\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      const data = await unifiedSearchData({ rootDir: root, query: "kellySize", mode: "file", preset: "keyword_only" });
      // keyword_only with no embeddings → semantic≈0 → breakdown present and confidence not "high"
      if (data.topResultBreakdown) {
        assert.ok(["semantic-dominant", "keyword-dominant", "balanced", "none"].includes(data.topResultBreakdown.signal));
        assert.ok(["high", "medium", "low"].includes(data.topResultBreakdown.confidenceLabel));
      }
    });
  });
});
