#!/usr/bin/env node
// Deterministic offline retrieval measurements. These are retrieval checks, not
// completed-agent-task evaluations or actual billing-savings measurements.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function retrievalMetrics(actualPaths, expectedPaths, k = 5) {
  const actual = [...new Set(actualPaths)].slice(0, k);
  const expected = new Set(expectedPaths);
  const hits = actual.filter((path) => expected.has(path)).length;
  const first = actual.findIndex((path) => expected.has(path));
  return {
    hitAt1: actual.length > 0 && expected.has(actual[0]) ? 1 : 0,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    recallAt5: expected.size ? hits / expected.size : 0,
    // Missing result slots count as nonrelevant: denominator is fixed at k.
    precisionAt5: hits / k,
  };
}

function outputMetrics(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  return { outputBytes: bytes, estimatedOutputTokens: Math.ceil(bytes / 4) };
}

async function writeProject(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function rgCommand(args, root) {
  try { return (await exec("rg", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 1) return ""; // No matches is a valid retrieval outcome.
    throw error;
  }
}

async function baseline(root, query) {
  // A reproducible ordinary search/read strategy: literal case-insensitive path
  // discovery, then at most three local matching snippets per top-five file.
  const discovery = await rgCommand(["-l", "-i", "-F", "--sort", "path", "--glob", "*.ts", "--glob", "*.py", "--", query, "."], root);
  const paths = discovery.trim().split("\n").filter(Boolean).map((path) => path.replace(/^\.\//, "")).slice(0, 5);
  const snippets = paths.length ? await rgCommand(["-n", "-H", "-i", "-F", "-C", "2", "-m", "3", "--", query, ...paths], root) : "";
  return { paths, text: discovery + snippets, toolCalls: paths.length ? 2 : 1 };
}

async function timeCall(operation) {
  const start = performance.now();
  const result = await operation();
  return { ...result, latencyMs: performance.now() - start };
}

export function summarizePairedAgentRuns(runs) {
  if (!Array.isArray(runs)) throw new Error("Agent runs must be an array matching benchmark-agent-runs.schema.json.");
  const groups = new Map();
  for (const run of runs) {
    if (!run || typeof run.taskId !== "string" || !run.taskId || typeof run.pairId !== "string" || !run.pairId
      || typeof run.model !== "string" || !run.model || !["baseline", "contextpro"].includes(run.variant)
      || typeof run.success !== "boolean" || run.tokenSource !== "provider_usage"
      || !["provider_billing", "calculated_given_rates"].includes(run.costSource)
      || ![run.inputTokens, run.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
      || !Number.isFinite(run.costUsd) || run.costUsd < 0) throw new Error("Invalid external agent run; provide measured provider usage and explicit cost provenance.");
    const key = JSON.stringify([run.taskId, run.pairId, run.model]);
    const pair = groups.get(key) ?? {};
    if (pair[run.variant]) throw new Error(`Duplicate ${run.variant} run for ${key}`);
    pair[run.variant] = run;
    groups.set(key, pair);
  }
  const pairs = [...groups.values()];
  if (pairs.some((pair) => !pair.baseline || !pair.contextpro)) throw new Error("Every external run must have a baseline/contextpro pair with the same taskId, pairId, and model.");
  return {
    source: "user-supplied paired agent runs; measurements not independently verified",
    pairs: pairs.length,
    baselineSuccesses: pairs.filter((pair) => pair.baseline.success).length,
    contextproSuccesses: pairs.filter((pair) => pair.contextpro.success).length,
    inputTokenDifference: pairs.reduce((total, pair) => total + pair.baseline.inputTokens - pair.contextpro.inputTokens, 0),
    outputTokenDifference: pairs.reduce((total, pair) => total + pair.baseline.outputTokens - pair.contextpro.outputTokens, 0),
    costDifferenceUsd: pairs.reduce((total, pair) => total + pair.baseline.costUsd - pair.contextpro.costUsd, 0),
    costSources: [...new Set(runs.map((run) => run.costSource))],
  };
}

export async function runRetrievalBenchmark({ corpusPath = join(repository, "test/fixtures/retrieval-benchmark.json"), agentRuns } = {}) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const scratch = await mkdtemp(join(tmpdir(), "contextpro-benchmark-"));
  const envKeys = ["CONTEXTPRO_REINDEX_NO_EMBED", "CONTEXTPLUS_NATIVE_AUTO_REPAIR"];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.CONTEXTPRO_REINDEX_NO_EMBED = "1";
  process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR = "false";
  const { Ollama } = await import("ollama");
  const originalEmbed = Ollama.prototype.embed;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const blockProvider = async () => { providerCalls++; throw new Error("Benchmark is offline; provider request blocked."); };
  Ollama.prototype.embed = blockProvider;
  globalThis.fetch = blockProvider;
  const { reindex } = await import("../build/tools/reindex.js");
  const { closeDB } = await import("../build/core/db.js");
  const { seedWorktreeFromBase } = await import("../build/core/worktree-seed.js");
  const { unifiedSearch, invalidateSearchCache, invalidateIdentifierSearchCache } = await import("../build/tools/search.js");
  const { buildTaskPack } = await import("../build/tools/agentic-context.js");
  const roots = [];
  const rows = [];
  try {
    for (const project of corpus.projects) {
      for (const task of project.tasks) {
        const base = join(scratch, project.id, task.id, "base");
        roots.push(base);
        await writeProject(base, project.files);
        const prepStart = performance.now();
        await reindex({ rootDir: base, noEmbed: true, autoHubs: false });
        const indexPreparationMs = performance.now() - prepStart;
        let root = base;
        if (task.worktree) {
          root = join(scratch, project.id, task.id, "worktree");
          roots.push(root);
          await writeProject(root, project.files);
          await seedWorktreeFromBase(root, base);
        }
        await writeProject(root, task.changes ?? {});
        invalidateSearchCache();
        invalidateIdentifierSearchCache();
        const measureContext = async () => {
          const text = await unifiedSearch({ rootDir: root, query: task.query, mode: "file", preset: "keyword_only", topK: 5, format: "json", persistArtifact: false, inlineCode: "crux" });
          const data = JSON.parse(text);
          return { paths: data.files?.results.map((result) => result.path) ?? [], text, toolCalls: 1, freshness: data.freshness };
        };
        const measurePack = async (graphHops) => {
          const text = await buildTaskPack({ rootDir: root, task: task.query, preset: "keyword_only", maxFiles: 1, graphHops, graphMaxFiles: 4, maxTokens: 2048, includeTests: false, includeRecentDiffs: false, includeMemory: false, format: "json" });
          const data = JSON.parse(text);
          return { paths: [...(data.files ?? []), ...(data.relatedFiles ?? [])].map((file) => file.path), text, toolCalls: 1, relatedFiles: data.relatedFiles?.length ?? 0 };
        };
        const callsBefore = providerCalls;
        const baselineCold = await timeCall(() => baseline(root, task.query));
        const baselineWarm = await timeCall(() => baseline(root, task.query));
        const contextCold = await timeCall(measureContext);
        const contextWarm = await timeCall(measureContext);
        invalidateSearchCache();
        invalidateIdentifierSearchCache();
        const packetDefaultCold = await timeCall(() => measurePack(0));
        const packetDefaultWarm = await timeCall(() => measurePack(0));
        invalidateSearchCache();
        invalidateIdentifierSearchCache();
        const packetGraphCold = await timeCall(() => measurePack(2));
        const packetGraphWarm = await timeCall(() => measurePack(2));
        const concurrency = 4;
        const concurrentStart = performance.now();
        await Promise.all(Array.from({ length: concurrency }, measureContext));
        const concurrentMs = performance.now() - concurrentStart;
        const summarize = (cold, warm) => ({
          paths: cold.paths,
          ...retrievalMetrics(cold.paths, task.expectedPaths),
          ...outputMetrics(cold.text),
          warmOutputBytes: Buffer.byteLength(warm.text, "utf8"),
          toolCalls: cold.toolCalls,
          coldLatencyMs: cold.latencyMs,
          warmLatencyMs: warm.latencyMs,
        });
        rows.push({
          project: project.id, taskId: task.id, task: task.task, query: task.query,
          expectedPaths: task.expectedPaths, indexPreparationMs,
          baseline: summarize(baselineCold, baselineWarm),
          packetDefault: summarize(packetDefaultCold, packetDefaultWarm),
          packetGraph: { ...summarize(packetGraphCold, packetGraphWarm), graphHops: 2, relatedFiles: packetGraphCold.relatedFiles },
          contextpro: {
            ...summarize(contextCold, contextWarm),
            providerCalls: providerCalls - callsBefore,
            freshness: contextCold.freshness,
            concurrentQueries: concurrency,
            concurrentDurationMs: concurrentMs,
            concurrentQueriesPerSecond: concurrency * 1000 / concurrentMs,
          },
        });
      }
    }
    const average = (variant, field) => rows.reduce((sum, row) => sum + row[variant][field], 0) / rows.length;
    return {
      schemaVersion: 1,
      corpusVersion: corpus.version,
      generatedAt: new Date().toISOString(),
      runtime: process.version,
      methodology: {
        scope: "Deterministic retrieval quality on a small synthetic TS/Python/monorepo corpus, including stale-index recovery and a worktree seeded via the production helper.",
        baseline: "Two ordinary rg calls: literal case-insensitive path discovery in path order, then at most three matching snippets with two context lines per top-five file.",
        contextpro: "Production search, file mode, keyword_only, topK=5, JSON, crux excerpts. Structural index preparation is recorded separately; cold means empty retrieval caches, not a cold OS page cache.",
        graphExperiment: "Two optional task_pack variants with keyword_only, one ranked seed file, 2048 token response estimate budget, no tests/memory/diffs: graphHops=0 vs graphHops=2, at most four additional import neighbors. Measures bounded expansion benefit separately from default search.",
        tokens: "UTF-8 response bytes divided by 4, rounded up; approximate response-size proxy, not model tokenizer or billed usage.",
        precision: "Relevant results / 5; missing result slots count as nonrelevant.",
        excluded: ["Tool schema/prompt input overhead", "Agent reasoning and follow-up tool use", "Real completed-task success", "Live semantic-provider quality/cost", "Full-process or OS-cache cold starts"],
        moneySavedUsd: null,
        agentTokensSaved: null,
      },
      summary: {
        tasks: rows.length,
        providerCalls,
        baseline: Object.fromEntries(["hitAt1", "reciprocalRank", "recallAt5", "precisionAt5", "estimatedOutputTokens", "coldLatencyMs", "warmLatencyMs"].map((field) => [field, average("baseline", field)])),
        packetDefault: Object.fromEntries(["recallAt5", "precisionAt5", "estimatedOutputTokens", "coldLatencyMs", "warmLatencyMs"].map((field) => [field, average("packetDefault", field)])),
        packetGraph: Object.fromEntries(["recallAt5", "precisionAt5", "estimatedOutputTokens", "coldLatencyMs", "warmLatencyMs"].map((field) => [field, average("packetGraph", field)])),
        contextpro: Object.fromEntries(["hitAt1", "reciprocalRank", "recallAt5", "precisionAt5", "estimatedOutputTokens", "coldLatencyMs", "warmLatencyMs"].map((field) => [field, average("contextpro", field)])),
      },
      tasks: rows,
      externalAgentRuns: agentRuns ? summarizePairedAgentRuns(agentRuns) : null,
    };
  } finally {
    for (const root of roots) closeDB(root);
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    Ollama.prototype.embed = originalEmbed;
    globalThis.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flagValue = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
    return args[index + 1];
  };
  const output = flagValue("--output");
  const agentRunsPath = flagValue("--agent-runs");
  const report = await runRetrievalBenchmark({ agentRuns: agentRunsPath ? JSON.parse(await readFile(agentRunsPath, "utf8")) : undefined });
  const rendered = JSON.stringify(report, null, 2) + "\n";
  if (output) await writeFile(resolve(output), rendered);
  process.stdout.write(rendered);
  if (report.summary.providerCalls > 0) process.exitCode = 1;
}
