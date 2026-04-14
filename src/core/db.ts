// SQLite storage layer with vec0 vector search for embeddings and memory graph
// FEATURE: Core persistence — replaces JSON files with indexed, queryable storage

import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { createRequire } from "module";
import { join, resolve } from "path";

type DatabaseType = import("better-sqlite3").Database;
type BetterSqlite3Constructor = new (path: string, options?: unknown) => DatabaseType;
type SqliteVecModule = { load: (db: DatabaseType) => void };

const requireFromHere = createRequire(import.meta.url);

export interface FileRow {
  id: number;
  path: string;
  content_hash: string;
  header: string | null;
  language: string | null;
  symbol_count: number;
  last_indexed_at: number;
  file_size: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  line_start: number;
  line_end: number | null;
  signature: string | null;
  parent_symbol_id: number | null;
}

export interface ParsedSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd?: number;
  signature?: string;
  parentSymbolId?: number;
}

export interface EmbeddingMatch {
  rowid: number;
  sourceType: string;
  sourceId: string;
  contentHash: string;
  distance: number;
}

export interface MemoryNodeInput {
  id?: string;
  type: "concept" | "file" | "symbol" | "note";
  label: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface MemoryNodeRow {
  id: string;
  type: string;
  label: string;
  content: string;
  created_at: number;
  last_accessed: number;
  access_count: number;
  metadata: string;
}

export interface MemoryEdgeInput {
  id?: string;
  source: string;
  target: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, string>;
}

export interface MemoryEdgeRow {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
  created_at: number;
  metadata: string;
}

export interface MemorySearchResult {
  node: MemoryNodeRow;
  distance: number;
}

export interface TraversalResult {
  node: MemoryNodeRow;
  depth: number;
  pathRelations: string[];
  relevanceScore: number;
}

export interface ImportRow {
  id: number;
  source_file_id: number;
  target_path: string;
  target_file_id: number | null;
  import_type: string;
  symbols_imported: string | null;
}

export interface NativeStorageDiagnostic {
  code: string;
  message: string;
  remediation: string[];
}

export interface NativeStorageProbe {
  ok: boolean;
  runtime: {
    nodeVersion: string;
    nodeAbi: string;
  };
  diagnostic?: NativeStorageDiagnostic;
}

const SCHEMA_VERSION = "1";
const DECAY_LAMBDA = 0.05;
const STALE_EDGE_THRESHOLD = 0.15;
const STALE_NODE_DAYS = 7;
const STALE_NODE_MIN_ACCESS = 2;
const PRUNE_INTERVAL_HOURS = 24;

let nativeStorageBindings: { Database: BetterSqlite3Constructor; sqliteVec: SqliteVecModule } | null = null;

function normalizeBetterSqliteModule(candidate: unknown): BetterSqlite3Constructor {
  if (typeof candidate === "function") return candidate as BetterSqlite3Constructor;
  if (candidate && typeof (candidate as { default?: unknown }).default === "function") {
    return (candidate as { default: BetterSqlite3Constructor }).default;
  }
  throw new Error("better-sqlite3 did not expose a database constructor.");
}

function normalizeSqliteVecModule(candidate: unknown): SqliteVecModule {
  const maybeModule = candidate && typeof (candidate as SqliteVecModule).load === "function"
    ? candidate as SqliteVecModule
    : (candidate as { default?: SqliteVecModule } | null)?.default;
  if (maybeModule && typeof maybeModule.load === "function") return maybeModule;
  throw new Error("sqlite-vec did not expose a load(db) function.");
}

export function describeNativeStorageError(error: unknown): NativeStorageDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const remediation = [
    `Run npm install in the Context+ repo to restore native dependencies.`,
    `Rebuild better-sqlite3 with the same Node runtime that launches Context+ (${process.execPath}).`,
    `Restart the MCP host after fixing native dependencies so it respawns the server cleanly.`,
  ];

  if (message.includes("Cannot find module") || message.includes("Could not locate the bindings file")) {
    return {
      code: "native_module_missing",
      message,
      remediation,
    };
  }

  if (message.includes("NODE_MODULE_VERSION") || message.includes("compiled against a different Node.js version")) {
    return {
      code: "native_module_abi_mismatch",
      message,
      remediation,
    };
  }

  return {
    code: "native_module_error",
    message,
    remediation,
  };
}

function loadNativeStorageBindings(): { Database: BetterSqlite3Constructor; sqliteVec: SqliteVecModule } {
  if (nativeStorageBindings) return nativeStorageBindings;
  try {
    const betterSqlite = normalizeBetterSqliteModule(requireFromHere("better-sqlite3"));
    const sqliteVec = normalizeSqliteVecModule(requireFromHere("sqlite-vec"));
    nativeStorageBindings = { Database: betterSqlite, sqliteVec };
    return nativeStorageBindings;
  } catch (error) {
    const diagnostic = describeNativeStorageError(error);
    throw new Error(`Context+ native storage unavailable [${diagnostic.code}]: ${diagnostic.message}\n${diagnostic.remediation.join("\n")}`);
  }
}

export function probeNativeStorage(): NativeStorageProbe {
  try {
    const { Database, sqliteVec } = loadNativeStorageBindings();
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.prepare("SELECT 1").get();
    db.close();
    return {
      ok: true,
      runtime: {
        nodeVersion: process.version,
        nodeAbi: process.versions.modules ?? "unknown",
      },
    };
  } catch (error) {
    return {
      ok: false,
      runtime: {
        nodeVersion: process.version,
        nodeAbi: process.versions.modules ?? "unknown",
      },
      diagnostic: describeNativeStorageError(error),
    };
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  header TEXT,
  language TEXT,
  symbol_count INTEGER DEFAULT 0,
  last_indexed_at INTEGER NOT NULL,
  file_size INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER,
  signature TEXT,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('concept', 'file', 'symbol', 'note')),
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('relates_to', 'depends_on', 'implements', 'references', 'similar_to', 'contains')),
  weight REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  import_type TEXT DEFAULT 'static',
  symbols_imported TEXT
);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_file_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function vecToBuffer(vec: number[] | Float32Array): Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class ContextPlusDB {
  private db: DatabaseType;
  private vecDimension: number | null = null;
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    const dbPath = join(rootDir, ".contextplus", "index.db");
    const { Database, sqliteVec } = loadNativeStorageBindings();
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.initMeta();
    this.ensureVecTables();
  }

  private initMeta(): void {
    const existing = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    }
  }

  private ensureVecTables(): void {
    const dimRow = this.db.prepare("SELECT value FROM meta WHERE key = 'vec_dimension'").get() as { value: string } | undefined;
    if (dimRow) {
      this.vecDimension = parseInt(dimRow.value, 10);
      this.createVecTablesIfNeeded(this.vecDimension);
    }
  }

  private createVecTablesIfNeeded(dim: number): void {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(vector float[${dim}], +source_type TEXT, +source_id TEXT, +content_hash TEXT)`);
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(vector float[${dim}], +node_id TEXT)`);
    } catch {
      this.db.exec("DROP TABLE IF EXISTS embeddings");
      this.db.exec("DROP TABLE IF EXISTS memory_embeddings");
      this.db.exec(`CREATE VIRTUAL TABLE embeddings USING vec0(vector float[${dim}], +source_type TEXT, +source_id TEXT, +content_hash TEXT)`);
      this.db.exec(`CREATE VIRTUAL TABLE memory_embeddings USING vec0(vector float[${dim}], +node_id TEXT)`);
    }
  }

  private ensureVecDimension(dim: number): void {
    if (this.vecDimension === dim) return;
    if (this.vecDimension !== null && this.vecDimension !== dim) {
      this.db.exec("DROP TABLE IF EXISTS embeddings");
      this.db.exec("DROP TABLE IF EXISTS memory_embeddings");
    }
    this.vecDimension = dim;
    this.createVecTablesIfNeeded(dim);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dimension', ?)").run(String(dim));
  }

  upsertFile(path: string, hash: string, header: string | null, language: string | null, fileSize: number = 0): number {
    const existing = this.db.prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE files SET content_hash = ?, header = ?, language = ?, last_indexed_at = ?, file_size = ? WHERE id = ?")
        .run(hash, header, language, Date.now(), fileSize, existing.id);
      return existing.id;
    }
    const result = this.db.prepare("INSERT INTO files (path, content_hash, header, language, last_indexed_at, file_size) VALUES (?, ?, ?, ?, ?, ?)")
      .run(path, hash, header, language, Date.now(), fileSize);
    return Number(result.lastInsertRowid);
  }

  getFile(path: string): FileRow | null {
    return (this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as FileRow) ?? null;
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files").all() as FileRow[];
  }

  getStaleFiles(currentHashes: Map<string, string>): string[] {
    const stale: string[] = [];
    const rows = this.db.prepare("SELECT path, content_hash FROM files").all() as { path: string; content_hash: string }[];
    for (const row of rows) {
      const currentHash = currentHashes.get(row.path);
      if (!currentHash || currentHash !== row.content_hash) {
        stale.push(row.path);
      }
    }
    return stale;
  }

  getRemovedFiles(currentPaths: Set<string>): string[] {
    const rows = this.db.prepare("SELECT path FROM files").all() as { path: string }[];
    return rows.filter(r => !currentPaths.has(r.path)).map(r => r.path);
  }

  deleteFile(path: string): void {
    const file = this.getFile(path);
    if (file) {
      this.db.prepare("DELETE FROM embeddings WHERE source_type = 'file' AND source_id = ?").run(String(file.id));
      this.db.prepare("DELETE FROM embeddings WHERE source_type = 'symbol' AND source_id IN (SELECT CAST(id AS TEXT) FROM symbols WHERE file_id = ?)").run(file.id);
      this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(file.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
    }
  }

  upsertSymbols(fileId: number, symbols: ParsedSymbol[]): void {
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    const insert = this.db.prepare("INSERT INTO symbols (file_id, name, kind, line_start, line_end, signature, parent_symbol_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const tx = this.db.transaction((syms: ParsedSymbol[]) => {
      for (const s of syms) {
        insert.run(fileId, s.name, s.kind, s.lineStart, s.lineEnd ?? null, s.signature ?? null, s.parentSymbolId ?? null);
      }
    });
    tx(symbols);
    this.db.prepare("UPDATE files SET symbol_count = ? WHERE id = ?").run(symbols.length, fileId);
  }

  getSymbolsByFile(fileId: number): SymbolRow[] {
    return this.db.prepare("SELECT * FROM symbols WHERE file_id = ?").all(fileId) as SymbolRow[];
  }

  searchSymbolsByName(query: string): SymbolRow[] {
    return this.db.prepare("SELECT * FROM symbols WHERE name LIKE ?").all(`%${query}%`) as SymbolRow[];
  }

  upsertEmbedding(sourceType: string, sourceId: number, vector: number[] | Float32Array, hash: string): void {
    this.ensureVecDimension(vector.length);
    this.db.prepare("DELETE FROM embeddings WHERE source_type = ? AND source_id = ?").run(sourceType, String(sourceId));
    this.db.prepare("INSERT INTO embeddings (vector, source_type, source_id, content_hash) VALUES (?, ?, ?, ?)")
      .run(vecToBuffer(vector), sourceType, String(sourceId), hash);
  }

  searchEmbeddings(queryVector: number[] | Float32Array, topK: number, sourceType?: string): EmbeddingMatch[] {
    if (!this.vecDimension) return [];
    const buf = vecToBuffer(queryVector);
    let sql = "SELECT rowid, source_type, source_id, content_hash, distance FROM embeddings WHERE vector MATCH ? ORDER BY distance LIMIT ?";
    const params: (Buffer | string | number)[] = [buf, topK * 3];

    const raw = this.db.prepare(sql).all(...params) as { rowid: number; source_type: string; source_id: string; content_hash: string; distance: number }[];

    const filtered = sourceType ? raw.filter(r => r.source_type === sourceType) : raw;
    return filtered.slice(0, topK).map(r => ({
      rowid: r.rowid,
      sourceType: r.source_type,
      sourceId: r.source_id,
      contentHash: r.content_hash,
      distance: r.distance,
    }));
  }

  getEmbeddingBySource(sourceType: string, sourceId: number): { vector: Buffer; hash: string } | null {
    const row = this.db.prepare("SELECT rowid, content_hash FROM embeddings WHERE source_type = ? AND source_id = ?")
      .get(sourceType, String(sourceId)) as { rowid: number; content_hash: string } | undefined;
    return row ? { vector: Buffer.alloc(0), hash: row.content_hash } : null;
  }

  getEmbeddingHash(sourceType: string, sourceId: number): string | null {
    const row = this.db.prepare("SELECT content_hash FROM embeddings WHERE source_type = ? AND source_id = ?")
      .get(sourceType, String(sourceId)) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  upsertMemoryNode(input: MemoryNodeInput, embedding?: number[]): string {
    const now = Date.now();
    const existing = this.db.prepare("SELECT id FROM memory_nodes WHERE label = ? AND type = ?").get(input.label, input.type) as { id: string } | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_nodes SET content = ?, last_accessed = ?, access_count = access_count + 1, metadata = ? WHERE id = ?")
        .run(input.content, now, JSON.stringify(input.metadata ?? {}), existing.id);
      if (embedding) {
        this.ensureVecDimension(embedding.length);
        this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(existing.id);
        this.db.prepare("INSERT INTO memory_embeddings (vector, node_id) VALUES (?, ?)").run(vecToBuffer(embedding), existing.id);
      }
      return existing.id;
    }

    const id = input.id ?? generateId("node");
    this.db.prepare("INSERT INTO memory_nodes (id, type, label, content, created_at, last_accessed, access_count, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, input.type, input.label, input.content, now, now, JSON.stringify(input.metadata ?? {}));
    if (embedding) {
      this.ensureVecDimension(embedding.length);
      this.db.prepare("INSERT INTO memory_embeddings (vector, node_id) VALUES (?, ?)").run(vecToBuffer(embedding), id);
    }
    return id;
  }

  getMemoryNode(id: string): MemoryNodeRow | null {
    const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as MemoryNodeRow | undefined;
    if (row) {
      this.db.prepare("UPDATE memory_nodes SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?").run(Date.now(), id);
    }
    return row ?? null;
  }

  listMemoryNodes(): MemoryNodeRow[] {
    return this.db.prepare("SELECT * FROM memory_nodes ORDER BY last_accessed DESC, created_at DESC").all() as MemoryNodeRow[];
  }

  deleteMemoryNode(id: string): void {
    this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(id);
    this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
  }

  upsertMemoryEdge(input: MemoryEdgeInput): string {
    const existing = this.db.prepare("SELECT id FROM memory_edges WHERE source = ? AND target = ? AND relation = ?")
      .get(input.source, input.target, input.relation) as { id: string } | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_edges SET weight = ?, metadata = ? WHERE id = ?")
        .run(input.weight ?? 1.0, JSON.stringify(input.metadata ?? {}), existing.id);
      return existing.id;
    }

    const id = input.id ?? generateId("edge");
    this.db.prepare("INSERT INTO memory_edges (id, source, target, relation, weight, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.source, input.target, input.relation, input.weight ?? 1.0, Date.now(), JSON.stringify(input.metadata ?? {}));
    return id;
  }

  deleteMemoryEdge(id: string): void {
    this.db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id);
  }

  getMemoryEdgesForNode(id: string): MemoryEdgeRow[] {
    return this.db.prepare("SELECT * FROM memory_edges WHERE source = ? OR target = ?").all(id, id) as MemoryEdgeRow[];
  }

  searchMemoryNodes(queryVector: number[], topK: number = 5): MemorySearchResult[] {
    if (!this.vecDimension) return [];
    const buf = vecToBuffer(queryVector);
    const vecResults = this.db.prepare("SELECT node_id, distance FROM memory_embeddings WHERE vector MATCH ? ORDER BY distance LIMIT ?")
      .all(buf, topK) as { node_id: string; distance: number }[];

    const results: MemorySearchResult[] = [];
    for (const vr of vecResults) {
      const node = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(vr.node_id) as MemoryNodeRow | undefined;
      if (node) results.push({ node, distance: vr.distance });
    }
    return results;
  }

  getNeighbors(nodeId: string, maxDepth: number = 2, edgeFilter?: string[]): TraversalResult[] {
    const startNode = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as MemoryNodeRow | undefined;
    if (!startNode) return [];

    const visited = new Set<string>();
    const results: TraversalResult[] = [{ node: startNode, depth: 0, pathRelations: [], relevanceScore: 1.0 }];
    visited.add(nodeId);

    let frontier = [{ id: nodeId, depth: 0, pathRelations: [] as string[], score: 1.0 }];

    for (let d = 0; d < maxDepth; d++) {
      const nextFrontier: typeof frontier = [];
      for (const current of frontier) {
        let edgeSql = "SELECT * FROM memory_edges WHERE source = ? OR target = ?";
        const edges = this.db.prepare(edgeSql).all(current.id, current.id) as MemoryEdgeRow[];

        for (const edge of edges) {
          if (edgeFilter && !edgeFilter.includes(edge.relation)) continue;
          const neighborId = edge.source === current.id ? edge.target : edge.source;
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);

          const daysSince = (Date.now() - edge.created_at) / 86_400_000;
          const decayed = edge.weight * Math.exp(-DECAY_LAMBDA * daysSince);
          const depthPenalty = 1 / (d + 2);
          const score = decayed * depthPenalty;

          const node = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(neighborId) as MemoryNodeRow | undefined;
          if (node) {
            const pathRelations = [...current.pathRelations, edge.relation];
            results.push({ node, depth: d + 1, pathRelations, relevanceScore: score });
            nextFrontier.push({ id: neighborId, depth: d + 1, pathRelations, score });
          }
        }
      }
      frontier = nextFrontier;
    }

    return results;
  }

  pruneStaleEdges(threshold: number = STALE_EDGE_THRESHOLD): { edgesRemoved: number; nodesRemoved: number } {
    const now = Date.now();
    const edges = this.db.prepare("SELECT * FROM memory_edges").all() as MemoryEdgeRow[];
    let edgesRemoved = 0;

    for (const edge of edges) {
      const daysSince = (now - edge.created_at) / 86_400_000;
      const decayed = edge.weight * Math.exp(-DECAY_LAMBDA * daysSince);
      if (decayed < threshold) {
        this.db.prepare("DELETE FROM memory_edges WHERE id = ?").run(edge.id);
        edgesRemoved++;
      }
    }

    const orphans = this.db.prepare(`
      SELECT id FROM memory_nodes
      WHERE id NOT IN (SELECT source FROM memory_edges)
      AND id NOT IN (SELECT target FROM memory_edges)
      AND access_count < ?
      AND last_accessed < ?
    `).all(STALE_NODE_MIN_ACCESS, now - STALE_NODE_DAYS * 86_400_000) as { id: string }[];

    for (const orphan of orphans) {
      this.deleteMemoryNode(orphan.id);
    }

    this.setMeta("last_prune", String(now));
    return { edgesRemoved, nodesRemoved: orphans.length };
  }

  ensureGraphFresh(): void {
    const lastPrune = this.getMeta("last_prune");
    const hoursSincePrune = (Date.now() - Number(lastPrune ?? "0")) / 3_600_000;
    if (hoursSincePrune > PRUNE_INTERVAL_HOURS) {
      this.pruneStaleEdges();
    }
  }

  upsertImport(sourceFileId: number, targetPath: string, targetFileId: number | null, importType: string = "static", symbolsImported?: string[]): void {
    this.db.prepare("DELETE FROM imports WHERE source_file_id = ? AND target_path = ?").run(sourceFileId, targetPath);
    this.db.prepare("INSERT INTO imports (source_file_id, target_path, target_file_id, import_type, symbols_imported) VALUES (?, ?, ?, ?, ?)")
      .run(sourceFileId, targetPath, targetFileId, importType, symbolsImported ? JSON.stringify(symbolsImported) : null);
  }

  getImportsFrom(fileId: number): ImportRow[] {
    return this.db.prepare("SELECT * FROM imports WHERE source_file_id = ?").all(fileId) as ImportRow[];
  }

  getImportersOf(fileId: number): ImportRow[] {
    return this.db.prepare("SELECT * FROM imports WHERE target_file_id = ?").all(fileId) as ImportRow[];
  }

  getGraphStats(): { totalNodes: number; totalEdges: number } {
    const nodes = this.db.prepare("SELECT count(*) as n FROM memory_nodes").get() as { n: number };
    const edges = this.db.prepare("SELECT count(*) as n FROM memory_edges").get() as { n: number };
    return { totalNodes: nodes.n, totalEdges: edges.n };
  }

  getLatestIndexedAt(): number | null {
    const row = this.db.prepare("SELECT MAX(last_indexed_at) as value FROM files").get() as { value: number | null };
    return row?.value ?? null;
  }

  getIndexGeneration(): number {
    const value = Number(this.getMeta("index_generation") ?? "0");
    return Number.isFinite(value) ? value : 0;
  }

  bumpIndexGeneration(): number {
    const next = this.getIndexGeneration() + 1;
    this.setMeta("index_generation", String(next));
    return next;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }
}

const dbInstances = new Map<string, ContextPlusDB>();

export async function getDB(rootDir: string): Promise<ContextPlusDB> {
  const normalizedRoot = resolve(rootDir);
  const existing = dbInstances.get(normalizedRoot);
  if (existing) return existing;
  await mkdir(join(normalizedRoot, ".contextplus"), { recursive: true });
  const db = new ContextPlusDB(normalizedRoot);
  dbInstances.set(normalizedRoot, db);
  return db;
}

export function closeDB(rootDir?: string): void {
  if (rootDir) {
    const normalizedRoot = resolve(rootDir);
    const db = dbInstances.get(normalizedRoot);
    if (db) {
      db.close();
      dbInstances.delete(normalizedRoot);
    }
    return;
  }
  for (const [key, db] of dbInstances) {
    db.close();
    dbInstances.delete(key);
  }
}
