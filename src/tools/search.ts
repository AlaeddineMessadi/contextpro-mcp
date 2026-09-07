// Unified semantic search over files, identifiers, or both with metadata
// FEATURE: Search — single entry point for structured and text discovery

import { applySearchPreset, formatSemanticCodeSearchData, semanticCodeSearchResults, invalidateSearchCache, type SemanticSearchOptions, type SemanticCodeSearchData } from "./semantic-search.js";
import { formatSemanticIdentifierSearchData, semanticIdentifierSearchResults, invalidateIdentifierSearchCache, type SemanticIdentifierSearchOptions, type SemanticIdentifierSearchData } from "./semantic-identifiers.js";
import { quickRefresh } from "./reindex.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact, canonicalArtifactKey } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState, type FreshnessMetadata, type TrustMetadata } from "../core/context-metadata.js";
import { getDB } from "../core/db.js";
import { withQueryEmbeddingCache, matchesSearchConstraints, type SearchResult } from "../core/embeddings.js";

export { invalidateSearchCache, invalidateIdentifierSearchCache };

export type SearchMode = "file" | "identifier" | "hybrid";
export type SearchFormat = "text" | "json" | "compact";

export interface UnifiedSearchOptions {
  rootDir: string;
  query: string;
  mode?: SearchMode;
  preset?: "fast" | "balanced" | "exhaustive" | "semantic_only" | "keyword_only";
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
  expandCallers?: boolean;
  fusion?: "weighted" | "rrf";
  inlineCode?: "off" | "crux" | "full";
  profile?: boolean;
  includeDependencies?: boolean;
}

export interface TopResultBreakdown {
  path: string;
  semantic: number;
  keyword: number;
  combined: number;
  signal: "semantic-dominant" | "keyword-dominant" | "balanced" | "none";
  confidenceLabel: "high" | "medium" | "low";
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
  topResultBreakdown?: TopResultBreakdown;
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
  timingsMs?: Record<string, number>;
  dependencies?: Array<{ path: string; importedBy: string; symbols: string | null }>;
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

function computeTopBreakdown(input: {
  mode: SearchMode;
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
}): TopResultBreakdown | undefined {
  // Pick the single best result across whichever surfaces are present.
  const topFile = input.files?.results[0];
  const topId = input.identifiers?.results[0];
  let best: { path: string; semantic: number; keyword: number; combined: number } | null = null;
  if (topFile && (topFile.score ?? 0) >= (topId?.score ?? 0)) {
    best = { path: topFile.path, semantic: topFile.semanticScore, keyword: topFile.keywordScore, combined: topFile.score };
  } else if (topId) {
    best = { path: topId.path, semantic: topId.semanticScore, keyword: topId.keywordScore, combined: topId.score };
  } else if (topFile) {
    best = { path: topFile.path, semantic: topFile.semanticScore, keyword: topFile.keywordScore, combined: topFile.score };
  }
  if (!best) return undefined;

  const sem = best.semantic;
  const kw = best.keyword;
  let signal: TopResultBreakdown["signal"];
  if (sem < 5 && kw < 5) signal = "none";
  else if (sem < 5) signal = "keyword-dominant";
  else if (kw < 5) signal = "semantic-dominant";
  else if (Math.abs(sem - kw) > 35) signal = sem > kw ? "semantic-dominant" : "keyword-dominant";
  else signal = "balanced";

  // Confidence label is bound by min(semantic, keyword) so a keyword-only hit can't read "high".
  const minComponent = Math.min(sem, kw);
  let confidenceLabel: TopResultBreakdown["confidenceLabel"];
  if (minComponent >= 50) confidenceLabel = "high";
  else if (minComponent >= 20) confidenceLabel = "medium";
  else confidenceLabel = "low";

  return { ...best, signal, confidenceLabel };
}

function buildAmbiguities(input: {
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
}): string[] {
  const filesAllKeywordOnly = input.files
    && input.files.results.length > 0
    && input.files.results.every((result) => result.semanticScore <= 0);
  const identifiersAllKeywordOnly = input.identifiers
    && input.identifiers.results.length > 0
    && input.identifiers.results.every((result) => result.semanticScore <= 0);
  const topFile = input.files?.results[0];
  const topId = input.identifiers?.results[0];
  const topKeywordOnly = (topFile && topFile.semanticScore < 20 && topFile.keywordScore > 60)
    || (topId && topId.semanticScore < 20 && topId.keywordScore > 60);
  return [
    ...(input.files && input.files.results.length === 0 ? ["no file matches found"] : []),
    ...(input.identifiers && input.identifiers.results.length === 0 ? ["no identifier matches found"] : []),
    ...(topKeywordOnly
      ? [`top hit is keyword-only (semantic≈0); it matches the query text but may not be semantically relevant — verify before trusting`]
      : []),
    ...(filesAllKeywordOnly ? ["file search is keyword-only because semantic embeddings are unavailable or empty"] : []),
    ...(identifiersAllKeywordOnly ? ["identifier search is keyword-only because semantic embeddings are unavailable or empty"] : []),
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
  const semanticBackedScores = files.results
    .filter((result) => result.semanticScore > 40)
    .map((result) => result.score);
  const keywordOnlyCap = semanticBackedScores.length > 0
    ? Math.max(0, Math.min(...semanticBackedScores) - 0.01)
    : /^[A-Za-z_$][\w$]*$/.test(query.trim()) ? 100 : 65;

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
    // Keep exact-name evidence, but never let a zero-semantic result jump above a result with
    // strong semantic agreement. The keyword component remains honest at 100.
    const rawCombined = result.score + exactPathBoost + exactSymbolBoost;
    const cap = result.semanticScore < 15 ? keywordOnlyCap : 100;
    return {
      ...result,
      score: Math.min(cap, Math.round(rawCombined * 100) / 100),
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
      // A hit found only through the symbol table stays below every strong semantic result.
      score: keywordOnlyCap,
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

export function unifiedSearchData(options: UnifiedSearchOptions): Promise<UnifiedSearchData> {
  return withQueryEmbeddingCache(() => unifiedSearchDataUncached(options));
}

async function unifiedSearchDataUncached(options: UnifiedSearchOptions): Promise<UnifiedSearchData> {
  const started = performance.now();
  options = { ...options, ...applySearchPreset(options) };
  const refreshState = await quickRefresh(options.rootDir, { includeEmbeddings: false }).catch(() => ({ staleCount: 0, refreshed: false, indexingTimedOut: false }));
  const { staleCount, refreshed } = refreshState;
  const refreshedAt = performance.now();
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
      preset: options.preset,
      expandCallers: options.expandCallers,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
      minSemanticScore: options.minSemanticScore,
      minKeywordScore: options.minKeywordScore,
      minCombinedScore: options.minCombinedScore,
      requireKeywordMatch: options.requireKeywordMatch,
      requireSemanticMatch: options.requireSemanticMatch,
    });
  } else {
    [files, identifiers] = await Promise.all([
      semanticCodeSearchResults({
        rootDir: options.rootDir,
        query: options.query,
        preset: options.preset,
        topK: options.topK,
        semanticWeight: options.semanticWeight,
        keywordWeight: options.keywordWeight,
        minSemanticScore: options.minSemanticScore,
        minKeywordScore: options.minKeywordScore,
        minCombinedScore: options.minCombinedScore,
        requireKeywordMatch: options.requireKeywordMatch,
        requireSemanticMatch: options.requireSemanticMatch,
        fusion: options.fusion,
        inlineCode: options.inlineCode,
      }),
      semanticIdentifierSearchResults({
        rootDir: options.rootDir,
        query: options.query,
        topK: options.topK,
        preset: options.preset,
      expandCallers: options.expandCallers,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
        includeKinds: options.includeKinds,
        semanticWeight: options.semanticWeight,
        keywordWeight: options.keywordWeight,
        minSemanticScore: options.minSemanticScore,
        minKeywordScore: options.minKeywordScore,
        minCombinedScore: options.minCombinedScore,
        requireKeywordMatch: options.requireKeywordMatch,
        requireSemanticMatch: options.requireSemanticMatch,
      }),
    ]);
  }
  files = await applyExactSymbolFileBoosts(options.rootDir, options.query, files, undefined);
  if (files) files.results = files.results.filter((result) => matchesSearchConstraints(result, options)).slice(0, options.topK ?? 5);
  if (identifiers) identifiers.results = identifiers.results.filter((result) => matchesSearchConstraints(result, options)).slice(0, options.topK ?? 5);

  const evidence = buildEvidence({ mode, files, identifiers, freshness });
  const ambiguities = buildAmbiguities({ files, identifiers });
  const topResultBreakdown = computeTopBreakdown({ mode, files, identifiers });
  // Base confidence reflects the actual signal quality. A keyword-only top hit (semantic≈0)
  // can't read as high confidence — bound by min(semantic, keyword) of the top result.
  const hasResults = (files?.results.length ?? 0) > 0 || (identifiers?.results.length ?? 0) > 0;
  let baseConfidence: number;
  if (!hasResults) {
    baseConfidence = 0.32;
  } else if (topResultBreakdown) {
    const minComp = Math.min(topResultBreakdown.semantic, topResultBreakdown.keyword) / 100;
    // Map the min-component into a 0.4–0.85 band so we never over- or under-claim.
    baseConfidence = Math.max(0.4, Math.min(0.85, 0.4 + minComp * 0.5));
  } else {
    baseConfidence = 0.74;
  }
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
    topResultBreakdown,
    files,
    identifiers,
  };
  if (options.includeDependencies && files) {
    const db = await getDB(options.rootDir);
    const inventory = new Map(db.getAllFiles().map(file => [file.id, file]));
    const seen = new Set(files.results.map(file => file.path));
    const candidates: Array<{ path: string; importedBy: string; symbols: string | null; score: number }> = [];
    const terms = options.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const source of files.results.slice(0, 2)) {
      const file = db.getFile(source.path);
      if (!file) continue;
      for (const edge of db.getImportsFrom(file.id)) {
        const target = edge.target_file_id ? inventory.get(edge.target_file_id) : undefined;
        if (!target || seen.has(target.path)) continue;
        seen.add(target.path);
        const text = `${target.path} ${edge.symbols_imported ?? ""}`.toLowerCase();
        candidates.push({ path: target.path, importedBy: file.path, symbols: edge.symbols_imported, score: terms.filter(term => term.length > 2 && text.includes(term)).length });
      }
    }
    partial.dependencies = candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 3).map(({ score, ...item }) => item);
  }
  const retrievedAt = performance.now();

  let artifact = null;
  if (options.persistArtifact === true) {
    artifact = await persistArtifact({
      rootDir: options.rootDir,
      kind: "search",
      key: canonicalArtifactKey({
        query: options.query,
        mode,
        topK: options.topK ?? null,
        includeKinds: options.includeKinds ?? [],
      }),
      repoFingerprint: repo.fingerprint,
      projectId: repo.projectId,
      clientId: repo.clientId,
      indexGeneration: freshness.indexGeneration,
      metadata: {
        query: options.query,
        mode,
      },
      payload: partial,
    });
  }

  return {
    ...partial,
    ...(options.profile ? { timingsMs: { freshness: refreshedAt - started, retrievalAndRanking: retrievedAt - refreshedAt, artifact: performance.now() - retrievedAt, total: performance.now() - started } } : {}),
    trust: buildTrustMetadata({
      baseConfidence,
      freshness,
      evidence,
      ambiguities,
      artifact,
    }),
  };
}

function buildQualityBanner(data: UnifiedSearchData): string {
  const b = data.topResultBreakdown;
  if (!b) return "";
  // confidenceLabel is already bound by min(semantic, keyword) in computeTopBreakdown.
  let suffix = "";
  if (b.signal === "keyword-dominant" && b.semantic < 5) {
    suffix = ` — keyword-only (semantic=0); matches query text but may not be semantically relevant`;
  } else if (b.signal === "semantic-dominant" && b.keyword < 5) {
    suffix = ` — semantic-only (keyword=0); conceptual match, no literal token overlap`;
  } else {
    suffix = ` — ${b.signal}`;
  }
  return `Confidence: ${b.confidenceLabel} (top: ${Math.round(b.combined)}% combined, semantic=${Math.round(b.semantic)}%, keyword=${Math.round(b.keyword)}%)${suffix}\n\n`;
}

export async function unifiedSearch(options: UnifiedSearchOptions): Promise<string> {
  const data = await unifiedSearchData({
    ...options,
    inlineCode: options.inlineCode ?? "crux",
    persistArtifact: options.persistArtifact ?? options.format === "json",
  });
  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }
  if (options.format === "compact") {
    return JSON.stringify({
      query: data.query, mode: data.mode,
      freshness: data.freshness,
      confidence: data.topResultBreakdown,
      warnings: data.trust.ambiguities,
      ...(data.timingsMs ? { timingsMs: data.timingsMs } : {}),
      files: data.files?.results.map(({ path, score, inlineCode, matchedSymbolLocations }) => ({
        path, score, definitions: matchedSymbolLocations, code: inlineCode,
      })),
      identifiers: data.identifiers,
      dependencies: data.dependencies,
    });
  }

  const warning = data.freshness.warning ? `\n⚠ ${data.freshness.warning}\n\n` : "";
  const quality = buildQualityBanner(data);
  const dependencies = data.dependencies?.length ? `\nImport dependencies (pointers, not relevance claims):\n${data.dependencies.map(item => `  ${item.path} ← ${item.importedBy}`).join("\n")}\n` : "";
  if (data.mode === "file") {
    return warning + quality + formatSemanticCodeSearchData(data.files ?? { query: data.query, results: [] }) + dependencies;
  }
  if (data.mode === "identifier") {
    return warning + quality + formatSemanticIdentifierSearchData(data.identifiers ?? { query: data.query, results: [] }, options.includeKinds);
  }
  return `${warning}${quality}=== FILE MATCHES ===\n\n${formatSemanticCodeSearchData(data.files ?? { query: data.query, results: [] })}\n\n=== IDENTIFIER MATCHES ===\n\n${formatSemanticIdentifierSearchData(data.identifiers ?? { query: data.query, results: [] }, options.includeKinds)}${dependencies}`;
}
