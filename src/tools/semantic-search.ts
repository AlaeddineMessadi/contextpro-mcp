// Ollama-powered semantic search over file headers and symbol names
// Uses vector embeddings with cosine similarity for concept matching

import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import {
  fetchEmbedding,
  getEmbeddingBatchSize,
  deleteFileSearchEmbedding,
  SearchIndex,
  type SearchDocument,
  type SearchQueryOptions,
  type SearchResult,
} from "../core/embeddings.js";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";
import { resolveProjectPath } from "../core/path-guard.js";

const FILE_SEARCH_SOURCE_TYPE = "file_search_cache";
import { readFile, stat } from "fs/promises";
import { extname } from "path";

export interface SemanticSearchOptions {
  rootDir: string;
  query: string;
  preset?: "fast" | "balanced" | "exhaustive" | "semantic_only" | "keyword_only";
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
}

export interface SemanticCodeSearchData {
  query: string;
  results: SearchResult[];
}

let cachedIndex: SearchIndex | null = null;
let cachedRootDir: string | null = null;
let lastIndexTime = 0;

const INDEX_TTL_MS = 60000;
const TEXT_INDEX_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".geojson",
  ".csv",
  ".tsv",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".lock",
  ".env",
]);
const MAX_TEXT_DOC_CHARS = 4000;
const MAX_CODE_SEARCH_BODY_CHARS = 4000;
const DEFAULT_MAX_EMBED_FILE_SIZE = 50 * 1024;

function applySearchPreset(options: SemanticSearchOptions): SemanticSearchOptions {
  const preset = options.preset ?? "balanced";
  if (preset === "fast") {
    return {
      ...options,
      topK: options.topK ?? 5,
      semanticWeight: options.semanticWeight ?? 0.55,
      keywordWeight: options.keywordWeight ?? 0.45,
      minCombinedScore: options.minCombinedScore ?? 0.05,
    };
  }
  if (preset === "exhaustive") {
    return {
      ...options,
      topK: options.topK ?? 20,
      semanticWeight: options.semanticWeight ?? 0.62,
      keywordWeight: options.keywordWeight ?? 0.38,
      minCombinedScore: options.minCombinedScore ?? 0,
    };
  }
  if (preset === "semantic_only") {
    return {
      ...options,
      topK: options.topK ?? 5,
      semanticWeight: options.semanticWeight ?? 1,
      keywordWeight: options.keywordWeight ?? 0,
      requireSemanticMatch: options.requireSemanticMatch ?? true,
    };
  }
  if (preset === "keyword_only") {
    return {
      ...options,
      topK: options.topK ?? 5,
      semanticWeight: options.semanticWeight ?? 0,
      keywordWeight: options.keywordWeight ?? 1,
      requireKeywordMatch: options.requireKeywordMatch ?? true,
    };
  }
  return {
    ...options,
    topK: options.topK ?? 5,
    semanticWeight: options.semanticWeight ?? 0.72,
    keywordWeight: options.keywordWeight ?? 0.28,
  };
}

function isTextIndexCandidate(filePath: string): boolean {
  return TEXT_INDEX_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxEmbedFileSize(): number {
  return Math.max(1024, toIntegerOr(process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE, DEFAULT_MAX_EMBED_FILE_SIZE));
}

function extractPlainTextHeader(content: string): string {
  const lines = content.split("\n");
  const headerLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    headerLines.push(trimmed.slice(0, 120));
    if (headerLines.length >= 2) break;
  }
  return headerLines.join(" | ");
}

function buildCodeSearchBody(content: string): string {
  const selected: string[] = [];
  let charBudget = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length < 3) continue;
    const isPureSyntax = /^[\}\)\]\;,]+$/.test(trimmed);
    if (isPureSyntax) continue;
    const snippet = trimmed.slice(0, 180);
    selected.push(snippet);
    charBudget += snippet.length + 1;
    if (charBudget >= MAX_CODE_SEARCH_BODY_CHARS) break;
  }
  const summary = selected.join("\n");
  return (summary || content).slice(0, MAX_CODE_SEARCH_BODY_CHARS);
}

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function buildSearchDocumentForFile(rootDir: string, relativePath: string): Promise<SearchDocument | null> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolveProjectPath(rootDir, normalized, "search file");

  if (isTextIndexCandidate(fullPath)) {
    try {
      if ((await stat(fullPath)).size > getMaxEmbedFileSize()) return null;
      const raw = await readFile(fullPath, "utf-8");
      const content = raw.slice(0, MAX_TEXT_DOC_CHARS);
      return {
        path: normalized,
        header: extractPlainTextHeader(content),
        symbols: [],
        content,
      };
    } catch {
      return null;
    }
  }

  if (!isSupportedFile(fullPath)) return null;

  try {
    const analysis = await analyzeFile(fullPath);
    const raw = await readFile(fullPath, "utf-8");
    const flatSymbols = flattenSymbols(analysis.symbols);
    return {
      path: normalized,
      header: analysis.header,
      symbols: flatSymbols.map((s) => s.name),
      symbolEntries: flatSymbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.endLine,
        signature: s.signature,
      })),
      content: `${flatSymbols.map((s) => s.signature).join(" ")}\n${buildCodeSearchBody(raw)}`,
    };
  } catch {
    return null;
  }
}

async function buildSearchDocumentFromIndexedFile(rootDir: string, file: FileRow, symbols: SymbolRow[]): Promise<SearchDocument> {
  let sourceBody = "";
  try {
    if ((await stat(resolveProjectPath(rootDir, file.path, "indexed file"))).size <= getMaxEmbedFileSize()) {
      sourceBody = buildCodeSearchBody(await readFile(resolveProjectPath(rootDir, file.path, "indexed file"), "utf-8"));
    }
  } catch {}
  return {
    path: normalizeRelativePath(file.path),
    header: file.header ?? "",
    symbols: symbols.map((symbol) => symbol.name),
    symbolEntries: symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line_start,
      endLine: symbol.line_end ?? undefined,
      signature: symbol.signature ?? undefined,
    })),
    content: `${symbols.map((symbol) => symbol.signature ?? symbol.name).join(" ")}\n${sourceBody}`,
  };
}

async function buildSearchDocumentsFromDB(rootDir: string): Promise<SearchDocument[]> {
  const db = await getDB(rootDir);
  const files = db.getAllFiles();
  if (files.length === 0) return [];
  return Promise.all(files.map((file) => buildSearchDocumentFromIndexedFile(rootDir, file, db.getSymbolsByFile(file.id))));
}

async function buildIndex(rootDir: string): Promise<SearchIndex> {
  if (cachedIndex && cachedRootDir === rootDir && Date.now() - lastIndexTime < INDEX_TTL_MS) {
    return cachedIndex;
  }

  let docs = await buildSearchDocumentsFromDB(rootDir);
  if (docs.length === 0) {
    const entries = await walkDirectory({ rootDir, depthLimit: 0 });
    const files = entries.filter((e) => !e.isDirectory);
    docs = [];
    for (const file of files) {
      const doc = await buildSearchDocumentForFile(rootDir, file.relativePath);
      if (doc) docs.push(doc);
    }
  }

  const index = new SearchIndex();
  await index.index(docs, rootDir);
  cachedIndex = index;
  cachedRootDir = rootDir;
  lastIndexTime = Date.now();

  return index;
}

function queryTerms(query: string): string[] {
  return (query.match(/[A-Za-z0-9_]+/g) ?? []).map((term) => term.toLowerCase()).filter((term) => term.length > 1);
}

function hasTestIntent(query: string): boolean {
  return /\b(test|tests|spec|coverage|regression|assert|fixture)\b/i.test(query);
}

function isLikelyTestPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
  return /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(path)
    || /^test_[^/]+\.py$/.test(name)
    || /_test\.py$/.test(name);
}

function rankSearchResults(query: string, results: SearchResult[], topK: number | undefined): SearchResult[] {
  const queryWantsTests = hasTestIntent(query);
  return results
    .map((result) => {
      if (queryWantsTests || !isLikelyTestPath(result.path)) return result;
      return {
        ...result,
        score: Math.round(result.score * 8.2) / 10,
      };
    })
    .sort((a, b) => b.score - a.score || b.semanticScore - a.semanticScore || b.keywordScore - a.keywordScore || a.path.localeCompare(b.path))
    .slice(0, topK ?? 5);
}

async function fuseFtsMatches(rootDir: string, query: string, results: SearchResult[], topK: number | undefined, options: SemanticSearchOptions): Promise<SearchResult[]> {
  if (options.requireSemanticMatch) return results;
  const db = await getDB(rootDir);
  const ftsMatches = db.searchFileText(query, Math.max((topK ?? 5) * 4, 20));
  if (ftsMatches.length === 0) return results;
  const terms = queryTerms(query);
  const byPath = new Map(results.map((result) => [result.path, result]));

  for (let i = 0; i < ftsMatches.length; i++) {
    const match = ftsMatches[i];
    const lexicalScore = Math.max(45, 100 - i * 6);
    const existing = byPath.get(match.path);
    if (existing) {
      // Trust dampener: when semantic ≈ 0, cap the combined at 70 so the rolled-up label can
      // never show "high (100%)" on a pure-keyword hit. Keep the keyword component honest.
      const semantic = existing.semanticScore;
      const cap = semantic < 5 ? 70 : 100;
      byPath.set(match.path, {
        ...existing,
        score: Math.min(cap, Math.max(existing.score, Math.round((existing.score + lexicalScore * 0.18) * 10) / 10)),
        keywordScore: Math.max(existing.keywordScore, lexicalScore),
      });
      continue;
    }
    const file = db.getFile(match.path);
    if (!file) continue;
    const symbols = db.getSymbolsByFile(file.id);
    const matchedSymbols = symbols
      .filter((symbol) => terms.some((term) => symbol.name.toLowerCase().includes(term) || (symbol.signature ?? "").toLowerCase().includes(term)))
      .map((symbol) => symbol.name);
    // Synthetic FTS-only entry: semantic is genuinely zero so cap the headline score at 65.
    byPath.set(match.path, {
      path: match.path,
      score: Math.min(65, lexicalScore),
      semanticScore: 0,
      keywordScore: lexicalScore,
      header: file.header ?? "",
      matchedSymbols,
      matchedSymbolLocations: symbols
        .filter((symbol) => matchedSymbols.includes(symbol.name))
        .map((symbol) => `${symbol.name}@L${symbol.line_start}${symbol.line_end && symbol.line_end > symbol.line_start ? `-L${symbol.line_end}` : ""}`),
    });
  }

  return [...byPath.values()]
    .filter((result) => !options.requireKeywordMatch || result.keywordScore > 0)
    .filter((result) => options.minKeywordScore === undefined || result.keywordScore >= (options.minKeywordScore > 1 ? options.minKeywordScore : options.minKeywordScore * 100))
    .sort((a, b) => b.score - a.score || b.keywordScore - a.keywordScore || a.path.localeCompare(b.path))
    .slice(0, topK ?? 5);
}

export async function semanticCodeSearchResults(options: SemanticSearchOptions): Promise<SemanticCodeSearchData> {
  const resolvedOptions = applySearchPreset(options);
  const index = await buildIndex(options.rootDir);
  const searchOptions: SearchQueryOptions = {
    topK: resolvedOptions.topK,
    semanticWeight: resolvedOptions.semanticWeight,
    keywordWeight: resolvedOptions.keywordWeight,
    minSemanticScore: resolvedOptions.minSemanticScore,
    minKeywordScore: resolvedOptions.minKeywordScore,
    minCombinedScore: resolvedOptions.minCombinedScore,
    requireKeywordMatch: resolvedOptions.requireKeywordMatch,
    requireSemanticMatch: resolvedOptions.requireSemanticMatch,
  };
  const rawResults = await index.search(options.query, searchOptions);
  const fusedResults = await fuseFtsMatches(options.rootDir, options.query, rawResults, Math.max((searchOptions.topK ?? 5) * 2, 10), resolvedOptions);
  const results = rankSearchResults(options.query, fusedResults, searchOptions.topK);

  return {
    query: options.query,
    results,
  };
}

export async function semanticCodeSearch(options: SemanticSearchOptions): Promise<string> {
  const { query, results } = await semanticCodeSearchResults(options);

  if (results.length === 0) return "No matching files found for the given query.";

  const lines: string[] = [`Top ${results.length} hybrid matches for: "${query}"\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.path} (${r.score}% total)`);
    lines.push(`   Semantic: ${r.semanticScore}% | Keyword: ${r.keywordScore}%`);
    if (r.header) lines.push(`   Header: ${r.header}`);
    if (r.matchedSymbols.length > 0) lines.push(`   Matched symbols: ${r.matchedSymbols.join(", ")}`);
    if (r.matchedSymbolLocations.length > 0) lines.push(`   Definition lines: ${r.matchedSymbolLocations.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function invalidateSearchCache(): void {
  cachedIndex = null;
  cachedRootDir = null;
  lastIndexTime = 0;
}

export async function refreshFileSearchEmbeddings(options: { rootDir: string; relativePaths: string[] }): Promise<number> {
  const uniquePaths = Array.from(new Set(options.relativePaths.map(normalizeRelativePath).filter(Boolean)));
  if (uniquePaths.length === 0) return 0;

  const db = await getDB(options.rootDir);
  const existing = db.getEmbeddingsByType(FILE_SEARCH_SOURCE_TYPE);
  const existingMap = new Map(existing.map((r) => [r.sourceId, r.contentHash]));
  const pending: { path: string; hash: string; text: string }[] = [];

  for (const relativePath of uniquePaths) {
    const doc = await buildSearchDocumentForFile(options.rootDir, relativePath);
    if (!doc) {
      await deleteFileSearchEmbedding(options.rootDir, relativePath);
      continue;
    }

    const text = `${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
    const hash = hashContent(text);
    if (existingMap.get(relativePath) === hash) continue;
    pending.push({ path: relativePath, hash, text });
  }

  if (pending.length > 0) {
    const batchSize = getEmbeddingBatchSize();
    const entries: Array<{ sourceId: string; vector: number[]; hash: string }> = [];
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await fetchEmbedding(batch.map((entry) => entry.text));
      for (let j = 0; j < batch.length; j++) {
        entries.push({ sourceId: batch[j].path, vector: vectors[j], hash: batch[j].hash });
      }
    }
    db.upsertEmbeddingsBatch(FILE_SEARCH_SOURCE_TYPE, entries);
  }

  invalidateSearchCache();
  return pending.length;
}
