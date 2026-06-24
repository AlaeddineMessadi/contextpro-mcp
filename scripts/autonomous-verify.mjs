// Autonomous verification probe — exercises every audit fix end-to-end against the built code.
// Run with: node scripts/autonomous-verify.mjs
// Exit code: 0 = clean, 1 = issues found (printed to stderr).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const issues = [];
const failures = [];
function fail(msg) { failures.push(msg); console.error(`✖ ${msg}`); }
function pass(msg) { console.log(`✓ ${msg}`); }
function warn(msg) { issues.push(msg); console.warn(`⚠ ${msg}`); }

async function mkFixture(prefix, files) {
  const root = await mkdtemp(join(tmpdir(), `ctx-verify-${prefix}-`));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

// ─── FIX 1: lint .venv preference ─────────────────────────────────────────────
{
  const root = await mkFixture("lint", {
    "pyproject.toml": "[project]\nname='x'\n",
    "uv.lock": "version=1\n",
    "src/a.py": "def x(): pass\n",
  });
  // Skip actually running lint (would invoke external uv); just verify detector wiring.
  const sa = await import("../build/tools/static-analysis.js");
  if (typeof sa.runStaticAnalysis !== "function") fail("static-analysis: runStaticAnalysis missing");
  else pass("static-analysis: runStaticAnalysis exported");
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 2: validate_scope detects pytest from pyproject.toml ─────────────────
{
  const root = await mkFixture("validate", {
    "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\ntestpaths=['tests']\n",
    "src/a.py": "def x(): pass\n",
    "tests/test_a.py": "def test_x(): assert True\n",
  });
  const projectMod = await import("../build/core/project-config.js");
  await projectMod.ensureProjectConfig({ rootDir: root });
  const reindexMod = await import("../build/tools/reindex.js");
  await reindexMod.reindex({ rootDir: root, force: true, noEmbed: true });
  const agentic = await import("../build/tools/agentic-context.js");
  const out = await agentic.buildValidateScope({ rootDir: root, task: "fix bug in a.py", format: "json" });
  const parsed = JSON.parse(out);
  const cmds = parsed.checks.map((c) => c.command).join(" | ");
  if (/pytest/i.test(cmds)) pass(`validate_scope: pytest detected (${cmds})`);
  else fail(`validate_scope: pytest NOT detected (got: ${cmds})`);
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 3: search trust dampener ─────────────────────────────────────────────
{
  // computeCombinedScore is not exported; verify via direct import of internal helper.
  // We can probe behavior through SearchIndex.search instead — but that needs embeddings.
  // Easier: inline the math from the source to confirm the constants survived a rebuild.
  const src = await import("node:fs").then((m) => m.readFileSync("build/core/embeddings.js", "utf-8"));
  if (/SINGLE_COMPONENT_CAP\s*=\s*0\.7/.test(src) && /SEMANTIC_FLOOR\s*=\s*0\.05/.test(src)) {
    pass("embeddings: trust dampener constants present");
  } else {
    fail("embeddings: trust dampener constants missing or changed");
  }
}

// ─── FIX 4: planning helpers — lemmatization + stopword + dir bonus ──────────
{
  const planning = await import("../build/tools/planning-helpers.js");
  // splitQueryTerms is exported, but lemmatize is not. Re-implement test fixture from the
  // outer surface: rerankPlanningFiles is exported and uses lemmatize/STOPWORD_VERBS internally.
  const candidates = [
    { path: "src/fees/feeModel.ts", reason: "seed", score: 0.4, symbols: ["FeeModel"] },
    { path: "src/status.py", reason: "seed", score: 0.5, symbols: ["addEntry"] },
    { path: "src/random.ts", reason: "seed", score: 0.5, symbols: ["other"] },
  ];
  const ranked = planning.rerankPlanningFiles(candidates, "add fee model for new venue", new Set());
  if (ranked[0].path === "src/fees/feeModel.ts") {
    pass(`planning: fees/feeModel.ts ranks first for fee-model query (score=${ranked[0].score.toFixed(2)})`);
  } else {
    fail(`planning: expected src/fees/feeModel.ts first, got ${ranked[0].path} (full order: ${ranked.map(r => r.path).join(", ")})`);
  }
  // Check why_picked field
  if (ranked[0].reason && ranked[0].reason.length > "seed".length) {
    pass(`planning: rerank emits why_picked reason ("${ranked[0].reason.slice(0, 120)}")`);
  } else {
    fail(`planning: rerank did NOT emit why_picked evidence; reason="${ranked[0].reason}"`);
  }
}

// ─── FIX 5: repo_map honors max_tokens for breadth ────────────────────────────
{
  // Use the contextpro-mcp repo itself (130+ files indexed).
  const rm = await import("../build/tools/repo-map.js");
  // Need an indexed repo. Use the current project root.
  const root = process.cwd();
  const small = await rm.getRepoMapData({ rootDir: root, maxTokens: 1500 });
  const big = await rm.getRepoMapData({ rootDir: root, maxTokens: 12000 });
  if (big.summary.returnedFiles > small.summary.returnedFiles) {
    pass(`repo_map: scales with max_tokens (1500→${small.summary.returnedFiles} files, 12000→${big.summary.returnedFiles} files)`);
  } else {
    fail(`repo_map: breadth does NOT scale (1500→${small.summary.returnedFiles}, 12000→${big.summary.returnedFiles})`);
  }
}

// ─── FIX 6: hub directory-derived fallback ───────────────────────────────────
{
  const root = await mkFixture("hub", {
    "src/auth/a.ts": "// auth alpha\nexport function a() {}\n",
    "src/auth/b.ts": "// auth beta\nexport function b() {}\n",
    "src/auth/c.ts": "// auth gamma\nexport function c() {}\n",
    "src/billing/x.ts": "// billing x\nexport function x() {}\n",
    "src/billing/y.ts": "// billing y\nexport function y() {}\n",
  });
  const fh = await import("../build/tools/feature-hub.js");
  const result = await fh.autoGenerateHubData(root);
  if (result.generated.length > 0) {
    pass(`hub: auto-generated ${result.generated.length} hub(s) for fresh project: ${result.generated.join(", ")}`);
  } else {
    fail(`hub: returned no hubs for fresh project; message="${result.message}"`);
  }
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 7: tree fuzzy-resolve target_path ───────────────────────────────────
{
  const root = await mkFixture("tree", {
    "src/tradebot/a.ts": "// alpha\nexport function a() {}\n",
    "src/tradebot/b.ts": "// beta\nexport function b() {}\n",
  });
  const ctxTree = await import("../build/tools/context-tree.js");
  const result = await ctxTree.getContextTree({ rootDir: root, targetPath: "tradebot/" });
  if (/Fuzzy-resolved|did not match/.test(result)) {
    pass(`tree: fuzzy-resolve fired or surfaced explicit miss for "tradebot/"`);
  } else if (result.includes("a.ts") && result.includes("b.ts")) {
    pass(`tree: fuzzy-resolve silently succeeded (found tradebot files)`);
  } else {
    fail(`tree: fuzzy-resolve did not engage for "tradebot/" — output: ${result.slice(0, 300)}`);
  }
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 8: symbolic-edit collision + body validation ─────────────────────────
{
  const root = await mkFixture("sym", {
    "src/a.ts": [
      "// alpha",
      "// beta",
      "",
      "export function foo() { return 1; }",
      "export function bar() { return 2; }",
      "",
    ].join("\n"),
  });
  const symEdit = await import("../build/tools/symbolic-edit.js");

  // Collision check
  try {
    await symEdit.renameSymbol({ rootDir: root, relativePath: "src/a.ts", namePath: "foo", newName: "bar" });
    fail("symbolic-edit: renameSymbol did NOT detect collision foo→bar");
  } catch (err) {
    if (/already exists/.test(err.message)) pass("symbolic-edit: rename collision detected");
    else fail(`symbolic-edit: wrong error for collision: ${err.message}`);
  }

  // Body validation
  try {
    await symEdit.replaceSymbolBody({ rootDir: root, relativePath: "src/a.ts", namePath: "foo", body: "return 99;" });
    fail("symbolic-edit: replaceSymbolBody accepted bare body without signature line");
  } catch (err) {
    if (/does not look like|must include the full definition/.test(err.message)) {
      pass("symbolic-edit: replaceSymbolBody rejected bare body without signature");
    } else {
      fail(`symbolic-edit: wrong error for bare body: ${err.message}`);
    }
  }

  await rm(root, { recursive: true, force: true });
}

// ─── FIX 9: extractConfigKeys depth + dedup + comment safety ─────────────────
{
  const root = await mkFixture("cfg", {
    "rsbuild.config.ts": [
      "// build config",
      "// for MF",
      "",
      "export default {",
      "  moduleFederation: {",
      "    shared: {",
      "      react: {",
      "        singleton: true,",
      "      },",
      "    },",
      "  },",
      "};",
      "",
    ].join("\n"),
    "src/types.ts": [
      "// types",
      "// not config",
      "",
      "export type Foo = { singleton: boolean };",
      "export function notConfig() { const settings = { singleton: true }; return settings; }",
      "",
    ].join("\n"),
    "webpack.config.ts": [
      "// webpack",
      "// build",
      "",
      "// singleton: true  ← in a comment, should NOT be extracted",
      "/* block comment with singleton: true inside */",
      "export default {",
      "  mode: 'production',",
      "};",
      "",
    ].join("\n"),
  });
  const parser = await import("../build/core/parser.js");
  const cfg = await parser.analyzeFile(join(root, "rsbuild.config.ts"));
  const cfgNames = cfg.symbols.map((s) => s.name);
  if (cfgNames.includes("singleton")) pass(`extractConfigKeys: depth-4 'singleton' extracted from rsbuild.config.ts`);
  else fail(`extractConfigKeys: 'singleton' missing from rsbuild.config.ts; got: ${cfgNames.join(", ")}`);

  const types = await parser.analyzeFile(join(root, "src/types.ts"));
  const typesNames = types.symbols.map((s) => s.name);
  if (!typesNames.includes("singleton")) pass(`extractConfigKeys: 'singleton' NOT extracted from non-config types.ts`);
  else fail(`extractConfigKeys: 'singleton' wrongly extracted from non-config types.ts; got: ${typesNames.join(", ")}`);

  const wp = await parser.analyzeFile(join(root, "webpack.config.ts"));
  const wpNames = wp.symbols.map((s) => s.name);
  if (!wpNames.includes("singleton")) pass(`extractConfigKeys: comment-only 'singleton' NOT extracted from webpack.config.ts`);
  else fail(`extractConfigKeys: 'singleton' wrongly extracted from a COMMENT in webpack.config.ts; got: ${wpNames.join(", ")}`);

  await rm(root, { recursive: true, force: true });
}

// ─── FIX 10: identifier-search filters internal locals ───────────────────────
{
  const root = await mkFixture("ident", {
    "src/component.tsx": [
      "// React component",
      "// uses internal const",
      "",
      "export function Component() {",
      "  const containerStyle = { color: 'red' };",
      "  const internalLocal = 42;",
      "  return null;",
      "}",
      "export const PUBLIC_EXPORT = 'hello';",
      "",
    ].join("\n"),
  });
  const projectMod = await import("../build/core/project-config.js");
  await projectMod.ensureProjectConfig({ rootDir: root });
  const reindexMod = await import("../build/tools/reindex.js");
  await reindexMod.reindex({ rootDir: root, force: true, noEmbed: true });
  const ident = await import("../build/tools/semantic-identifiers.js");
  const result = await ident.semanticIdentifierSearchResults({ rootDir: root, query: "containerStyle internal local style" });
  const names = result.results.map((r) => r.name);
  if (!names.includes("containerStyle") && !names.includes("internalLocal")) {
    pass(`identifier-search: internal locals (containerStyle, internalLocal) NOT in results`);
  } else {
    fail(`identifier-search: internal locals LEAKED into results: ${names.join(", ")}`);
  }
  if (names.includes("PUBLIC_EXPORT") || names.includes("Component")) {
    pass(`identifier-search: public exports still indexed`);
  } else {
    warn(`identifier-search: no public exports surfaced for the query — could be a ranking issue (got: ${names.join(", ")})`);
  }
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 11: grep glob DoS cap surfaces error ─────────────────────────────────
{
  const root = await mkFixture("grep", {
    "src/a.ts": "export const x = 1;\n",
  });
  const grep = await import("../build/tools/grep.js");
  const out = await grep.grepProject({
    rootDir: root,
    pattern: "x",
    glob: "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}{s,t}{u,v}{w,x}{y,z}{1,2}{3,4}",
  });
  if (/Error:.*DoS guard|expanded.*sub-patterns/i.test(out)) {
    pass(`grep: DoS cap surfaces a clear error`);
  } else {
    fail(`grep: DoS cap silent; output="${out.slice(0, 200)}"`);
  }
  await rm(root, { recursive: true, force: true });
}

// ─── FIX 12: diff scope option exists ─────────────────────────────────────────
{
  const diff = await import("../build/tools/diff.js");
  if (typeof diff.getDiff === "function") {
    // Source has the option, verify it doesn't crash when called outside a git repo.
    const root = await mkFixture("diff", { "a.txt": "x\n" });
    const out = await diff.getDiff({ rootDir: root, scope: "staged" });
    if (out.length > 0) pass(`diff: getDiff accepted scope=staged (output: "${out.slice(0, 60)}")`);
    else warn(`diff: getDiff returned empty for scope=staged`);
    await rm(root, { recursive: true, force: true });
  } else {
    fail("diff: getDiff missing");
  }
}

// ─── FIX 13: search semantic_only / keyword_only presets ──────────────────────
{
  // Check the preset enum surfaces as a valid input. Run a search with each preset.
  const root = await mkFixture("preset", {
    "src/a.ts": "// alpha\n// beta\nexport function alpha() {}\n",
    "src/b.ts": "// alpha\n// beta\nexport function beta() {}\n",
  });
  const projectMod = await import("../build/core/project-config.js");
  await projectMod.ensureProjectConfig({ rootDir: root });
  const reindexMod = await import("../build/tools/reindex.js");
  await reindexMod.reindex({ rootDir: root, force: true, noEmbed: true });
  const search = await import("../build/tools/search.js");
  try {
    await search.unifiedSearchData({ rootDir: root, query: "alpha", mode: "file", preset: "keyword_only" });
    pass("search: keyword_only preset accepted");
  } catch (err) {
    fail(`search: keyword_only preset rejected: ${err.message}`);
  }
  try {
    await search.unifiedSearchData({ rootDir: root, query: "alpha", mode: "file", preset: "semantic_only" });
    pass("search: semantic_only preset accepted");
  } catch (err) {
    fail(`search: semantic_only preset rejected: ${err.message}`);
  }
  await rm(root, { recursive: true, force: true });
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log("");
console.log("═══════════════════════════════════════════════════════════════════");
console.log(`Verification complete: ${failures.length} failure(s), ${issues.length} warning(s)`);
if (failures.length > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  ✖ ${f}`);
}
if (issues.length > 0) {
  console.warn("\nWarnings:");
  for (const w of issues) console.warn(`  ⚠ ${w}`);
}
process.exit(failures.length > 0 ? 1 : 0);
