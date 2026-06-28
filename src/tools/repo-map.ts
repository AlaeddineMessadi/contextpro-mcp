// Compact repository map built from indexed files and top-level symbols
// FEATURE: RepoMap — low-token whole-repo outline for first-turn agent orientation

import { resolve } from "path";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact } from "../core/artifacts.js";
import { computePageRank } from "../core/pagerank.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState, type TrustMetadata, type FreshnessMetadata } from "../core/context-metadata.js";

export interface RepoMapOptions {
  rootDir: string;
  targetPath?: string;
  includeSignatures?: boolean;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
  maxTokens?: number;
  format?: "text" | "json";
}

export interface RepoMapFileEntry {
  path: string;
  header: string | null;
  symbolCount: number;
  importance: number;
  /** Normalized PageRank centrality over the import graph (0–100). */
  pageRank: number;
  importsFromCount: number;
  importedByCount: number;
  symbols: Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number | null;
    signature: string | null;
  }>;
}

export interface RepoMapData {
  repo: {
    root: string;
    targetPath: string | null;
    projectId: string | null;
    clientId: string | null;
    fingerprint: string | null;
  };
  summary: {
    totalIndexedFiles: number;
    returnedFiles: number;
    includeSignatures: boolean;
  };
  freshness: FreshnessMetadata;
  trust: TrustMetadata;
  files: RepoMapFileEntry[];
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function fileRoleBoost(path: string): number {
  if (path === "src/index.ts") return 20;
  if (/\/(index|main|app|server|cli)\.[a-z]+$/i.test(path)) return 12;
  if (path.startsWith("src/tools/")) return 8;
  if (path.startsWith("src/core/")) return -2;
  if (
    path.startsWith("test/") || path.startsWith("tests/") || path.startsWith("demo/") ||
    path.includes(".test.") || path.includes(".spec.") || path.includes(".demo.") ||
    path.endsWith("/test_*.py") || /\/test_[^/]+\.py$/.test(path) || /_test\.go$/.test(path)
  ) return -20;
  if (path.includes("scripts/") || path.includes("/scripts")) return -6;
  return 0;
}

function docstringBoost(dbFile: FileRow): number {
  // Files with a real 2-line header docstring are more useful to surface in a repo map than
  // files with a generic or missing header.
  const header = (dbFile.header ?? "").trim();
  if (header.length === 0) return -3;
  if (header.length < 20) return 0;
  return 2;
}

function scoreFileImportance(
  dbFile: FileRow,
  symbols: SymbolRow[],
  importsFromCount: number,
  importedByCount: number,
  pageRankBoost: number,
): number {
  const topLevelCount = symbols.filter((symbol) => symbol.parent_symbol_id === null).length;
  // PageRank captures TRANSITIVE importance over the import graph (a file depended
  // on by important files, not just by many files). It dominates the local degree
  // terms, which are kept as a small tie-breaker. The role/docstring boosts encode
  // priors PageRank can't see (entry points up, test files down).
  return (
    pageRankBoost +
    importedByCount * 1.5 +
    importsFromCount * 0.5 +
    topLevelCount * 1.5 +
    Math.min(dbFile.symbol_count, 20) * 0.3 +
    fileRoleBoost(dbFile.path) +
    docstringBoost(dbFile)
  );
}

function formatSymbolLine(symbol: RepoMapFileEntry["symbols"][number], includeSignatures: boolean): string {
  const lineRange = symbol.endLine && symbol.endLine > symbol.line ? `L${symbol.line}-L${symbol.endLine}` : `L${symbol.line}`;
  if (includeSignatures && symbol.signature) {
    return `  ${symbol.kind}: ${symbol.signature} (${lineRange})`;
  }
  return `  ${symbol.kind}: ${symbol.name} (${lineRange})`;
}

export async function getRepoMapData(options: RepoMapOptions): Promise<RepoMapData> {
  const [db, config, indexState] = await Promise.all([
    getDB(options.rootDir),
    loadProjectConfig(options.rootDir),
    getIndexState(options.rootDir),
  ]);
  const everyFile = db.getAllFiles();
  const allFiles = everyFile
    .filter((file) => !options.targetPath || file.path.startsWith(options.targetPath));

  // Compute PageRank over the WHOLE import graph (not just the target subtree) so
  // transitive importance from outside the subtree still counts. Edge source→target
  // means "source imports target", so rank flows toward heavily-depended-on files.
  // When a targetPath is given, personalize toward that subtree to pull rank into it.
  const idToPath = new Map<number, string>(everyFile.map((file) => [file.id, file.path]));
  const edges: Array<[string, string]> = [];
  for (const file of everyFile) {
    for (const imp of db.getImportsFrom(file.id)) {
      const targetPath = imp.target_file_id != null ? idToPath.get(imp.target_file_id) : undefined;
      if (targetPath) edges.push([file.path, targetPath]);
    }
  }
  const personalization = options.targetPath
    ? new Set(allFiles.map((file) => file.path))
    : undefined;
  const rawRanks = computePageRank(everyFile.map((file) => file.path), edges, { personalization });
  // Normalize to 0–100 against the max rank so the boost is scale-stable across
  // repos of any size (PageRank values shrink as node count grows).
  const maxRank = Math.max(...rawRanks.values(), Number.EPSILON);
  const pageRankScore = (path: string): number => Math.round((100 * (rawRanks.get(path) ?? 0)) / maxRank);

  // Compute an effective file budget. If max_tokens is set and max_files wasn't, scale breadth
  // proportionally so repo_map can actually surface a meaningful coverage on large repos.
  // Heuristic: ~120 tokens per file row (path + header + ~6 signatures truncated), so
  // budget = max_tokens / 120, clamped to [8, 400]. The user can still override with max_files.
  // The floor is intentionally low (8) so small token budgets actually reduce breadth instead of
  // landing on the same 40-file response as larger budgets.
  let effectiveMaxFiles: number;
  if (options.maxFiles !== undefined) {
    effectiveMaxFiles = Math.max(1, options.maxFiles);
  } else if (options.maxTokens !== undefined) {
    const TOKENS_PER_FILE_ESTIMATE = 120;
    effectiveMaxFiles = Math.max(8, Math.min(400, Math.floor(options.maxTokens / TOKENS_PER_FILE_ESTIMATE)));
  } else {
    // No budget given: cover ~60% of the project (capped at 80 files) so the default map is
    // genuinely useful for orientation rather than truncating at a flat 40.
    effectiveMaxFiles = Math.max(40, Math.min(80, Math.ceil(allFiles.length * 0.6)));
  }

  const files = allFiles
    .map((file) => {
      const symbols = db.getSymbolsByFile(file.id);
      const topLevelSymbols = symbols
        .filter((symbol) => symbol.parent_symbol_id === null)
        .sort((left, right) => left.line_start - right.line_start)
        .slice(0, options.maxSymbolsPerFile ?? 8)
        .map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line_start,
          endLine: symbol.line_end,
          signature: symbol.signature,
        }));
      const importsFromCount = db.getImportsFrom(file.id).length;
      const importedByCount = db.getImportersOf(file.id).length;
      const pageRank = pageRankScore(file.path);

      return {
        path: file.path,
        header: file.header,
        symbolCount: file.symbol_count,
        importance: scoreFileImportance(file, symbols, importsFromCount, importedByCount, pageRank),
        pageRank,
        importsFromCount,
        importedByCount,
        symbols: topLevelSymbols,
      } satisfies RepoMapFileEntry;
    })
    .sort((left, right) => right.importance - left.importance || left.path.localeCompare(right.path))
    .slice(0, effectiveMaxFiles);

  const freshness = buildFreshnessMetadata(indexState, {
    staleCount: 0,
    refreshed: false,
    warning: indexState.state === "empty"
      ? "Index is empty. Run reindex to populate the repository map."
      : indexState.state === "indexing"
        ? "Indexing is still in progress. Wait for completion before trusting the repository map."
        : indexState.state === "stale"
          ? "Index is stale relative to the workspace. Run reindex for a truthful repository map."
          : null,
  });
  const evidence = [
    `${allFiles.length} indexed files available`,
    `${files.length} high-importance files returned`,
    ...(indexState.autoHubCount && indexState.autoHubCount > 0 ? [`${indexState.autoHubCount} auto-generated hubs available`] : []),
  ];
  const ambiguities = [
    ...(files.length === 0 ? ["no indexed source files available"] : []),
    ...(files.length > 1 && Math.abs(files[0].importance - files[1].importance) < 4 ? ["top repo map entries are close in importance"] : []),
  ];
  const partial: RepoMapData = {
    repo: {
      root: resolve(options.rootDir),
      targetPath: options.targetPath ?? null,
      projectId: config?.projectId ?? null,
      clientId: config?.clientId ?? null,
      fingerprint: config?.repoFingerprint ?? null,
    },
    summary: {
      totalIndexedFiles: allFiles.length,
      returnedFiles: files.length,
      includeSignatures: options.includeSignatures !== false,
    },
    freshness,
    trust: buildTrustMetadata({
      baseConfidence: files.length > 0 ? 0.77 : 0.28,
      freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    files,
  };
  const artifact = await persistArtifact({
    rootDir: options.rootDir,
    kind: "repo_map",
    key: JSON.stringify({
      targetPath: options.targetPath ?? null,
      includeSignatures: options.includeSignatures !== false,
      maxFiles: options.maxFiles ?? 40,
      maxSymbolsPerFile: options.maxSymbolsPerFile ?? 8,
    }),
    repoFingerprint: partial.repo.fingerprint,
    projectId: partial.repo.projectId,
    clientId: partial.repo.clientId,
    metadata: {
      targetPath: options.targetPath ?? "",
    },
    payload: partial,
  });

  return {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: files.length > 0 ? 0.77 : 0.28,
      freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
}

export async function getRepoMap(options: RepoMapOptions): Promise<string> {
  const data = await getRepoMapData(options);
  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }

  const includeSignatures = options.includeSignatures !== false;
  const maxTokens = options.maxTokens ?? 2000;
  const lines = [
    `=== Repo Map ===`,
    `Root: ${data.repo.root}`,
    `Indexed files: ${data.summary.totalIndexedFiles} | Returned: ${data.summary.returnedFiles}`,
    data.trust.artifact ? `Artifact: ${data.trust.artifact.id}` : "",
    "",
  ].filter(Boolean);

  for (const file of data.files) {
    lines.push(`${file.path}${file.header ? ` | ${file.header}` : ""}`);
    for (const symbol of file.symbols) {
      lines.push(formatSymbolLine(symbol, includeSignatures));
    }
    lines.push("");

    if (estimateTokens(lines.join("\n")) > maxTokens) {
      lines.push(`[truncated to fit ${maxTokens} tokens]`);
      break;
    }
  }

  return lines.join("\n");
}
