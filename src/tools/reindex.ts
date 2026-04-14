// Re-walk, re-parse, and re-index project files into SQLite database
// FEATURE: Reindex — persistent file/symbol/import graph population

import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile, extractImports, extractCallSites } from "../core/parser.js";
import { getDB, hashContent, type ContextPlusDB } from "../core/db.js";
import { readFile, stat } from "fs/promises";
import { resolve, extname, dirname, relative } from "path";
import { invalidateSearchCache, refreshFileSearchEmbeddings } from "./semantic-search.js";
import { invalidateIdentifierSearchCache, refreshIdentifierEmbeddings } from "./semantic-identifiers.js";
import { autoGenerateHubData } from "./feature-hub.js";
import { toolUpsertMemoryNode } from "./memory-tools.js";

export interface ReindexOptions {
  rootDir: string;
  targetPath?: string;
  force?: boolean;
}

export interface ReindexResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  removed: number;
  symbols: number;
  imports: number;
  durationMs: number;
}

interface WaitForIndexingOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const INDEX_STATUS_KEY = "index_status";
const INDEX_STARTED_AT_KEY = "index_started_at";
const INDEX_FINISHED_AT_KEY = "index_finished_at";
const INDEX_TARGET_PATH_KEY = "index_target_path";
const LAST_INDEX_ERROR_KEY = "last_index_error";
const INDEXING_STATUS = "indexing";
const IDLE_STATUS = "idle";

function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".cs": "csharp", ".c": "c", ".cpp": "cpp",
    ".rb": "ruby", ".swift": "swift", ".kt": "kotlin",
  };
  return map[ext] ?? null;
}

function resolveImportPath(importSource: string, fromFile: string, allFiles: Set<string>, rootDir: string): string | null {
  if (!importSource.startsWith(".")) return null;
  const fromDir = dirname(resolve(rootDir, fromFile));
  const candidates = [
    resolve(fromDir, importSource),
    resolve(fromDir, importSource + ".ts"),
    resolve(fromDir, importSource + ".tsx"),
    resolve(fromDir, importSource + ".js"),
    resolve(fromDir, importSource + ".jsx"),
    resolve(fromDir, importSource.replace(/\.js$/, ".ts")),
    resolve(fromDir, importSource + "/index.ts"),
    resolve(fromDir, importSource + "/index.js"),
  ];
  for (const c of candidates) {
    const rel = relative(rootDir, c).replace(/\\/g, "/");
    if (allFiles.has(rel)) return rel;
  }
  return null;
}

function setIndexStatus(db: ContextPlusDB, status: string, input?: { targetPath?: string; error?: string | null }): void {
  db.setMeta(INDEX_STATUS_KEY, status);
  if (status === INDEXING_STATUS) {
    db.setMeta(INDEX_STARTED_AT_KEY, String(Date.now()));
    db.setMeta(INDEX_TARGET_PATH_KEY, input?.targetPath ?? "");
    db.setMeta(LAST_INDEX_ERROR_KEY, "");
    return;
  }
  db.setMeta(INDEX_FINISHED_AT_KEY, String(Date.now()));
  db.setMeta(INDEX_TARGET_PATH_KEY, "");
  db.setMeta(LAST_INDEX_ERROR_KEY, input?.error ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForIndexingCompletion(
  rootDir: string,
  options: WaitForIndexingOptions = {},
): Promise<{ waited: boolean; timedOut: boolean }> {
  const timeoutMs = Math.max(500, options.timeoutMs ?? 30_000);
  const pollMs = Math.max(50, options.pollMs ?? 250);
  const db = await getDB(rootDir);
  const startedAt = Date.now();
  let waited = false;

  while (db.getMeta(INDEX_STATUS_KEY) === INDEXING_STATUS) {
    waited = true;
    if (Date.now() - startedAt >= timeoutMs) {
      return { waited, timedOut: true };
    }
    await sleep(pollMs);
  }

  return { waited, timedOut: false };
}

export async function reindex(options: ReindexOptions): Promise<string> {
  const start = Date.now();
  const db = await getDB(options.rootDir);
  setIndexStatus(db, INDEXING_STATUS, { targetPath: options.targetPath });
  try {
    const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
    const files = entries.filter((e) => !e.isDirectory);

    const currentPaths = new Set(files.map((f) => f.relativePath));
    const currentHashes = new Map<string, string>();
    let totalSymbols = 0;
    let totalImports = 0;
    let indexed = 0;
    let skipped = 0;

    for (const file of files) {
      if (!isSupportedFile(file.path)) { skipped++; continue; }

      try {
        const content = await readFile(file.path, "utf-8");
        const hash = hashContent(content);
        currentHashes.set(file.relativePath, hash);

        const existing = db.getFile(file.relativePath);
        if (existing && existing.content_hash === hash && !options.force) {
          skipped++;
          continue;
        }

        const analysis = await analyzeFile(file.path);
        const flatSymbols = flattenSymbols(analysis.symbols);
        const lang = detectLanguage(file.path);
        const fileSize = (await stat(file.path)).size;

        const fileId = db.upsertFile(file.relativePath, hash, analysis.header, lang, fileSize);
        db.upsertSymbols(fileId, flatSymbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          lineStart: s.line,
          lineEnd: s.endLine,
          signature: s.signature,
          parentSymbolId: undefined,
        })));

        const imports = extractImports(content, file.path);
        for (const imp of imports) {
          const targetRel = resolveImportPath(imp.source, file.relativePath, currentPaths, options.rootDir);
          const targetFile = targetRel ? db.getFile(targetRel) : null;
          db.upsertImport(fileId, imp.source, targetFile?.id ?? null, imp.type, imp.specifiers.length > 0 ? imp.specifiers : undefined);
          totalImports++;
        }

        db.upsertCallSites(fileId, extractCallSites(content));

        totalSymbols += flatSymbols.length;
        indexed++;
      } catch {
        skipped++;
      }
    }

    const removed = options.targetPath ? [] : db.getRemovedFiles(currentPaths);
    for (const path of removed) db.deleteFile(path);

    let autoHubCount = 0;
    if (!options.targetPath) {
      const hubResult = await autoGenerateHubData(options.rootDir).catch(() => null);
      autoHubCount = hubResult?.generated.length ?? 0;
    }

    const duration = Date.now() - start;
    db.bumpIndexGeneration();
    db.setMeta("last_reindex_at", String(Date.now()));
    db.setMeta("last_reindex_duration_ms", String(duration));
    db.setMeta("last_auto_hub_count", String(autoHubCount));
    setIndexStatus(db, IDLE_STATUS, { targetPath: options.targetPath, error: null });

    invalidateSearchCache();
    invalidateIdentifierSearchCache();

    if (!options.targetPath) {
      toolUpsertMemoryNode({
        rootDir: options.rootDir,
        type: "note",
        label: "index-snapshot",
        content: `Reindex completed at ${new Date().toISOString()}. Files: ${files.length} total, ${indexed} indexed, ${skipped} skipped. Symbols: ${totalSymbols}. Imports: ${totalImports}. Duration: ${duration}ms.`,
        scope: "project",
      }).catch(() => undefined);
    }

    const lines = [
      `Reindex complete in ${duration}ms`,
      `  Files: ${files.length} total, ${indexed} indexed, ${skipped} skipped, ${removed.length} removed`,
      `  Symbols: ${totalSymbols} extracted`,
      `  Imports: ${totalImports} resolved`,
    ];
    if (!options.targetPath) lines.push(`  Auto hubs: ${autoHubCount}`);
    if (options.force) lines.push("  Mode: force (all files re-processed)");
    if (options.targetPath) lines.push(`  Scope: ${options.targetPath}`);

    return lines.join("\n");
  } catch (error) {
    setIndexStatus(db, IDLE_STATUS, {
      targetPath: options.targetPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function quickRefresh(rootDir: string): Promise<{
  staleCount: number;
  refreshed: boolean;
  waitedForIndexing?: boolean;
  indexingTimedOut?: boolean;
  changedSymbols?: string[];
}> {
  const waitState = await waitForIndexingCompletion(rootDir);
  if (waitState.timedOut) {
    return {
      staleCount: 0,
      refreshed: false,
      waitedForIndexing: waitState.waited,
      indexingTimedOut: true,
    };
  }
  const db = await getDB(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((e) => !e.isDirectory && isSupportedFile(e.path));

  const currentHashes = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await readFile(file.path, "utf-8");
      currentHashes.set(file.relativePath, hashContent(content));
    } catch {}
  }

  const stale = db.getStaleFiles(currentHashes);
  const currentPaths = new Set(files.map((f) => f.relativePath));
  const removed = db.getRemovedFiles(currentPaths);
  const totalStale = stale.length + removed.length;

  if (totalStale === 0) {
    return { staleCount: 0, refreshed: false, waitedForIndexing: waitState.waited, indexingTimedOut: false };
  }

  const maxStale = Math.max(1, parseInt(process.env.CONTEXTPLUS_QUICKREFRESH_MAX_FILES ?? "30", 10));
  if (totalStale <= maxStale) {
    const changedSymbols: string[] = [];
    for (const path of stale) {
      try {
        const fullPath = resolve(rootDir, path);
        const content = await readFile(fullPath, "utf-8");
        const hash = hashContent(content);
        const analysis = await analyzeFile(fullPath);
        const flatSymbols = flattenSymbols(analysis.symbols);
        const lang = detectLanguage(fullPath);
        const fileSize = (await stat(fullPath)).size;

        const existingFile = db.getFile(path);
        const oldSymbolNames = existingFile ? new Set(db.getSymbolsByFile(existingFile.id).map((s) => s.name)) : new Set<string>();
        const newSymbolNames = new Set(flatSymbols.map((s) => s.name));
        for (const name of newSymbolNames) {
          if (!oldSymbolNames.has(name)) changedSymbols.push(`+${path}:${name}`);
        }
        for (const name of oldSymbolNames) {
          if (!newSymbolNames.has(name)) changedSymbols.push(`-${path}:${name}`);
        }

        const fileId = db.upsertFile(path, hash, analysis.header, lang, fileSize);
        db.upsertSymbols(fileId, flatSymbols.map((s) => ({
          name: s.name, kind: s.kind, lineStart: s.line, lineEnd: s.endLine, signature: s.signature,
        })));
        const imports = extractImports(content, fullPath);
        for (const imp of imports) {
          const targetRel = resolveImportPath(imp.source, path, currentPaths, rootDir);
          const targetFile = targetRel ? db.getFile(targetRel) : null;
          db.upsertImport(fileId, imp.source, targetFile?.id ?? null, imp.type, imp.specifiers.length > 0 ? imp.specifiers : undefined);
        }
        db.upsertCallSites(fileId, extractCallSites(content));
      } catch {}
    }
    for (const path of removed) db.deleteFile(path);
    db.bumpIndexGeneration();
    db.setMeta("last_reindex_at", String(Date.now()));
    db.setMeta("last_reindex_duration_ms", "0");

    await Promise.all([
      refreshFileSearchEmbeddings({ rootDir, relativePaths: stale }).catch(() => 0),
      refreshIdentifierEmbeddings({ rootDir, relativePaths: stale }).catch(() => 0),
    ]);

    return { staleCount: totalStale, refreshed: true, waitedForIndexing: waitState.waited, indexingTimedOut: false, changedSymbols };
  }

  return { staleCount: totalStale, refreshed: false, waitedForIndexing: waitState.waited, indexingTimedOut: false };
}
