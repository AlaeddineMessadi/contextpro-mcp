// Task-oriented retrieval and memory tools for multi-project agent workflows
// FEATURE: High-leverage agent context assembly over project intelligence data

import { readFile, stat } from "fs/promises";
import { resolveProjectPath } from "../core/path-guard.js";
import { createHash, randomUUID } from "node:crypto";
import { bindEvidence, createValidationSnapshot, validationState, memoryEvidenceStatus, evidenceConfigurationFiles, type EvidenceFile } from "../core/evidence-state.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchEmbedding, withQueryEmbeddingCache } from "../core/embeddings.js";
import { getDB, type MemoryNodeInput, type MemoryNodeRow } from "../core/db.js";
import { createPromotedPattern, listPromotedPatterns, listRegisteredWorkspaces, loadProjectConfig } from "../core/project-config.js";
import { unifiedSearchData } from "./search.js";
import { join, resolve } from "path";
import { persistArtifact, lookupFreshArtifact, readArtifact, buildArtifactId } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState } from "../core/context-metadata.js";
import { resolveSymbolData } from "./resolve-symbol.js";
import {
  unique, parseMetadata, parseJsonArray,
  findTestsForFiles, getRecentDiffSummary, getProjectMemoryHits,
  resolveFilesFromSymbols, scanExactMentions, fileRisk, hubMatchesForFiles, isTestFile,
} from "./retrieval-helpers.js";
import {
  type PlanningFileCandidate,
  buildExactIdentifierPathSet, rerankPlanningFiles, maybeChatRerankPlanningFiles, upsertRanked,
  detectCodeChangeIntent, extractIdentifierHints, isDocumentationPath, isHubPath, isSourcePath, isTestPath, splitQueryTerms, clamp01,
} from "./planning-helpers.js";
import { findDirectoryPriorMatches } from "./directory-prior.js";
import { connectedRetrievalEnabled, retrieveEvidence } from "./evidence-retrieval.js";
import { collectSourceEvidence, type Excerpt } from "./context.js";
import { chatModelIdentity } from "../core/chat-model.js";
import { getProvider, getEmbedModelName } from "../core/provider-config.js";

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
  previousContextId?: string;
  graphHops?: 0 | 1 | 2;
  graphMaxFiles?: number;
  preset?: "balanced" | "keyword_only";
  maxFiles?: number;
  maxMemory?: number;
  maxTokens?: number;
  includeTests?: boolean;
  includeRecentDiffs?: boolean;
  includeMemory?: boolean;
  format?: OutputFormat;
}

// The persisted task-pack payload, exactly what renderTaskPack consumes. Stored as the artifact so a
// fresh cache hit can re-render without recomputing search/rerank/tests/diffs/memory.
interface TaskPackFileEntry { path: string; reason: string; score: number; symbols: string[] }
interface TaskPackPayload {
  summary: string;
  files: TaskPackFileEntry[];
  relatedFiles?: TaskPackFileEntry[];
  tests: Array<{ path: string; reason: string; score: number }>;
  recentDiffs: Array<{ path: string; commit: string; summary: string } | null>;
  memory: Array<{ id: string; kind: string; summary: string }>;
  risks: string[];
  source?: Excerpt[];
  [key: string]: unknown;
}

interface TaskPackBudgetReport {
  maxTokens: number;
  estimator: "utf8_bytes_div_4";
  estimatedTokens: number;
  truncated: boolean;
  dropped: {
    files: number;
    relatedFiles: number;
    tests: number;
    recentDiffs: number;
    memory: number;
    symbols: number;
    risks: number;
    metadataFields: number;
    sourceRanges?: number;
  };
}

// The cache identity for a task pack: same task + same option flags → same artifact. The repo
// fingerprint and index generation gate freshness separately (handled by lookupFreshArtifact).
async function taskPackArtifactKey(task: string, maxFiles: number, opts: TaskPackOptions): Promise<string> {
  const connected = connectedRetrievalEnabled();
  const graphHops = opts.graphHops ?? (connected ? 1 : 0);
  return createHash("sha256").update(JSON.stringify({
    task,
    connected,
    retrievalVersion: 29,
    adaptive: process.env.CONTEXTPRO_ADAPTIVE_CONTEXT === "true",
    rerank: process.env.CONTEXTPRO_CHAT_RERANK === "true",
    chatModel: process.env.CONTEXTPRO_CHAT_RERANK === "true" ? await chatModelIdentity(opts.rootDir) : null,
    embeddingModel: `${getProvider()}:${getEmbedModelName()}`,
    preset: opts.preset ?? "balanced",
    graphHops,
    graphMaxFiles: graphHops ? (connected ? Math.max(0, Math.min(opts.graphMaxFiles ?? 8, 16)) : Math.max(1, Math.min(opts.graphMaxFiles ?? 4, 10))) : 0,
    // Connected payloads already contain source selected under this budget.
    // A later larger request must recompute rather than reuse the small packet.
    sourceBudget: connected ? Math.max(512, Math.floor((opts.maxTokens ?? 3000) * .65)) : null,
    maxFiles,
    includeTests: opts.includeTests !== false,
    includeRecentDiffs: opts.includeRecentDiffs !== false,
    includeMemory: opts.includeMemory !== false,
    // maxMemory changes how many memory hits the pack carries, so it MUST be part of the cache
    // identity — otherwise two calls differing only in maxMemory would collide on one cached pack.
    maxMemory: opts.includeMemory === false ? 0 : Math.min(opts.maxMemory ?? 3, 10),
  })).digest("hex");
}

function budgetTaskPackPayload(payload: TaskPackPayload, maxTokens: number | undefined, render: (value: TaskPackPayload & { budget: TaskPackBudgetReport }) => string): TaskPackPayload & { budget: TaskPackBudgetReport } {
  const budget = Math.max(512, Math.min(maxTokens ?? 3000, 12_000));
  const maxBytes = budget * 4;
  const original = {
    files: payload.files.length,
    relatedFiles: payload.relatedFiles?.length ?? 0,
    tests: payload.tests.length,
    recentDiffs: payload.recentDiffs.length,
    memory: payload.memory.length,
    symbols: payload.files.reduce((sum, file) => sum + file.symbols.length, 0),
    risks: payload.risks.length,
    sourceRanges: payload.source?.length ?? 0,
  };
  const result: TaskPackPayload = {
    ...structuredClone(payload),
    files: payload.files.map((file) => ({ ...file, symbols: file.symbols.slice() })),
    tests: payload.tests.slice(),
    recentDiffs: payload.recentDiffs.slice(),
    memory: payload.memory.slice(),
    risks: payload.risks.slice(),
  };
  if (payload.trust && typeof payload.trust === "object" && !Array.isArray(payload.trust)) {
    const trust = payload.trust as Record<string, unknown>;
    result.trust = {
      ...trust,
      evidence: Array.isArray(trust.evidence) ? trust.evidence.slice() : trust.evidence,
      ambiguities: Array.isArray(trust.ambiguities) ? trust.ambiguities.slice() : trust.ambiguities,
    };
  }

  let droppedMetadataFields = 0;
  const pruneNext = (): boolean => {
    if (result.recentDiffs.length > 0) result.recentDiffs.pop();
    else if ((result.relatedFiles?.length ?? 0) > 0) result.relatedFiles!.pop();
    else if (result.memory.length > 0) result.memory.pop();
    else if (result.tests.length > 0) result.tests.pop();
    else {
      const verboseFile = [...result.files].reverse().find((file) => file.symbols.length > 0);
      if (verboseFile) verboseFile.symbols.pop();
      // Preserve the two strongest files: task packs commonly need both the entry point
      // and the implementation file, and dropping the latter makes a tiny pack useless.
      else if (result.files.length > 2) result.files.pop();
      else if ((result.source?.length ?? 0) > 1) result.source!.pop();
      else if (result.risks.length > 1) result.risks.pop();
      else {
        const trust = result.trust as Record<string, unknown> | undefined;
        // Freshness is already present at the payload's top level, so this is the first
        // metadata field to remove under an extremely tight budget.
        if (trust && "freshness" in trust) {
          delete trust.freshness;
          droppedMetadataFields += 1;
        } else if (trust && Array.isArray(trust.evidence) && trust.evidence.length > 1) {
          trust.evidence.pop();
          droppedMetadataFields += 1;
        } else if (result.files.some((file) => file.reason.length > 0)) {
          result.files = result.files.map((file) => ({ ...file, reason: "" }));
          droppedMetadataFields += 1;
        } else if (result.summary.length > 0) {
          result.summary = "";
          droppedMetadataFields += 1;
        } else if (result.trust) {
          delete result.trust;
          droppedMetadataFields += 1;
        } else if (result.freshness) {
          delete result.freshness;
          droppedMetadataFields += 1;
        } else if (result.repo) {
          delete result.repo;
          droppedMetadataFields += 1;
        } else if (result.risks.length) {
          result.risks.pop();
        } else if (result.source?.length) {
          result.source.pop();
        } else if (result.files.length) {
          result.files.pop();
        } else if (result.delta) {
          // An incomplete delta is unsafe to apply. Explicitly require reading the full snapshot.
          delete result.delta;
          result.context = { ...(result.context as object), mode: "full_required", reason: "delta_exceeds_budget" };
          droppedMetadataFields += 1;
        } else {
          return false;
        }
      }
    }
    return true;
  };

  const buildReport = (estimatedTokens: number): TaskPackBudgetReport => {
    const retainedSymbols = result.files.reduce((sum, file) => sum + file.symbols.length, 0);
    return {
      maxTokens: budget,
      estimator: "utf8_bytes_div_4",
      estimatedTokens,
      truncated: original.files !== result.files.length
        || original.relatedFiles !== (result.relatedFiles?.length ?? 0)
        || original.tests !== result.tests.length
        || original.recentDiffs !== result.recentDiffs.length
        || original.memory !== result.memory.length
        || original.symbols !== retainedSymbols
        || original.risks !== result.risks.length
        || original.sourceRanges !== (result.source?.length ?? 0)
        || droppedMetadataFields > 0,
      dropped: {
        files: original.files - result.files.length,
        relatedFiles: original.relatedFiles - (result.relatedFiles?.length ?? 0),
        tests: original.tests - result.tests.length,
        recentDiffs: original.recentDiffs - result.recentDiffs.length,
        memory: original.memory - result.memory.length,
        symbols: original.symbols - retainedSymbols,
        risks: original.risks - result.risks.length,
        metadataFields: droppedMetadataFields,
        ...(payload.source ? { sourceRanges: original.sourceRanges - (result.source?.length ?? 0) } : {}),
      },
    };
  };

  while (true) {
    let estimatedTokens = 0;
    let candidate = { ...result, budget: buildReport(estimatedTokens) };
    // The estimate changes its own digit count at most a couple of times.
    for (let iteration = 0; iteration < 3; iteration += 1) {
      estimatedTokens = Math.ceil(Buffer.byteLength(render(candidate), "utf8") / 4);
      candidate = { ...result, budget: buildReport(estimatedTokens) };
    }
    if (Buffer.byteLength(render(candidate), "utf8") <= maxBytes) return candidate;
    if (!pruneNext()) {
      throw new Error("Task pack response cannot fit the requested UTF-8 byte budget; use a larger max_tokens.");
    }
  }
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
  /** Files already changed or known to be in scope. These take precedence over task inference. */
  files?: string[];
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
  sourceEvidence?: EvidenceFile[];
  supersedes?: string[];
  validationRefs?: string[];
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
    indexGeneration: input.repo.indexGeneration,
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

/**
 * Merge directory-purpose / Protocol-implementation prior matches into a candidate set.
 * For "add a new X for Y" tasks, the directory hosting sibling implementations is surfaced even
 * when those files didn't make the semantic top-K. Prior matches get a high base score so they
 * outrank generic single-token matches like status.py.
 */
async function applyDirectoryPrior(
  rootDir: string,
  task: string,
  candidates: PlanningFileCandidate[],
): Promise<{ candidates: PlanningFileCandidate[]; priorPaths: string[] }> {
  const priors = await findDirectoryPriorMatches(rootDir, task).catch(() => []);
  if (priors.length === 0) return { candidates, priorPaths: [] };
  const byPath = new Map(candidates.map((c) => [c.path, c]));
  for (const prior of priors) {
    const existing = byPath.get(prior.path);
    // Prior boost maps to a strong base score (0.7–0.85) so implementation-directory files
    // clearly outrank generic keyword hits.
    const priorScore = 0.7 + prior.boost * 0.3;
    if (existing) {
      byPath.set(prior.path, {
        ...existing,
        score: Math.max(existing.score, priorScore),
        reason: `${existing.reason}; ${prior.reason}`,
        symbols: existing.symbols.length > 0 ? existing.symbols : prior.symbols,
      });
    } else {
      byPath.set(prior.path, {
        path: prior.path,
        reason: prior.reason,
        score: priorScore,
        symbols: prior.symbols,
      });
    }
  }
  return { candidates: [...byPath.values()], priorPaths: priors.map((p) => p.path) };
}

function weightForFileRole(path: string): number {
  if (isTestFile(path)) return 0.85;
  if (/\.(json|toml|yaml|yml|ini|cfg)$/i.test(path)) return 0.65;
  if (/(^|\/)(README|TODO|CHANGELOG|CONTRIBUTING)(\.md)?$/i.test(path)) return 0.6;
  if (/(^|\/)(src|app|lib|packages)\//.test(path)) return 0.95;
  return 0.75;
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

interface PythonProjectProfile {
  isUvManaged: boolean;
  isPoetryManaged: boolean;
  hasPyprojectToml: boolean;
  hasVenv: boolean;
  hasPytestConfig: boolean;
  hasRuffConfig: boolean;
  hasMypyConfig: boolean;
  testRoots: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function detectPythonProfile(rootDir: string): Promise<PythonProjectProfile> {
  const profile: PythonProjectProfile = {
    isUvManaged: false,
    isPoetryManaged: false,
    hasPyprojectToml: false,
    hasVenv: false,
    hasPytestConfig: false,
    hasRuffConfig: false,
    hasMypyConfig: false,
    testRoots: [],
  };
  const pyproject = join(rootDir, "pyproject.toml");
  if (await fileExists(pyproject)) {
    profile.hasPyprojectToml = true;
    try {
      const raw = await readFile(pyproject, "utf-8");
      if (/\[tool\.pytest\.ini_options\]/.test(raw)) profile.hasPytestConfig = true;
      if (/\[tool\.ruff/.test(raw)) profile.hasRuffConfig = true;
      if (/\[tool\.mypy\]/.test(raw)) profile.hasMypyConfig = true;
      const testpathsMatch = raw.match(/testpaths\s*=\s*\[([^\]]*)\]/);
      if (testpathsMatch) {
        const items = testpathsMatch[1].match(/"([^"]+)"|'([^']+)'/g) ?? [];
        profile.testRoots = items.map((item) => item.replace(/^['"]|['"]$/g, ""));
      }
    } catch {
      // ignore parse errors, profile fields stay at defaults
    }
  }
  if (await fileExists(join(rootDir, "uv.lock"))) profile.isUvManaged = true;
  if (await fileExists(join(rootDir, "poetry.lock"))) profile.isPoetryManaged = true;
  if (await fileExists(join(rootDir, ".venv", "bin", "python")) || await fileExists(join(rootDir, ".venv", "Scripts", "python.exe"))) {
    profile.hasVenv = true;
  }
  if (await fileExists(join(rootDir, "pytest.ini")) || await fileExists(join(rootDir, "setup.cfg"))) {
    profile.hasPytestConfig = true;
  }
  if (await fileExists(join(rootDir, "ruff.toml")) || await fileExists(join(rootDir, ".ruff.toml"))) {
    profile.hasRuffConfig = true;
  }
  if (await fileExists(join(rootDir, "mypy.ini"))) {
    profile.hasMypyConfig = true;
  }
  return profile;
}

function pythonRunCommand(profile: PythonProjectProfile, tool: string, rootDir: string): string {
  if (profile.hasVenv) {
    return `.venv/bin/${tool}`;
  }
  if (profile.isUvManaged) return `uv run ${tool}`;
  if (profile.isPoetryManaged) return `poetry run ${tool}`;
  return tool;
}


async function expandTaskImportGraph(rootDir: string, seeds: string[], hops: number, maxFiles: number): Promise<TaskPackFileEntry[]> {
  if (hops <= 0) return [];
  const db = await getDB(rootDir);
  const seen = new Set(seeds);
  const related: TaskPackFileEntry[] = [];
  let frontier = seeds.slice(0, 3);
  for (let depth = 0; depth < Math.min(hops, 2) && frontier.length; depth++) {
    const next: string[] = [];
    for (const seed of frontier) {
      const file = db.getFile(seed);
      if (!file) continue;
      const edges = [
        ...db.getImportsFrom(file.id).map((edge) => ({ path: edge.target_file_id ? db.getFileById(edge.target_file_id)?.path : null, reason: `Imported by ${seed}` })),
        ...db.getImportersOf(file.id).map((edge) => ({ path: db.getFileById(edge.source_file_id)?.path, reason: `Imports ${seed}` })),
      ].sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
      for (const edge of edges) {
        if (!edge.path || seen.has(edge.path)) continue;
        seen.add(edge.path);
        related.push({ path: edge.path, reason: `${edge.reason}; indexed import edge, parser/resolver heuristic (${depth + 1} hop)`, score: 0.5 / (depth + 1), symbols: [] });
        next.push(edge.path);
        if (related.length >= maxFiles) return related;
      }
    }
    frontier = next;
  }
  return related;
}

export function buildTaskPack(options: TaskPackOptions): Promise<string> {
  return withQueryEmbeddingCache(() => buildTaskPackUncached(options));
}

async function buildTaskPackUncached(options: TaskPackOptions): Promise<string> {
  if (options.previousContextId && !/^task_context-[a-f0-9]{14}$/.test(options.previousContextId)) throw new Error("Invalid previous_context_id; use the task_context ID from a previous response.");
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 8));
  const taskKey = await taskPackArtifactKey(options.task, maxFiles, options);
  const db = await getDB(options.rootDir);
  let memoryRevision = options.includeMemory === false ? 0 : db.getMemoryRevision();
  const gitHead = options.includeRecentDiffs === false ? "" : await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: options.rootDir, timeout: 3000 }).then(({ stdout }) => stdout.trim()).catch(() => "");
  let artifactKey = createHash("sha256").update(`${taskKey}:${memoryRevision}:${gitHead}`).digest("hex");

  // READ-THROUGH CACHE: if a task pack for this exact task+flags was already computed and the index
  // hasn't advanced since, re-render the stored payload instead of recomputing the whole pipeline
  // (search + directory-prior + rerank + tests + diffs + memory). This makes a repeated task_pack
  // call genuinely cheap — the artifact is the source of truth, not just a side-effect record.
  // Best-effort: any failure resolving identity falls through to a normal (re)compute.
  try {
    const config = await loadProjectConfig(options.rootDir).catch(() => null);
    const indexState = await getIndexState(options.rootDir);
    // Only serve from cache when the index is genuinely FRESH. The generation number alone is not
    // enough: adding/removing/editing a source file without reindexing leaves the generation
    // unchanged but flips state to "stale" — serving the pre-change pack would be wrong. A non-fresh
    // index always recomputes (and the recompute reflects the current on-disk reality).
    const cached = indexState.state !== "fresh" ? null : await lookupFreshArtifact<TaskPackPayload>(
      options.rootDir,
      "task_pack",
      artifactKey,
      config?.repoFingerprint ?? null,
      indexState.generation,
    );
    const memoryUsable = cached?.payload?.memory ? (await Promise.all(cached.payload.memory.map(async hit => {
      const node = db.getMemoryNode(hit.id);
      if (!node) return false;
      const status = await memoryEvidenceStatus(options.rootDir, node);
      return status !== "stale" && status !== "superseded";
    }))).every(Boolean) : true;
    if (cached?.payload?.files && memoryUsable) {
      const trust = buildTrustMetadata({
        baseConfidence: cached.payload.files.length > 0 ? 0.79 : 0.34,
        freshness: buildFreshnessMetadata(indexState, { staleCount: 0, refreshed: false, warning: null }),
        evidence: [...(((cached.payload.trust as { evidence?: string[] })?.evidence) ?? []), "served from artifact cache (no recompute)"],
        ambiguities: ((cached.payload.trust as { ambiguities?: string[] })?.ambiguities) ?? [],
        artifact: { id: cached.id, kind: cached.kind, key: cached.key, path: cached.path, createdAt: cached.createdAt, updatedAt: cached.updatedAt, indexGeneration: cached.indexGeneration },
      });
      const cachedPayload: TaskPackPayload = { ...cached.payload, trust };
      return finishTaskPack(options, cachedPayload, taskKey, memoryRevision, cached.repoFingerprint);
    }
  } catch {
    // Cache lookup failed (e.g. corrupt manifest, DB not ready) — fall through to recompute.
  }

  const connected = connectedRetrievalEnabled() ? await retrieveEvidence({ rootDir: options.rootDir, query: options.task,
    graphHops: options.graphHops, graphMaxFiles: options.graphMaxFiles, includeTests: options.includeTests, preset: options.preset }) : undefined;
  const search = connected?.search ?? await unifiedSearchData({
    rootDir: options.rootDir,
    query: options.task,
    mode: "hybrid",
    topK: maxFiles,
    persistArtifact: false,
    expandCallers: false,
    preset: options.preset,
  });
  const fileResults = search.files?.results ?? [];
  const identifierResults = search.identifiers?.results ?? [];
  const exactIdentifierPaths = buildExactIdentifierPathSet(search, options.task);
  const baseTaskCandidates = connected?.candidates ?? fileResults.slice(0, Math.max(maxFiles, 8)).map((item) => ({
    path: item.path,
    reason: `Top semantic and structural match (${Math.round(item.semanticScore)} semantic / ${Math.round(item.keywordScore)} keyword)`,
    score: item.score / 100,
    symbols: item.matchedSymbols,
  }));
  const { candidates: taskCandidatesWithPrior } = await applyDirectoryPrior(options.rootDir, options.task, baseTaskCandidates);
  const rankedTaskFiles = connected?.candidates ?? await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.task,
    rerankPlanningFiles(taskCandidatesWithPrior, options.task, exactIdentifierPaths),
  );
  const topFiles = rankedTaskFiles.slice(0, maxFiles).map((item) => ({
    path: item.path,
    reason: item.reason,
    score: item.score,
    symbols: item.symbols,
  }));
  const filePaths = topFiles.map((item) => item.path);
  const relatedFiles = connected ? connected.candidates.filter(item => !filePaths.includes(item.path) && item.roles.some(role => role === "caller" || role === "dependency")).slice(0, options.graphMaxFiles ?? 4)
    : await expandTaskImportGraph(options.rootDir, filePaths, options.graphHops ?? 0, Math.max(1, Math.min(options.graphMaxFiles ?? 4, 10)));
  const tests = options.includeTests === false ? [] : connected?.tests ?? await findTestsForFiles(options.rootDir, filePaths);
  const source = connected ? await collectSourceEvidence({ rootDir: options.rootDir, query: options.task, retrieved: connected, connected: true,
    retrievalPreset: options.preset, maxTokens: Math.max(512, Math.floor((options.maxTokens ?? 3000) * .65)) }) : undefined;
  const recentDiffs = options.includeRecentDiffs === false
    ? []
    : (await Promise.all(filePaths.slice(0, 5).map((path) => getRecentDiffSummary(options.rootDir, path)))).filter(Boolean);
  // Capture before the asynchronous read: concurrent writes must invalidate, never bless stale memory.
  memoryRevision = options.includeMemory === false ? 0 : db.getMemoryRevision();
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.task, Math.min(options.maxMemory ?? 3, 10), options.preset === "keyword_only");
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
    ...(connected || options.graphHops ? { relatedFiles } : {}),
    ...(source ? { source: source.ranges } : {}),
    tests,
    recentDiffs,
    memory,
    risks: [...risks, ...(source?.notices ?? [])],
  };
  // Structural refresh can update memory too; cache under the revision captured for retrieval.
  artifactKey = createHash("sha256").update(`${taskKey}:${memoryRevision}:${gitHead}`).digest("hex");
  const artifact = await persistAgentArtifact({
    rootDir: options.rootDir,
    kind: "task_pack",
    key: artifactKey,
    repo,
    payload: partial,
    metadata: {
      task: options.task.slice(0, 500),
      memoryRevision: String(memoryRevision),
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
  return finishTaskPack(options, payload, taskKey, memoryRevision, search.repo.fingerprint);
}

interface TaskContextSnapshot {
  taskKey: string;
  payload: TaskPackPayload;
  entries: Record<string, unknown>;
  complete: boolean;
}

// Snapshots include source content hashes, so a changed implementation is visible even when its
// ranking, path and symbols remain identical. IDs bind repository, task/options and delivery budget.
async function finishTaskPack(options: TaskPackOptions, payload: TaskPackPayload, taskKey: string, memoryRevision: number, fingerprint: string | null): Promise<string> {
  const db = await getDB(options.rootDir);
  const entries: Record<string, unknown> = {};
  for (const file of payload.files) entries[`file:${file.path}`] = { ...file, sourceHash: db.getFile(file.path)?.content_hash ?? null };
  for (const file of payload.relatedFiles ?? []) entries[`graph:${file.path}`] = { ...file, sourceHash: db.getFile(file.path)?.content_hash ?? null };
  for (const test of payload.tests) entries[`test:${test.path}`] = { ...test, sourceHash: db.getFile(test.path)?.content_hash ?? null };
  for (const part of payload.source ?? []) entries[`source:${part.file}:${part.start}-${part.end}`] = part;
  for (const memory of payload.memory) entries[`memory:${memory.id}`] = memory;
  for (const diff of payload.recentDiffs) if (diff) entries[`diff:${diff.path}`] = diff;
  payload.risks.forEach((risk, index) => { entries[`risk:${index}`] = risk; });
  const generation = db.getIndexGeneration();
  const key = createHash("sha256").update(JSON.stringify({ root: options.rootDir, taskKey, entries, generation, memoryRevision, maxTokens: options.maxTokens ?? 3000, format: options.format ?? "text", previousId: options.previousContextId ?? null })).digest("hex");
  const contextId = buildArtifactId("task_context", key, fingerprint);
  const previous = options.previousContextId ? await readArtifact<TaskContextSnapshot>(options.rootDir, options.previousContextId) : null;
  const validBaseline = previous?.kind === "task_context" && previous.repoRoot === resolve(options.rootDir) && previous.repoFingerprint === fingerprint
    && previous.payload.taskKey === taskKey && previous.payload.complete === true;
  const context: Record<string, unknown> = {
    id: contextId,
    mode: "full",
    indexGeneration: generation,
    memoryRevision,
    recovery: "artifact_read({artifact_id: context.id}) returns the full snapshot; omit previous_context_id after compaction",
  };
  let delivery: TaskPackPayload = { ...payload, context };
  if (options.previousContextId && validBaseline) {
    const before = previous!.payload.entries;
    const added = Object.entries(entries).filter(([id]) => !(id in before)).map(([id, value]) => ({ id, value }));
    const changed = Object.entries(entries).filter(([id, value]) => id in before && JSON.stringify(before[id]) !== JSON.stringify(value)).map(([id, value]) => ({ id, value }));
    const removed = Object.keys(before).filter((id) => !(id in entries));
    context.mode = "delta";
    context.previousId = options.previousContextId;
    context.unchanged = added.length === 0 && changed.length === 0 && removed.length === 0;
    delivery = { ...delivery, files: [], relatedFiles: [], tests: [], memory: [], recentDiffs: [], risks: [], ...(payload.source ? { source: [] } : {}), delta: { added, changed, removed } };
  } else if (options.previousContextId) {
    context.fallbackReason = previous ? "unrelated_or_incomplete_baseline" : "baseline_not_found";
  }
  const budgeted = budgetTaskPackPayload(delivery, options.maxTokens, (value) => renderTaskPack(options.format, value));
  // A pruned full packet cannot serve as a delta baseline: the agent never received every entry.
  // Complete deltas can be chained, since the unchanged entries came from a complete baseline.
  const complete = !budgeted.budget.truncated;
  await persistArtifact({ rootDir: options.rootDir, kind: "task_context", key, repoFingerprint: fingerprint,
    indexGeneration: generation, immutable: true, payload: { taskKey, payload, entries, complete } satisfies TaskContextSnapshot });
  return renderTaskPack(options.format, budgeted);
}

function renderTaskPack(format: OutputFormat | undefined, payload: TaskPackPayload & { budget: TaskPackBudgetReport }): string {
  const context = payload.context as Record<string, unknown> | undefined;
  if (context?.unchanged) {
    const freshness = payload.freshness as { indexState?: string; warning?: string | null } | undefined;
    const compact = {
      context: { id: context.id, previousId: context.previousId, mode: "delta", unchanged: true, indexGeneration: context.indexGeneration, memoryRevision: context.memoryRevision },
      freshness: { state: freshness?.indexState, warning: freshness?.warning ?? null },
      delta: payload.delta,
      files: [], relatedFiles: [], tests: [], memory: [], recentDiffs: [], risks: [],
      budget: payload.budget,
    };
    if (format === "json") return JSON.stringify(compact);
    return `Context unchanged: ${context.id} (previous: ${context.previousId}; generation: ${context.indexGeneration}). Keep the previous packet.\nFreshness: ${freshness?.indexState ?? "unknown"}${freshness?.warning ? `; ${freshness.warning}` : ""}`;
  }
  if (format === "json") return JSON.stringify(payload);
  const lines = ["Task Pack", `Summary: ${payload.summary}`,
    `Budget: ~${payload.budget.estimatedTokens}/${payload.budget.maxTokens} tokens (UTF-8 bytes / 4 estimate)${payload.budget.truncated ? " (truncated; read full context artifact)" : ""}`,
    `Context: ${JSON.stringify(payload.context)}`];
  if (payload.delta) lines.push(`Delta: ${JSON.stringify(payload.delta)}`);
  if (payload.files.length) lines.push("Files:");
  for (const file of payload.files) {
    lines.push(`  ${file.path} (${Math.round(file.score * 100)}%) - ${file.reason}`);
    if (file.symbols.length) lines.push(`    Symbols: ${file.symbols.join(", ")}`);
  }
  if (payload.relatedFiles?.length) lines.push("Related files (indexed import graph):");
  for (const file of payload.relatedFiles ?? []) lines.push(`  ${file.path} - ${file.reason}`);
  if (payload.source?.length) lines.push("Source evidence (only indicated ranges):");
  for (const part of payload.source ?? []) lines.push(`${part.file}:${part.start}-${part.end}\n${part.text}`);
  if (payload.tests.length) lines.push("Tests:");
  for (const test of payload.tests) lines.push(`  ${test.path} - ${test.reason}`);
  if (payload.recentDiffs.length) lines.push("Recent Diffs:");
  for (const diff of payload.recentDiffs) if (diff) lines.push(`  ${diff.path} @ ${diff.commit} - ${diff.summary}`);
  if (payload.memory.length) lines.push("Memory:");
  for (const item of payload.memory) lines.push(`  ${item.id} [${item.kind}] ${item.summary}`);
  if (payload.risks.length) lines.push("Risks:");
  for (const risk of payload.risks) lines.push(`  - ${risk}`);
  return lines.join("\n");
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
  const symbolsByResolvedFile = new Map<string, string[]>();
  for (const item of resolvedSymbols) {
    const match = item.resolution?.bestMatch;
    if (!match) continue;
    symbolsByResolvedFile.set(match.path, unique([
      ...(symbolsByResolvedFile.get(match.path) ?? []),
      match.name,
    ]));
  }
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
  // Only narrow to symbols when every analyzed file is covered by a resolved
  // definition. An unknown name or an additional explicitly supplied file must
  // remain conservative and be treated as a whole-file change.
  const symbolScoped = inputFiles.length > 0 && inputFiles.every((file) => symbolsByResolvedFile.has(file));
  const directCallerFiles = new Set<string>();
  const symbolImporterFiles = new Set<string>();

  for (const file of inputFiles) {
    const dbFile = db.getFile(file);
    if (!dbFile) continue;
    const importers = db.getImportersOf(dbFile.id);
    const fileSymbols = unique(db.getSymbolsByFile(dbFile.id).map((symbol) => symbol.name)).slice(0, 8);
    // An explicitly named symbol is a narrower request than changing its entire
    // module. Falling back to every top-level symbol made a tiny method edit look
    // like a rewrite of a highly-imported core file.
    const relevantSymbols = symbolScoped
      ? symbolsByResolvedFile.get(file) ?? []
      : fileSymbols;
    for (const symbol of relevantSymbols) {
      for (const call of db.getCallersOf(symbol)) {
        const callerFile = indexedFiles.find((candidate) => candidate.id === call.file_id);
        if (!callerFile || callerFile.path === file) continue;
        if (!isTestFile(callerFile.path)) directCallerFiles.add(callerFile.path);
        upsertRanked(affected, {
          path: callerFile.path,
          kind: isTestFile(callerFile.path) ? "test_call_site" : "call_site",
          score: isTestFile(callerFile.path) ? 0.84 : 0.86,
          reason: `Calls ${symbol} at L${call.line}`,
        });
      }
    }
    if (importers.length > 0) reasons.push(`${file} has ${importers.length} importers`);
    for (const importer of importers) {
      const source = indexedFiles.find((candidate) => candidate.id === importer.source_file_id);
      if (!source) continue;
      const importedSymbols = parseJsonArray(importer.symbols_imported);
      const symbolOverlap = importedSymbols.filter((symbol) => relevantSymbols.includes(symbol));
      if (!isTestFile(source.path) && symbolOverlap.length > 0) symbolImporterFiles.add(source.path);
      upsertRanked(affected, {
        path: source.path,
        kind: isTestFile(source.path)
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
    const candidateMentionFiles = unique([
      ...importers.map((importer) => indexedFiles.find((candidate) => candidate.id === importer.source_file_id)?.path ?? "").filter(Boolean),
      ...targetTests.map((test) => test.path),
    ]);
    const exactMentions = await scanExactMentions(options.rootDir, candidateMentionFiles, relevantSymbols);
    for (const dependent of exactMentions) {
      if (dependent === file) continue;
      upsertRanked(affected, {
        path: dependent,
        kind: isTestFile(dependent) ? "symbol_test_match" : "symbol_reference",
        score: isTestFile(dependent) ? 0.78 : 0.58,
        reason: "Exact mention of target symbol in graph-related file",
      });
    }
  }

  const riskDetails = await Promise.all(inputFiles.map((file) => fileRisk(options.rootDir, file)));
  const totalImporters = riskDetails.reduce((sum, detail) => sum + detail.importers, 0);
  const totalChurn = options.includeRecentChurn === false ? 0 : riskDetails.reduce((sum, detail) => sum + detail.churn, 0);
  if (targetTests.length === 0) reasons.push("No nearby regression tests found");
  if (totalChurn > 0) reasons.push(`Recent churn count: ${totalChurn}`);
  const riskScope = symbolScoped ? "symbol" : "file";
  const fanOut = symbolScoped
    ? new Set([...directCallerFiles, ...symbolImporterFiles]).size
    : totalImporters;
  const blastRadius = symbolScoped
    ? new Set([...directCallerFiles, ...symbolImporterFiles]).size
    : affected.size;
  // A requested symbol name that resolved ambiguously (e.g. "search" matching a throwaway
  // local variable as readily as the real implementation) means everything computed below —
  // inputFiles, fanOut, blastRadius — may be built on the wrong file entirely. Don't let the
  // score present a confident-looking number in that case; a high riskScore built on a bad
  // resolution is worse than no score.
  const ambiguousResolutions = resolvedSymbols
    .filter((item) => item.resolution?.ambiguous)
    .map((item) => ({
      symbol: item.symbol,
      candidates: (item.resolution?.candidates ?? []).slice(0, 5).map((c) => ({
        path: c.path,
        line: c.line,
        kind: c.kind,
        score: c.score,
      })),
    }));
  const rawRiskScore = Math.min(
    0.95,
    (symbolScoped ? 0.12 : 0.24)
      + Math.min(fanOut, 12) * (symbolScoped ? 0.055 : 0.07)
      + (targetTests.length === 0 ? 0.12 : 0)
      + Math.min(totalChurn, 10) * 0.015
      + Math.min(blastRadius, 12) * 0.01,
  );
  const riskScore = ambiguousResolutions.length > 0 ? Math.min(rawRiskScore, 0.4) : rawRiskScore;
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
    ...(fanOut > 0 ? [`${fanOut} ${symbolScoped ? "symbol-level dependents" : "direct importers"}`] : []),
    ...(targetTests.length > 0 ? [`${targetTests.length} nearby tests`] : []),
    ...(blastRadius > 0 ? [`${blastRadius} structurally related files`] : []),
  ];
  const ambiguities = [
    ...resolvedSymbols
      .filter((item) => item.resolution?.ambiguous)
      .map((item) => `${item.symbol} resolved ambiguously`),
    ...(inputFiles.length === 0 ? ["no files resolved for impact analysis"] : []),
  ];
  const ambiguousWarning = ambiguousResolutions.length > 0
    ? `⚠ AMBIGUOUS: ${ambiguousResolutions.map((item) => `"${item.symbol}"`).join(", ")} did not resolve to a single definition — this report may be built on the wrong file. Disambiguate with resolve_symbol(file_context: ...) or pass "files" explicitly. `
    : "";
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
    riskScope,
    riskDrivers: {
      fanOut,
      directCallers: directCallerFiles.size,
      symbolImporters: symbolImporterFiles.size,
      wholeFileImporters: totalImporters,
      churn: totalChurn,
      nearbyTests: targetTests.length,
    },
    ambiguousResolutions,
    impactSummary: ambiguousWarning + (inputFiles.length > 0
      ? `Changes may affect ${affected.size} structurally related files around ${inputFiles.join(", ")}.`
      : "No files resolved for impact analysis."),
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
      `Risk Score: ${Math.round(payload.riskScore * 100)}%${payload.ambiguousResolutions.length > 0 ? " (capped — see ambiguity warning below)" : ""}`,
      `Risk scope: ${payload.riskScope}${payload.riskScope === "symbol" ? ` (${payload.publicSurface.join(", ") || "resolved symbol"})` : " (whole file)"}`,
      artifact ? `Artifact: ${artifact.id}` : "",
      "",
    ].filter(Boolean);
    if (payload.ambiguousResolutions.length > 0) {
      lines.push("⚠ AMBIGUOUS SYMBOL RESOLUTION — this report may be built on the wrong file:");
      for (const item of payload.ambiguousResolutions) {
        lines.push(`  "${item.symbol}" matched ${item.candidates.length} candidate(s):`);
        for (const c of item.candidates) lines.push(`    ${c.path}:L${c.line} [${c.kind}] (score ${c.score})`);
      }
      lines.push("  Disambiguate with resolve_symbol(file_context: ...) or pass \"files\" explicitly.");
      lines.push("");
    }
    lines.push(`Summary: ${payload.impactSummary}`, "", "Affected Files:");
    for (const file of payload.affectedFiles.slice(0, 12)) {
      lines.push(`  ${file.path} [${file.kind}] (${Math.round(file.score * 100)}%) - ${file.reason}`);
    }
    if (payload.affectedFiles.length > 12) {
      lines.push(`  ... and ${payload.affectedFiles.length - 12} more affected file(s) (full list in artifact ${artifact?.id ?? "n/a"})`);
    }
    if (payload.affectedTests.length > 0) {
      lines.push("");
      lines.push("Affected Tests:");
      for (const test of payload.affectedTests.slice(0, 8)) {
        lines.push(`  ${test.path} (${Math.round(test.score * 100)}%) - ${test.reason}`);
      }
      if (payload.affectedTests.length > 8) {
        lines.push(`  ... and ${payload.affectedTests.length - 8} more affected test(s)`);
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
  const identifierTop = search.identifiers?.results.slice(0, 5) ?? [];
  const identifierAnchorPaths = identifierTop
    .filter((item) => item.score >= 50 || item.keywordScore >= 80 || (item.semanticScore >= 60 && item.totalCalls >= 2))
    .map((item) => item.path);
  const baseScopeCandidates = (search.files?.results ?? []).slice(0, Math.max(maxFiles, 6)).map((file) => ({
    path: file.path,
    reason: `Scoped from semantic file matches (${Math.round(file.semanticScore)} semantic / ${Math.round(file.keywordScore)} keyword)`,
    score: file.score / 100,
    symbols: file.matchedSymbols,
  }));
  const { candidates: scopeCandidatesWithPrior } = await applyDirectoryPrior(options.rootDir, options.task, baseScopeCandidates);
  const rankedScopeFiles = await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.task,
    rerankPlanningFiles(scopeCandidatesWithPrior, options.task, exactIdentifierPaths),
  );
  const rankedPathList = rankedScopeFiles.map((file) => file.path);
  const orderedPaths = Array.from(new Set([...identifierAnchorPaths, ...rankedPathList]));
  const rankedByPath = new Map(rankedScopeFiles.map((file) => [file.path, file]));
  const identifierScoreByPath = new Map(identifierTop.map((item) => [item.path, item.score]));
  const limit = options.preferSmallestScope === false ? maxFiles : Math.min(maxFiles, 3);
  let recommendedScope = orderedPaths.slice(0, limit).map((path) => {
    const ranked = rankedByPath.get(path);
    const score = ranked?.score ?? ((identifierScoreByPath.get(path) ?? 60) / 100);
    return {
      path,
      action: "modify",
      confidence: Math.min(0.98, 0.45 + score),
    };
  });
  const tests = await findTestsForFiles(options.rootDir, recommendedScope.map((item) => item.path));
  const existingPaths = new Set(recommendedScope.map((item) => item.path));
  for (const test of tests.slice(0, 2)) {
    if (existingPaths.has(test.path)) continue;
    existingPaths.add(test.path);
    recommendedScope.push({
      path: test.path,
      action: "modify",
      confidence: Math.min(0.92, test.score),
    });
  }
  // Final dedupe pass: keep the highest-confidence row per path. Ranking may produce the same
  // path twice if both the file-search and identifier-search anchors include it.
  const dedupedScope = new Map<string, typeof recommendedScope[0]>();
  for (const row of recommendedScope) {
    const existing = dedupedScope.get(row.path);
    if (!existing || row.confidence > existing.confidence) dedupedScope.set(row.path, row);
  }
  recommendedScope = [...dedupedScope.values()];
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
    topK: 7,
    persistArtifact: false,
  });
  const exactIdentifierPaths = buildExactIdentifierPathSet(search, options.query);
  const baseBriefCandidates = (search.files?.results ?? []).slice(0, 10).map((item) => ({
    path: item.path,
    reason: `Decision candidate (${Math.round(item.semanticScore)} semantic / ${Math.round(item.keywordScore)} keyword)`,
    score: item.score / 100,
    symbols: item.matchedSymbols,
  }));
  const { candidates: briefCandidatesWithPrior } = await applyDirectoryPrior(options.rootDir, options.query, baseBriefCandidates);
  const rankedBriefFiles = await maybeChatRerankPlanningFiles(
    options.rootDir,
    options.query,
    rerankPlanningFiles(briefCandidatesWithPrior, options.query, exactIdentifierPaths),
  );
  const filesFromFileSearch = rankedBriefFiles.map((item) => item.path);
  const topIdentifiers = search.identifiers?.results.slice(0, 5) ?? [];
  const identifierResolvedFiles = topIdentifiers
    .filter((item) => item.score >= 50 || item.keywordScore >= 80 || (item.semanticScore >= 60 && item.totalCalls >= 2))
    .map((item) => item.path);
  const filesToReadFirstRaw = [...identifierResolvedFiles, ...filesFromFileSearch];
  const filesToReadFirst = Array.from(new Set(filesToReadFirstRaw)).slice(0, 4);
  const memory = options.includeMemory === false ? [] : await getProjectMemoryHits(options.rootDir, options.query, Math.min(options.maxMemory ?? 3, 10));
  const tests = options.includeTests === false ? [] : await findTestsForFiles(options.rootDir, filesToReadFirst);
  const hubs = options.includeHubs === false ? [] : await hubMatchesForFiles(options.rootDir, filesToReadFirst);
  const hotSymbols = topIdentifiers
    .filter((item) => item.totalCalls > 2)
    .map((item) => ({ name: item.name, totalCalls: item.totalCalls, path: item.path }));
  const noTestCoverage = filesToReadFirst.filter((path) => {
    if (isTestFile(path)) return false;
    const sourceBasename = path.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
    if (!sourceBasename) return true;
    return !tests.some((test) => {
      const testBasename = test.path.split("/").pop()?.replace(/\.(test|spec|demo)\.\w+$/, "") ?? "";
      return testBasename === sourceBasename;
    });
  });
  const openQuestions = [
    ...(tests.length === 0
      ? [`No nearby tests were found for ${filesToReadFirst.join(", ") || "the candidate files"}; which regression path validates this subsystem today?`]
      : noTestCoverage.length > 0
        ? [`${noTestCoverage.join(", ")} appears to have no direct test coverage — should we add one?`]
        : []),
    ...hotSymbols.map((item) => `Will the change to ${item.name} (${item.totalCalls} call sites in ${item.path}) preserve backward compatibility for all callers?`),
    ...(hubs.length === 0 && filesToReadFirst.length > 0
      ? [`No feature hub links ${filesToReadFirst[0]} — is this subsystem documented anywhere?`]
      : []),
    ...(rankedBriefFiles.length >= 2 && Math.abs((rankedBriefFiles[0]?.score ?? 0) - (rankedBriefFiles[1]?.score ?? 0)) < 0.06
      ? [`Top candidates (${rankedBriefFiles[0]?.path} vs ${rankedBriefFiles[1]?.path}) are close in score — confirm the intended target before editing.`]
      : []),
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
    ...(hotSymbols.length > 0 ? [`${hotSymbols.length} hot symbols with >2 callers`] : []),
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
    topSymbols: topIdentifiers.map((item) => item.name),
    hotSymbols,
    filesToReadFirst,
    doNotReadYet: filesFromFileSearch.filter((path) => !filesToReadFirst.includes(path)).slice(0, 4),
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
    if (payload.hotSymbols.length > 0) {
      lines.push("");
      lines.push("Hot Symbols (high call count):");
      for (const item of payload.hotSymbols) lines.push(`  ${item.name} — ${item.totalCalls} call sites in ${item.path}`);
    }
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
  const explicitFiles = unique(options.files ?? []);
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
  const pyProfile = await detectPythonProfile(options.rootDir);
  const inferredSources = editScopeRaw.recommendedScope.filter((item) => isSourcePath(item.path) && !isTestPath(item.path)).map((item) => item.path);
  const explicitSources = explicitFiles.filter((path) => isSourcePath(path) && !isTestPath(path));
  const sourceFiles = unique(explicitFiles.length ? explicitSources : inferredSources).slice(0, Math.max(maxFiles, explicitSources.length));
  const inferredTests = await findTestsForFiles(options.rootDir, sourceFiles);
  const explicitTests = explicitFiles
    .filter((path) => isTestPath(path))
    .map((path) => ({ path, reason: "Explicitly changed test file", score: 1 }));
  const testsByPath = new Map<string, { path: string; reason: string; score: number }>();
  for (const test of [...explicitTests, ...inferredTests]) {
    if (!testsByPath.has(test.path)) testsByPath.set(test.path, test);
  }
  const tests = [...testsByPath.values()].slice(0, Math.max(8, explicitTests.length));
  const testPaths = tests.map((test) => test.path);
  const checks: Array<{ type: string; command: string; reason: string }> = [];

  const hasPythonSources = sourceFiles.some((path) => path.endsWith(".py")) || testPaths.some((path) => path.endsWith(".py"));

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
  } else if (hasPythonSources && (pyProfile.hasPytestConfig || pyProfile.hasPyprojectToml)) {
    const pytestCmd = pythonRunCommand(pyProfile, "pytest", options.rootDir);
    const targets = testPaths.length > 0 ? ` ${testPaths.join(" ")}` : "";
    checks.push({
      type: "test",
      command: `${pytestCmd} -q${targets}`,
      reason: pyProfile.isUvManaged
        ? "Detected uv-managed Python project; pytest invoked via uv run."
        : pyProfile.hasVenv
          ? "Detected .venv; running pytest from the virtualenv binary."
          : pyProfile.isPoetryManaged
            ? "Detected poetry-managed Python project; pytest invoked via poetry run."
            : "Detected pyproject.toml with pytest configuration.",
    });
  }

  if (scripts.lint) {
    checks.push({
      type: "lint",
      command: "npm run lint",
      reason: "Project lint pass to catch type and style regressions around the edit scope.",
    });
  } else if (hasPythonSources && pyProfile.hasRuffConfig) {
    checks.push({
      type: "lint",
      command: `${pythonRunCommand(pyProfile, "ruff", options.rootDir)} check .`,
      reason: "Detected ruff configuration in pyproject.toml / ruff.toml.",
    });
  }

  if (scripts.build) {
    checks.push({
      type: "build",
      command: "npm run build",
      reason: "Project build verifies the edited modules still compile cleanly.",
    });
  }

  if (hasPythonSources && pyProfile.hasMypyConfig) {
    checks.push({
      type: "typecheck",
      command: `${pythonRunCommand(pyProfile, "mypy", options.rootDir)} .`,
      reason: "Detected mypy configuration in pyproject.toml / mypy.ini.",
    });
  }

  if (checks.length === 0) {
    checks.push({
      type: "manual",
      command: "Inspect nearest tests or run the project-standard validation command manually.",
      reason: "No safe script-level validation command could be inferred from the repository config.",
    });
  }

  const snapshot = await createValidationSnapshot(options.rootDir);
  const payload = {
    snapshot,
    execution: "recommendations only; run checks in the host and submit validation_record",
    repo: editScopeRaw.repo,
    freshness: editScopeRaw.freshness,
    trust: editScopeRaw.trust,
    task: options.task,
    explicitFiles,
    sourceFiles,
    tests: tests.slice(0, 8),
    optionalFiles: editScopeRaw.optionalScope,
    checks,
  };

  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Validate Scope: ${options.task}`,
      `Validation snapshot: ${snapshot.id} (checks have not been executed)`,
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
  const requestedEvidence: EvidenceFile[] = [], unavailableEvidence: string[] = [];
  if(options.sourceEvidence) requestedEvidence.push(...options.sourceEvidence);
  else for(const file of options.files ?? []) {
    const path=resolveProjectPath(options.rootDir,file);
    try { if((await stat(path)).isFile()) requestedEvidence.push({file}); else unavailableEvidence.push(file); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; unavailableEvidence.push(file); }
  }
  const configuration = requestedEvidence.length ? (await evidenceConfigurationFiles(options.rootDir)).map(file=>({file})) : [];
  const sourceEvidence = await bindEvidence(options.rootDir, [...requestedEvidence,...configuration.filter(item=>!requestedEvidence.some(ref=>ref.file===item.file))]);
  const supersedes = [...new Set(options.supersedes ?? [])];
  for (const id of supersedes) if (!db.getMemoryNode(id)) throw new Error(`Unknown superseded memory: ${id}`);
  const validation = await Promise.all((options.validationRefs ?? []).map(async id => ({ id, state: await validationState(options.rootDir, id) })));
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
    source_evidence: JSON.stringify(sourceEvidence),
    configuration_paths: JSON.stringify(configuration.map(item=>item.file)),
    validation_refs: JSON.stringify(options.validationRefs ?? []),
    unavailable_evidence: JSON.stringify(unavailableEvidence),
    open_risks: JSON.stringify(options.openRisks ?? []),
  };
  let embedding: number[] = [];
  try {
    [embedding] = await fetchEmbedding(contentParts.join("\n"));
  } catch {
    // Embedding provider unavailable — store node without vector; keyword search still works.
  }
  const node = {
    type: "note",
    label: `task:${options.task}:${randomUUID()}`,
    content: contentParts.join("\n"),
    metadata,
  } satisfies MemoryNodeInput;
  // Pre-check whether the task node already exists so we can report "Created N nodes" accurately.
  const taskWasNew = !db.findMemoryNodeByLabel("note", node.label);
  const taskMemoryId = db.transaction(() => {
    for(const id of supersedes) if(!db.getMemoryNode(id)) throw new Error(`Superseded memory disappeared: ${id}`);
    const id = db.upsertMemoryNode(node, embedding.length > 0 ? embedding : undefined);
    for (const previous of supersedes) db.upsertMemoryEdge({ source: previous, target: id, relation: "resolved_by", metadata: { relation_kind: "supersedes" } });
    return id;
  });
  const linkedNodes: string[] = [];
  const newlyCreatedNodes: string[] = [];
  for (const file of options.files ?? []) {
    const existingFileNode = db.findMemoryNodeByLabel("file", file);
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
    if (!existingFileNode) newlyCreatedNodes.push(fileNodeId);
    db.upsertMemoryEdge({
      source: taskMemoryId,
      target: fileNodeId,
      relation: "references",
      weight: weightForFileRole(file),
    });
    linkedNodes.push(fileNodeId);
  }
  const handoff = await persistArtifact({ rootDir: options.rootDir, kind: "handoff", key: taskMemoryId, immutable: true,
    payload: { task: options.task, completed: options.summary, remaining: options.openRisks ?? [], assumptions: options.assumptions ?? [], sourceEvidence, unavailableEvidence, validation, taskMemoryId } });
  const payload = {
    taskMemoryId,
    handoff,
    evidenceState: await memoryEvidenceStatus(options.rootDir, db.getMemoryNode(taskMemoryId)!),
    linkedNodes,
    newlyCreatedNodes,
    createdCount: newlyCreatedNodes.length + (taskWasNew ? 1 : 0),
    storedSummary: options.summary,
  };
  return formatMaybeJson(options.format, payload, () => {
    const lines = [
      `Task memory recorded: ${taskMemoryId}`,
      `Handoff: ${handoff.id}`,
      `Summary: ${options.summary}`,
      `Created: ${payload.createdCount} new node(s), ${linkedNodes.length} edge(s)`,
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
