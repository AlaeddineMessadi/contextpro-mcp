// SQLite storage layer with vec0 vector search for embeddings and memory graph
// FEATURE: Core persistence — replaces JSON files with indexed, queryable storage

import { createHash } from "crypto";
import { join, resolve } from "path";
import { resolveProjectPath } from "./path-guard.js";
import { CONTEXTPRO_DIR, ensureContextProDir } from "./data-dir.js";
import { ensureNativeStorage, loadNativeStorageBindings } from "./db-native.js";

type DatabaseType = import("better-sqlite3").Database;

export interface FileRow {
  id: number;
  path: string;
  content_hash: string;
  header: string | null;
  language: string | null;
  symbol_count: number;
  last_indexed_at: number;
  file_size: number;
  file_mtime_ms: number;
  file_ctime_ms: number;
}

export interface ToolCallEfficiency {
  inputTokens?: number;
  outputTokens?: number;
  sourceTokens?: number;
  savedTokens?: number;
  representedFiles?: number;
}

export interface ToolCallHistoryRow {
  tool: string;
  status: string;
  durationMs: number;
  calledAt: number;
  inputTokens: number;
  outputTokens: number;
  sourceTokens: number;
  savedTokens: number;
  representedFiles: number;
}

export interface ToolEfficiencyAggregate {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  lastAt: number;
  inputTokens: number;
  outputTokens: number;
  sourceTokens: number;
  savedTokens: number;
  representedFiles: number;
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
  /** Index into the same `symbols` array passed to upsertSymbols, resolved to a real row id at insert time. */
  parentIndex?: number;
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

export interface CallSiteRow {
  id: number;
  file_id: number;
  callee: string;
  line: number;
  context: string;
}

export interface FileTextSearchMatch {
  path: string;
  score: number;
}

// Re-export native storage types and helpers so callers keep a single import point
export type { NativeStorageDiagnostic, NativeStorageProbe } from "./db-native.js";
export { describeNativeStorageError, probeNativeStorage } from "./db-native.js";

const SCHEMA_VERSION = "7";
const DECAY_LAMBDA = 0.05;
const STALE_EDGE_THRESHOLD = 0.15;
const STALE_NODE_DAYS = 7;
const STALE_NODE_MIN_ACCESS = 2;
const PRUNE_INTERVAL_HOURS = 24;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  header TEXT,
  language TEXT,
  symbol_count INTEGER DEFAULT 0,
  last_indexed_at INTEGER NOT NULL,
  file_size INTEGER DEFAULT 0,
  file_mtime_ms INTEGER DEFAULT 0,
  file_ctime_ms REAL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_symbol_id);

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
  relation TEXT NOT NULL CHECK(relation IN ('relates_to', 'depends_on', 'implements', 'references', 'similar_to', 'contains', 'resolved_by', 'contradicts')),
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

-- Append-only telemetry of MCP tool invocations, so external readers
-- can show real history (which tools ran, when, latency, errors) across restarts.
-- Created unconditionally (IF NOT EXISTS) so no schema-version bump is needed.
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,        -- 'ok' | 'error'
  duration_ms INTEGER NOT NULL,
  called_at INTEGER NOT NULL,  -- ms since epoch
  input_tokens_est INTEGER NOT NULL DEFAULT 0,
  output_tokens_est INTEGER NOT NULL DEFAULT 0,
  source_tokens_est INTEGER NOT NULL DEFAULT 0,
  saved_tokens_est INTEGER NOT NULL DEFAULT 0,
  represented_files INTEGER NOT NULL DEFAULT 0,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_called_at ON tool_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);

CREATE TABLE IF NOT EXISTS call_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  callee TEXT NOT NULL,
  line INTEGER NOT NULL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_sites_file ON call_sites(file_id);
CREATE INDEX IF NOT EXISTS idx_call_sites_callee ON call_sites(callee);

CREATE VIRTUAL TABLE IF NOT EXISTS file_search_fts USING fts5(
  path UNINDEXED,
  header,
  symbols,
  language,
  body,
  tokenize='porter unicode61'
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

export function bufferToVec(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

export class ContextPlusDB {
  private db: DatabaseType;
  // Other MCP connections can migrate the vector tables while this one lives.
  private get vecDimension(): number | null {
    const value = this.getMeta("vec_dimension");
    return value ? Number.parseInt(value, 10) : null;
  }
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    const dbPath = resolveProjectPath(rootDir, join(CONTEXTPRO_DIR, "index.db"));
    for (const suffix of ["-wal", "-shm", "-journal"]) resolveProjectPath(rootDir, `${dbPath}${suffix}`);
    const { Database, sqliteVec } = loadNativeStorageBindings();
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    // FTS stemming/punctuation folding finds candidates, but a literal key must
    // also occur in the indexed text. Verify before LIMIT, not after truncation.
    this.db.function("contextpro_literal_contains", { deterministic: true }, (body, needle) =>
      Number(String(body ?? "").normalize("NFC").toLowerCase().includes(String(needle))));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.initMeta();
    this.runMigrations();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, called_at)");
    this.ensureVecTables();
  }

  private initMeta(): void {
    const existing = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    }
  }

  private runMigrations(): void {
    const currentStr = (this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? "1";
    if (currentStr === SCHEMA_VERSION) return;
    // Numeric comparison so the gates stay correct past version 9 (lexicographic "10" < "2" was a bug).
    const current = Number.parseInt(currentStr, 10) || 1;
    if (current < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_edges_new (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
          target TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
          relation TEXT NOT NULL CHECK(relation IN ('relates_to', 'depends_on', 'implements', 'references', 'similar_to', 'contains', 'resolved_by', 'contradicts')),
          weight REAL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          metadata TEXT DEFAULT '{}'
        );
        INSERT OR IGNORE INTO memory_edges_new SELECT * FROM memory_edges;
        DROP TABLE memory_edges;
        ALTER TABLE memory_edges_new RENAME TO memory_edges;
        CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target);
      `);
    }
    if (current < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS call_sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          callee TEXT NOT NULL,
          line INTEGER NOT NULL,
          context TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_call_sites_file ON call_sites(file_id);
        CREATE INDEX IF NOT EXISTS idx_call_sites_callee ON call_sites(callee);
      `);
    }
    if (current < 4) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS file_search_fts USING fts5(
          path UNINDEXED,
          header,
          symbols,
          language,
          body,
          tokenize='porter unicode61'
        );
      `);
    }
    if (current < 5) {
      if (!this.columnExists("files", "file_mtime_ms")) this.db.exec("ALTER TABLE files ADD COLUMN file_mtime_ms INTEGER DEFAULT 0");
      if (!this.columnExists("tool_calls", "input_tokens_est")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN input_tokens_est INTEGER NOT NULL DEFAULT 0");
      if (!this.columnExists("tool_calls", "output_tokens_est")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN output_tokens_est INTEGER NOT NULL DEFAULT 0");
      if (!this.columnExists("tool_calls", "source_tokens_est")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN source_tokens_est INTEGER NOT NULL DEFAULT 0");
      if (!this.columnExists("tool_calls", "saved_tokens_est")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN saved_tokens_est INTEGER NOT NULL DEFAULT 0");
      if (!this.columnExists("tool_calls", "represented_files")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN represented_files INTEGER NOT NULL DEFAULT 0");
    }
    if (current < 6) {
      if (!this.columnExists("tool_calls", "session_id")) this.db.exec("ALTER TABLE tool_calls ADD COLUMN session_id TEXT");
    }
    if (current < 7 && !this.columnExists("files", "file_ctime_ms")) this.db.exec("ALTER TABLE files ADD COLUMN file_ctime_ms REAL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, called_at)");
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }

  private ensureVecTables(): void {
    const dimRow = this.db.prepare("SELECT value FROM meta WHERE key = 'vec_dimension'").get() as { value: string } | undefined;
    if (dimRow) {
      this.createVecTablesIfNeeded(parseInt(dimRow.value, 10));
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
    if (this.vecDimension === dim) {
      if (!this.hasVectorTables()) this.createVecTablesIfNeeded(dim);
      return;
    }
    if (this.vecDimension !== null && this.vecDimension !== dim) {
      process.stderr.write(
        `[contextpro/db] WARNING: embedding dimension changed from ${this.vecDimension} to ${dim}. ` +
        `All cached embeddings are being cleared. Run reindex to rebuild them.\n`,
      );
      this.db.exec("DROP TABLE IF EXISTS embeddings");
      this.db.exec("DROP TABLE IF EXISTS memory_embeddings");
      this.bumpMemoryRevision();
      this.bumpEmbeddingRevision();
      this.setMeta("embeddings_stale", "true");
      this.setMeta("embeddings_stale_reason", `dimension changed from ${this.vecDimension} to ${dim}`);
    }
    this.createVecTablesIfNeeded(dim);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dimension', ?)").run(String(dim));
  }

  recordEmbeddingProvider(provider: string, model: string): void {
    this.db.transaction(() => this.recordEmbeddingProviderInTransaction(provider, model)).immediate();
  }

  private recordEmbeddingProviderInTransaction(provider: string, model: string): void {
    const previousProvider = this.getMeta("embed_provider");
    const previousModel = this.getMeta("embed_model");
    const missingIdentity = !previousProvider || !previousModel;
    const populatedWithoutIdentity = missingIdentity && (() => { const stats = this.getEmbeddingStats(); return stats.total > 0 || stats.memory > 0; })();
    if (populatedWithoutIdentity || (!missingIdentity && (previousProvider !== provider || previousModel !== model))) {
      process.stderr.write(
        `[contextpro/db] WARNING: embedding provider/model changed from ${previousProvider || "unknown"}/${previousModel || "unknown"} to ${provider}/${model}. ` +
        `Cached vectors are being cleared; run reindex to rebuild.\n`,
      );
      // Content hashes alone cannot validate vectors across embedding models. This is
      // especially important when the old and new models happen to share a dimension:
      // vec0 would accept the stale vectors and silently mix incompatible vector spaces.
      if (this.tableExists("embeddings")) this.db.exec("DELETE FROM embeddings");
      if (this.tableExists("memory_embeddings")) this.db.exec("DELETE FROM memory_embeddings");
      this.bumpMemoryRevision();
      this.bumpEmbeddingRevision();
      this.setMeta("embeddings_stale", "true");
      this.setMeta("embeddings_stale_reason", `provider/model changed from ${previousProvider || "unknown"}/${previousModel || "unknown"} to ${provider}/${model}`);
    }
    this.setMeta("embed_provider", provider);
    this.setMeta("embed_model", model);
  }

  isEmbeddingsStale(): { stale: boolean; reason: string | null } {
    return {
      stale: this.getMeta("embeddings_stale") === "true",
      reason: this.getMeta("embeddings_stale_reason"),
    };
  }

  clearEmbeddingsStaleFlag(): void {
    this.setMeta("embeddings_stale", "false");
    this.setMeta("embeddings_stale_reason", "");
  }

  private hasVectorTables(): boolean {
    return this.vecDimension !== null && this.tableExists("embeddings") && this.tableExists("memory_embeddings");
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name) as { name: string } | undefined;
    return row !== undefined;
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private hasUsableEmbedding(value: number[] | undefined): value is number[] {
    return Array.isArray(value) && value.length > 0;
  }

  upsertFile(path: string, hash: string, header: string | null, language: string | null, fileSize: number = 0, fileMtimeMs: number = 0, fileCtimeMs: number = 0): number {
    const existing = this.db.prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE files SET content_hash = ?, header = ?, language = ?, last_indexed_at = ?, file_size = ?, file_mtime_ms = ?, file_ctime_ms = ? WHERE id = ?")
        .run(hash, header, language, Date.now(), fileSize, fileMtimeMs, fileCtimeMs, existing.id);
      return existing.id;
    }
    const result = this.db.prepare("INSERT INTO files (path, content_hash, header, language, last_indexed_at, file_size, file_mtime_ms, file_ctime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(path, hash, header, language, Date.now(), fileSize, fileMtimeMs, fileCtimeMs);
    return Number(result.lastInsertRowid);
  }

  updateFileFingerprint(path: string, fileSize: number, fileMtimeMs: number, fileCtimeMs = 0, expectedHash?: string): void {
    this.db.prepare("UPDATE files SET file_size = ?, file_mtime_ms = ?, file_ctime_ms = ? WHERE path = ? AND (? IS NULL OR content_hash = ?)")
      .run(fileSize, fileMtimeMs, fileCtimeMs, path, expectedHash ?? null, expectedHash ?? null);
  }

  getFile(path: string): FileRow | null {
    return (this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as FileRow) ?? null;
  }

  getFileById(id: number): FileRow | null {
    return (this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow) ?? null;
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
      if (this.hasVectorTables()) {
        this.db.prepare("DELETE FROM embeddings WHERE source_type = 'file' AND source_id = ?").run(String(file.id));
        this.db.prepare("DELETE FROM embeddings WHERE source_type = 'symbol' AND source_id IN (SELECT CAST(id AS TEXT) FROM symbols WHERE file_id = ?)").run(file.id);
      }
      this.deleteFileSearchDocument(path);
      this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(file.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
    }
  }

  upsertSymbols(fileId: number, symbols: ParsedSymbol[]): void {
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    const insert = this.db.prepare("INSERT INTO symbols (file_id, name, kind, line_start, line_end, signature, parent_symbol_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // `parentIndex` (index into `symbols`, always < this entry's own index — parents are
    // inserted in DFS pre-order before their children) resolves to a real row id here,
    // once we know it. Falls back to an explicit `parentSymbolId` if the caller has one.
    const insertedIds: number[] = [];
    const tx = this.db.transaction((syms: ParsedSymbol[]) => {
      for (const s of syms) {
        const parentId = s.parentIndex != null ? insertedIds[s.parentIndex] ?? null : s.parentSymbolId ?? null;
        const info = insert.run(fileId, s.name, s.kind, s.lineStart, s.lineEnd ?? null, s.signature ?? null, parentId);
        insertedIds.push(Number(info.lastInsertRowid));
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

  upsertEmbedding(sourceType: string, sourceId: number | string, vector: number[] | Float32Array, hash: string): void {
    this.upsertEmbeddingsBatch(sourceType, [{sourceId: String(sourceId), vector, hash}]);
  }

  upsertEmbeddingsBatch(sourceType: string, entries: Array<{ sourceId: string; vector: number[] | Float32Array; hash: string }>): void {
    if (entries.length === 0) return;
    const tx = this.db.transaction((rows: typeof entries) => {
      this.ensureVecDimension(rows[0].vector.length);
      // vec0 auxiliary columns have no index. Resolve existing identities once;
      // scanning the growing vector table before every insert is quadratic.
      const wanted = new Set(rows.map(row => row.sourceId));
      const existing = new Map<string, Array<number | bigint>>();
      const stored = this.db.prepare("SELECT rowid, source_id FROM embeddings WHERE source_type = ?").all(sourceType) as Array<{rowid: number; source_id: string}>;
      for (const row of stored) {
        if (!wanted.has(row.source_id)) continue;
        const ids = existing.get(row.source_id) ?? [];
        ids.push(row.rowid); existing.set(row.source_id, ids);
      }
      const del = this.db.prepare("DELETE FROM embeddings WHERE rowid = ?");
      const ins = this.db.prepare("INSERT INTO embeddings (vector, source_type, source_id, content_hash) VALUES (?, ?, ?, ?)");
      for (const r of rows) {
        for (const id of existing.get(r.sourceId) ?? []) del.run(id);
        const inserted = ins.run(vecToBuffer(r.vector), sourceType, r.sourceId, r.hash);
        existing.set(r.sourceId, [inserted.lastInsertRowid]);
      }
      this.bumpEmbeddingRevision();
    });
    tx.immediate(entries);
  }

  private bumpEmbeddingRevision(): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('embedding_revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  }

  getEmbeddingsByType(sourceType: string): Array<{ sourceId: string; contentHash: string; vector: Buffer }> {
    if (!this.hasVectorTables()) return [];
    try {
      return this.db.prepare("SELECT source_id as sourceId, content_hash as contentHash, vector FROM embeddings WHERE source_type = ?").all(sourceType) as Array<{ sourceId: string; contentHash: string; vector: Buffer }>;
    } catch {
      return [];
    }
  }

  getEmbeddingStats(): {
    vectorTablesReady: boolean;
    dimension: number | null;
    total: number;
    fileSearch: number;
    identifiers: number;
    memory: number;
  } {
    const empty = {
      vectorTablesReady: false,
      dimension: this.vecDimension,
      total: 0,
      fileSearch: 0,
      identifiers: 0,
      memory: 0,
    };
    if (!this.hasVectorTables()) return empty;
    try {
      const rows = this.db.prepare("SELECT source_type, count(*) as n FROM embeddings GROUP BY source_type").all() as { source_type: string; n: number }[];
      const memory = this.db.prepare("SELECT count(*) as n FROM memory_embeddings").get() as { n: number };
      const byType = new Map(rows.map((row) => [row.source_type, row.n]));
      const total = rows.reduce((sum, row) => sum + row.n, 0);
      return {
        vectorTablesReady: true,
        dimension: this.vecDimension,
        total,
        fileSearch: byType.get("file_search_cache") ?? 0,
        identifiers: byType.get("identifier_cache") ?? 0,
        memory: memory.n,
      };
    } catch {
      return empty;
    }
  }

  deleteEmbeddingsByPrefix(sourceType: string, prefix: string): void {
    if (!this.hasVectorTables()) return;
    const result = this.db.prepare("DELETE FROM embeddings WHERE source_type = ? AND source_id LIKE ?").run(sourceType, `${prefix}%`);
    if (result.changes) this.bumpEmbeddingRevision();
  }

  searchEmbeddings(queryVector: number[] | Float32Array, topK: number, sourceType?: string): EmbeddingMatch[] {
    if (!this.vecDimension || queryVector.length !== this.vecDimension || !this.hasVectorTables()) return [];
    const buf = vecToBuffer(queryVector);
    const count = sourceType
      ? (this.db.prepare("SELECT count(*) as n FROM embeddings").get() as { n: number }).n
      : topK;
    const fetchK = Math.max(topK, count);
    const sql = "SELECT rowid, source_type, source_id, content_hash, distance FROM embeddings WHERE vector MATCH ? ORDER BY distance LIMIT ?";
    const raw = this.db.prepare(sql).all(buf, fetchK) as { rowid: number; source_type: string; source_id: string; content_hash: string; distance: number }[];
    const filtered = sourceType ? raw.filter((r) => r.source_type === sourceType) : raw;
    return filtered.slice(0, topK).map((r) => ({
      rowid: r.rowid,
      sourceType: r.source_type,
      sourceId: r.source_id,
      contentHash: r.content_hash,
      distance: r.distance,
    }));
  }

  getEmbeddingBySource(sourceType: string, sourceId: number): { vector: Buffer; hash: string } | null {
    if (!this.hasVectorTables()) return null;
    const row = this.db.prepare("SELECT rowid, content_hash FROM embeddings WHERE source_type = ? AND source_id = ?")
      .get(sourceType, String(sourceId)) as { rowid: number; content_hash: string } | undefined;
    return row ? { vector: Buffer.alloc(0), hash: row.content_hash } : null;
  }

  getEmbeddingHash(sourceType: string, sourceId: number): string | null {
    if (!this.hasVectorTables()) return null;
    const row = this.db.prepare("SELECT content_hash FROM embeddings WHERE source_type = ? AND source_id = ?")
      .get(sourceType, String(sourceId)) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  getMemoryRevision(): number { return Number(this.getMeta("memory_revision") ?? "0"); }

  private bumpMemoryRevision(): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('memory_revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  }

  upsertMemoryNode(input: MemoryNodeInput, embedding?: number[], model?: {provider: string; model: string}): string {
    return this.db.transaction(() => {
      const compatible = !model || (this.getMeta("embed_provider") === model.provider && this.getMeta("embed_model") === model.model);
      return this.upsertMemoryNodeInTransaction(input, compatible ? embedding : undefined);
    }).immediate();
  }

  private upsertMemoryNodeInTransaction(input: MemoryNodeInput, embedding?: number[]): string {
    const now = Date.now();
    const existing = this.db.prepare("SELECT id, content FROM memory_nodes WHERE label = ? AND type = ?").get(input.label, input.type) as { id: string; content: string } | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_nodes SET content = ?, last_accessed = ?, access_count = access_count + 1, metadata = ? WHERE id = ?")
        .run(input.content, now, JSON.stringify(input.metadata ?? {}), existing.id);
      this.bumpMemoryRevision();
      if (existing.content !== input.content && this.hasVectorTables()) {
        this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(existing.id);
      }
      if (this.hasUsableEmbedding(embedding)) {
        this.ensureVecDimension(embedding.length);
        this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(existing.id);
        this.db.prepare("INSERT INTO memory_embeddings (vector, node_id) VALUES (?, ?)").run(vecToBuffer(embedding), existing.id);
      }
      return existing.id;
    }

    const id = input.id ?? generateId("node");
    this.db.prepare("INSERT INTO memory_nodes (id, type, label, content, created_at, last_accessed, access_count, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, input.type, input.label, input.content, now, now, JSON.stringify(input.metadata ?? {}));
    this.bumpMemoryRevision();
    if (this.hasUsableEmbedding(embedding)) {
      this.ensureVecDimension(embedding.length);
      this.db.prepare("INSERT INTO memory_embeddings (vector, node_id) VALUES (?, ?)").run(vecToBuffer(embedding), id);
    }
    return id;
  }

  peekMemoryNode(id: string): MemoryNodeRow | null {
    return this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as MemoryNodeRow | undefined ?? null;
  }

  findMemoryNodeByLabel(type: string, label: string): MemoryNodeRow | null {
    return this.db.prepare("SELECT * FROM memory_nodes WHERE type = ? AND label = ?").get(type, label) as MemoryNodeRow | undefined ?? null;
  }

  getMemoryNode(id: string): MemoryNodeRow | null {
    const row = this.peekMemoryNode(id);
    if (row) {
      this.db.prepare("UPDATE memory_nodes SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?").run(Date.now(), id);
    }
    return row;
  }

  listMemoryNodes(): MemoryNodeRow[] {
    return this.db.prepare("SELECT * FROM memory_nodes ORDER BY last_accessed DESC, created_at DESC").all() as MemoryNodeRow[];
  }

  listMemoryNodesWithoutEmbeddings(): MemoryNodeRow[] {
    if (!this.hasVectorTables()) return this.listMemoryNodes();
    return this.db.prepare("SELECT * FROM memory_nodes WHERE id NOT IN (SELECT node_id FROM memory_embeddings)").all() as MemoryNodeRow[];
  }

  setMemoryEmbedding(node: Pick<MemoryNodeRow, "id" | "label" | "content">, embedding: number[]): boolean {
    return this.db.transaction(() => {
      const current = this.peekMemoryNode(node.id);
      // Keep the revision check and publication in one SQLite transaction so
      // another process cannot change the node between the check and write.
      if (!current || current.label !== node.label || current.content !== node.content) return false;
      if (!this.hasUsableEmbedding(embedding)) throw new Error(`Invalid memory embedding for ${node.id}`);
      this.ensureVecDimension(embedding.length);
      this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(node.id);
      this.db.prepare("INSERT INTO memory_embeddings (vector, node_id) VALUES (?, ?)").run(vecToBuffer(embedding), node.id);
      this.bumpMemoryRevision();
      return true;
    }).immediate();
  }

  deleteMemoryNode(id: string): void {
    if (this.hasVectorTables()) {
      try {
        this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(id);
      } catch {}
    }
    this.db.prepare("DELETE FROM memory_edges WHERE source = ? OR target = ?").run(id, id);
    if (this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id).changes > 0) this.bumpMemoryRevision();
  }

  upsertMemoryEdge(input: MemoryEdgeInput): string {
    const existing = this.db.prepare("SELECT id FROM memory_edges WHERE source = ? AND target = ? AND relation = ?")
      .get(input.source, input.target, input.relation) as { id: string } | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_edges SET weight = ?, metadata = ? WHERE id = ?")
        .run(input.weight ?? 1.0, JSON.stringify(input.metadata ?? {}), existing.id);
      this.bumpMemoryRevision();
      return existing.id;
    }

    const id = input.id ?? generateId("edge");
    this.db.prepare("INSERT INTO memory_edges (id, source, target, relation, weight, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.source, input.target, input.relation, input.weight ?? 1.0, Date.now(), JSON.stringify(input.metadata ?? {}));
    this.bumpMemoryRevision();
    return id;
  }

  deleteMemoryEdge(id: string): void {
    if (this.db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id).changes > 0) this.bumpMemoryRevision();
  }

  getMemoryEdgesForNode(id: string): MemoryEdgeRow[] {
    return this.db.prepare("SELECT * FROM memory_edges WHERE source = ? OR target = ?").all(id, id) as MemoryEdgeRow[];
  }

  searchMemoryNodes(queryVector: number[], topK: number = 5): MemorySearchResult[] {
    if (!this.vecDimension || queryVector.length !== this.vecDimension || !this.hasVectorTables()) return [];
    const buf = vecToBuffer(queryVector);
    let vecResults: { node_id: string; distance: number }[] = [];
    try {
      vecResults = this.db.prepare("SELECT node_id, distance FROM memory_embeddings WHERE vector MATCH ? ORDER BY distance LIMIT ?")
        .all(buf, topK) as { node_id: string; distance: number }[];
    } catch {
      return [];
    }

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
      const pendingNeighbors: Array<{ neighborId: string; edge: MemoryEdgeRow; current: typeof frontier[number] }> = [];

      for (const current of frontier) {
        const edges = this.db.prepare("SELECT * FROM memory_edges WHERE source = ? OR target = ?")
          .all(current.id, current.id) as MemoryEdgeRow[];
        for (const edge of edges) {
          if (edgeFilter && !edgeFilter.includes(edge.relation)) continue;
          const neighborId = edge.source === current.id ? edge.target : edge.source;
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);
          pendingNeighbors.push({ neighborId, edge, current });
        }
      }

      if (pendingNeighbors.length === 0) break;

      const ids = pendingNeighbors.map((p) => p.neighborId);
      const placeholders = ids.map(() => "?").join(", ");
      const nodeMap = new Map<string, MemoryNodeRow>(
        (this.db.prepare(`SELECT * FROM memory_nodes WHERE id IN (${placeholders})`).all(...ids) as MemoryNodeRow[])
          .map((n) => [n.id, n]),
      );

      const now = Date.now();
      for (const { neighborId, edge, current } of pendingNeighbors) {
        const node = nodeMap.get(neighborId);
        if (!node) continue;
        const daysSince = (now - edge.created_at) / 86_400_000;
        const decayed = edge.weight * Math.exp(-DECAY_LAMBDA * daysSince);
        const score = decayed * (1 / (d + 2));
        const pathRelations = [...current.pathRelations, edge.relation];
        results.push({ node, depth: d + 1, pathRelations, relevanceScore: score });
        nextFrontier.push({ id: neighborId, depth: d + 1, pathRelations, score });
      }

      frontier = nextFrontier;
    }

    return results;
  }

  pruneStaleEdges(threshold: number = STALE_EDGE_THRESHOLD): { edgesRemoved: number; nodesRemoved: number } {
    const now = Date.now();
    const edges = this.db.prepare("SELECT id, weight, created_at FROM memory_edges").all() as Pick<MemoryEdgeRow, "id" | "weight" | "created_at">[];
    const staleEdgeIds: string[] = [];

    for (const edge of edges) {
      const daysSince = (now - edge.created_at) / 86_400_000;
      const decayed = edge.weight * Math.exp(-DECAY_LAMBDA * daysSince);
      if (decayed < threshold) staleEdgeIds.push(edge.id);
    }

    const orphans = this.db.prepare(`
      SELECT id FROM memory_nodes
      WHERE id NOT IN (SELECT source FROM memory_edges)
      AND id NOT IN (SELECT target FROM memory_edges)
      AND access_count < ?
      AND last_accessed < ?
    `).all(STALE_NODE_MIN_ACCESS, now - STALE_NODE_DAYS * 86_400_000) as { id: string }[];

    const prune = this.db.transaction(() => {
      if (staleEdgeIds.length > 0) {
        const placeholders = staleEdgeIds.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM memory_edges WHERE id IN (${placeholders})`).run(...staleEdgeIds);
        this.bumpMemoryRevision();
      }
      for (const orphan of orphans) this.deleteMemoryNode(orphan.id);
      this.setMeta("last_prune", String(now));
    });
    prune();

    return { edgesRemoved: staleEdgeIds.length, nodesRemoved: orphans.length };
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

  deleteImportsForFile(fileId: number): void {
    this.db.prepare("DELETE FROM imports WHERE source_file_id = ?").run(fileId);
  }

  getImportsFrom(fileId: number): ImportRow[] {
    return this.db.prepare("SELECT * FROM imports WHERE source_file_id = ?").all(fileId) as ImportRow[];
  }

  getImportersOf(fileId: number): ImportRow[] {
    return this.db.prepare("SELECT * FROM imports WHERE target_file_id = ?").all(fileId) as ImportRow[];
  }

  getAllImports(): ImportRow[] {
    return this.db.prepare("SELECT * FROM imports").all() as ImportRow[];
  }

  updateImportTarget(importId: number, targetFileId: number | null): void {
    this.db.prepare("UPDATE imports SET target_file_id = ? WHERE id = ?").run(targetFileId, importId);
  }

  upsertCallSites(fileId: number, sites: Array<{ callee: string; line: number; context: string }>): void {
    this.db.prepare("DELETE FROM call_sites WHERE file_id = ?").run(fileId);
    const insert = this.db.prepare("INSERT INTO call_sites (file_id, callee, line, context) VALUES (?, ?, ?, ?)");
    const tx = this.db.transaction((rows: typeof sites) => {
      for (const s of rows) insert.run(fileId, s.callee, s.line, s.context);
    });
    tx(sites);
  }

  getCallSitesByFile(fileId: number): CallSiteRow[] {
    return this.db.prepare("SELECT * FROM call_sites WHERE file_id = ?").all(fileId) as CallSiteRow[];
  }

  getCallersOf(callee: string): CallSiteRow[] {
    return this.db.prepare("SELECT * FROM call_sites WHERE callee = ?").all(callee) as CallSiteRow[];
  }

  upsertFileSearchDocument(input: {
    path: string;
    header?: string | null;
    language?: string | null;
    symbols?: Array<{ name: string; kind?: string; signature?: string | null }>;
    content?: string;
  }): void {
    const symbolText = (input.symbols ?? [])
      .map((symbol) => `${symbol.name} ${symbol.kind ?? ""} ${symbol.signature ?? ""}`)
      .join(" ");
    const body = `${input.path} ${input.header ?? ""} ${input.language ?? ""} ${symbolText} ${input.content ?? ""}`;
    this.deleteFileSearchDocument(input.path);
    this.db.prepare("INSERT INTO file_search_fts (path, header, symbols, language, body) VALUES (?, ?, ?, ?, ?)")
      .run(input.path, input.header ?? "", symbolText, input.language ?? "", body);
  }

  deleteFileSearchDocument(path: string): void {
    // path is UNINDEXED in FTS5, so filtering it alone scans every stored body
    // once per source file. Every document's body already contains its path;
    // use that inverted index to find candidates, then check the exact path to
    // distinguish punctuation/stemming collisions. No new persisted mapping.
    if (/[\p{L}\p{N}]/u.test(path) && !path.includes("\0")) {
      this.db.prepare(`DELETE FROM file_search_fts WHERE rowid IN (
        SELECT rowid FROM file_search_fts WHERE file_search_fts MATCH ? AND path = ?
      )`).run(`body : "${path.replace(/"/g, '""')}"`, path);
    } else {
      // Unusual standalone documents may have no searchable path tokens.
      this.db.prepare("DELETE FROM file_search_fts WHERE path = ?").run(path);
    }
  }

  searchFileText(query: string, topK: number = 10, phraseOnly = false, requireAllTerms = false): FileTextSearchMatch[] {
    const stopwords = new Set([
      "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from",
      "how", "i", "if", "in", "is", "it", "of", "on", "or", "the", "to", "what", "where",
      "which", "who", "why", "with",
    ]);
    const queryWords = (query.normalize("NFC").match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => (term.length > 1 || /[^\x00-\x7F]/u.test(term)) && !stopwords.has(term));
    // Strict topic lookups must not silently discard their final constraints.
    if (requireAllTerms && queryWords.length > 64) return [];
    const terms = queryWords.slice(0, requireAllTerms ? 64 : 12);
    if (terms.length === 0 && !phraseOnly) return [];
    const limit = Math.max(1, topK);
    const literal = query.normalize("NFC").trim().replace(/^(["'`])([\s\S]*)\1$/, "$2");
    const runQuery = (ftsQuery: string) => this.db.prepare(`SELECT path, bm25(file_search_fts) as score FROM file_search_fts WHERE file_search_fts MATCH ?${phraseOnly ? " AND contextpro_literal_contains(body, ?)" : ""} ORDER BY score LIMIT ?`)
      .all(...(phraseOnly ? [ftsQuery, literal.toLowerCase(), limit] : [ftsQuery, limit])) as FileTextSearchMatch[];
    try {
      // Preserve phrase order before broadening to token/prefix matches. Quoting
      // tokens also keeps Unicode and FTS syntax out of the query grammar.
      const phraseRows = runQuery(`"${literal.replace(/"/g, '""')}"`);
      if (phraseOnly || phraseRows.length > 0) return phraseRows;
      if (terms.length > 1) {
        const andRows = runQuery(terms.map((term) => `"${term}"*`).join(" "));
        if (andRows.length > 0 || requireAllTerms) return andRows;
      }
      return runQuery(terms.map((term) => `"${term}"*`).join(" OR "));
    } catch {
      return [];
    }
  }

  getGraphStats(): { totalNodes: number; totalEdges: number } {
    const nodes = this.db.prepare("SELECT count(*) as n FROM memory_nodes").get() as { n: number };
    const edges = this.db.prepare("SELECT count(*) as n FROM memory_edges").get() as { n: number };
    return { totalNodes: nodes.n, totalEdges: edges.n };
  }

  /** Append one tool-call event. Best-effort telemetry — callers must not let a
   * failure here break the tool itself. Prunes opportunistically to a bounded size. */
  recordToolCall(
    tool: string,
    status: "ok" | "error",
    durationMs: number,
    calledAt: number,
    efficiency: ToolCallEfficiency = {},
    sessionId?: string,
  ): void {
    this.db.prepare(
      `INSERT INTO tool_calls (
         tool, status, duration_ms, called_at, input_tokens_est, output_tokens_est,
         source_tokens_est, saved_tokens_est, represented_files, session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tool,
      status,
      Math.max(0, Math.round(durationMs)),
      calledAt,
      Math.max(0, Math.round(efficiency.inputTokens ?? 0)),
      Math.max(0, Math.round(efficiency.outputTokens ?? 0)),
      Math.max(0, Math.round(efficiency.sourceTokens ?? 0)),
      Math.max(0, Math.round(efficiency.savedTokens ?? 0)),
      Math.max(0, Math.round(efficiency.representedFiles ?? 0)),
      sessionId ?? null,
    );
  }

  /** Most-recent tool calls, newest first. */
  getToolCallHistory(limit: number = 200): ToolCallHistoryRow[] {
    const rows = this.db.prepare(
      `SELECT tool, status, duration_ms as durationMs, called_at as calledAt,
              input_tokens_est as inputTokens, output_tokens_est as outputTokens,
              source_tokens_est as sourceTokens, saved_tokens_est as savedTokens,
              represented_files as representedFiles
       FROM tool_calls ORDER BY called_at DESC, id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(2000, limit))) as ToolCallHistoryRow[];
    return rows;
  }

  /** Recent calls with a positive savings estimate, optionally bounded by time. */
  getToolSavingsHistory(limit: number = 20, sinceMs?: number, sessionId?: string): ToolCallHistoryRow[] {
    const filters = ["saved_tokens_est > 0"];
    const params: Array<number | string> = [];
    if (sinceMs !== undefined) { filters.push("called_at >= ?"); params.push(sinceMs); }
    if (sessionId !== undefined) { filters.push("session_id = ?"); params.push(sessionId); }
    const where = `WHERE ${filters.join(" AND ")}`;
    const stmt = this.db.prepare(
      `SELECT tool, status, duration_ms as durationMs, called_at as calledAt,
              input_tokens_est as inputTokens, output_tokens_est as outputTokens,
              source_tokens_est as sourceTokens, saved_tokens_est as savedTokens,
              represented_files as representedFiles
       FROM tool_calls ${where}
       ORDER BY called_at DESC, id DESC LIMIT ?`,
    );
    const boundedLimit = Math.max(1, Math.min(100, limit));
    return stmt.all(...params, boundedLimit) as ToolCallHistoryRow[];
  }

  /** Per-tool aggregates over the whole history (or since a timestamp). */
  getToolCallAggregates(sinceMs?: number, sessionId?: string): ToolEfficiencyAggregate[] {
    const filters: string[] = [];
    const params: Array<number | string> = [];
    if (sinceMs !== undefined) { filters.push("called_at >= ?"); params.push(sinceMs); }
    if (sessionId !== undefined) { filters.push("session_id = ?"); params.push(sessionId); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT tool,
              COUNT(*) as calls,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
              AVG(duration_ms) as avgMs,
              MAX(duration_ms) as maxMs,
              MAX(called_at) as lastAt,
              SUM(input_tokens_est) as inputTokens,
              SUM(output_tokens_est) as outputTokens,
              SUM(source_tokens_est) as sourceTokens,
              SUM(saved_tokens_est) as savedTokens,
              SUM(represented_files) as representedFiles
       FROM tool_calls ${where}
       GROUP BY tool
       ORDER BY calls DESC`,
    );
    const rows = stmt.all(...params) as ToolEfficiencyAggregate[];
    return rows.map((r) => ({ ...r, avgMs: Math.round(r.avgMs) }));
  }

  getEfficiencyTotals(sinceMs?: number, sessionId?: string): Omit<ToolEfficiencyAggregate, "tool" | "avgMs" | "maxMs"> & { avgMs: number; maxMs: number } {
    const filters: string[] = [];
    const params: Array<number | string> = [];
    if (sinceMs !== undefined) { filters.push("called_at >= ?"); params.push(sinceMs); }
    if (sessionId !== undefined) { filters.push("session_id = ?"); params.push(sessionId); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avgMs,
              COALESCE(MAX(duration_ms), 0) as maxMs,
              COALESCE(MAX(called_at), 0) as lastAt,
              COALESCE(SUM(input_tokens_est), 0) as inputTokens,
              COALESCE(SUM(output_tokens_est), 0) as outputTokens,
              COALESCE(SUM(source_tokens_est), 0) as sourceTokens,
              COALESCE(SUM(saved_tokens_est), 0) as savedTokens,
              COALESCE(SUM(represented_files), 0) as representedFiles
       FROM tool_calls ${where}`,
    );
    const row = stmt.get(...params) as Omit<ToolEfficiencyAggregate, "tool">;
    return { ...row, avgMs: Math.round(row.avgMs) };
  }

  getToolCallTotal(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM tool_calls").get() as { n: number }).n;
  }

  /** Keep the table bounded: delete all but the newest `keep` rows. */
  pruneToolCalls(keep: number = 5000): number {
    const info = this.db.prepare(
      "DELETE FROM tool_calls WHERE id NOT IN (SELECT id FROM tool_calls ORDER BY id DESC LIMIT ?)",
    ).run(keep);
    return info.changes;
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

  /**
   * Atomic compare-and-set on the meta table. Returns true if the previous value matched
   * `expected` and `next` was written; false otherwise. Both reads and writes happen inside
   * an IMMEDIATE transaction so concurrent callers cannot race past the guard.
   */
  compareAndSetMeta(key: string, expected: string | null, next: string | null, extra?: Array<[string, string]>): boolean {
    const txn = this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      const current = row?.value ?? null;
      if (current !== expected) return false;
      if (next === null) {
        this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
      } else {
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, next);
      }
      if (extra) {
        const insert = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
        for (const [k, v] of extra) insert.run(k, v);
      }
      return true;
    });
    // BEGIN IMMEDIATE acquires the write lock up-front so the SELECT inside the transaction
    // can't be raced by a concurrent SELECT-then-INSERT from another tool call.
    return txn.immediate();
  }

  setMetaBatch(entries: Array<[string, string]>): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    const tx = this.db.transaction((rows: Array<[string, string]>) => {
      for (const [key, value] of rows) insert.run(key, value);
    });
    tx(entries);
  }

  close(): void {
    this.db.close();
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  /** Commit a synchronous group of related index writes, or roll them all back. */
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  /**
   * Flush the WAL into the main index.db so an on-disk copy of the file is fully
   * current. Used before seeding a worktree from this base index. TRUNCATE resets
   * the WAL after checkpointing. Best-effort: a busy checkpoint is non-fatal.
   */
  checkpoint(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // A concurrent writer can block a full checkpoint; the seed tolerates a
      // slightly stale copy because the worktree's incremental reindex reconciles.
    }
  }
}

/** Checkpoint the base DB (if open) so a file copy captures all committed rows. */
export function checkpointDB(rootDir: string): void {
  const db = dbInstances.get(resolve(rootDir));
  if (db) db.checkpoint();
}

const dbInstances = new Map<string, ContextPlusDB>();

export async function getDB(rootDir: string): Promise<ContextPlusDB> {
  const normalizedRoot = resolve(rootDir);
  const existing = dbInstances.get(normalizedRoot);
  if (existing) return existing;
  await ensureNativeStorage();
  await ensureContextProDir(normalizedRoot);
  // Another request may have opened this root while native repair was awaited.
  const opened = dbInstances.get(normalizedRoot);
  if (opened) return opened;
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
