// Compact repository map built from indexed files and top-level symbols
// FEATURE: RepoMap — low-token whole-repo outline for first-turn agent orientation

import { resolve } from "path";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact } from "../core/artifacts.js";
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
  if (path.startsWith("test/") || path.startsWith("demo/") || path.includes(".test.") || path.includes(".spec.")) return -8;
  return 0;
}

function scoreFileImportance(dbFile: FileRow, symbols: SymbolRow[], importsFromCount: number, importedByCount: number): number {
  const topLevelCount = symbols.filter((symbol) => symbol.parent_symbol_id === null).length;
  return importedByCount * 4 + importsFromCount * 2 + topLevelCount * 1.25 + Math.min(dbFile.symbol_count, 20) * 0.25 + fileRoleBoost(dbFile.path);
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
  const allFiles = db.getAllFiles()
    .filter((file) => !options.targetPath || file.path.startsWith(options.targetPath));

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
    effectiveMaxFiles = 40;
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

      return {
        path: file.path,
        header: file.header,
        symbolCount: file.symbol_count,
        importance: scoreFileImportance(file, symbols, importsFromCount, importedByCount),
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
