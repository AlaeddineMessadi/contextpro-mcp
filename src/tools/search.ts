// Unified semantic search over files, identifiers, or both with metadata
// FEATURE: Search — single entry point for structured and text discovery

import { semanticCodeSearch, semanticCodeSearchResults, invalidateSearchCache, type SemanticSearchOptions, type SemanticCodeSearchData } from "./semantic-search.js";
import { semanticIdentifierSearch, semanticIdentifierSearchResults, invalidateIdentifierSearchCache, type SemanticIdentifierSearchOptions, type SemanticIdentifierSearchData } from "./semantic-identifiers.js";
import { quickRefresh } from "./reindex.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState, type FreshnessMetadata, type TrustMetadata } from "../core/context-metadata.js";
import { getDB } from "../core/db.js";
import type { SearchResult } from "../core/embeddings.js";

export { invalidateSearchCache, invalidateIdentifierSearchCache };

export type SearchMode = "file" | "identifier" | "hybrid";
export type SearchFormat = "text" | "json";

export interface UnifiedSearchOptions {
  rootDir: string;
  query: string;
  mode?: SearchMode;
  format?: SearchFormat;
  topK?: number;
  topCallsPerIdentifier?: number;
  includeKinds?: string[];
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
  persistArtifact?: boolean;
}

export interface UnifiedSearchData {
  repo: {
    root: string;
    projectId: string | null;
    clientId: string | null;
    fingerprint: string | null;
  };
  query: string;
  mode: SearchMode;
  freshness: FreshnessMetadata;
  trust: TrustMetadata;
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
}

function buildEvidence(input: {
  mode: SearchMode;
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
  freshness: FreshnessMetadata;
}): string[] {
  return [
    ...(input.files && input.files.results.length > 0 ? [`${input.files.results.length} ranked file matches`] : []),
    ...(input.identifiers && input.identifiers.results.length > 0 ? [`${input.identifiers.results.length} ranked identifier matches`] : []),
    ...(input.freshness.refreshed && input.freshness.staleCount > 0 ? [`auto-refreshed ${input.freshness.staleCount} stale files`] : []),
    ...(input.freshness.indexGeneration > 0 ? [`index generation ${input.freshness.indexGeneration}`] : []),
    ...(input.mode === "hybrid" ? ["hybrid retrieval across files and identifiers"] : []),
  ];
}

function buildAmbiguities(input: {
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
}): string[] {
  return [
    ...(input.files && input.files.results.length === 0 ? ["no file matches found"] : []),
    ...(input.identifiers && input.identifiers.results.length === 0 ? ["no identifier matches found"] : []),
    ...(input.files && input.files.results.length > 1 && Math.abs(input.files.results[0].score - input.files.results[1].score) < 5
      ? ["top file matches are close in score"]
      : []),
    ...(input.identifiers && input.identifiers.results.length > 1 && Math.abs(input.identifiers.results[0].score - input.identifiers.results[1].score) < 8
      ? ["top identifier matches are close in score"]
      : []),
  ];
}

function extractIdentifierHints(query: string): string[] {
  const rawTokens = query.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const unique = new Map<string, string>();
  const queryTrimmed = query.trim();
  for (const token of rawTokens) {
    if (token.length < 3) continue;
    const looksIdentifier = /[A-Z_]/.test(token) || rawTokens.length === 1 || queryTrimmed === token;
    if (!looksIdentifier) continue;
    unique.set(token.toLowerCase(), token);
  }
  return [...unique.values()];
}

function formatLineRange(line: number, endLine: number | null): string {
  return endLine && endLine > line ? `L${line}-L${endLine}` : `L${line}`;
}

async function applyExactSymbolFileBoosts(
  rootDir: string,
  query: string,
  files: SemanticCodeSearchData | undefined,
  topK: number | undefined,
): Promise<SemanticCodeSearchData | undefined> {
  if (!files || files.results.length === 0) return files;
  const hints = extractIdentifierHints(query);
  if (hints.length === 0) return files;

  const db = await getDB(rootDir);
  const exactSymbols = hints.flatMap((hint) =>
    db.searchSymbolsByName(hint).filter((symbol) => symbol.name.toLowerCase() === hint.toLowerCase())
  );
  if (exactSymbols.length === 0) return files;

  const exactPaths = new Set<string>();
  const symbolLocationsByPath = new Map<string, string[]>();
  const symbolsByPath = new Map<string, string[]>();
  const allFiles = db.getAllFiles();

  for (const symbol of exactSymbols) {
    const file = allFiles.find((candidate) => candidate.id === symbol.file_id);
    if (!file) continue;
    exactPaths.add(file.path);
    const existingSymbols = symbolsByPath.get(file.path) ?? [];
    if (!existingSymbols.includes(symbol.name)) existingSymbols.push(symbol.name);
    symbolsByPath.set(file.path, existingSymbols);
    const existingLocations = symbolLocationsByPath.get(file.path) ?? [];
    existingLocations.push(`${symbol.name}@${formatLineRange(symbol.line_start, symbol.line_end)}`);
    symbolLocationsByPath.set(file.path, existingLocations);
  }

  const boosted: SearchResult[] = files.results.map((result) => {
    const matchedExactSymbols = (symbolsByPath.get(result.path) ?? []).filter((name) =>
      result.matchedSymbols.includes(name) || exactPaths.has(result.path)
    );
    const exactPathBoost = exactPaths.has(result.path) ? 25 : 0;
    const exactSymbolBoost = matchedExactSymbols.length > 0 ? 12 : 0;
    if (exactPathBoost === 0 && exactSymbolBoost === 0) return result;
    return {
      ...result,
      score: Math.min(100, Math.round((result.score + exactPathBoost + exactSymbolBoost) * 10) / 10),
      keywordScore: Math.min(100, Math.round(Math.max(result.keywordScore, matchedExactSymbols.length > 0 ? 96 : result.keywordScore) * 10) / 10),
      matchedSymbols: [...new Set([...matchedExactSymbols, ...result.matchedSymbols])],
      matchedSymbolLocations: [...new Set([...(symbolLocationsByPath.get(result.path) ?? []), ...result.matchedSymbolLocations])],
    };
  });

  const missingExactFiles = [...exactPaths].filter((path) => !boosted.some((result) => result.path === path));
  for (const path of missingExactFiles) {
    const dbFile = db.getFile(path);
    boosted.push({
      path,
      score: 99.9,
      semanticScore: 0,
      keywordScore: 100,
      header: dbFile?.header ?? "",
      matchedSymbols: symbolsByPath.get(path) ?? [],
      matchedSymbolLocations: symbolLocationsByPath.get(path) ?? [],
    });
  }

  return {
    ...files,
    results: boosted
      .sort((left, right) => right.score - left.score || right.keywordScore - left.keywordScore || left.path.localeCompare(right.path))
      .slice(0, topK ?? boosted.length),
  };
}

export async function unifiedSearchData(options: UnifiedSearchOptions): Promise<UnifiedSearchData> {
  const refreshState = await quickRefresh(options.rootDir).catch(() => ({ staleCount: 0, refreshed: false, indexingTimedOut: false }));
  const { staleCount, refreshed } = refreshState;
  const mode = options.mode ?? "hybrid";
  let staleWarning: string | null = null;
  if (refreshState.indexingTimedOut) {
    staleWarning = "Indexing is still in progress. Wait for it to finish before trusting search results.";
  } else if (staleCount > 15) {
    staleWarning = `${staleCount} files changed since last index. Run reindex for accurate results.`;
  } else if (refreshed && staleCount > 0) {
    staleWarning = `Auto-refreshed ${staleCount} stale files.`;
  }

  const [config, indexState] = await Promise.all([
    loadProjectConfig(options.rootDir),
    getIndexState(options.rootDir),
  ]);
  const freshness = buildFreshnessMetadata(indexState, {
    staleCount,
    refreshed,
    warning: staleWarning,
  });
  const repo = {
    root: options.rootDir,
    projectId: config?.projectId ?? null,
    clientId: config?.clientId ?? null,
    fingerprint: config?.repoFingerprint ?? null,
  };

  let files: SemanticCodeSearchData | undefined;
  let identifiers: SemanticIdentifierSearchData | undefined;

  if (mode === "file") {
    files = await semanticCodeSearchResults(options as SemanticSearchOptions);
  } else if (mode === "identifier") {
    identifiers = await semanticIdentifierSearchResults({
      rootDir: options.rootDir,
      query: options.query,
      topK: options.topK,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
    });
  } else {
    [files, identifiers] = await Promise.all([
      semanticCodeSearchResults({
        rootDir: options.rootDir,
        query: options.query,
        topK: options.topK,
        semanticWeight: options.semanticWeight,
        keywordWeight: options.keywordWeight,
        minSemanticScore: options.minSemanticScore,
        minKeywordScore: options.minKeywordScore,
        minCombinedScore: options.minCombinedScore,
        requireKeywordMatch: options.requireKeywordMatch,
        requireSemanticMatch: options.requireSemanticMatch,
      }),
      semanticIdentifierSearchResults({
        rootDir: options.rootDir,
        query: options.query,
        topK: options.topK,
        topCallsPerIdentifier: options.topCallsPerIdentifier,
        includeKinds: options.includeKinds,
        semanticWeight: options.semanticWeight,
        keywordWeight: options.keywordWeight,
      }),
    ]);
  }
  files = await applyExactSymbolFileBoosts(options.rootDir, options.query, files, options.topK);

  const evidence = buildEvidence({ mode, files, identifiers, freshness });
  const ambiguities = buildAmbiguities({ files, identifiers });
  const baseConfidence = (files?.results.length ?? 0) > 0 || (identifiers?.results.length ?? 0) > 0 ? 0.74 : 0.32;
  const partial: UnifiedSearchData = {
    repo,
    query: options.query,
    mode,
    freshness,
    trust: buildTrustMetadata({
      baseConfidence,
      freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    files,
    identifiers,
  };

  let artifact = null;
  if (options.persistArtifact === true) {
    artifact = await persistArtifact({
      rootDir: options.rootDir,
      kind: "search",
      key: JSON.stringify({
        query: options.query,
        mode,
        topK: options.topK ?? null,
        includeKinds: options.includeKinds ?? [],
      }),
      repoFingerprint: repo.fingerprint,
      projectId: repo.projectId,
      clientId: repo.clientId,
      metadata: {
        query: options.query,
        mode,
      },
      payload: partial,
    });
  }

  return {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence,
      freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
}

function qualityLabel(topScore: number): string {
  if (topScore >= 75) return "high";
  if (topScore >= 45) return "medium";
  return "low";
}

function buildQualityBanner(data: UnifiedSearchData): string {
  const topFileScore = data.files?.results[0]?.score ?? 0;
  const topIdScore = data.identifiers?.results[0]?.score ?? 0;
  const topScore = Math.max(topFileScore, topIdScore);
  if (topScore === 0) return "";
  const label = qualityLabel(topScore);
  return `Confidence: ${label} (top score: ${Math.round(topScore)}%)\n\n`;
}

export async function unifiedSearch(options: UnifiedSearchOptions): Promise<string> {
  const data = await unifiedSearchData({
    ...options,
    persistArtifact: options.persistArtifact ?? options.format === "json",
  });
  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }

  const warning = data.freshness.warning ? `\n⚠ ${data.freshness.warning}\n\n` : "";
  const quality = buildQualityBanner(data);
  if (data.mode === "file") {
    return warning + quality + await semanticCodeSearch(options as SemanticSearchOptions);
  }
  if (data.mode === "identifier") {
    return warning + quality + await semanticIdentifierSearch({
      rootDir: options.rootDir,
      query: options.query,
      topK: options.topK,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
    });
  }
  return `${warning}${quality}=== FILE MATCHES ===\n\n${await semanticCodeSearch(options as SemanticSearchOptions)}\n\n=== IDENTIFIER MATCHES ===\n\n${await semanticIdentifierSearch({
    rootDir: options.rootDir,
    query: options.query,
    topK: options.topK,
    topCallsPerIdentifier: options.topCallsPerIdentifier,
    includeKinds: options.includeKinds,
    semanticWeight: options.semanticWeight,
    keywordWeight: options.keywordWeight,
  })}`;
}
