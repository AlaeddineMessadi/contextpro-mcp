// Unified semantic search over files, identifiers, or both with metadata
// FEATURE: Search — single entry point for structured and text discovery

import { semanticCodeSearch, semanticCodeSearchResults, invalidateSearchCache, type SemanticSearchOptions, type SemanticCodeSearchData } from "./semantic-search.js";
import { semanticIdentifierSearch, semanticIdentifierSearchResults, invalidateIdentifierSearchCache, type SemanticIdentifierSearchOptions, type SemanticIdentifierSearchData } from "./semantic-identifiers.js";
import { quickRefresh } from "./reindex.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState, type FreshnessMetadata, type TrustMetadata } from "../core/context-metadata.js";

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

export async function unifiedSearchData(options: UnifiedSearchOptions): Promise<UnifiedSearchData> {
  const { staleCount, refreshed } = await quickRefresh(options.rootDir).catch(() => ({ staleCount: 0, refreshed: false }));
  const mode = options.mode ?? "hybrid";
  let staleWarning: string | null = null;
  if (staleCount > 15) {
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

export async function unifiedSearch(options: UnifiedSearchOptions): Promise<string> {
  const data = await unifiedSearchData({
    ...options,
    persistArtifact: options.persistArtifact ?? options.format === "json",
  });
  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }

  const warning = data.freshness.warning ? `\n⚠ ${data.freshness.warning}\n\n` : "";
  if (data.mode === "file") {
    return warning + await semanticCodeSearch(options as SemanticSearchOptions);
  }
  if (data.mode === "identifier") {
    return warning + await semanticIdentifierSearch({
      rootDir: options.rootDir,
      query: options.query,
      topK: options.topK,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
    });
  }
  return `${warning}=== FILE MATCHES ===\n\n${await semanticCodeSearch(options as SemanticSearchOptions)}\n\n=== IDENTIFIER MATCHES ===\n\n${await semanticIdentifierSearch({
    rootDir: options.rootDir,
    query: options.query,
    topK: options.topK,
    topCallsPerIdentifier: options.topCallsPerIdentifier,
    includeKinds: options.includeKinds,
    semanticWeight: options.semanticWeight,
    keywordWeight: options.keywordWeight,
  })}`;
}
