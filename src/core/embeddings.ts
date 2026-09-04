// Multi-provider vector embedding engine with cosine similarity search
// Supports Ollama (local) and OpenAI-compatible APIs (Gemini, OpenAI, etc.)
// Indexes file headers and symbols, caches embeddings to disk for speed

import { mkdir } from "fs/promises";
import { join } from "path";
import { getProvider, getEmbedModelName, getApiKey, getBaseUrl } from "./provider-config.js";

const EMBED_TIMEOUT_MS = 60_000;
let embedAbortController = new AbortController();

export function cancelAllEmbeddings(): void {
  embedAbortController.abort();
  embedAbortController = new AbortController();
}

export interface SearchDocument {
  path: string;
  header: string;
  symbols: string[];
  symbolEntries?: SymbolSearchEntry[];
  content: string;
}

export interface SymbolSearchEntry {
  name: string;
  kind?: string;
  line: number;
  endLine?: number;
  signature?: string;
}

export interface SearchResult {
  path: string;
  score: number;
  semanticScore: number;
  keywordScore: number;
  header: string;
  matchedSymbols: string[];
  matchedSymbolLocations: string[];
  inlineCode?: {
    mode: "crux" | "full";
    startLine: number;
    endLine: number;
    symbol?: string;
    text: string;
  };
}

export interface SearchQueryOptions {
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
  /**
   * How to fuse the semantic and keyword component scores into one ranking.
   * "weighted": semanticWeight/keywordWeight-blended average — simple, but BM25-style
   * keyword scores and cosine-similarity scores aren't on comparable scales, so the blend can
   * drift as the corpus/embedding model changes and near-tied components can round to
   * identical displayed totals despite different underlying signal.
   * "rrf" (default): reciprocal rank fusion (Cormack, Clarke & Büttcher 2009) — ranks candidates
   * separately by each component, then fuses by rank position (1/(60+rank)) rather than raw
   * score value. Ignores magnitude entirely, so it can't be thrown off by scale mismatches.
   */
  fusion?: "weighted" | "rrf";
}

interface ResolvedSearchQueryOptions {
  topK: number;
  semanticWeight: number;
  keywordWeight: number;
  minSemanticScore: number;
  minKeywordScore: number;
  minCombinedScore: number;
  requireKeywordMatch: boolean;
  requireSemanticMatch: boolean;
  fusion: "weighted" | "rrf";
}

interface EmbedRuntimeOptions {
  num_gpu?: number;
  main_gpu?: number;
  num_thread?: number;
  num_batch?: number;
  num_ctx?: number;
  low_vram?: boolean;
}

export interface EmbeddingCache {
  [path: string]: { hash: string; vector: number[] };
}

// Provider configuration is centralized in provider-config.ts. See that file for the full
// env-var precedence (generic CONTEXTPRO_* → legacy → provider-native → default). Resolved once
// at module load to preserve prior behavior; restart the server to pick up env changes.
const EMBED_PROVIDER = getProvider();
const EMBED_MODEL = getEmbedModelName("ollama");
const OPENAI_EMBED_MODEL = getEmbedModelName("openai");
const OPENAI_API_KEY = getApiKey();
const OPENAI_BASE_URL = getBaseUrl();
const CACHE_DIR = ".contextpro";
const MIN_EMBED_BATCH_SIZE = 5;
const MAX_EMBED_BATCH_SIZE = 10;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const MIN_EMBED_INPUT_CHARS = 1;
const SINGLE_INPUT_SHRINK_FACTOR = 0.75;
const MAX_SINGLE_INPUT_RETRIES = 40;
const MIN_EMBED_CHUNK_CHARS = 256;
const DEFAULT_EMBED_CHUNK_CHARS = 2000;
const MAX_EMBED_CHUNK_CHARS = 8000;

type OllamaEmbedClient = { embed: (params: Record<string, unknown>) => Promise<{ embeddings: number[][] }> };
let ollamaClient: OllamaEmbedClient | null = null;

async function getOllamaClient(): Promise<OllamaEmbedClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaEmbedClient;
  }
  return ollamaClient;
}

async function callOllamaEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  const client = await getOllamaClient();
  const options = getEmbedRuntimeOptions();
  const request: Record<string, unknown> = { model: EMBED_MODEL, input, signal };
  if (options) request.options = options;
  try {
    const response = await client.embed(request);
    return response.embeddings;
  } catch (error) {
    throw new Error(formatOllamaModelError(error, "embedding", EMBED_MODEL));
  }
}

async function callOpenAIEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  const url = `${OPENAI_BASE_URL.replace(/\/+$/, "")}/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI embed API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: { embedding: number[] }[] };
  return data.data.map((item) => item.embedding);
}

async function callProviderEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  if (EMBED_PROVIDER === "openai") {
    return callOpenAIEmbed(input, signal);
  }
  return callOllamaEmbed(input, signal);
}

function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}

function getEmbedRuntimeOptions(): EmbedRuntimeOptions | undefined {
  if (EMBED_PROVIDER === "openai") return undefined;
  const options: EmbedRuntimeOptions = {
    num_gpu: toOptionalInteger(process.env.CONTEXTPRO_EMBED_NUM_GPU ?? process.env.CONTEXTPLUS_EMBED_NUM_GPU),
    main_gpu: toOptionalInteger(process.env.CONTEXTPRO_EMBED_MAIN_GPU ?? process.env.CONTEXTPLUS_EMBED_MAIN_GPU),
    num_thread: toOptionalInteger(process.env.CONTEXTPRO_EMBED_NUM_THREAD ?? process.env.CONTEXTPLUS_EMBED_NUM_THREAD),
    num_batch: toOptionalInteger(process.env.CONTEXTPRO_EMBED_NUM_BATCH ?? process.env.CONTEXTPLUS_EMBED_NUM_BATCH),
    num_ctx: toOptionalInteger(process.env.CONTEXTPRO_EMBED_NUM_CTX ?? process.env.CONTEXTPLUS_EMBED_NUM_CTX),
    low_vram: toOptionalBoolean(process.env.CONTEXTPRO_EMBED_LOW_VRAM ?? process.env.CONTEXTPLUS_EMBED_LOW_VRAM),
  };

  if (Object.values(options).every((value) => value === undefined)) return undefined;
  return options;
}

export function getEmbeddingBatchSize(): number {
  const requested = toIntegerOr(process.env.CONTEXTPRO_EMBED_BATCH_SIZE ?? process.env.CONTEXTPLUS_EMBED_BATCH_SIZE, DEFAULT_EMBED_BATCH_SIZE);
  return Math.min(MAX_EMBED_BATCH_SIZE, Math.max(MIN_EMBED_BATCH_SIZE, requested));
}

export function getEmbedChunkChars(): number {
  const requested = toIntegerOr(process.env.CONTEXTPRO_EMBED_CHUNK_CHARS ?? process.env.CONTEXTPLUS_EMBED_CHUNK_CHARS, DEFAULT_EMBED_CHUNK_CHARS);
  return Math.min(MAX_EMBED_CHUNK_CHARS, Math.max(MIN_EMBED_CHUNK_CHARS, requested));
}

export function getEmbedProvider(): string {
  return EMBED_PROVIDER;
}

export function getEmbedModel(): string {
  return EMBED_PROVIDER === "openai" ? OPENAI_EMBED_MODEL : EMBED_MODEL;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatOllamaModelError(error: unknown, kind: "embedding" | "chat", model: string): string {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();
  const installHint = "Install Ollama from https://ollama.com/download, then run `ollama serve`.";
  const modelHint = `Run \`ollama pull ${model}\`, or set OLLAMA_${kind === "embedding" ? "EMBED" : "CHAT"}_MODEL to any model shown by \`ollama list\`.`;

  if (
    lower.includes("econnrefused")
    || lower.includes("fetch failed")
    || lower.includes("connection refused")
    || lower.includes("connect")
  ) {
    return `Ollama is not reachable while loading the ${kind} model "${model}". ${installHint} ${modelHint} Original error: ${message}`;
  }

  if (
    lower.includes("not found")
    || lower.includes("no such model")
    || lower.includes("model")
  ) {
    return `Ollama ${kind} model "${model}" is not available. ${modelHint} Original error: ${message}`;
  }

  return `Ollama ${kind} model "${model}" failed. ${installHint} ${modelHint} Original error: ${message}`;
}

function isContextLengthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("input length exceeds context length")
    || (message.includes("context") && message.includes("exceed"))
    || message.includes("maximum context length");
}

function shrinkEmbeddingInput(input: string): string {
  if (input.length <= MIN_EMBED_INPUT_CHARS) return input;
  const nextLength = Math.max(MIN_EMBED_INPUT_CHARS, Math.floor(input.length * SINGLE_INPUT_SHRINK_FACTOR));
  if (nextLength >= input.length) return input.slice(0, input.length - 1);
  return input.slice(0, nextLength);
}

async function embedSingleAdaptive(input: string): Promise<number[]> {
  let candidate = input;

  for (let attempt = 0; attempt <= MAX_SINGLE_INPUT_RETRIES; attempt++) {
    try {
      const timeoutCtrl = AbortSignal.timeout(EMBED_TIMEOUT_MS);
      const signal = AbortSignal.any([embedAbortController.signal, timeoutCtrl]);
      const embeddings = await callProviderEmbed([candidate], signal);
      if (!embeddings[0]) throw new Error("Missing embedding vector in response");
      return embeddings[0];
    } catch (error) {
      if (!isContextLengthError(error)) throw error;
      const nextCandidate = shrinkEmbeddingInput(candidate);
      if (nextCandidate.length === candidate.length) throw error;
      candidate = nextCandidate;
    }
  }

  throw new Error("Unable to embed oversized input after adaptive retries");
}

async function embedBatchAdaptive(batch: string[]): Promise<number[][]> {
  try {
    const timeoutCtrl = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const signal = AbortSignal.any([embedAbortController.signal, timeoutCtrl]);
    const embeddings = await callProviderEmbed(batch, signal);
    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding response size mismatch: expected ${batch.length}, got ${embeddings.length}`);
    }
    return embeddings;
  } catch (error) {
    if (!isContextLengthError(error)) throw error;
    if (batch.length === 1) {
      return [await embedSingleAdaptive(batch[0])];
    }
    const middle = Math.ceil(batch.length / 2);
    const left = await embedBatchAdaptive(batch.slice(0, middle));
    const right = await embedBatchAdaptive(batch.slice(middle));
    return [...left, ...right];
  }
}

function splitEmbeddingInput(input: string): string[] {
  const chunkChars = getEmbedChunkChars();
  if (input.length <= chunkChars) return [input];
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += chunkChars) {
    chunks.push(input.slice(start, start + chunkChars));
  }
  return chunks;
}

function mergeEmbeddingVectors(vectors: number[][], weights: number[]): number[] {
  if (vectors.length === 0) throw new Error("Cannot merge empty embedding vectors");
  if (vectors.length === 1) return vectors[0];

  const dimension = vectors[0].length;
  const merged = new Array<number>(dimension).fill(0);
  let totalWeight = 0;

  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    if (vector.length !== dimension) {
      throw new Error(`Embedding dimension mismatch: expected ${dimension}, got ${vector.length}`);
    }
    const weight = Math.max(1, weights[i] ?? 1);
    totalWeight += weight;
    for (let d = 0; d < dimension; d++) merged[d] += vector[d] * weight;
  }

  if (totalWeight <= 0) return vectors[0];
  for (let d = 0; d < merged.length; d++) merged[d] /= totalWeight;
  return merged;
}

export async function fetchEmbedding(input: string | string[]): Promise<number[][]> {
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];

  const chunkedInputs = inputs.map(splitEmbeddingInput);
  const flattenedInputs = chunkedInputs.flat();
  const batchSize = getEmbeddingBatchSize();
  const flattenedEmbeddings: number[][] = [];

  for (let i = 0; i < flattenedInputs.length; i += batchSize) {
    const batch = flattenedInputs.slice(i, i + batchSize);
    flattenedEmbeddings.push(...await embedBatchAdaptive(batch));
  }

  const embeddings: number[][] = [];
  let offset = 0;
  for (const chunks of chunkedInputs) {
    const vectors = flattenedEmbeddings.slice(offset, offset + chunks.length);
    if (vectors.length !== chunks.length) {
      throw new Error(`Merged embedding size mismatch: expected ${chunks.length}, got ${vectors.length}`);
    }
    embeddings.push(mergeEmbeddingVectors(vectors, chunks.map((chunk) => chunk.length)));
    offset += chunks.length;
  }

  return embeddings;
}

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function splitCamelCase(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length > 1);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value > 1) return clamp01(value / 100);
  return clamp01(value);
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function resolveSearchOptions(optionsOrTopK?: number | SearchQueryOptions): ResolvedSearchQueryOptions {
  const raw = typeof optionsOrTopK === "number" ? { topK: optionsOrTopK } : (optionsOrTopK ?? {});
  return {
    topK: normalizeTopK(raw.topK, 5),
    semanticWeight: normalizeWeight(raw.semanticWeight, 0.72),
    keywordWeight: normalizeWeight(raw.keywordWeight, 0.28),
    minSemanticScore: normalizeThreshold(raw.minSemanticScore, 0),
    minKeywordScore: normalizeThreshold(raw.minKeywordScore, 0),
    minCombinedScore: normalizeThreshold(raw.minCombinedScore, 0.1),
    requireKeywordMatch: raw.requireKeywordMatch ?? false,
    requireSemanticMatch: raw.requireSemanticMatch ?? false,
    fusion: raw.fusion === "weighted" ? "weighted" : "rrf",
  };
}

/**
 * Reciprocal rank fusion (Cormack, Clarke & Büttcher, SIGIR 2009): fuse two ranked lists by
 * rank position rather than raw score value, sidestepping the scale mismatch between an
 * unbounded/keyword-style score and a bounded cosine similarity. k=60 is the empirical
 * default from the original paper's TREC evaluation. Result is normalized to [0, 1] by the
 * best-possible score (rank 1 in both lists) so it composes with the existing 0-1 score
 * conventions (rounding, clamping, minCombinedScore) used by the weighted fusion path.
 */
const RRF_K = 60;
function reciprocalRankFusionScores(semanticScores: number[], keywordScores: number[]): number[] {
  const n = semanticScores.length;
  const buildRanks = (scores: number[]): Array<number | null> => {
    const ranks = new Array<number | null>(n).fill(null);
    const ranked = [...scores.keys()]
      .filter((index) => scores[index] > 0)
      .sort((left, right) => scores[right] - scores[left] || left - right);
    ranked.forEach((index, rank) => { ranks[index] = rank + 1; });
    return ranks;
  };
  const semanticRank = buildRanks(semanticScores.map((score) => Math.max(score, 0)));
  const keywordRank = buildRanks(keywordScores);
  const activeLists = Number(semanticRank.some((rank) => rank !== null)) + Number(keywordRank.some((rank) => rank !== null));
  if (activeLists === 0) return new Array<number>(n).fill(0);
  const bestPossible = activeLists / (RRF_K + 1);
  return semanticScores.map((_, index) => {
    const semantic = semanticRank[index] === null ? 0 : 1 / (RRF_K + semanticRank[index]!);
    const keyword = keywordRank[index] === null ? 0 : 1 / (RRF_K + keywordRank[index]!);
    return (semantic + keyword) / bestPossible;
  });
}

const LOW_SEMANTIC_FLOOR = 0.15;

function dampLowSemanticScore(score: number, semanticScore: number, keywordScore: number, semanticAvailable: boolean): number {
  const semantic = Math.max(semanticScore, 0);
  if (!semanticAvailable || semantic >= LOW_SEMANTIC_FLOOR) return score;
  // A lexical collision should remain visible as a low-confidence fallback, but it must not
  // outrank a genuinely semantic result. The ceiling rises smoothly from 12% at semantic=0
  // to just under 40% at the 0.15 semantic floor.
  const ceiling = keywordScore * (0.12 + 0.28 * (semantic / LOW_SEMANTIC_FLOOR));
  return Math.min(score, ceiling);
}

function getTermCoverage(queryTerms: Set<string>, docTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matched++;
  }
  return matched / queryTerms.size;
}

function getMatchedSymbols(symbols: string[], queryTerms: Set<string>): string[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol).some((term) => queryTerms.has(term)));
}

function computeKeywordScore(query: string, queryTerms: Set<string>, doc: SearchDocument, matchedSymbols: string[]): number {
  if (queryTerms.size === 0) return 0;
  const docText = `${doc.path} ${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
  const docTerms = new Set(splitCamelCase(docText));
  const queryLower = query.trim().toLowerCase();
  const phraseBoost = queryLower.length > 0 && docText.toLowerCase().includes(queryLower) ? 0.15 : 0;
  const symbolTerms = new Set(splitCamelCase(matchedSymbols.join(" ")));
  const termCoverage = getTermCoverage(queryTerms, docTerms);
  const symbolCoverage = getTermCoverage(queryTerms, symbolTerms);
  return clamp01(termCoverage * 0.65 + symbolCoverage * 0.2 + phraseBoost);
}

function computeCombinedScore(semanticScore: number, keywordScore: number, options: ResolvedSearchQueryOptions): number {
  const semanticComponent = Math.max(semanticScore, 0);
  const totalWeight = options.semanticWeight + options.keywordWeight;
  if (totalWeight <= 0) return semanticComponent;
  const blended = (options.semanticWeight * semanticComponent + options.keywordWeight * keywordScore) / totalWeight;
  // Trust dampener: when one component is essentially zero, the combined score is misleading.
  // A pure-keyword 94 should not look like a high-confidence hybrid match. Cap at 0.7 when
  // semantic ≈ 0, and at 0.7 when keyword ≈ 0 (allows lexical hits to surface without claiming
  // high hybrid confidence). 0.7 is the "medium" threshold in the qualityLabel UI.
  const SEMANTIC_FLOOR = 0.05;
  const KEYWORD_FLOOR = 0.05;
  const SINGLE_COMPONENT_CAP = 0.7;
  if (semanticComponent < SEMANTIC_FLOOR || keywordScore < KEYWORD_FLOOR) {
    return clamp01(Math.min(blended, SINGLE_COMPONENT_CAP));
  }
  return clamp01(blended);
}

const FILE_SEARCH_SOURCE_TYPE = "file_search_cache";

async function loadCache(rootDir: string): Promise<EmbeddingCache> {
  const { getDB, bufferToVec } = await import("./db.js");
  const db = await getDB(rootDir);
  const rows = db.getEmbeddingsByType(FILE_SEARCH_SOURCE_TYPE);
  const cache: EmbeddingCache = {};
  for (const r of rows) {
    cache[r.sourceId] = { hash: r.contentHash, vector: bufferToVec(r.vector) };
  }
  return cache;
}

async function saveCache(rootDir: string, cache: EmbeddingCache, dirtyKeys?: Set<string>): Promise<void> {
  const { getDB } = await import("./db.js");
  const db = await getDB(rootDir);
  const keys = dirtyKeys ?? new Set(Object.keys(cache));
  const entries: Array<{ sourceId: string; vector: number[]; hash: string }> = [];
  for (const key of keys) {
    const entry = cache[key];
    if (entry) entries.push({ sourceId: key, vector: entry.vector, hash: entry.hash });
  }
  db.upsertEmbeddingsBatch(FILE_SEARCH_SOURCE_TYPE, entries);
}

export async function deleteFileSearchEmbedding(rootDir: string, path: string): Promise<void> {
  const { getDB } = await import("./db.js");
  const db = await getDB(rootDir);
  db.deleteEmbeddingsByPrefix(FILE_SEARCH_SOURCE_TYPE, path);
}

export async function ensureMcpDataDir(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, CACHE_DIR), { recursive: true });
}

function formatLineRange(line: number, endLine?: number): string {
  if (endLine && endLine > line) return `L${line}-L${endLine}`;
  return `L${line}`;
}

function getMatchedSymbolEntries(symbols: SymbolSearchEntry[], queryTerms: Set<string>): SymbolSearchEntry[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol.name).some((term) => queryTerms.has(term)));
}

export class SearchIndex {
  private documents: SearchDocument[] = [];
  private vectors: number[][] = [];
  async index(docs: SearchDocument[], rootDir: string): Promise<void> {
    this.documents = docs;
    const cache = await loadCache(rootDir);
    const uncached: { idx: number; text: string; hash: string }[] = [];
    const dirtyKeys = new Set<string>();

    this.vectors = new Array(docs.length);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const rawText = `${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
      const hash = hashContent(rawText);

      if (cache[doc.path]?.hash === hash) {
        this.vectors[i] = cache[doc.path].vector;
      } else {
        uncached.push({ idx: i, text: rawText, hash });
      }
    }

    if (uncached.length > 0) {
      const batchSize = getEmbeddingBatchSize();
      const batches: { idx: number; text: string; hash: string }[][] = [];
      for (let b = 0; b < uncached.length; b += batchSize) {
        batches.push(uncached.slice(b, b + batchSize));
      }

      const pLimit = (await import("p-limit")).default;
      const limit = pLimit(4);

      await Promise.all(batches.map((batch) => limit(async () => {
        try {
          const embeddings = await fetchEmbedding(batch.map((u) => u.text));
          for (let j = 0; j < batch.length; j++) {
            this.vectors[batch[j].idx] = embeddings[j];
            const key = docs[batch[j].idx].path;
            cache[key] = { hash: batch[j].hash, vector: embeddings[j] };
            dirtyKeys.add(key);
          }
        } catch (error) {
          if (!isContextLengthError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[contextpro/embeddings] degraded: batch failed (${message}); falling back to keyword-only for ${batch.length} files\n`);
            return;
          }
          for (const item of batch) {
            try {
              const [vector] = await fetchEmbedding(item.text);
              this.vectors[item.idx] = vector;
              const key = docs[item.idx].path;
              cache[key] = { hash: item.hash, vector };
              dirtyKeys.add(key);
            } catch (innerError) {
              const message = innerError instanceof Error ? innerError.message : String(innerError);
              process.stderr.write(`[contextpro/embeddings] degraded: single-item embed failed for ${docs[item.idx].path} (${message})\n`);
              delete cache[docs[item.idx].path];
            }
          }
        }
      })));
      await saveCache(rootDir, cache, dirtyKeys);
    }
  }

  async search(query: string, optionsOrTopK?: number | SearchQueryOptions): Promise<SearchResult[]> {
    const options = resolveSearchOptions(optionsOrTopK);
    let queryVec: number[];
    try {
      [queryVec] = await fetchEmbedding(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/embeddings] degraded: query embed failed (${message}); using keyword-only ranking\n`);
      queryVec = [];
    }
    const queryTerms = new Set(splitCamelCase(query));
    const candidates: {
      idx: number;
      semanticScore: number;
      keywordScore: number;
      matchedSymbols: string[];
      matchedSymbolLocations: string[];
    }[] = [];

    for (let i = 0; i < this.vectors.length; i++) {
      if (!this.vectors[i]) continue;
      const doc = this.documents[i];
      const semanticScore = cosine(queryVec, this.vectors[i]);
      const matchedEntries = doc.symbolEntries ? getMatchedSymbolEntries(doc.symbolEntries, queryTerms) : [];
      const matchedSymbols = matchedEntries.length > 0
        ? matchedEntries.map((entry) => entry.name)
        : getMatchedSymbols(doc.symbols, queryTerms);
      const matchedSymbolLocations = matchedEntries.map((entry) => `${entry.name}@${formatLineRange(entry.line, entry.endLine)}`);
      const keywordScore = computeKeywordScore(query, queryTerms, doc, matchedSymbols);

      if (options.requireSemanticMatch && semanticScore <= 0) continue;
      if (options.requireKeywordMatch && keywordScore <= 0) continue;
      if (Math.max(semanticScore, 0) < options.minSemanticScore) continue;
      if (keywordScore < options.minKeywordScore) continue;

      candidates.push({ idx: i, semanticScore, keywordScore, matchedSymbols, matchedSymbolLocations });
    }

    // RRF fuses by rank position across the filtered candidate set, so it's computed once over
    // all of them rather than per-candidate like the weighted blend.
    const rrfScores = options.fusion === "rrf"
      ? reciprocalRankFusionScores(candidates.map((c) => c.semanticScore), candidates.map((c) => c.keywordScore))
      : null;
    const semanticAvailable = candidates.some((candidate) => candidate.semanticScore >= LOW_SEMANTIC_FLOOR);

    const scores = candidates
      .map((candidate, i) => ({
        ...candidate,
        score: dampLowSemanticScore(
          rrfScores ? clamp01(rrfScores[i]) : computeCombinedScore(candidate.semanticScore, candidate.keywordScore, options),
          candidate.semanticScore,
          candidate.keywordScore,
          semanticAvailable,
        ),
      }))
      .filter((candidate) => candidate.score >= options.minCombinedScore);

    return scores
      .sort((a, b) => b.score - a.score || b.keywordScore - a.keywordScore || b.semanticScore - a.semanticScore)
      .slice(0, options.topK)
      .map(({ idx, score, semanticScore, keywordScore, matchedSymbols, matchedSymbolLocations }) => {
        const doc = this.documents[idx];
        return {
          path: doc.path,
          score: Math.round(score * 10000) / 100,
          semanticScore: Math.round(Math.max(semanticScore, 0) * 1000) / 10,
          keywordScore: Math.round(keywordScore * 1000) / 10,
          header: doc.header,
          matchedSymbols,
          matchedSymbolLocations,
        };
      });
  }

  getDocumentCount(): number {
    return this.documents.length;
  }
}
