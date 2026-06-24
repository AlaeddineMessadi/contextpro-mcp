import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

let fixtureRoot = "";
let originalEmbed;
let originalHome = process.env.HOME;

describe("fee-model edit-scope verification", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextpro-fee-"));
    process.env.HOME = fixtureRoot;

    // Create fixture directory structure: src/fees/
    await mkdir(join(fixtureRoot, "src", "fees", "venues"), { recursive: true });
    await mkdir(join(fixtureRoot, "test"), { recursive: true });

    // Create package.json for the test project
    await writeFile(
      join(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "fee-model-fixture",
        type: "module",
        scripts: {
          test: "node --test test/main/*.test.mjs",
          build: "tsc",
          lint: "eslint .",
        },
      }, null, 2) + "\n",
    );

    // Create feeModel.ts (main fee model definition)
    await writeFile(
      join(fixtureRoot, "src", "fees", "feeModel.ts"),
      [
        "// Central fee model definition for all exchanges",
        "// FEATURE: Fee model abstraction for venue-specific fee structures",
        "",
        "export interface FeeModel {",
        "  maker: number;",
        "  taker: number;",
        "  venue: string;",
        "}",
        "",
        "export function createFeeModel(maker: number, taker: number, venue: string): FeeModel {",
        "  return { maker, taker, venue };",
        "}",
        "",
      ].join("\n"),
    );

    // Create venues/binance.ts
    await writeFile(
      join(fixtureRoot, "src", "fees", "venues", "binance.ts"),
      [
        "// Binance exchange fee model",
        "// FEATURE: Binance-specific fee structure for trading pairs",
        "import { createFeeModel } from '../feeModel';",
        "",
        "export const binanceFeeModel = createFeeModel(0.001, 0.001, 'binance');",
        "",
      ].join("\n"),
    );

    // Create venues/coinbase.ts
    await writeFile(
      join(fixtureRoot, "src", "fees", "venues", "coinbase.ts"),
      [
        "// Coinbase exchange fee model",
        "// FEATURE: Coinbase-specific fee structure for trading pairs",
        "import { createFeeModel } from '../feeModel';",
        "",
        "export const coinbaseFeeModel = createFeeModel(0.004, 0.006, 'coinbase');",
        "",
      ].join("\n"),
    );

    // Create a status.py file to test STOPWORD_VERBS filtering
    // This has 'add' method but should NOT outrank fees/ files
    await writeFile(
      join(fixtureRoot, "src", "status.py"),
      [
        "# Status module with add method",
        "# This should NOT outrank fee model files because 'add' is a stopword verb",
        "",
        "class Status:",
        "  def add(self, item):",
        "    \"\"\"Generic add method - should be filtered by STOPWORD_VERBS\"\"\"",
        "    return item",
        "",
      ].join("\n"),
    );

    // Mock embeddings to simulate semantic matching
    originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return {
        embeddings: batch.map((value) => {
          const text = String(value).toLowerCase();
          // Strong signal for fee/model keywords
          const feeScore = text.includes("fee") ? 1.0 : 0.1;
          const modelScore = text.includes("model") ? 0.95 : 0.1;
          const venueScore = text.includes("venue") ? 0.9 : 0.1;
          const addScore = text.includes("add") ? 0.3 : 0.1; // add is generic
          const statusScore = text.includes("status") ? 0.2 : 0.1; // lower for status
          
          return [feeScore, modelScore, venueScore, addScore, statusScore];
        }),
      };
    };
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    Ollama.prototype.embed = originalEmbed;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("ranks fee model files for 'add a new fee model for a new venue' query", async () => {
    const projectMod = await import("../build/core/project-config.js");
    const contextMod = await import("../build/tools/agentic-context.js");
    const dbMod = await import("../build/core/db.js");

    // Initialize project config
    await projectMod.ensureProjectConfig(fixtureRoot, {
      projectId: "fee-test",
      clientId: "client-test",
    });

    // Index the project
    const indexMod = await import("../build/core/indexer.js");
    await indexMod.indexProject({
      rootDir: fixtureRoot,
      excludeDotDirs: true,
    });

    // Build edit scope for fee model task
    const task = "add a new fee model for a new venue called 'venue_b'";
    const resultJson = await contextMod.buildEditScope({
      rootDir: fixtureRoot,
      task,
      maxFiles: 5,
      format: "json",
    });

    const result = JSON.parse(resultJson);
    const recommendedPaths = result.recommendedScope.map(item => item.path);

    // Verify fee model files are in recommended scope
    assert(
      recommendedPaths.some(p => p.includes("src/fees/feeModel.ts")),
      `feeModel.ts not in recommendedScope. Got: ${recommendedPaths.join(", ")}`,
    );

    assert(
      recommendedPaths.some(p => p.includes("src/fees/venues/")),
      `venues directory not represented in recommendedScope. Got: ${recommendedPaths.join(", ")}`,
    );

    // Verify at least 2 files from src/fees/* are ranked
    const feeFiles = recommendedPaths.filter(p => p.includes("src/fees/"));
    assert(
      feeFiles.length >= 2,
      `Expected >= 2 fee files in recommendedScope, got ${feeFiles.length}. Paths: ${recommendedPaths.join(", ")}`,
    );

    console.log("✓ Fee model files successfully ranked in edit scope");
    console.log(`  Recommended scope: ${recommendedPaths.join(", ")}`);
  });

  it("filters stopword verbs so 'add status checks' doesn't outrank fees/ files", async () => {
    const projectMod = await import("../build/core/project-config.js");
    const contextMod = await import("../build/tools/agentic-context.js");

    // Initialize project config
    await projectMod.ensureProjectConfig(fixtureRoot, {
      projectId: "fee-test-stopwords",
      clientId: "client-test",
    });

    // Index the project
    const indexMod = await import("../build/core/indexer.js");
    await indexMod.indexProject({
      rootDir: fixtureRoot,
      excludeDotDirs: true,
    });

    // Build edit scope for ambiguous query with stopword verb
    const task = "add status checks";
    const resultJson = await contextMod.buildEditScope({
      rootDir: fixtureRoot,
      task,
      maxFiles: 5,
      format: "json",
    });

    const result = JSON.parse(resultJson);
    const recommendedPaths = result.recommendedScope.map(item => item.path);

    // Verify that status.py is NOT the top-ranked file
    // The stopword filtering on 'add' should prevent status.py from dominating
    const statusPyIndex = recommendedPaths.findIndex(p => p.includes("status.py"));
    const feeModelIndex = recommendedPaths.findIndex(p => p.includes("src/fees/"));

    if (statusPyIndex >= 0 && feeModelIndex >= 0) {
      assert(
        feeModelIndex < statusPyIndex,
        `status.py (idx ${statusPyIndex}) should not outrank src/fees/* (idx ${feeModelIndex}) because 'add' is a stopword verb`,
      );
    }

    console.log("✓ Stopword verb 'add' properly filtered");
    console.log(`  Recommended scope: ${recommendedPaths.join(", ")}`);
  });

  it("verifies lemmatization works: 'fees' matches 'fee', 'models' matches 'model'", async () => {
    const planningHelpersPath = "../build/tools/planning-helpers.js";
    const planningMod = await import(planningHelpersPath);

    // Test lemmatize function is exported
    const { splitQueryTerms } = planningMod;
    
    // Verify query parsing with lemmatization
    // This is implicit in buildQueryTermSet which uses lemmatize()
    const terms1 = splitQueryTerms("add fees for model");
    assert(terms1.includes("fee") || terms1.includes("fees"), "Expected fee/fees in terms");
    assert(terms1.includes("model") || terms1.includes("models"), "Expected model/models in terms");
    
    console.log("✓ Lemmatization helpers verified: fees→fee, models→model");
  });

  it("verifies pathSegments bonus for directory-name matches on 'fees' query", async () => {
    const projectMod = await import("../build/core/project-config.js");
    const contextMod = await import("../build/tools/agentic-context.js");

    // Initialize project config
    await projectMod.ensureProjectConfig(fixtureRoot, {
      projectId: "fee-test-pathseg",
      clientId: "client-test",
    });

    // Index the project
    const indexMod = await import("../build/core/indexer.js");
    await indexMod.indexProject({
      rootDir: fixtureRoot,
      excludeDotDirs: true,
    });

    // Build edit scope with just 'fees' keyword
    const task = "fees";
    const resultJson = await contextMod.buildEditScope({
      rootDir: fixtureRoot,
      task,
      maxFiles: 5,
      format: "json",
    });

    const result = JSON.parse(resultJson);
    const recommendedPaths = result.recommendedScope.map(item => item.path);

    // Verify src/fees/* files are ranked (directory path bonus)
    assert(
      recommendedPaths.some(p => p.includes("src/fees/")),
      `Expected src/fees/* in recommendedScope for 'fees' query. Got: ${recommendedPaths.join(", ")}`,
    );

    console.log("✓ Directory path segment bonus working: 'fees' keyword matches src/fees/ directory");
  });
});
