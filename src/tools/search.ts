// Unified semantic search over files, identifiers, or both (hybrid mode)
// FEATURE: Search — single entry point combining file and identifier search

import { semanticCodeSearch, invalidateSearchCache, type SemanticSearchOptions } from "./semantic-search.js";
import { semanticIdentifierSearch, invalidateIdentifierSearchCache, type SemanticIdentifierSearchOptions } from "./semantic-identifiers.js";

export { invalidateSearchCache, invalidateIdentifierSearchCache };

export type SearchMode = "file" | "identifier" | "hybrid";

export interface UnifiedSearchOptions {
  rootDir: string;
  query: string;
  mode?: SearchMode;
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

export async function unifiedSearch(options: UnifiedSearchOptions): Promise<string> {
  const mode = options.mode ?? "hybrid";

  if (mode === "file") {
    return semanticCodeSearch(options as SemanticSearchOptions);
  }

  if (mode === "identifier") {
    return semanticIdentifierSearch({
      rootDir: options.rootDir,
      query: options.query,
      topK: options.topK,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
    });
  }

  const [fileResults, identifierResults] = await Promise.all([
    semanticCodeSearch({
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
    semanticIdentifierSearch({
      rootDir: options.rootDir,
      query: options.query,
      topK: options.topK,
      topCallsPerIdentifier: options.topCallsPerIdentifier,
      includeKinds: options.includeKinds,
      semanticWeight: options.semanticWeight,
      keywordWeight: options.keywordWeight,
    }),
  ]);

  return `=== FILE MATCHES ===\n\n${fileResults}\n\n=== IDENTIFIER MATCHES ===\n\n${identifierResults}`;
}
