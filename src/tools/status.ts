// Project overview dashboard for instant agent orientation
// FEATURE: Status — file count, index state, memory stats, recent changes

import { walkDirectory } from "../core/walker.js";
import { isSupportedFile } from "../core/parser.js";
import { getDB } from "../core/db.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { extname } from "path";
import { loadProjectConfig } from "../core/project-config.js";
import { getIndexState } from "../core/context-metadata.js";
import { getToolTimingSnapshots } from "../core/tool-metrics.js";

const execFileAsync = promisify(execFile);

export interface StatusOptions {
  rootDir: string;
  format?: "text" | "json";
}

export interface StatusSnapshot {
  repo: {
    root: string;
    projectId: string | null;
    clientId: string | null;
    gitRoot: string | null;
    fingerprint: string | null;
  };
  files: {
    total: number;
    source: number;
    indexed: number;
    staleRemoved: number;
  };
  index: {
    generation: number;
    sourceFiles: number;
    missingIndexedFiles: number;
    removedIndexedFiles: number;
    lastIndexedAt: string | null;
    lastReindexAt: string | null;
    lastReindexDurationMs: number | null;
    autoHubCount: number | null;
    indexStartedAt: string | null;
    state: "empty" | "indexing" | "stale" | "fresh";
  };
  memory: {
    nodes: number;
    edges: number;
  };
  embeddings: {
    vectorTablesReady: boolean;
    dimension: number | null;
    total: number;
    fileSearch: number;
    identifiers: number;
    memory: number;
  };
  git: {
    branch: string;
    uncommitted: number;
    recentCommits: string[];
  };
  tools: {
    timings: ReturnType<typeof getToolTimingSnapshots>;
  };
  warnings: string[];
}

async function gitInfo(rootDir: string): Promise<{ branch: string; uncommitted: number; recentCommits: string[] }> {
  try {
    const { stdout: branch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: rootDir, timeout: 5000 });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: rootDir, timeout: 5000 });
    const uncommitted = status.trim().split("\n").filter((l) => l.trim()).length;
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline", "-5"], { cwd: rootDir, timeout: 5000 });
    const recentCommits = log.trim().split("\n").filter((l) => l.trim());
    return { branch: branch.trim(), uncommitted, recentCommits };
  } catch {
    return { branch: "unknown", uncommitted: 0, recentCommits: [] };
  }
}

function detectProjectType(files: { relativePath: string }[]): string {
  const exts = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f.relativePath).toLowerCase();
    if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const sorted = [...exts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([ext, count]) => `${ext} (${count})`).join(", ");

  const has = (ext: string) => exts.has(ext);
  let type = "Unknown";
  if (has(".ts") || has(".tsx")) type = "TypeScript";
  else if (has(".js") || has(".jsx")) type = "JavaScript";
  else if (has(".py")) type = "Python";
  else if (has(".rs")) type = "Rust";
  else if (has(".go")) type = "Go";
  else if (has(".java")) type = "Java";

  return `${type} — ${top}`;
}

export async function getStatusData(options: StatusOptions): Promise<StatusSnapshot> {
  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const allFiles = entries.filter((e) => !e.isDirectory);
  const sourceFiles = allFiles.filter((e) => isSupportedFile(e.path));

  const [db, git, config, indexState] = await Promise.all([
    getDB(options.rootDir),
    gitInfo(options.rootDir),
    loadProjectConfig(options.rootDir),
    getIndexState(options.rootDir),
  ]);
  const indexedFiles = db.getAllFiles().filter((file) => isSupportedFile(file.path));
  const graphStats = db.getGraphStats();
  const embeddingStats = db.getEmbeddingStats();
  const staleCount = indexedFiles.filter((f) => !allFiles.some((e) => e.relativePath === f.path)).length;
  const warnings: string[] = [];
  if (indexState.state === "empty") warnings.push("Index is empty. Run reindex to populate the database.");
  if (indexState.state === "indexing") warnings.push("Indexing is currently in progress. Waiting for completion is safer than reading partial state.");
  if (indexState.generation === 0 && indexedFiles.length > 0) warnings.push("Index generation is still 0, so the index cannot be treated as fresh.");
  if (indexState.missingIndexedFiles > 0) warnings.push(`${indexState.missingIndexedFiles} supported source files are not indexed yet.`);
  if (indexState.removedIndexedFiles > 0 || staleCount > 0) warnings.push(`${Math.max(indexState.removedIndexedFiles, staleCount)} indexed files no longer match the current workspace.`);
  if (indexState.state === "stale" && warnings.length === 0) warnings.push("Index is stale. Run reindex to refresh.");
  if (indexedFiles.length > 0 && embeddingStats.fileSearch === 0) {
    warnings.push("Semantic file embeddings are empty. Search/start_task will fall back to keyword ranking until an embedding model is reachable.");
  }

  return {
    repo: {
      root: options.rootDir,
      projectId: config?.projectId ?? null,
      clientId: config?.clientId ?? null,
      gitRoot: config?.gitRoot ?? null,
      fingerprint: config?.repoFingerprint ?? null,
    },
    files: {
      total: allFiles.length,
      source: sourceFiles.length,
      indexed: indexedFiles.length,
      staleRemoved: staleCount,
    },
    index: {
      generation: indexState.generation,
      sourceFiles: indexState.sourceFiles,
      missingIndexedFiles: indexState.missingIndexedFiles,
      removedIndexedFiles: indexState.removedIndexedFiles,
      lastIndexedAt: indexState.lastIndexedAt,
      lastReindexAt: indexState.lastReindexAt,
      lastReindexDurationMs: indexState.lastReindexDurationMs,
      autoHubCount: indexState.autoHubCount,
      indexStartedAt: indexState.indexStartedAt,
      state: indexState.state,
    },
    memory: {
      nodes: graphStats.totalNodes,
      edges: graphStats.totalEdges,
    },
    embeddings: embeddingStats,
    git,
    tools: {
      timings: getToolTimingSnapshots(options.rootDir),
    },
    warnings,
  };
}

export async function getStatus(options: StatusOptions): Promise<string> {
  const snapshot = await getStatusData(options);
  if (options.format === "json") {
    return JSON.stringify(snapshot, null, 2);
  }
  const projectType = detectProjectType((await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 })).filter((e) => !e.isDirectory));

  const lines = [
    `=== ContextPro Status ===`,
    ``,
    `Project: ${options.rootDir.split("/").pop()} (${projectType})`,
    `Project ID: ${snapshot.repo.projectId ?? "unknown"} | Client ID: ${snapshot.repo.clientId ?? "none"}`,
    `Git Root: ${snapshot.repo.gitRoot ?? "unknown"}`,
    `Fingerprint: ${snapshot.repo.fingerprint ?? "unknown"}`,
    `Branch: ${snapshot.git.branch}`,
    ``,
    `--- Files ---`,
    `Total files: ${snapshot.files.total}`,
    `Source files: ${snapshot.files.source}`,
    `Indexed in DB: ${snapshot.files.indexed}`,
    `Stale/removed: ${snapshot.files.staleRemoved}`,
    ``,
    `--- Index ---`,
    `Generation: ${snapshot.index.generation} | State: ${snapshot.index.state}`,
    `Source files: ${snapshot.index.sourceFiles} | Missing indexed: ${snapshot.index.missingIndexedFiles} | Removed indexed: ${snapshot.index.removedIndexedFiles}`,
    `Last indexed: ${snapshot.index.lastIndexedAt ?? "unknown"}`,
    `Index started: ${snapshot.index.indexStartedAt ?? "unknown"}`,
    `Last full reindex: ${snapshot.index.lastReindexAt ?? "unknown"} (${snapshot.index.lastReindexDurationMs ?? 0}ms)`,
    `Auto hubs: ${snapshot.index.autoHubCount ?? 0}`,
    ``,
    `--- Memory Graph ---`,
    `Nodes: ${snapshot.memory.nodes}`,
    `Edges: ${snapshot.memory.edges}`,
    ``,
    `--- Embeddings ---`,
    `Vector tables: ${snapshot.embeddings.vectorTablesReady ? "ready" : "not initialized"} | Dimension: ${snapshot.embeddings.dimension ?? "unknown"}`,
    `File search: ${snapshot.embeddings.fileSearch} | Identifiers: ${snapshot.embeddings.identifiers} | Memory: ${snapshot.embeddings.memory}`,
    ``,
    `--- Git ---`,
    `Uncommitted changes: ${snapshot.git.uncommitted}`,
    `Recent commits:`,
  ];

  for (const c of snapshot.git.recentCommits) lines.push(`  ${c}`);
  if (snapshot.tools.timings.length > 0) {
    lines.push("");
    lines.push("--- Tool Timings ---");
    for (const timing of snapshot.tools.timings.slice(0, 8)) {
      lines.push(`  ${timing.tool}: avg ${timing.avgMs}ms | last ${timing.lastMs}ms | calls ${timing.calls} | errors ${timing.errors}`);
    }
  }
  if (snapshot.warnings.length > 0) {
    lines.push(``);
    for (const warning of snapshot.warnings) lines.push(`⚠ ${warning}`);
  }

  return lines.join("\n");
}
