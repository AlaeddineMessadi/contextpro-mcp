// Task-oriented retrieval and memory tools for multi-project agent workflows
// FEATURE: High-leverage agent context assembly over project intelligence data

import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { fetchEmbedding } from "../core/embeddings.js";
import { getDB, type MemoryNodeInput, type MemoryNodeRow } from "../core/db.js";
import { createPromotedPattern, listPromotedPatterns, listRegisteredWorkspaces, loadProjectConfig } from "../core/project-config.js";
import { unifiedSearchData } from "./search.js";
import { walkDirectory } from "../core/walker.js";
import { discoverHubs, parseHubFile } from "../core/hub.js";
import { basename, join } from "path";

const execAsync = promisify(exec);

type OutputFormat = "text" | "json";

export interface TaskPackOptions {
  rootDir: string;
  task: string;
  maxFiles?: number;
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

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function inferProjectSummary(task: string, filePaths: string[]): string {
  const focus = filePaths.length > 0 ? filePaths.slice(0, 3).join(", ") : "no files ranked yet";
  return `${task} likely centers on ${focus}.`;
}

async function findConventionTests(rootDir: string, sourceFile: string, allFiles: string[]): Promise<string[]> {
  const base = sourceFile.replace(/\.\w+$/, "").split("/").pop() ?? "";
  return allFiles.filter((file) => {
    const isTest = /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(file);
    if (!isTest) return false;
    const testBase = file.replace(/\.\w+$/, "").replace(/\.(test|spec|demo)$/, "").split("/").pop() ?? "";
    return testBase === base;
  });
}

async function findTestsForFiles(rootDir: string, files: string[]): Promise<Array<{ path: string; reason: string; score: number }>> {
  const db = await getDB(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const allFiles = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const results: Array<{ path: string; reason: string; score: number }> = [];

  for (const file of files) {
    const convention = await findConventionTests(rootDir, file, allFiles);
    for (const testPath of convention) {
      results.push({ path: testPath, reason: "Matched by test naming convention", score: 0.68 });
    }
    const dbFile = db.getFile(file);
    if (!dbFile) continue;
    const importers = db.getImportersOf(dbFile.id);
    const indexedFiles = db.getAllFiles();
    for (const importer of importers) {
      const source = indexedFiles.find((candidate) => candidate.id === importer.source_file_id);
      if (!source) continue;
      if (!/\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(source.path)) continue;
      results.push({ path: source.path, reason: "Imports target module", score: 0.82 });
    }
  }

  const deduped = new Map<string, { path: string; reason: string; score: number }>();
  for (const item of results) {
    const existing = deduped.get(item.path);
    if (!existing || item.score > existing.score) deduped.set(item.path, item);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}

async function getRecentDiffSummary(rootDir: string, filePath: string): Promise<{ path: string; commit: string; summary: string } | null> {
  try {
    const { stdout } = await execAsync(`git log --oneline -n 1 -- "${filePath}"`, {
      cwd: rootDir,
      timeout: 5000,
    });
    const line = stdout.trim().split("\n")[0];
    if (!line) return null;
    const [commit, ...summary] = line.split(" ");
    return {
      path: filePath,
      commit,
      summary: summary.join(" "),
    };
  } catch {
    return null;
  }
}

async function getProjectMemoryHits(rootDir: string, query: string, topK: number): Promise<Array<{ id: string; kind: string; summary: string }>> {
  const db = await getDB(rootDir);
  const [queryVector] = await fetchEmbedding(query);
  const hits = db.searchMemoryNodes(queryVector, Math.max(topK * 6, 18));
  const filtered: Array<{ id: string; kind: string; summary: string }> = [];
  for (const hit of hits) {
    const metadata = parseMetadata(hit.node.metadata);
    if ((metadata.scope ?? "project") !== "project") continue;
    filtered.push({
      id: hit.node.id,
      kind: metadata.record_kind ?? "memory",
      summary: hit.node.content.slice(0, 220),
    });
    if (filtered.length >= topK) break;
  }
  return filtered;
}

async function resolveFilesFromSymbols(rootDir: string, symbols: string[] | undefined): Promise<string[]> {
  if (!symbols || symbols.length === 0) return [];
  const db = await getDB(rootDir);
  const files: string[] = [];
  const indexedFiles = db.getAllFiles();
  for (const symbol of symbols) {
    const matches = db.searchSymbolsByName(symbol);
    for (const match of matches) {
      const file = indexedFiles.find((candidate) => candidate.id === match.file_id);
      if (file) files.push(file.path);
    }
  }
  return unique(files);
}

async function findTextDependents(rootDir: string, filePath: string, symbolNames: string[] = []): Promise<string[]> {
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const candidates = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const baseName = basename(filePath).replace(/\.\w+$/, "");
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (candidate === filePath) continue;
    try {
      const content = await readFile(join(rootDir, candidate), "utf-8");
      if (content.includes(baseName) || symbolNames.some((symbol) => content.includes(symbol))) {
        matches.push(candidate);
      }
    } catch {}
  }
  return unique(matches);
}

function formatMaybeJson(format: OutputFormat | undefined, value: unknown, textRenderer: () => string): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  return textRenderer();
}

async function fileRisk(rootDir: string, filePath: string): Promise<{ importers: number; imports: number; churn: number }> {
  const db = await getDB(rootDir);
  const dbFile = db.getFile(filePath);
  let importers = 0;
  let imports = 0;
  if (dbFile) {
    importers = db.getImportersOf(dbFile.id).length;
    imports = db.getImportsFrom(dbFile.id).length;
  }
  let churn = 0;
  try {
    const { stdout } = await execAsync(`git log --oneline -- "${filePath}"`, { cwd: rootDir, timeout: 5000 });
    churn = stdout.trim().split("\n").filter(Boolean).length;
  } catch {}
  return { importers, imports, churn };
}

async function hubMatchesForFiles(rootDir: string, filePaths: string[]): Promise<string[]> {
  const hubs = await discoverHubs(rootDir).catch(() => []);
  const matches: string[] = [];
  for (const hubPath of hubs) {
    const hub = await parseHubFile(`${rootDir}/${hubPath}`).catch(() => null);
    if (!hub) continue;
    if (hub.links.some((link) => filePaths.includes(link.target))) {
      matches.push(hubPath);
    }
  }
  return matches;
}

export async function buildTaskPack(options: TaskPackOptions): Promise<string> {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 8));
  const search = await unifiedSearchData({
    rootDir: options.rootDir,
    query: options.task,
    mode: "hybrid",
    topK: maxFiles,
  });
  const fileResults = search.files?.results ?? [];
  const identifierResults = search.identifiers?.results ?? [];
  const topFiles = fileResults.slice(0, maxFiles).map((item) => ({
    path: item.path,
    reason: "Top semantic and structural match",
    score: item.score / 100,
    symbols: item.matchedSymbols,
  }));
  const filePaths = topFiles.map((item) => item.path);
  const tests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, filePaths);
  const recentDiffs = options.includeRecentDiffs === false
    ? []
    : (await Promise.all(filePaths.slice(0, 5).map((path) => getRecentDiffSummary(options.rootDir, path)))).filter(Boolean);
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.task, 3);
  const risks = [
    ...identifierResults.slice(0, 2).filter((item) => item.totalCalls > 3).map((item) => `${item.name} has ${item.totalCalls} ranked call sites`),
    ...(tests.length === 0 ? ["No nearby tests found for top-ranked files"] : []),
    ...(search.freshness.warning ? [search.freshness.warning] : []),
  ];
  const payload = {
    repo: {
      root: search.repo.root,
      projectId: search.repo.projectId,
      clientId: search.repo.clientId,
      fingerprint: search.repo.fingerprint,
      staleFiles: search.freshness.staleCount,
    },
    summary: inferProjectSummary(options.task, filePaths),
    files: topFiles,
    tests,
    recentDiffs,
    memory,
    risks,
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Task Pack: ${options.task}`,
      `Repo: ${search.repo.projectId ?? "unknown"} | Root: ${search.repo.root}`,
      `Summary: ${payload.summary}`,
      "",
      "Files:",
    ];
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
  const inputFiles = unique([...(options.files ?? []), ...(await resolveFilesFromSymbols(options.rootDir, options.symbols))]);
  const db = await getDB(options.rootDir);
  const indexedFiles = db.getAllFiles();
  const affected = new Map<string, { path: string; kind: string; score: number }>();
  const reasons: string[] = [];
  const targetTests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, inputFiles);

  for (const file of inputFiles) {
    const dbFile = db.getFile(file);
    if (!dbFile) continue;
    const importers = db.getImportersOf(dbFile.id);
    const imports = db.getImportsFrom(dbFile.id);
    if (importers.length > 0) reasons.push(`${file} has ${importers.length} importers`);
    for (const importer of importers) {
      const source = indexedFiles.find((candidate) => candidate.id === importer.source_file_id);
      if (!source) continue;
      affected.set(source.path, {
        path: source.path,
        kind: /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(source.path) ? "test_importer" : "importer",
        score: Math.min(0.95, 0.55 + importers.length * 0.08),
      });
    }
    for (const imp of imports) {
      const target = indexedFiles.find((candidate) => candidate.id === imp.target_file_id);
      if (!target) continue;
      affected.set(target.path, {
        path: target.path,
        kind: "dependency",
        score: 0.42,
      });
    }
    const textDependents = await findTextDependents(options.rootDir, file, options.symbols ?? []);
    for (const dependent of textDependents) {
      affected.set(dependent, {
        path: dependent,
        kind: /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(dependent) ? "text_test_match" : "text_match",
        score: 0.48,
      });
    }
  }

  const riskDetails = await Promise.all(inputFiles.map((file) => fileRisk(options.rootDir, file)));
  const totalImporters = riskDetails.reduce((sum, detail) => sum + detail.importers, 0);
  const totalChurn = options.includeRecentChurn === false ? 0 : riskDetails.reduce((sum, detail) => sum + detail.churn, 0);
  if (targetTests.length === 0) reasons.push("No nearby regression tests found");
  if (totalChurn > 0) reasons.push(`Recent churn count: ${totalChurn}`);
  const riskScore = Math.min(0.99, 0.25 + totalImporters * 0.08 + (targetTests.length === 0 ? 0.15 : 0) + Math.min(totalChurn, 10) * 0.03);
  const payload = {
    riskScore,
    impactSummary: inputFiles.length > 0
      ? `Changes may affect ${affected.size} related files around ${inputFiles.join(", ")}.`
      : "No files resolved for impact analysis.",
    affectedFiles: [...affected.values()].sort((a, b) => b.score - a.score),
    affectedTests: targetTests,
    publicSurface: unique(options.symbols ?? []),
    reasons: unique(reasons),
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Change Impact`,
      `Risk Score: ${Math.round(payload.riskScore * 100)}%`,
      `Summary: ${payload.impactSummary}`,
      "",
      "Affected Files:",
    ];
    for (const file of payload.affectedFiles.slice(0, 12)) {
      lines.push(`  ${file.path} [${file.kind}] (${Math.round(file.score * 100)}%)`);
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
  });
  const recommendedScope = search.files?.results.slice(0, options.preferSmallestScope === false ? maxFiles : Math.min(maxFiles, 3)).map((file) => ({
    path: file.path,
    action: "modify",
    confidence: Math.min(0.98, 0.45 + file.score / 100),
  })) ?? [];
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
  const payload = {
    recommendedScope,
    optionalScope,
    scopeRationale: [
      `Recommended scope is ranked from semantic file matches for "${options.task}".`,
      tests.length > 0 ? "Nearby tests were included because they are the cheapest validation surface." : "No nearby tests were detected, so only source files are recommended.",
    ],
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Edit Scope: ${options.task}`,
      "",
      "Recommended:",
    ];
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
  });
  const filesToReadFirst = search.files?.results.slice(0, 4).map((item) => item.path) ?? [];
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.query, 3);
  const tests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, filesToReadFirst);
  const hubs = options.includeHubs === false ? [] : await hubMatchesForFiles(options.rootDir, filesToReadFirst);
  const openQuestions = [
    ...(tests.length === 0 ? ["Which regression path validates this subsystem today?"] : []),
    ...(search.identifiers?.results.slice(0, 2).map((item) => `What behavior around ${item.name} is relied on by ${item.totalCalls} call sites?`) ?? []),
  ];
  const payload = {
    summary: inferProjectSummary(options.query, filesToReadFirst),
    topSymbols: search.identifiers?.results.slice(0, 5).map((item) => item.name) ?? [],
    filesToReadFirst,
    doNotReadYet: search.files?.results.slice(4, 7).map((item) => item.path) ?? [],
    hubs,
    memory,
    tests: tests.slice(0, 5),
    openQuestions,
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Decision Brief: ${options.query}`,
      `Summary: ${payload.summary}`,
      "",
      `Files To Read First: ${payload.filesToReadFirst.join(", ") || "(none)"}`,
      `Top Symbols: ${payload.topSymbols.join(", ") || "(none)"}`,
    ];
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
  const [embedding] = await fetchEmbedding(contentParts.join("\n"));
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
