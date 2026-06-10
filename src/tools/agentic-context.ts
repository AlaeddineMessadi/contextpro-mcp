// Task-oriented retrieval and memory tools for multi-project agent workflows
// FEATURE: High-leverage agent context assembly over project intelligence data

import { readFile } from "fs/promises";
import { fetchEmbedding } from "../core/embeddings.js";
import { getDB, type MemoryNodeInput, type MemoryNodeRow } from "../core/db.js";
import { createPromotedPattern, listPromotedPatterns, listRegisteredWorkspaces, loadProjectConfig } from "../core/project-config.js";
import { unifiedSearchData } from "./search.js";
import { dirname, join } from "path";
import { persistArtifact } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState } from "../core/context-metadata.js";
import { resolveSymbolData } from "./resolve-symbol.js";
import {
  unique, parseMetadata, parseJsonArray,
  findTestsForFiles, getRecentDiffSummary, getProjectMemoryHits,
  resolveFilesFromSymbols, findTextDependents, scanExactMentions, fileRisk, hubMatchesForFiles,
} from "./retrieval-helpers.js";
import {
  type PlanningFileCandidate,
  buildExactIdentifierPathSet, rerankPlanningFiles, maybeChatRerankPlanningFiles, upsertRanked,
  detectCodeChangeIntent, extractIdentifierHints, isDocumentationPath, isHubPath, isSourcePath, isTestPath, splitQueryTerms, clamp01,
} from "./planning-helpers.js";

type OutputFormat = "text" | "json";

interface AgentRepoMetadata {
  root: string;
  projectId: string | null;
  clientId: string | null;
  fingerprint: string | null;
  staleFiles: number;
  indexGeneration: number;
}

export interface TaskPackOptions {
  rootDir: string;
  task: string;
  maxFiles?: number;
  maxMemory?: number;
  includeTests?: boolean;
  includeRecentDiffs?: boolean;
  includeMemory?: boolean;
  format?: OutputFormat;
}

export interface ChangeImpactOptions {
  rootDir: string;
  files?: string[];
  symbols?: string[];
  includeTests?: boolean;
  includeRecentChurn?: boolean;
  format?: OutputFormat;
}

export interface EditScopeOptions {
  rootDir: string;
  task: string;
  maxFiles?: number;
  preferSmallestScope?: boolean;
  format?: OutputFormat;
}

export interface DecisionBriefOptions {
  rootDir: string;
  query: string;
  includeHubs?: boolean;
  includeMemory?: boolean;
  includeTests?: boolean;
  maxMemory?: number;
  format?: OutputFormat;
}

export interface ValidateScopeOptions {
  rootDir: string;
  task: string;
  maxFiles?: number;
  format?: OutputFormat;
}

export interface MemoryRecordTaskOptions {
  rootDir: string;
  task: string;
  summary: string;
  files?: string[];
  assumptions?: string[];
  evidence?: string[];
  openRisks?: string[];
  format?: OutputFormat;
}

export interface WorkspaceContextOptions {
  clientId?: string;
  includeProjects?: boolean;
  includeRecentSessions?: boolean;
  format?: OutputFormat;
}

export interface PromotePatternOptions {
  rootDir: string;
  sourceMemoryId: string;
  targetScope: "client" | "global";
  sanitize?: boolean;
  summary: string;
  format?: OutputFormat;
}

function normalizeConfidence(score: number): number {
  return Math.max(0.1, Math.min(0.99, Number(score.toFixed(2))));
}

function buildRepoMetadata(input: {
  rootDir: string;
  projectId?: string | null;
  clientId?: string | null;
  fingerprint?: string | null;
  staleFiles: number;
  indexGeneration: number;
}): AgentRepoMetadata {
  return {
    root: input.rootDir,
    projectId: input.projectId ?? null,
    clientId: input.clientId ?? null,
    fingerprint: input.fingerprint ?? null,
    staleFiles: input.staleFiles,
    indexGeneration: input.indexGeneration,
  };
}

async function persistAgentArtifact<T>(input: {
  rootDir: string;
  kind: string;
  key: string;
  repo: AgentRepoMetadata;
  payload: T;
  metadata?: Record<string, string>;
}) {
  return persistArtifact({
    rootDir: input.rootDir,
    kind: input.kind,
    key: input.key,
    repoFingerprint: input.repo.fingerprint,
    projectId: input.repo.projectId,
    clientId: input.repo.clientId,
    metadata: input.metadata,
    payload: input.payload,
  });
}

function inferProjectSummary(task: string, filePaths: string[]): string {
  const focus = filePaths.length > 0 ? filePaths.slice(0, 3).join(", ") : "no files ranked yet";
  return `${task} likely centers on ${focus}.`;
}

function formatMaybeJson(format: OutputFormat | undefined, value: unknown, textRenderer: () => string): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  return textRenderer();
}

async function readPackageScripts(rootDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(rootDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}


export async function buildTaskPack(options: TaskPackOptions): Promise<string> {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 8));
  const search = await unifiedSearchData({
    rootDir: options.rootDir,
    query: options.task,
    mode: "hybrid",
    topK: maxFiles,
    persistArtifact: false,
  });
  const fileResults = search.files?.results ?? [];
  const identifierResults = search.identifiers?.results ?? [];
  const exactIdentifierPaths = buildExactIdentifierPathSet(search, options.task);
  const rankedTaskFiles = await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.task,
    rerankPlanningFiles(
      fileResults.slice(0, Math.max(maxFiles, 8)).map((item) => ({
        path: item.path,
        reason: `Top semantic and structural match (${Math.round(item.semanticScore)} semantic / ${Math.round(item.keywordScore)} keyword)`,
        score: item.score / 100,
        symbols: item.matchedSymbols,
      })),
      options.task,
      exactIdentifierPaths,
    ),
  );
  const topFiles = rankedTaskFiles.slice(0, maxFiles).map((item) => ({
    path: item.path,
    reason: item.reason,
    score: item.score,
    symbols: item.symbols,
  }));
  const filePaths = topFiles.map((item) => item.path);
  const tests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, filePaths);
  const recentDiffs = options.includeRecentDiffs === false
    ? []
    : (await Promise.all(filePaths.slice(0, 5).map((path) => getRecentDiffSummary(options.rootDir, path)))).filter(Boolean);
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.task, Math.min(options.maxMemory ?? 3, 10));
  const risks = [
    ...identifierResults.slice(0, 2).filter((item) => item.totalCalls > 3).map((item) => `${item.name} has ${item.totalCalls} ranked call sites`),
    ...(tests.length === 0 ? ["No nearby tests found for top-ranked files"] : []),
    ...(search.freshness.warning ? [search.freshness.warning] : []),
  ];
  const repo = buildRepoMetadata({
    rootDir: search.repo.root,
    projectId: search.repo.projectId,
    clientId: search.repo.clientId,
    fingerprint: search.repo.fingerprint,
    staleFiles: search.freshness.staleCount,
    indexGeneration: search.freshness.indexGeneration,
  });
  const evidence = [
    ...search.trust.evidence,
    `${topFiles.length} ranked task files`,
    ...(tests.length > 0 ? [`${tests.length} nearby tests`] : []),
    ...(recentDiffs.length > 0 ? [`${recentDiffs.length} recent diffs`] : []),
    ...(memory.length > 0 ? [`${memory.length} project memory hits`] : []),
  ];
  const ambiguities = [
    ...search.trust.ambiguities,
    ...(topFiles.length === 0 ? ["task pack could not rank any files"] : []),
    ...(topFiles.length > 1 && Math.abs((topFiles[0]?.score ?? 0) - (topFiles[1]?.score ?? 0)) < 0.06 ? ["top task files are close in score"] : []),
  ];
  const partial = {
    repo,
    freshness: search.freshness,
    trust: buildTrustMetadata({
      baseConfidence: topFiles.length > 0 ? 0.79 : 0.34,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    summary: inferProjectSummary(options.task, filePaths),
    files: topFiles,
    tests,
    recentDiffs,
    memory,
    risks,
  };
  const artifact = await persistAgentArtifact({
    rootDir: options.rootDir,
    kind: "task_pack",
    key: JSON.stringify({
      task: options.task,
      maxFiles,
      includeTests: options.includeTests !== false,
      includeRecentDiffs: options.includeRecentDiffs !== false,
      includeMemory: options.includeMemory !== false,
    }),
    repo,
    payload: partial,
    metadata: {
      task: options.task,
    },
  });
  const payload = {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: topFiles.length > 0 ? 0.79 : 0.34,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Task Pack: ${options.task}`,
      `Repo: ${search.repo.projectId ?? "unknown"} | Root: ${search.repo.root}`,
      artifact ? `Artifact: ${artifact.id}` : "",
      `Summary: ${payload.summary}`,
      "",
      "Files:",
    ].filter(Boolean);
    for (const file of payload.files) {
      lines.push(`  ${file.path} (${Math.round(file.score * 100)}%) - ${file.reason}`);
      if (file.symbols.length > 0) lines.push(`    Symbols: ${file.symbols.join(", ")}`);
    }
    if (tests.length > 0) {
      lines.push("");
      lines.push("Tests:");
      for (const test of tests.slice(0, 6)) lines.push(`  ${test.path} (${Math.round(test.score * 100)}%) - ${test.reason}`);
    }
    if (recentDiffs.length > 0) {
      lines.push("");
      lines.push("Recent Diffs:");
      for (const diff of recentDiffs.slice(0, 5)) lines.push(`  ${diff?.path} @ ${diff?.commit} - ${diff?.summary}`);
    }
    if (memory.length > 0) {
      lines.push("");
      lines.push("Memory:");
      for (const item of memory) lines.push(`  ${item.id} [${item.kind}] ${item.summary}`);
    }
    if (risks.length > 0) {
      lines.push("");
      lines.push("Risks:");
      for (const risk of risks) lines.push(`  - ${risk}`);
    }
    return lines.join("\n");
  });
}

export async function buildChangeImpact(options: ChangeImpactOptions): Promise<string> {
  const resolvedSymbols = await Promise.all((options.symbols ?? []).map(async (symbol) => ({
    symbol,
    resolution: await resolveSymbolData({
      rootDir: options.rootDir,
      symbolName: symbol,
      limit: 5,
    }).catch(() => null),
  })));
  const resolvedFiles = resolvedSymbols
    .map((item) => item.resolution?.bestMatch?.path)
    .filter((path): path is string => Boolean(path));
  const fallbackFiles = await resolveFilesFromSymbols(options.rootDir, options.symbols);
  const inputFiles = unique([...(options.files ?? []), ...resolvedFiles, ...fallbackFiles]);
  const db = await getDB(options.rootDir);
  const indexedFiles = db.getAllFiles();
  const indexState = await getIndexState(options.rootDir);
  const freshness = buildFreshnessMetadata(indexState, {
    staleCount: 0,
    refreshed: false,
    warning: inputFiles.length === 0 ? "No files resolved for impact analysis." : null,
  });
  const affected = new Map<string, { path: string; kind: string; score: number; reason: string }>();
  const reasons: string[] = [];
  const targetTests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, inputFiles);
  const publicSurface = unique([
    ...(options.symbols ?? []),
    ...resolvedSymbols.map((item) => item.resolution?.bestMatch?.name).filter((name): name is string => Boolean(name)),
  ]);

  for (const file of inputFiles) {
    const dbFile = db.getFile(file);
    if (!dbFile) continue;
    const importers = db.getImportersOf(dbFile.id);
    const imports = db.getImportsFrom(dbFile.id);
    const fileSymbols = unique(db.getSymbolsByFile(dbFile.id).map((symbol) => symbol.name)).slice(0, 8);
    const relevantSymbols = unique([...(options.symbols ?? []), ...fileSymbols]);
    if (importers.length > 0) reasons.push(`${file} has ${importers.length} importers`);
    for (const importer of importers) {
      const source = indexedFiles.find((candidate) => candidate.id === importer.source_file_id);
      if (!source) continue;
      const importedSymbols = parseJsonArray(importer.symbols_imported);
      const symbolOverlap = importedSymbols.filter((symbol) => relevantSymbols.includes(symbol));
      upsertRanked(affected, {
        path: source.path,
        kind: /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(source.path)
          ? "test_importer"
          : symbolOverlap.length > 0
            ? "symbol_importer"
            : "importer",
        score: Math.min(0.96, symbolOverlap.length > 0 ? 0.9 : 0.72 + importers.length * 0.04),
        reason: symbolOverlap.length > 0
          ? `Imports ${symbolOverlap.join(", ")} from ${file}`
          : `Imports ${file}`,
      });
    }
    for (const imp of imports) {
      const target = indexedFiles.find((candidate) => candidate.id === imp.target_file_id);
      if (!target) continue;
      upsertRanked(affected, {
        path: target.path,
        kind: "dependency",
        score: 0.42,
        reason: `${file} depends on ${target.path}`,
      });
    }
    const candidateMentionFiles = unique([
      ...importers.map((importer) => indexedFiles.find((candidate) => candidate.id === importer.source_file_id)?.path ?? "").filter(Boolean),
      ...targetTests.map((test) => test.path),
      ...indexedFiles.filter((candidate) => dirname(candidate.path) === dirname(file)).map((candidate) => candidate.path),
    ]);
    const exactMentions = await scanExactMentions(options.rootDir, candidateMentionFiles, relevantSymbols);
    for (const dependent of exactMentions) {
      if (dependent === file) continue;
      upsertRanked(affected, {
        path: dependent,
        kind: /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(dependent) ? "symbol_test_match" : "symbol_reference",
        score: /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(dependent) ? 0.78 : 0.58,
        reason: `Exact mention of ${relevantSymbols.find((symbol) => symbol && exactMentions.includes(dependent)) ? "target symbol" : "target file context"}`,
      });
    }
  }

  const riskDetails = await Promise.all(inputFiles.map((file) => fileRisk(options.rootDir, file)));
  const totalImporters = riskDetails.reduce((sum, detail) => sum + detail.importers, 0);
  const totalChurn = options.includeRecentChurn === false ? 0 : riskDetails.reduce((sum, detail) => sum + detail.churn, 0);
  if (targetTests.length === 0) reasons.push("No nearby regression tests found");
  if (totalChurn > 0) reasons.push(`Recent churn count: ${totalChurn}`);
  const fanOut = totalImporters;
  const blastRadius = affected.size;
  const riskScore = Math.min(0.99, 0.28 + fanOut * 0.07 + (targetTests.length === 0 ? 0.14 : 0) + Math.min(totalChurn, 10) * 0.025 + Math.min(blastRadius, 12) * 0.015);
  const config = await loadProjectConfig(options.rootDir);
  const repo = buildRepoMetadata({
    rootDir: options.rootDir,
    projectId: config?.projectId ?? null,
    clientId: config?.clientId ?? null,
    fingerprint: config?.repoFingerprint ?? null,
    staleFiles: 0,
    indexGeneration: freshness.indexGeneration,
  });
  const evidence = [
    ...resolvedSymbols
      .filter((item) => item.resolution?.bestMatch)
      .map((item) => `${item.symbol} resolved to ${item.resolution?.bestMatch?.path}`),
    ...(fanOut > 0 ? [`${fanOut} direct importers`] : []),
    ...(targetTests.length > 0 ? [`${targetTests.length} nearby tests`] : []),
    ...(blastRadius > 0 ? [`${blastRadius} structurally related files`] : []),
  ];
  const ambiguities = [
    ...resolvedSymbols
      .filter((item) => item.resolution?.ambiguous)
      .map((item) => `${item.symbol} resolved ambiguously`),
    ...(inputFiles.length === 0 ? ["no files resolved for impact analysis"] : []),
  ];
  const partial = {
    repo,
    freshness,
    trust: buildTrustMetadata({
      baseConfidence: inputFiles.length > 0 ? 0.76 : 0.24,
      freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    riskScore,
    impactSummary: inputFiles.length > 0
      ? `Changes may affect ${affected.size} structurally related files around ${inputFiles.join(", ")}.`
      : "No files resolved for impact analysis.",
    affectedFiles: [...affected.values()].sort((a, b) => b.score - a.score),
    affectedTests: targetTests,
    publicSurface,
    reasons: unique(reasons),
  };
  const artifact = await persistAgentArtifact({
    rootDir: options.rootDir,
    kind: "change_impact",
    key: JSON.stringify({
      files: options.files ?? [],
      symbols: options.symbols ?? [],
      includeTests: options.includeTests !== false,
      includeRecentChurn: options.includeRecentChurn !== false,
    }),
    repo,
    payload: partial,
    metadata: {
      files: inputFiles.join(","),
      symbols: publicSurface.join(","),
    },
  });
  const payload = {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: inputFiles.length > 0 ? 0.76 : 0.24,
      freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Change Impact`,
      `Risk Score: ${Math.round(payload.riskScore * 100)}%`,
      artifact ? `Artifact: ${artifact.id}` : "",
      `Summary: ${payload.impactSummary}`,
      "",
      "Affected Files:",
    ].filter(Boolean);
    for (const file of payload.affectedFiles.slice(0, 12)) {
      lines.push(`  ${file.path} [${file.kind}] (${Math.round(file.score * 100)}%) - ${file.reason}`);
    }
    if (payload.affectedTests.length > 0) {
      lines.push("");
      lines.push("Affected Tests:");
      for (const test of payload.affectedTests.slice(0, 8)) {
        lines.push(`  ${test.path} (${Math.round(test.score * 100)}%) - ${test.reason}`);
      }
    }
    if (payload.reasons.length > 0) {
      lines.push("");
      lines.push("Reasons:");
      for (const reason of payload.reasons) lines.push(`  - ${reason}`);
    }
    return lines.join("\n");
  });
}

export async function buildEditScope(options: EditScopeOptions): Promise<string> {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 5));
  const search = await unifiedSearchData({
    rootDir: options.rootDir,
    query: options.task,
    mode: "hybrid",
    topK: Math.max(maxFiles, 5),
    persistArtifact: false,
  });
  const exactIdentifierPaths = buildExactIdentifierPathSet(search, options.task);
  const rankedScopeFiles = await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.task,
    rerankPlanningFiles(
      (search.files?.results ?? []).slice(0, Math.max(maxFiles, 6)).map((file) => ({
        path: file.path,
        reason: `Scoped from semantic file matches (${Math.round(file.semanticScore)} semantic / ${Math.round(file.keywordScore)} keyword)`,
        score: file.score / 100,
        symbols: file.matchedSymbols,
      })),
      options.task,
      exactIdentifierPaths,
    ),
  );
  const recommendedScope = rankedScopeFiles
    .slice(0, options.preferSmallestScope === false ? maxFiles : Math.min(maxFiles, 3))
    .map((file) => ({
    path: file.path,
    action: "modify",
    confidence: Math.min(0.98, 0.45 + file.score),
  }));
  const tests = await findTestsForFiles(options.rootDir, recommendedScope.map((item) => item.path));
  for (const test of tests.slice(0, 2)) {
    recommendedScope.push({
      path: test.path,
      action: "modify",
      confidence: Math.min(0.92, test.score),
    });
  }
  const optionalScope = search.identifiers?.results.slice(0, 3).map((item) => ({
    path: item.path,
    action: "review_only",
    confidence: Math.min(0.85, 0.35 + item.score / 100),
  })).filter((item) => !recommendedScope.some((recommended) => recommended.path === item.path)) ?? [];
  const repo = buildRepoMetadata({
    rootDir: search.repo.root,
    projectId: search.repo.projectId,
    clientId: search.repo.clientId,
    fingerprint: search.repo.fingerprint,
    staleFiles: search.freshness.staleCount,
    indexGeneration: search.freshness.indexGeneration,
  });
  const evidence = [
    ...search.trust.evidence,
    `${recommendedScope.length} recommended files in edit scope`,
    ...(tests.length > 0 ? [`${tests.length} nearby tests considered`] : []),
  ];
  const ambiguities = [
    ...search.trust.ambiguities,
    ...(recommendedScope.length === 0 ? ["edit scope could not recommend source files"] : []),
  ];
  const partial = {
    repo,
    freshness: search.freshness,
    trust: buildTrustMetadata({
      baseConfidence: recommendedScope.length > 0 ? 0.78 : 0.31,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    recommendedScope,
    optionalScope,
    scopeRationale: [
      `Recommended scope is ranked from semantic file matches for "${options.task}".`,
      tests.length > 0 ? "Nearby tests were included because they are the cheapest validation surface." : "No nearby tests were detected, so only source files are recommended.",
    ],
  };
  const artifact = await persistAgentArtifact({
    rootDir: options.rootDir,
    kind: "edit_scope",
    key: JSON.stringify({
      task: options.task,
      maxFiles,
      preferSmallestScope: options.preferSmallestScope !== false,
    }),
    repo,
    payload: partial,
    metadata: {
      task: options.task,
    },
  });
  const payload = {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: recommendedScope.length > 0 ? 0.78 : 0.31,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Edit Scope: ${options.task}`,
      artifact ? `Artifact: ${artifact.id}` : "",
      "",
      "Recommended:",
    ].filter(Boolean);
    for (const item of recommendedScope) lines.push(`  ${item.path} [${item.action}] (${Math.round(item.confidence * 100)}%)`);
    if (optionalScope.length > 0) {
      lines.push("");
      lines.push("Optional:");
      for (const item of optionalScope) lines.push(`  ${item.path} [${item.action}] (${Math.round(item.confidence * 100)}%)`);
    }
    lines.push("");
    lines.push("Rationale:");
    for (const reason of payload.scopeRationale) lines.push(`  - ${reason}`);
    return lines.join("\n");
  });
}

export async function buildDecisionBrief(options: DecisionBriefOptions): Promise<string> {
  const search = await unifiedSearchData({
    rootDir: options.rootDir,
    query: options.query,
    mode: "hybrid",
    topK: 5,
    persistArtifact: false,
  });
  const exactIdentifierPaths = buildExactIdentifierPathSet(search, options.query);
  const rankedBriefFiles = await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.query,
    rerankPlanningFiles(
      (search.files?.results ?? []).slice(0, 7).map((item) => ({
        path: item.path,
        reason: `Decision candidate (${Math.round(item.semanticScore)} semantic / ${Math.round(item.keywordScore)} keyword)`,
        score: item.score / 100,
        symbols: item.matchedSymbols,
      })),
      options.query,
      exactIdentifierPaths,
    ),
  );
  const filesToReadFirst = rankedBriefFiles.slice(0, 4).map((item) => item.path);
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.query, Math.min(options.maxMemory ?? 3, 10));
  const tests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, filesToReadFirst);
  const hubs = options.includeHubs === false ? [] : await hubMatchesForFiles(options.rootDir, filesToReadFirst);
  const openQuestions = [
    ...(tests.length === 0 ? ["Which regression path validates this subsystem today?"] : []),
    ...(search.identifiers?.results.slice(0, 2).map((item) => `What behavior around ${item.name} is relied on by ${item.totalCalls} call sites?`) ?? []),
  ];
  const repo = buildRepoMetadata({
    rootDir: search.repo.root,
    projectId: search.repo.projectId,
    clientId: search.repo.clientId,
    fingerprint: search.repo.fingerprint,
    staleFiles: search.freshness.staleCount,
    indexGeneration: search.freshness.indexGeneration,
  });
  const evidence = [
    ...search.trust.evidence,
    `${filesToReadFirst.length} files to read first`,
    ...(hubs.length > 0 ? [`${hubs.length} linked hubs`] : []),
    ...(memory.length > 0 ? [`${memory.length} memory hits`] : []),
  ];
  const ambiguities = [
    ...search.trust.ambiguities,
    ...(filesToReadFirst.length === 0 ? ["decision brief did not rank any files"] : []),
  ];
  const partial = {
    repo,
    freshness: search.freshness,
    trust: buildTrustMetadata({
      baseConfidence: filesToReadFirst.length > 0 ? 0.8 : 0.29,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    summary: inferProjectSummary(options.query, filesToReadFirst),
    topSymbols: search.identifiers?.results.slice(0, 5).map((item) => item.name) ?? [],
    filesToReadFirst,
    doNotReadYet: rankedBriefFiles.slice(4, 7).map((item) => item.path),
    hubs,
    memory,
    tests: tests.slice(0, 5),
    openQuestions,
  };
  const artifact = await persistAgentArtifact({
    rootDir: options.rootDir,
    kind: "decision_brief",
    key: JSON.stringify({
      query: options.query,
      includeHubs: options.includeHubs !== false,
      includeMemory: options.includeMemory !== false,
      includeTests: options.includeTests !== false,
    }),
    repo,
    payload: partial,
    metadata: {
      query: options.query,
    },
  });
  const payload = {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: filesToReadFirst.length > 0 ? 0.8 : 0.29,
      freshness: search.freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Decision Brief: ${options.query}`,
      artifact ? `Artifact: ${artifact.id}` : "",
      `Summary: ${payload.summary}`,
      "",
      `Files To Read First: ${payload.filesToReadFirst.join(", ") || "(none)"}`,
      `Top Symbols: ${payload.topSymbols.join(", ") || "(none)"}`,
    ].filter(Boolean);
    if (payload.hubs.length > 0) lines.push(`Hubs: ${payload.hubs.join(", ")}`);
    if (payload.tests.length > 0) {
      lines.push("");
      lines.push("Tests:");
      for (const test of payload.tests) lines.push(`  ${test.path} (${Math.round(test.score * 100)}%) - ${test.reason}`);
    }
    if (payload.memory.length > 0) {
      lines.push("");
      lines.push("Memory:");
      for (const item of payload.memory) lines.push(`  ${item.id} [${item.kind}] ${item.summary}`);
    }
    if (payload.openQuestions.length > 0) {
      lines.push("");
      lines.push("Open Questions:");
      for (const question of payload.openQuestions) lines.push(`  - ${question}`);
    }
    return lines.join("\n");
  });
}

export async function buildValidateScope(options: ValidateScopeOptions): Promise<string> {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 5));
  const editScopeRaw = JSON.parse(await buildEditScope({
    rootDir: options.rootDir,
    task: options.task,
    maxFiles,
    preferSmallestScope: true,
    format: "json",
  })) as {
    repo: AgentRepoMetadata;
    freshness: ReturnType<typeof buildFreshnessMetadata>;
    trust: ReturnType<typeof buildTrustMetadata>;
    recommendedScope: Array<{ path: string; action: string; confidence: number }>;
    optionalScope: Array<{ path: string; action: string; confidence: number }>;
  };
  const scripts = await readPackageScripts(options.rootDir);
  const sourceFiles = editScopeRaw.recommendedScope.filter((item) => isSourcePath(item.path)).map((item) => item.path);
  const tests = await findTestsForFiles(options.rootDir, sourceFiles);
  const testPaths = tests.slice(0, 8).map((test) => test.path);
  const checks: Array<{ type: string; command: string; reason: string }> = [];

  if (testPaths.length > 0 && scripts.test) {
    checks.push({
      type: "test",
      command: `npm run test -- ${testPaths.join(" ")}`,
      reason: "Closest regression tests for the scoped source files.",
    });
  } else if (testPaths.length > 0 && testPaths.every((path) => /\.(test|spec)\.(mjs|js)$/.test(path))) {
    checks.push({
      type: "test",
      command: `node --test ${testPaths.join(" ")}`,
      reason: "Direct Node test invocation is available for the scoped test files.",
    });
  }

  if (scripts.lint) {
    checks.push({
      type: "lint",
      command: "npm run lint",
      reason: "Project lint pass to catch type and style regressions around the edit scope.",
    });
  }

  if (scripts.build) {
    checks.push({
      type: "build",
      command: "npm run build",
      reason: "Project build verifies the edited modules still compile cleanly.",
    });
  }

  if (checks.length === 0) {
    checks.push({
      type: "manual",
      command: "Inspect nearest tests or run the project-standard validation command manually.",
      reason: "No safe script-level validation command could be inferred from the repository config.",
    });
  }

  const payload = {
    repo: editScopeRaw.repo,
    freshness: editScopeRaw.freshness,
    trust: editScopeRaw.trust,
    task: options.task,
    sourceFiles,
    tests: tests.slice(0, 8),
    optionalFiles: editScopeRaw.optionalScope,
    checks,
  };

  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Validate Scope: ${options.task}`,
      "",
      `Source files: ${sourceFiles.join(", ") || "(none)"}`,
      `Tests: ${testPaths.join(", ") || "(none)"}`,
      "",
      "Checks:",
    ];
    for (const check of checks) {
      lines.push(`  ${check.command}`);
      lines.push(`    ${check.reason}`);
    }
    return lines.join("\n");
  });
}

export async function recordTaskMemory(options: MemoryRecordTaskOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const config = await loadProjectConfig(options.rootDir);
  const contentParts = [
    `Task: ${options.task}`,
    `Summary: ${options.summary}`,
    options.files && options.files.length > 0 ? `Files: ${options.files.join(", ")}` : "",
    options.assumptions && options.assumptions.length > 0 ? `Assumptions: ${options.assumptions.join(" | ")}` : "",
    options.evidence && options.evidence.length > 0 ? `Evidence: ${options.evidence.join(" | ")}` : "",
    options.openRisks && options.openRisks.length > 0 ? `Open Risks: ${options.openRisks.join(" | ")}` : "",
  ].filter(Boolean);
  const metadata = {
    scope: "project",
    project_id: config?.projectId ?? "",
    client_id: config?.clientId ?? "",
    record_kind: "task",
    task: options.task,
  };
  let embedding: number[] = [];
  try {
    [embedding] = await fetchEmbedding(contentParts.join("\n"));
  } catch {
    // Embedding provider unavailable — store node without vector; keyword search still works.
  }
  const node = {
    type: "note",
    label: `task:${options.task}`,
    content: contentParts.join("\n"),
    metadata,
  } satisfies MemoryNodeInput;
  const taskMemoryId = db.upsertMemoryNode(node, embedding);
  const linkedNodes: string[] = [];
  for (const file of options.files ?? []) {
    const fileNodeId = db.upsertMemoryNode({
      type: "file",
      label: file,
      content: file,
      metadata: {
        scope: "project",
        project_id: config?.projectId ?? "",
        client_id: config?.clientId ?? "",
        record_kind: "file_ref",
      },
    });
    db.upsertMemoryEdge({
      source: taskMemoryId,
      target: fileNodeId,
      relation: "references",
      weight: 0.9,
    });
    linkedNodes.push(fileNodeId);
  }
  const payload = {
    taskMemoryId,
    linkedNodes,
    storedSummary: options.summary,
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Task memory recorded: ${taskMemoryId}`,
      `Summary: ${options.summary}`,
    ];
    if (linkedNodes.length > 0) lines.push(`Linked Nodes: ${linkedNodes.join(", ")}`);
    return lines.join("\n");
  });
}

export async function getWorkspaceContext(options: WorkspaceContextOptions): Promise<string> {
  const projects = options.includeProjects === false ? [] : await listRegisteredWorkspaces(options.clientId);
  const recentSessions = options.includeRecentSessions === false
    ? []
    : projects.slice(0, 8).map((item) => ({
      sessionSource: item.sessionSource,
      projectId: item.projectId,
      summary: `Last active at ${item.lastActiveAt}`,
    }));
  const patterns = await listPromotedPatterns(options.clientId);
  const payload = {
    clientId: options.clientId ?? null,
    projects,
    recentSessions,
    patterns: patterns.slice(0, 8),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Workspace Context${options.clientId ? ` for ${options.clientId}` : ""}`,
    ];
    if (projects.length > 0) {
      lines.push("");
      lines.push("Projects:");
      for (const project of projects.slice(0, 12)) {
        lines.push(`  ${project.projectId} | ${project.workspaceRoot} | ${project.sessionSource} | ${project.lastActiveAt}`);
      }
    }
    if (recentSessions.length > 0) {
      lines.push("");
      lines.push("Recent Sessions:");
      for (const session of recentSessions) {
        lines.push(`  ${session.sessionSource} | ${session.projectId} | ${session.summary}`);
      }
    }
    if (patterns.length > 0) {
      lines.push("");
      lines.push("Promoted Patterns:");
      for (const pattern of patterns.slice(0, 8)) {
        lines.push(`  ${pattern.patternId} [${pattern.targetScope}] ${pattern.summary}`);
      }
    }
    return lines.join("\n");
  });
}

export async function promotePattern(options: PromotePatternOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const config = await loadProjectConfig(options.rootDir);
  const source = db.getMemoryNode(options.sourceMemoryId);
  if (!source) {
    throw new Error(`Memory node not found: ${options.sourceMemoryId}`);
  }
  const pattern = await createPromotedPattern({
    sourceMemoryId: options.sourceMemoryId,
    targetScope: options.targetScope,
    clientId: config?.clientId ?? null,
    projectId: config?.projectId ?? "unknown",
    summary: options.summary,
    sanitize: options.sanitize ?? true,
  });
  const payload = {
    patternId: pattern.patternId,
    targetScope: pattern.targetScope,
    sanitized: pattern.sanitized,
    linkedSource: pattern.linkedSource,
  };
  return formatMaybeJson(options.format, payload, () => {
    return [
      `Pattern promoted: ${pattern.patternId}`,
      `Target Scope: ${pattern.targetScope}`,
      `Sanitized: ${pattern.sanitized ? "yes" : "no"}`,
      `Source: ${pattern.linkedSource}`,
    ].join("\n");
  });
}
