// Identifier-level semantic retrieval with call-site ranking and line metadata
// FEATURE: Symbol intelligence via semantic search over definitions and usages

import { readFile } from "fs/promises";
import { walkDirectory } from "../core/walker.js";
import { analyzeFile, analyzeContent, flattenSymbols, isSupportedFile } from "../core/parser.js";
import {
  fetchEmbedding,
  fetchQueryEmbedding,
  getEmbeddingBatchSize,
  type EmbeddingCache,
} from "../core/embeddings.js";
import { getDB, bufferToVec, hashContent as hashSource } from "../core/db.js";
import { resolve } from "path";
import { maskSourceText } from "../core/source-mask.js";

const IDENTIFIER_SOURCE_TYPE = "identifier_cache";

async function loadIdentifierCache(rootDir: string): Promise<EmbeddingCache> {
  const db = await getDB(rootDir);
  const rows = db.getEmbeddingsByType(IDENTIFIER_SOURCE_TYPE);
  const cache: EmbeddingCache = {};
  for (const r of rows) {
    cache[r.sourceId] = { hash: r.contentHash, vector: bufferToVec(r.vector) };
  }
  return cache;
}

async function saveIdentifierCache(rootDir: string, cache: EmbeddingCache, dirtyKeys: Set<string>): Promise<void> {
  if (dirtyKeys.size === 0) return;
  const db = await getDB(rootDir);
  const entries: Array<{ sourceId: string; vector: number[]; hash: string }> = [];
  for (const key of dirtyKeys) {
    const entry = cache[key];
    if (entry) entries.push({ sourceId: key, vector: entry.vector, hash: entry.hash });
  }
  db.upsertEmbeddingsBatch(IDENTIFIER_SOURCE_TYPE, entries);
}

export interface SemanticIdentifierSearchOptions {
  rootDir: string;
  query: string;
  preset?: "fast" | "balanced" | "exhaustive" | "semantic_only" | "keyword_only";
  expandCallers?: boolean;
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

export interface IdentifierCallSiteResult {
  file: string;
  line: number;
  context: string;
  semanticScore: number;
  keywordScore: number;
  score: number;
}

export interface SemanticIdentifierHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
  score: number;
  semanticScore: number;
  keywordScore: number;
  calls: IdentifierCallSiteResult[];
  totalCalls: number;
}

export interface SemanticIdentifierSearchData {
  query: string;
  results: SemanticIdentifierHit[];
}

interface IdentifierDoc {
  id: string;
  path: string;
  header: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
  text: string;
}

interface RankedIdentifier {
  doc: IdentifierDoc;
  semanticScore: number;
  keywordScore: number;
  score: number;
}

interface CallSite {
  file: string;
  line: number;
  context: string;
  semanticScore: number;
  keywordScore: number;
  score: number;
}

interface IdentifierIndex {
  docs: IdentifierDoc[];
  vectors: number[][];
  fileLines: Map<string, string[]>;
  fileCodeLines: Map<string, string[]>;
}

const CALLSITE_CACHE_PREFIX = "callsite:";
const INDEX_TTL_MS = 60_000;
const TRIVIAL_IDENTIFIER_NAMES = new Set([
  "data", "result", "results", "score", "value", "values", "item", "items", "temp", "tmp", "index", "idx", "key", "obj", "res", "err", "i", "j", "k",
]);

let cachedRootDir: string | null = null;
let cachedAt = 0;
let cachedGeneration = -1;
let cachedLexicalOnly = false;
let cachedIndex: IdentifierIndex | null = null;

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

function extractIdentifierHints(query: string): Set<string> {
  const rawTokens = query.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const queryTrimmed = query.trim();
  return new Set(
    rawTokens
      .filter((token) => token.length >= 3)
      .filter((token) => /[A-Z_]/.test(token) || rawTokens.length === 1 || queryTrimmed === token)
      .map((token) => token.toLowerCase()),
  );
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function formatLineRange(line: number, endLine: number): string {
  return endLine > line ? `L${line}-L${endLine}` : `L${line}`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getKeywordCoverage(queryTerms: Set<string>, input: string): number {
  if (queryTerms.size === 0) return 0;
  const docTerms = new Set(splitTerms(input));
  let matched = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matched++;
  }
  return matched / queryTerms.size;
}

function isDefinitionLine(line: string, symbolName: string): boolean {
  const escaped = escapeRegex(symbolName);
  const patterns = [
    new RegExp(`(?:function|class|enum|interface|struct|type|trait|fn|def|func)\\s+${escaped}`),
    new RegExp(`(?:const|let|var|pub|export)\\s+(?:async\\s+)?(?:function\\s+)?${escaped}`),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function normalizeKinds(kinds?: string[]): Set<string> | null {
  if (!kinds || kinds.length === 0) return null;
  const normalized = kinds.map((k) => k.trim().toLowerCase()).filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function removeFileScopedCacheEntries(cache: EmbeddingCache, relativePath: string): void {
  const definitionPrefix = `id:${relativePath}:`;
  const callsitePrefix = `${CALLSITE_CACHE_PREFIX}${relativePath}:`;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(definitionPrefix) || key.startsWith(callsitePrefix)) {
      delete cache[key];
    }
  }
}

const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);

interface IndexableInput {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature?: string | null;
  parentName?: string | null;
}

function isIndexableSymbol(
  symbol: IndexableInput,
  structuralRanges: Array<{ start: number; end: number }>,
  sourceLines?: string[],
): boolean {
  if (STRUCTURAL_KINDS.has(symbol.kind)) return true;
  if (symbol.kind !== "const" && symbol.kind !== "variable") return false;
  const sig = symbol.signature ?? "";
  // Check both the signature AND the raw source line for `export `. Tree-sitter strips the
  // leading `export ` keyword from node.text when emitting a `lexical_declaration` signature,
  // so we must consult the source directly to detect exported top-level consts.
  if (/^export\s/.test(sig)) return true;
  if (sourceLines && symbol.line >= 1 && symbol.line <= sourceLines.length) {
    const rawLine = sourceLines[symbol.line - 1] ?? "";
    if (/^\s*export\s/.test(rawLine)) return true;
  }
  if (symbol.parentName) return false;
  // Line-containment check: const inside a structural range is a local.
  for (const range of structuralRanges) {
    if (symbol.line > range.start && symbol.line <= range.end) return false;
  }
  if (symbol.name.length < 3) return false;
  return true;
}

async function buildIdentifierDocsForFile(rootDir: string, relativePath: string): Promise<IdentifierDoc[]> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);
  if (!isSupportedFile(fullPath)) return [];

  try {
    const analysis = await analyzeFile(fullPath);
    const flat = flattenSymbols(analysis.symbols);
    const sourceLines = (await readFile(fullPath, "utf-8")).split("\n");
    const structuralRanges = flat
      .filter((symbol) => STRUCTURAL_KINDS.has(symbol.kind))
      .map((symbol) => ({ start: symbol.line, end: symbol.endLine }));
    return flat
      .filter((symbol) => isIndexableSymbol(symbol, structuralRanges, sourceLines))
      .map((symbol) => ({
        id: `${normalized}:${symbol.name}:${symbol.line}`,
        path: normalized,
        header: analysis.header,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        signature: symbol.signature,
        parentName: symbol.parentName,
        text: `${symbol.name} ${symbol.kind} ${symbol.signature} ${normalized} ${analysis.header} ${symbol.parentName ?? ""}`,
      }));
  } catch {
    return [];
  }
}

async function buildIdentifierIndex(rootDir: string, skipEmbeddings = false): Promise<IdentifierIndex> {
  const db = await getDB(rootDir);
  const generation = db.getIndexGeneration();
  if (cachedIndex && cachedRootDir === rootDir && cachedGeneration === generation && cachedLexicalOnly === skipEmbeddings && Date.now() - cachedAt < INDEX_TTL_MS) {
    return cachedIndex;
  }

  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const docs: IdentifierDoc[] = [];
  const fileLines = new Map<string, string[]>();
  const fileCodeLines = new Map<string, string[]>();

  for (const file of files) {
    try {
      const content = await readFile(file.path, "utf-8");
      const sourceLines = content.split("\n");
      fileLines.set(file.relativePath, sourceLines);
      fileCodeLines.set(file.relativePath, maskSourceText(content, file.relativePath).split("\n"));
      // Reuse persisted syntax only when it describes the exact source just read.
      // A cold search should not reparse every unchanged file in the repository.
      const indexed = db.getFile(file.relativePath);
      const rows = indexed?.content_hash === hashSource(content) ? db.getSymbolsByFile(indexed.id) : null;
      const names = new Map(rows?.map(row => [row.id, row.name]));
      const analysis = rows ? null : await analyzeContent(file.path, content);
      const header = indexed && rows ? indexed.header ?? "" : analysis!.header;
      const flat = rows ? rows.map(row => ({
        name: row.name, kind: row.kind, line: row.line_start,
        endLine: row.line_end ?? row.line_start, signature: row.signature ?? "",
        parentName: row.parent_symbol_id === null ? undefined : names.get(row.parent_symbol_id),
      })) : flattenSymbols(analysis!.symbols);
      const structuralRanges = flat
        .filter((symbol) => STRUCTURAL_KINDS.has(symbol.kind))
        .map((symbol) => ({ start: symbol.line, end: symbol.endLine }));
      for (const symbol of flat) {
        if (!isIndexableSymbol(symbol, structuralRanges, sourceLines)) continue;
        docs.push({
          id: `${file.relativePath}:${symbol.name}:${symbol.line}`,
          path: file.relativePath,
          header,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          endLine: symbol.endLine,
          signature: symbol.signature,
          parentName: symbol.parentName,
          text: `${symbol.name} ${symbol.kind} ${symbol.signature} ${file.relativePath} ${header} ${symbol.parentName ?? ""}`,
        });
      }
    } catch {
    }
  }

  if (docs.length === 0) {
    const empty: IdentifierIndex = { docs: [], vectors: [], fileLines, fileCodeLines };
    cachedLexicalOnly = skipEmbeddings;
    cachedIndex = empty;
    cachedRootDir = rootDir;
    cachedAt = Date.now();
    cachedGeneration = generation;
    return empty;
  }

  const cache = await loadIdentifierCache(rootDir);
  const vectors: number[][] = new Array(docs.length);

  for (let i = 0; i < docs.length; i++) {
    const text = docs[i].text;
    const hash = hashContent(text);
    const key = `id:${docs[i].id}`;
    if (cache[key]?.hash === hash) {
      vectors[i] = cache[key].vector;
    }
  }

  // Interactive reads use cached vectors only; reindex/refresh builds missing vectors.

  const index: IdentifierIndex = { docs, vectors, fileLines, fileCodeLines };
  cachedLexicalOnly = skipEmbeddings;
  cachedIndex = index;
  cachedRootDir = rootDir;
  cachedAt = Date.now();
  cachedGeneration = generation;
  return index;
}

async function rankCallSites(
  cache: EmbeddingCache,
  queryTerms: Set<string>,
  queryVec: number[],
  symbol: IdentifierDoc,
  fileLines: Map<string, string[]>,
  fileCodeLines: Map<string, string[]>,
  limit: number,
): Promise<{ sites: CallSite[]; total: number }> {
  const callPattern = symbol.kind === "function" || symbol.kind === "method"
    ? new RegExp(`\\b${escapeRegex(symbol.name)}\\s*\\(`)
    : new RegExp(`\\b${escapeRegex(symbol.name)}\\b`);

  const candidates: { file: string; line: number; context: string; keywordScore: number }[] = [];

  for (const [file, lines] of fileLines) {
    const codeLines = fileCodeLines.get(file) ?? lines;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const code = codeLines[i] ?? "";
      if (!callPattern.test(code)) {
        callPattern.lastIndex = 0;
        continue;
      }
      callPattern.lastIndex = 0;

      if (file === symbol.path && i + 1 === symbol.line) continue;
      if (isDefinitionLine(code, symbol.name)) continue;

      const context = raw.trim().slice(0, 220);
      const keywordScore = getKeywordCoverage(queryTerms, `${file} ${context}`);
      candidates.push({
        file,
        line: i + 1,
        context,
        keywordScore,
      });
    }
  }

  if (candidates.length === 0) return { sites: [], total: 0 };

  const embedBudget = Math.max(30, limit * 4);
  const sampled = candidates
    .slice()
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, Math.min(embedBudget, candidates.length));

  const keyedCandidates: { candidate: (typeof sampled)[number]; key: string; hash: string }[] = [];

  for (const candidate of sampled) {
    const key = `${CALLSITE_CACHE_PREFIX}${candidate.file}:${candidate.line}`;
    const text = `${candidate.file} ${candidate.context}`;
    const hash = hashContent(text);
    keyedCandidates.push({ candidate, key, hash });
  }

  // Caller previews also avoid embedding work on the read path.

  const ranked: CallSite[] = keyedCandidates.map(({ candidate, key, hash }) => {
    const vector = cache[key]?.hash === hash ? cache[key].vector : undefined;
    const semanticScore = vector && queryVec.length > 0 ? Math.max(cosine(queryVec, vector), 0) : 0;
    const score = clamp01(semanticScore * 0.82 + candidate.keywordScore * 0.18);
    return {
      file: candidate.file,
      line: candidate.line,
      context: candidate.context,
      semanticScore,
      keywordScore: candidate.keywordScore,
      score,
    };
  });

  return {
    sites: ranked.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit)),
    total: candidates.length,
  };
}

export async function semanticIdentifierSearchResults(options: SemanticIdentifierSearchOptions): Promise<SemanticIdentifierSearchData> {
  const topK = Math.max(1, Math.floor(options.topK ?? 5));
  const topCalls = Math.max(1, Math.floor(options.topCallsPerIdentifier ?? 10));
  const semanticWeight = options.preset === "keyword_only" ? 0 : normalizeWeight(options.semanticWeight, 0.78);
  const keywordWeight = options.preset === "keyword_only" ? 1 : normalizeWeight(options.keywordWeight, 0.22);
  const includeKinds = normalizeKinds(options.includeKinds);

  const index = await buildIdentifierIndex(options.rootDir, semanticWeight === 0);
  if (index.docs.length === 0) return { query: options.query, results: [] };

  let queryVec: number[];
  try {
    queryVec = semanticWeight === 0 || !index.vectors.some(vector => vector?.length) ? [] : await fetchQueryEmbedding(options.query);
  } catch {
    queryVec = [];
  }
  const queryTerms = new Set(splitTerms(options.query));
  const identifierHints = extractIdentifierHints(options.query);
  const queryWantsTests = /\b(test|tests|spec|coverage|regression|assert|fixture)\b/i.test(options.query);

  const scored: RankedIdentifier[] = [];
  const minSem = options.minSemanticScore !== undefined ? (options.minSemanticScore > 1 ? options.minSemanticScore / 100 : options.minSemanticScore) : undefined;
  const minKw = options.minKeywordScore !== undefined ? (options.minKeywordScore > 1 ? options.minKeywordScore / 100 : options.minKeywordScore) : undefined;
  const minCombined = options.minCombinedScore !== undefined ? (options.minCombinedScore > 1 ? options.minCombinedScore / 100 : options.minCombinedScore) : undefined;

  for (let i = 0; i < index.docs.length; i++) {
    const doc = index.docs[i];
    if (includeKinds && !includeKinds.has(doc.kind.toLowerCase())) continue;

    const semanticScore = index.vectors[i] && queryVec.length > 0 ? Math.max(cosine(queryVec, index.vectors[i]), 0) : 0;
    const keywordScore = getKeywordCoverage(queryTerms, `${doc.name} ${doc.signature} ${doc.path} ${doc.header}`);
    const totalWeight = semanticWeight + keywordWeight;
    const exactIdentifierBoost = identifierHints.has(doc.name.toLowerCase()) ? 0.35 : 0;
    const score = totalWeight > 0
      ? clamp01((semanticWeight * semanticScore + keywordWeight * keywordScore) / totalWeight)
      : semanticScore;
    let boostedScore = clamp01(score + exactIdentifierBoost);
    if (TRIVIAL_IDENTIFIER_NAMES.has(doc.name.toLowerCase()) && !identifierHints.has(doc.name.toLowerCase())) {
      boostedScore *= 0.3;
    }
    if (!queryWantsTests && /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./.test(doc.path)) {
      boostedScore *= 0.82;
    }

    // Apply hard filters consistent with the file-search side.
    if (options.requireSemanticMatch && semanticScore <= 0) continue;
    if (options.requireKeywordMatch && keywordScore <= 0) continue;
    if (minSem !== undefined && semanticScore < minSem) continue;
    if (minKw !== undefined && keywordScore < minKw) continue;
    if (minCombined !== undefined && boostedScore < minCombined) continue;

    scored.push({
      doc,
      semanticScore,
      keywordScore: identifierHints.has(doc.name.toLowerCase()) ? Math.max(keywordScore, 0.98) : keywordScore,
      score: boostedScore,
    });
  }

  if (scored.length === 0) return { query: options.query, results: [] };

  const top = scored.sort((a, b) => b.score - a.score).slice(0, topK);
  const cache = await loadIdentifierCache(options.rootDir);
  const results: SemanticIdentifierHit[] = [];

  for (let i = 0; i < top.length; i++) {
    const item = top[i];
    const calls = options.expandCallers === false ? { sites: [], total: 0 } : await rankCallSites(
      cache,
      queryTerms,
      queryVec,
      item.doc,
      index.fileLines,
      index.fileCodeLines,
      topCalls,
    );
    results.push({
      name: item.doc.name,
      kind: item.doc.kind,
      path: item.doc.path,
      line: item.doc.line,
      endLine: item.doc.endLine,
      signature: item.doc.signature,
      parentName: item.doc.parentName,
      score: Math.round(item.score * 1000) / 10,
      semanticScore: Math.round(item.semanticScore * 1000) / 10,
      keywordScore: Math.round(item.keywordScore * 1000) / 10,
      calls: calls.sites,
      totalCalls: calls.total,
    });
  }

  return { query: options.query, results };
}

export function formatSemanticIdentifierSearchData({ query, results }: SemanticIdentifierSearchData, includeKinds?: string[]): string {
  if (results.length === 0) {
    return includeKinds && includeKinds.length > 0
      ? "No identifiers matched the requested kind filters."
      : "No supported identifiers found for semantic identifier search.";
  }

  const lines: string[] = [
    `Top ${results.length} identifier matches for: "${query}"`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const range = formatLineRange(item.line, item.endLine);
    lines.push(`${i + 1}. ${item.kind} ${item.name} - ${item.path} (${range})`);
    lines.push(`   Score: ${item.score}% | Semantic: ${item.semanticScore}% | Keyword: ${item.keywordScore}%`);
    lines.push(`   Signature: ${item.signature}`);
    if (item.parentName) lines.push(`   Parent: ${item.parentName}`);
    if (item.calls.length === 0) {
      lines.push("   Calls: none found");
      lines.push("");
      continue;
    }
    lines.push(`   Calls (${item.calls.length}/${item.totalCalls}):`);
    for (let j = 0; j < item.calls.length; j++) {
      const site = item.calls[j];
      lines.push(`     ${j + 1}. ${site.file}:L${site.line} (${Math.round(site.score * 1000) / 10}%) ${site.context}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function semanticIdentifierSearch(options: SemanticIdentifierSearchOptions): Promise<string> {
  return formatSemanticIdentifierSearchData(await semanticIdentifierSearchResults(options), options.includeKinds);
}

export function invalidateIdentifierSearchCache(): void {
  cachedRootDir = null;
  cachedAt = 0;
  cachedIndex = null;
}

export async function refreshIdentifierEmbeddings(options: { rootDir: string; relativePaths: string[] }): Promise<number> {
  const uniquePaths = Array.from(new Set(options.relativePaths.map(normalizeRelativePath).filter(Boolean)));
  if (uniquePaths.length === 0) return 0;

  const db = await getDB(options.rootDir);
  const cache = await loadIdentifierCache(options.rootDir);
  const dirtyKeys = new Set<string>();
  const pending: { key: string; hash: string; text: string }[] = [];
  let reused = 0;

  for (const relativePath of uniquePaths) {
    // Snapshot the file's existing cached vectors+hashes BEFORE clearing, so we can
    // re-use the embedding of any identifier whose text is unchanged. Re-embedding
    // every identifier in a file on any edit (the old behavior) sent a burst of
    // Ollama calls per changed file — the main idle/edit-time battery cost, since a
    // file averages ~25 identifiers and only one or two actually change per edit.
    const previous = new Map<string, { hash: string; vector: number[] }>();
    const defPrefix = `id:${relativePath}:`;
    const callPrefix = `${CALLSITE_CACHE_PREFIX}${relativePath}:`;
    for (const k of Object.keys(cache)) {
      if (k.startsWith(defPrefix) || k.startsWith(callPrefix)) previous.set(k, cache[k]);
    }

    removeFileScopedCacheEntries(cache, relativePath);
    db.deleteEmbeddingsByPrefix(IDENTIFIER_SOURCE_TYPE, `id:${relativePath}:`);
    db.deleteEmbeddingsByPrefix(IDENTIFIER_SOURCE_TYPE, `${CALLSITE_CACHE_PREFIX}${relativePath}:`);

    const docs = await buildIdentifierDocsForFile(options.rootDir, relativePath);
    for (const doc of docs) {
      const key = `id:${doc.id}`;
      const hash = hashContent(doc.text);
      const prior = previous.get(key);
      if (prior && prior.hash === hash) {
        // Unchanged identifier — reuse its vector, re-persist it, skip embedding.
        cache[key] = prior;
        dirtyKeys.add(key);
        reused++;
      } else {
        pending.push({ key, hash, text: doc.text });
      }
    }
  }

  if (pending.length > 0) {
    const batchSize = getEmbeddingBatchSize();
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await fetchEmbedding(batch.map((entry) => entry.text));
      for (let j = 0; j < batch.length; j++) {
        cache[batch[j].key] = { hash: batch[j].hash, vector: vectors[j] };
        dirtyKeys.add(batch[j].key);
      }
    }
  }

  await saveIdentifierCache(options.rootDir, cache, dirtyKeys);
  invalidateIdentifierSearchCache();
  // Returns only the count actually EMBEDDED (not reused) — that's the real cost.
  void reused;
  return pending.length;
}
