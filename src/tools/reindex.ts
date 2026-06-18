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
import { resolveProjectPath } from "../core/path-guard.js";
import { getEmbedProvider, getEmbedModel } from "../core/embeddings.js";

export interface ReindexOptions {
  rootDir: string;
  targetPath?: string;
  force?: boolean;
  noEmbed?: boolean;
}

export interface ReindexResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  removed: number;
  symbols: number;
  imports: number;
  durationMs: number;
  embeddings?: { files: number; identifiers: number; skipped: boolean };
}

interface WaitForIndexingOptions {
  timeoutMs?: number;
  pollMs?: number;
}

interface PendingImportSet {
  fileId: number;
  imports: ReturnType<typeof extractImports>;
}

const INDEX_STATUS_KEY = "index_status";
const INDEX_STARTED_AT_KEY = "index_started_at";
const INDEX_FINISHED_AT_KEY = "index_finished_at";
const INDEX_TARGET_PATH_KEY = "index_target_path";
const LAST_INDEX_ERROR_KEY = "last_index_error";
const INDEXING_STATUS = "indexing";
const IDLE_STATUS = "idle";
const MAX_SEARCH_BODY_CHARS = 4000;

function isReindexEmbedDisabled(): boolean {
  const raw = (process.env.CONTEXTPRO_REINDEX_NO_EMBED ?? process.env.CONTEXTPLUS_REINDEX_NO_EMBED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

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

function buildSearchBody(content: string): string {
  const lines = content.split("\n");
  const selected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isComment = /^(\/\/|#|--|\/\*|\*)/.test(trimmed);
    const isMeaningfulCode = /\b(function|class|interface|type|const|let|var|def|return|if|for|while|match|case|filter|map|reduce|where|select)\b/.test(trimmed);
    if (!isComment && !isMeaningfulCode) continue;
    selected.push(trimmed.slice(0, 180));
    if (selected.join("\n").length >= MAX_SEARCH_BODY_CHARS) break;
  }

  const summary = selected.join("\n");
  return (summary || content).slice(0, MAX_SEARCH_BODY_CHARS);
}

function toProjectRelative(rootDir: string, candidate: string): string | null {
  const rel = relative(rootDir, candidate).replace(/\\/g, "/");
  if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) return null;
  return rel;
}

function firstExistingPath(candidates: string[], allFiles: Set<string>, rootDir: string): string | null {
  for (const candidate of candidates) {
    const rel = toProjectRelative(rootDir, candidate);
    if (rel && allFiles.has(rel)) return rel;
  }
  return null;
}

function findUniqueSuffixPath(suffixes: string[], allFiles: Set<string>): string | null {
  const matches = [...allFiles].filter((file) => suffixes.some((suffix) => file === suffix || file.endsWith(`/${suffix}`)));
  return matches.length === 1 ? matches[0] : null;
}

function pythonModuleCandidates(moduleSource: string, fromFile: string, rootDir: string): { absolute: string[]; suffixes: string[] } {
  const fromDir = dirname(resolve(rootDir, fromFile));
  const leadingDots = moduleSource.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = moduleSource.slice(leadingDots);
  const modulePath = moduleName.replace(/\./g, "/");
  let relativeBase = fromDir;
  if (leadingDots > 0) {
    for (let i = 1; i < leadingDots; i++) relativeBase = resolve(relativeBase, "..");
  }
  const base = leadingDots > 0 ? relativeBase : resolve(rootDir);
  const absolute = modulePath.length > 0
    ? [
        resolve(base, `${modulePath}.py`),
        resolve(base, modulePath, "__init__.py"),
      ]
    : [resolve(base, "__init__.py")];

  if (leadingDots === 0 && !moduleName.includes(".")) {
    absolute.unshift(
      resolve(fromDir, `${modulePath}.py`),
      resolve(fromDir, modulePath, "__init__.py"),
    );
  }

  const suffixes = modulePath.length > 0
    ? [`${modulePath}.py`, `${modulePath}/__init__.py`]
    : [];
  return { absolute, suffixes };
}

function resolvePythonImportPath(importSource: string, fromFile: string, allFiles: Set<string>, rootDir: string, specifiers: string[] = []): string | null {
  const moduleSources = [
    importSource,
    ...specifiers
      .filter((specifier) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(specifier))
      .map((specifier) => importSource === "." ? `.${specifier}` : `${importSource}.${specifier}`),
  ];

  for (const moduleSource of moduleSources) {
    const candidates = pythonModuleCandidates(moduleSource, fromFile, rootDir);
    const direct = firstExistingPath(candidates.absolute, allFiles, rootDir);
    if (direct) return direct;
    if (!moduleSource.startsWith(".")) {
      const suffix = findUniqueSuffixPath(candidates.suffixes, allFiles);
      if (suffix) return suffix;
    }
  }

  return null;
}

function resolveImportPath(importSource: string, fromFile: string, allFiles: Set<string>, rootDir: string, specifiers: string[] = []): string | null {
  const fromExt = extname(fromFile).toLowerCase();
  if (fromExt === ".py") {
    const pythonTarget = resolvePythonImportPath(importSource, fromFile, allFiles, rootDir, specifiers);
    if (pythonTarget) return pythonTarget;
  }

  if (!importSource.startsWith(".")) return null;
  const fromDir = dirname(resolve(rootDir, fromFile));
  const candidates = [
    resolve(fromDir, importSource),
    resolve(fromDir, importSource + ".ts"),
    resolve(fromDir, importSource + ".tsx"),
    resolve(fromDir, importSource + ".js"),
    resolve(fromDir, importSource + ".jsx"),
    resolve(fromDir, importSource + ".py"),
    resolve(fromDir, importSource.replace(/\.js$/, ".ts")),
    resolve(fromDir, importSource + "/index.ts"),
    resolve(fromDir, importSource + "/index.js"),
    resolve(fromDir, importSource, "__init__.py"),
  ];
  return firstExistingPath(candidates, allFiles, rootDir);
}

function setIndexStatus(db: ContextPlusDB, status: string, input?: { targetPath?: string; error?: string | null }): void {
  if (status === INDEXING_STATUS) {
    db.setMetaBatch([
      [INDEX_STATUS_KEY, status],
      [INDEX_STARTED_AT_KEY, String(Date.now())],
      [INDEX_TARGET_PATH_KEY, input?.targetPath ?? ""],
      [LAST_INDEX_ERROR_KEY, ""],
    ]);
    return;
  }
  db.setMetaBatch([
    [INDEX_STATUS_KEY, status],
    [INDEX_FINISHED_AT_KEY, String(Date.now())],
    [INDEX_TARGET_PATH_KEY, ""],
    [LAST_INDEX_ERROR_KEY, input?.error ?? ""],
  ]);
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
  if (db.getMeta(INDEX_STATUS_KEY) === INDEXING_STATUS) {
    const wait = await waitForIndexingCompletion(options.rootDir, { timeoutMs: 60_000 });
    if (wait.timedOut) {
      return "Reindex skipped: another reindex is already in progress and did not finish within 60s.";
    }
  }
  setIndexStatus(db, INDEXING_STATUS, { targetPath: options.targetPath });
  try {
    const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
    const files = entries.filter((e) => !e.isDirectory);
    const sourceFiles = files.filter((file) => isSupportedFile(file.path));
    const currentPaths = new Set(sourceFiles.map((f) => f.relativePath));
    const currentHashes = new Map<string, string>();
    let totalSymbols = 0;
    let totalImports = 0;
    let indexed = 0;
    let skipped = files.length - sourceFiles.length;
    const pendingImports: PendingImportSet[] = [];

    for (const file of sourceFiles) {
      try {
        const content = await readFile(file.path, "utf-8");
        const hash = hashContent(content);
        currentHashes.set(file.relativePath, hash);

        const existing = db.getFile(file.relativePath);
        if (existing && existing.content_hash === hash && !options.force) {
          pendingImports.push({
            fileId: existing.id,
            imports: extractImports(content, file.path),
          });
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
        db.upsertFileSearchDocument({
          path: file.relativePath,
          header: analysis.header,
          language: lang,
          symbols: flatSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature })),
          content: buildSearchBody(content),
        });

        pendingImports.push({
          fileId,
          imports: extractImports(content, file.path),
        });

        db.upsertCallSites(fileId, extractCallSites(content));

        totalSymbols += flatSymbols.length;
        indexed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/reindex] degraded: failed to process ${file.relativePath}: ${message}\n`);
        skipped++;
      }
    }

    const resolvablePaths = new Set([...db.getAllFiles().map((file) => file.path), ...currentPaths]);
    for (const pending of pendingImports) {
      const sourceFile = db.getFileById(pending.fileId);
      if (!sourceFile) continue;
      db.deleteImportsForFile(pending.fileId);
      for (const imp of pending.imports) {
        const targetRel = resolveImportPath(imp.source, sourceFile.path, resolvablePaths, options.rootDir, imp.specifiers);
        const targetFile = targetRel ? db.getFile(targetRel) : null;
        db.upsertImport(pending.fileId, imp.source, targetFile?.id ?? null, imp.type, imp.specifiers.length > 0 ? imp.specifiers : undefined);
        totalImports++;
      }
    }

    const removed = options.targetPath ? [] : db.getRemovedFiles(currentPaths);
    for (const path of removed) db.deleteFile(path);

    let autoHubCount = 0;
    if (!options.targetPath) {
      const hubResult = await autoGenerateHubData(options.rootDir).catch(() => null);
      autoHubCount = hubResult?.generated.length ?? 0;
    }

    const indexedRelativePaths = sourceFiles.map((f) => f.relativePath);
    const noEmbed = options.noEmbed === true || isReindexEmbedDisabled();
    let fileEmbedCount = 0;
    let identifierEmbedCount = 0;
    let embedError: string | null = null;

    if (!noEmbed && indexedRelativePaths.length > 0) {
      try {
        const [files, identifiers] = await Promise.all([
          refreshFileSearchEmbeddings({ rootDir: options.rootDir, relativePaths: indexedRelativePaths }),
          refreshIdentifierEmbeddings({ rootDir: options.rootDir, relativePaths: indexedRelativePaths }),
        ]);
        fileEmbedCount = files;
        identifierEmbedCount = identifiers;
      } catch (error) {
        embedError = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/reindex] degraded: embedding population failed (${embedError}); index is structural-only until next reindex\n`);
      }
    }

    const duration = Date.now() - start;
    db.bumpIndexGeneration();
    db.setMeta("last_reindex_at", String(Date.now()));
    db.setMeta("last_reindex_duration_ms", String(duration));
    db.setMeta("last_auto_hub_count", String(autoHubCount));
    db.setMeta("last_embed_files_populated", String(fileEmbedCount));
    db.setMeta("last_embed_identifiers_populated", String(identifierEmbedCount));
    db.setMeta("last_embed_skipped", noEmbed ? "true" : "false");
    db.setMeta("last_embed_error", embedError ?? "");
    db.recordEmbeddingProvider(getEmbedProvider(), getEmbedModel());
    if (!embedError && !noEmbed) db.clearEmbeddingsStaleFlag();
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
    if (noEmbed) {
      lines.push(`  Embeddings: skipped (noEmbed=true or CONTEXTPRO_REINDEX_NO_EMBED set)`);
    } else if (embedError) {
      lines.push(`  Embeddings: failed (${embedError.slice(0, 120)}); search will fall back to keyword ranking`);
    } else {
      lines.push(`  Embeddings: ${fileEmbedCount} files, ${identifierEmbedCount} identifiers`);
    }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/quickRefresh] read failed for ${file.relativePath}: ${message}\n`);
    }
  }

  const stale = db.getStaleFiles(currentHashes);
  const currentPaths = new Set(files.map((f) => f.relativePath));
  const removed = db.getRemovedFiles(currentPaths);
  const totalStale = stale.length + removed.length;

  if (totalStale === 0) {
    return { staleCount: 0, refreshed: false, waitedForIndexing: waitState.waited, indexingTimedOut: false };
  }

    const maxStale = Math.max(1, parseInt(process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES ?? process.env.CONTEXTPLUS_QUICKREFRESH_MAX_FILES ?? "30", 10));
    if (totalStale <= maxStale) {
      const changedSymbols: string[] = [];
      const pendingImports: PendingImportSet[] = [];
      for (const path of stale) {
        try {
        const fullPath = resolveProjectPath(rootDir, path, "indexed file");
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
        db.upsertFileSearchDocument({
          path,
          header: analysis.header,
          language: lang,
          symbols: flatSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature })),
          content: buildSearchBody(content),
        });
        pendingImports.push({
          fileId,
          imports: extractImports(content, fullPath),
        });
        db.upsertCallSites(fileId, extractCallSites(content));
      } catch {}
    }
    const resolvablePaths = new Set([...db.getAllFiles().map((file) => file.path), ...currentPaths]);
    for (const pending of pendingImports) {
      const sourceFile = db.getFileById(pending.fileId);
      if (!sourceFile) continue;
      db.deleteImportsForFile(pending.fileId);
      for (const imp of pending.imports) {
        const targetRel = resolveImportPath(imp.source, sourceFile.path, resolvablePaths, rootDir, imp.specifiers);
        const targetFile = targetRel ? db.getFile(targetRel) : null;
        db.upsertImport(pending.fileId, imp.source, targetFile?.id ?? null, imp.type, imp.specifiers.length > 0 ? imp.specifiers : undefined);
      }
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
