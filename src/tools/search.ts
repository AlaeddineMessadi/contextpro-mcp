// Unified semantic search over files, identifiers, or both with metadata
// FEATURE: Search — single entry point for structured and text discovery

import { semanticCodeSearch, semanticCodeSearchResults, invalidateSearchCache, type SemanticSearchOptions, type SemanticCodeSearchData } from "./semantic-search.js";
import { semanticIdentifierSearch, semanticIdentifierSearchResults, invalidateIdentifierSearchCache, type SemanticIdentifierSearchOptions, type SemanticIdentifierSearchData } from "./semantic-identifiers.js";
import { quickRefresh } from "./reindex.js";
import { loadProjectConfig } from "../core/project-config.js";

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
  freshness: {
    staleCount: number;
    refreshed: boolean;
    warning: string | null;
  };
  files?: SemanticCodeSearchData;
  identifiers?: SemanticIdentifierSearchData;
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
  const config = await loadProjectConfig(options.rootDir);

  if (mode === "file") {
    return {
      repo: {
        root: options.rootDir,
        projectId: config?.projectId ?? null,
        clientId: config?.clientId ?? null,
        fingerprint: config?.repoFingerprint ?? null,
      },
      query: options.query,
      mode,
      freshness: { staleCount, refreshed, warning: staleWarning },
      files: await semanticCodeSearchResults(options as SemanticSearchOptions),
    };
  }

  if (mode === "identifier") {
    return {
      repo: {
        root: options.rootDir,
        projectId: config?.projectId ?? null,
        clientId: config?.clientId ?? null,
        fingerprint: config?.repoFingerprint ?? null,
      },
      query: options.query,
      mode,
      freshness: { staleCount, refreshed, warning: staleWarning },
      identifiers: await semanticIdentifierSearchResults({
        rootDir: options.rootDir,
        query: options.query,
        topK: options.topK,
        topCallsPerIdentifier: options.topCallsPerIdentifier,
        includeKinds: options.includeKinds,
        semanticWeight: options.semanticWeight,
        keywordWeight: options.keywordWeight,
      }),
    };
  }

  const [fileResults, identifierResults] = await Promise.all([
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

  return {
    repo: {
      root: options.rootDir,
      projectId: config?.projectId ?? null,
      clientId: config?.clientId ?? null,
      fingerprint: config?.repoFingerprint ?? null,
    },
    query: options.query,
    mode,
    freshness: { staleCount, refreshed, warning: staleWarning },
    files: fileResults,
    identifiers: identifierResults,
  };
}

export async function unifiedSearch(options: UnifiedSearchOptions): Promise<string> {
  const data = await unifiedSearchData(options);
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
