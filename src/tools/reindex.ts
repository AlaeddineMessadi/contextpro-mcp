// Re-walk, re-parse, and re-index project files into SQLite database
// FEATURE: Reindex — persistent file/symbol/import graph population

import { walkDirectory } from "../core/walker.js";
import { analyzeContent, flattenSymbols, isSupportedFile, extractImports, extractCallSites } from "../core/parser.js";
import { getDB, hashContent, type ContextPlusDB } from "../core/db.js";
import { readFile, stat } from "fs/promises";
import { resolve, extname, dirname, relative } from "path";
import { invalidateSearchCache, refreshFileSearchEmbeddings } from "./semantic-search.js";
import { invalidateIdentifierSearchCache, refreshIdentifierEmbeddings } from "./semantic-identifiers.js";
import { autoGenerateHubData } from "./feature-hub.js";
import { refreshMemoryEmbeddings, toolUpsertMemoryNode } from "./memory-tools.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { getEmbedProvider, getEmbedModel } from "../core/embeddings.js";
import { matchesFileFingerprint, readSourceSnapshot } from "../core/file-fingerprint.js";
import { getExtractorStamp } from "../core/extractor-stamp.js";

export interface ReindexOptions {
  rootDir: string;
  targetPath?: string;
  force?: boolean;
  noEmbed?: boolean;
  /**
   * Generate feature-hub labels during reindex. OFF by default: hub labelling calls
   * the configured chat model once per hub, which adds latency and (for a cloud
   * model) cost/quota on every reindex — and silently churns in the background via
   * the reconcile sweep. Opt in explicitly, or set CONTEXTPRO_AUTO_HUBS=1.
   */
  autoHubs?: boolean;
}

/** Whether auto-hub generation is enabled (opt-in via option or env). */
function isAutoHubsEnabled(option?: boolean): boolean {
  if (option !== undefined) return option;
  const env = (process.env.CONTEXTPRO_AUTO_HUBS ?? process.env.CONTEXTPLUS_AUTO_HUBS ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(env);
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

const INDEX_STATUS_KEY = "index_status";
const INDEX_STARTED_AT_KEY = "index_started_at";
const INDEX_FINISHED_AT_KEY = "index_finished_at";
const INDEX_TARGET_PATH_KEY = "index_target_path";
const INDEX_OWNER_PID_KEY = "index_owner_pid";
const LAST_INDEX_ERROR_KEY = "last_index_error";
const INDEXING_STATUS = "indexing";
const IDLE_STATUS = "idle";
const MAX_SEARCH_BODY_CHARS = 4000;

function tryAcquireIndexLock(db: ContextPlusDB, targetPath: string): boolean {
  const extra: Array<[string, string]> = [
    [INDEX_STARTED_AT_KEY, String(Date.now())],
    [INDEX_TARGET_PATH_KEY, targetPath],
    [INDEX_OWNER_PID_KEY, String(process.pid)],
    [LAST_INDEX_ERROR_KEY, ""],
  ];
  // A brand-new DB has no index_status row yet; null and explicit idle are both
  // unlocked states, acquired atomically through the same compare-and-set path.
  return db.compareAndSetMeta(INDEX_STATUS_KEY, IDLE_STATUS, INDEXING_STATUS, extra)
    || db.compareAndSetMeta(INDEX_STATUS_KEY, null, INDEXING_STATUS, extra);
}

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

/** Called inside the source-file transaction: never publish a current content
 * hash with missing or previous-version imports if a write fails. */
function replaceFileImports(
  db: ContextPlusDB, rootDir: string, fileId: number, path: string,
  imports: ReturnType<typeof extractImports>, resolvablePaths: Set<string>,
): void {
  db.deleteImportsForFile(fileId);
  for (const imp of imports) {
    const targetPath = resolveImportPath(imp.source, path, resolvablePaths, rootDir, imp.specifiers);
    const targetId = targetPath ? db.getFile(targetPath)?.id ?? null : null;
    db.upsertImport(fileId, imp.source, targetId, imp.type, imp.specifiers.length ? imp.specifiers : undefined);
  }
}

/** A failed multi-file finalization must be retried even when file hashes match. */
function requireIndexRepair(db: ContextPlusDB): void {
  db.setMeta("index_repair_required", "1");
  db.bumpIndexGeneration();
  invalidateSearchCache();
  invalidateIdentifierSearchCache();
}

/** File additions/deletions can change edges of UNCHANGED importers, including
 * resolved edges when extension/index precedence changes. Re-resolve stored
 * import metadata only when the file set changes; no importer reads or parses. */
function reconnectStoredImports(db: ContextPlusDB, rootDir: string): void {
  const files = db.getAllFiles();
  const filesById = new Map(files.map((file) => [file.id, file]));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const paths = new Set(filesByPath.keys());
  db.transaction(() => {
  for (const imp of db.getAllImports()) {
    const source = filesById.get(imp.source_file_id);
    if (!source) continue;
    let specifiers: string[] = [];
    if (imp.symbols_imported) {
      try {
        const parsed: unknown = JSON.parse(imp.symbols_imported);
        if (Array.isArray(parsed)) specifiers = parsed.filter((value): value is string => typeof value === "string");
      } catch { /* Older indexes may contain malformed optional specifiers. */ }
    }
    const targetPath = resolveImportPath(imp.target_path, source.path, paths, rootDir, specifiers);
    const targetId = targetPath ? filesByPath.get(targetPath)?.id ?? null : null;
    if (targetId !== imp.target_file_id) db.updateImportTarget(imp.id, targetId);
  }
  });
}

function setIndexStatus(db: ContextPlusDB, status: string, input?: { targetPath?: string; error?: string | null }): void {
  if (status === INDEXING_STATUS) {
    db.setMetaBatch([
      [INDEX_STATUS_KEY, status],
      [INDEX_STARTED_AT_KEY, String(Date.now())],
      [INDEX_TARGET_PATH_KEY, input?.targetPath ?? ""],
      [INDEX_OWNER_PID_KEY, String(process.pid)],
      [LAST_INDEX_ERROR_KEY, ""],
    ]);
    return;
  }
  db.setMetaBatch([
    [INDEX_STATUS_KEY, status],
    [INDEX_FINISHED_AT_KEY, String(Date.now())],
    [INDEX_TARGET_PATH_KEY, ""],
    [INDEX_OWNER_PID_KEY, ""],
    [LAST_INDEX_ERROR_KEY, input?.error ?? ""],
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recoverAbandonedIndexLock(db: ContextPlusDB): boolean {
  if (db.getMeta(INDEX_STATUS_KEY) !== INDEXING_STATUS) return false;
  const ownerPid = Number.parseInt(db.getMeta(INDEX_OWNER_PID_KEY) ?? "", 10);
  const startedAt = Number.parseInt(db.getMeta(INDEX_STARTED_AT_KEY) ?? "", 10);
  const ownerKnownDead = Number.isInteger(ownerPid) && ownerPid > 0 && !processIsAlive(ownerPid);
  // Pre-owner-version locks cannot be attributed. Only reclaim those after ten
  // minutes so a legitimate long-running legacy reindex is not interrupted.
  const legacyLockExpired = (!Number.isInteger(ownerPid) || ownerPid <= 0)
    && Number.isFinite(startedAt)
    && Date.now() - startedAt > 10 * 60_000;
  if (!ownerKnownDead && !legacyLockExpired) return false;
  return db.compareAndSetMeta(INDEX_STATUS_KEY, INDEXING_STATUS, IDLE_STATUS, [
    [INDEX_OWNER_PID_KEY, ""],
    [LAST_INDEX_ERROR_KEY, "Recovered an abandoned index lock."],
  ]);
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
    if (recoverAbandonedIndexLock(db)) break;
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
  // Atomic check-and-set so two parallel reindex calls don't race past the guard.
  const acquired = tryAcquireIndexLock(db, options.targetPath ?? "");
  if (!acquired) {
    const current = db.getMeta(INDEX_STATUS_KEY);
    if (current === INDEXING_STATUS) {
      const wait = await waitForIndexingCompletion(options.rootDir, { timeoutMs: 60_000 });
      if (wait.timedOut) {
        return "Reindex skipped: another reindex is already in progress and did not finish within 60s.";
      }
      // Retry the acquisition once the other reindex finishes.
      const retried = tryAcquireIndexLock(db, options.targetPath ?? "");
      if (!retried) {
        return "Reindex skipped: index lock could not be acquired after the prior reindex finished. Try again in a moment.";
      }
    } else {
      // The index was in an unexpected state (e.g., "stale" from a prior crash). Force it
      // forward — the existing setIndexStatus path will still log the error if anything goes wrong.
      setIndexStatus(db, INDEXING_STATUS, { targetPath: options.targetPath });
    }
  }
  try {
    const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
    if (options.targetPath && entries.length === 0) {
      setIndexStatus(db, IDLE_STATUS, { targetPath: options.targetPath, error: null });
      return `Reindex: target_path "${options.targetPath}" matched no files (path may not exist, or is fully gitignored). No-op.`;
    }
    // GUARD: if the unscoped reindex walks 0 source files but the DB already contains files,
    // this almost certainly means the user reindexed from the wrong cwd or the project moved.
    // Require force=true to delete previously indexed files in that case.
    const files = entries.filter((e) => !e.isDirectory);
    const sourceFiles = files.filter((file) => isSupportedFile(file.path));
    const indexedPathsBefore = new Set(db.getAllFiles().map((file) => file.path));
    const previouslyIndexed = indexedPathsBefore.size;
    const extractorStamp = getExtractorStamp();
    const extractorChanged = !options.targetPath
      && previouslyIndexed > 0
      && db.getMeta("extractor_stamp") !== extractorStamp;
    const force = options.force === true || extractorChanged || db.getMeta("index_repair_required") === "1";
    if (!options.targetPath && sourceFiles.length === 0 && previouslyIndexed > 0 && !options.force) {
      setIndexStatus(db, IDLE_STATUS, { targetPath: options.targetPath, error: null });
      return (
        `Reindex: walker found 0 source files but ${previouslyIndexed} files are already indexed. ` +
        `Refusing to delete the existing index. If the project moved or files were truly removed, ` +
        `pass force: true.`
      );
    }
    const currentPaths = new Set(sourceFiles.map((f) => f.relativePath));
    const currentHashes = new Map<string, string>();
    let totalSymbols = 0;
    let totalImports = 0;
    let indexed = 0;
    let degradedCount = 0;
    let skipped = files.length - sourceFiles.length;
    const resolvablePaths = new Set([...indexedPathsBefore, ...currentPaths]);

    for (const file of sourceFiles) {
      try {
        // Hard size cap to defend against checked-in minified bundles and other megabyte-scale
        // pseudo-source files. Default 5MB; env-var override for projects that genuinely need
        // a higher cap.
        const sizeCapEnv = parseInt(process.env.CONTEXTPRO_MAX_FILE_SIZE ?? process.env.CONTEXTPLUS_MAX_FILE_SIZE ?? "", 10);
        const sizeCap = Number.isFinite(sizeCapEnv) && sizeCapEnv > 0 ? sizeCapEnv : 5 * 1024 * 1024;
        const fileStats = await stat(file.path).catch(() => null);
        if (fileStats && fileStats.size > sizeCap) {
          process.stderr.write(`[contextpro/reindex] skipping oversized file (${(fileStats.size / 1024 / 1024).toFixed(2)} MB > ${(sizeCap / 1024 / 1024).toFixed(2)} MB cap): ${file.relativePath}\n`);
          currentHashes.set(file.relativePath, hashContent(`oversize:${file.relativePath}:${fileStats.size}`));
          skipped++;
          continue;
        }
        // Sniff the first 8KB for null bytes before reading as UTF-8. Files like images or
        // compiled binaries renamed with a supported extension would otherwise crash readFile
        // and leave currentHashes without an entry — making the file look "removed" on next
        // reindex even though it still exists on disk.
        const snapshot = await readSourceSnapshot(file.path);
        const buf = Buffer.from(snapshot.content, "utf8");
        const sniff = buf.subarray(0, Math.min(buf.length, 8192));
        let looksBinary = false;
        for (let i = 0; i < sniff.length; i++) {
          if (sniff[i] === 0) { looksBinary = true; break; }
        }
        if (looksBinary) {
          process.stderr.write(`[contextpro/reindex] skipping binary file: ${file.relativePath}\n`);
          // Still mark the path as "current" so it isn't deleted from the index next pass.
          currentHashes.set(file.relativePath, hashContent(`binary:${file.relativePath}:${buf.length}`));
          skipped++;
          continue;
        }
        const content = buf.toString("utf-8");
        const hash = hashContent(content);
        currentHashes.set(file.relativePath, hash);

        const existing = db.getFile(file.relativePath);
        if (existing && existing.content_hash === hash && !force) {
          db.updateFileFingerprint(file.relativePath, snapshot.stats.size, snapshot.stats.mtimeMs, snapshot.stats.ctimeMs, hash);
          totalImports += db.getImportsFrom(existing.id).length;
          skipped++;
          continue;
        }

        const analysis = await analyzeContent(file.path, content);
        const flatSymbols = flattenSymbols(analysis.symbols);
        const lang = detectLanguage(file.path);
        const fileSize = snapshot.stats.size;
        const fileMtimeMs = snapshot.stats.mtimeMs;

        const imports = extractImports(content, file.path);
        const callSites = extractCallSites(content, file.relativePath);
        const fileId = db.transaction(() => {
          const fileId = db.upsertFile(file.relativePath, hash, analysis.header, lang, fileSize, fileMtimeMs, snapshot.stats.ctimeMs);
          db.upsertSymbols(fileId, flatSymbols.map((s) => ({
            name: s.name,
            kind: s.kind,
            lineStart: s.line,
            lineEnd: s.endLine,
            signature: s.signature,
            parentIndex: s.parentIndex,
          })));
          db.upsertFileSearchDocument({
            path: file.relativePath,
            header: analysis.header,
            language: lang,
            symbols: flatSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature })),
            content: buildSearchBody(content),
          });

          replaceFileImports(db, options.rootDir, fileId, file.relativePath, imports, resolvablePaths);
          db.upsertCallSites(fileId, callSites);
          return fileId;
        });
        totalImports += imports.length;

        totalSymbols += flatSymbols.length;
        indexed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/reindex] degraded: failed to process ${file.relativePath}: ${message}\n`);
        degradedCount++;
        skipped++;
      }
    }

    const removed = options.targetPath ? [] : db.getRemovedFiles(currentPaths);
    for (const path of removed) db.deleteFile(path);
    if (removed.length > 0 || db.getAllFiles().some((file) => !indexedPathsBefore.has(file.path))) {
      reconnectStoredImports(db, options.rootDir);
    }

    let autoHubCount = 0;
    // Auto-hub generation makes a chat-model call per hub — off by default so reindex
    // (including the background reconcile-driven path) stays fast, quiet, and free.
    if (!options.targetPath && isAutoHubsEnabled(options.autoHubs)) {
      const hubResult = await autoGenerateHubData(options.rootDir).catch(() => null);
      autoHubCount = hubResult?.generated.length ?? 0;
    }

    const indexedRelativePaths = sourceFiles.map((f) => f.relativePath);
    const noEmbed = options.noEmbed === true || isReindexEmbedDisabled();
    let fileEmbedCount = 0;
    let identifierEmbedCount = 0;
    let memoryEmbedCount = 0;
    let embedError: string | null = null;

    // Validate the vector space before refreshers compare content hashes. Recording
    // this afterward can reuse vectors from a previous same-dimension model and then
    // incorrectly clear the stale flag without embedding anything.
    db.recordEmbeddingProvider(getEmbedProvider(), getEmbedModel());

    if (!noEmbed) {
      try {
        const [files, identifiers] = await Promise.all([
          refreshFileSearchEmbeddings({ rootDir: options.rootDir, relativePaths: indexedRelativePaths }),
          refreshIdentifierEmbeddings({ rootDir: options.rootDir, relativePaths: indexedRelativePaths }),
        ]);
        fileEmbedCount = files;
        identifierEmbedCount = identifiers;
        memoryEmbedCount = await refreshMemoryEmbeddings(options.rootDir);
      } catch (error) {
        embedError = error instanceof Error ? error.message : String(error);
        db.setMeta("embeddings_stale", "true");
        db.setMeta("embeddings_stale_reason", embedError);
        process.stderr.write(`[contextpro/reindex] degraded: embedding population failed (${embedError}); index is structural-only until next reindex\n`);
      }
    }

    const duration = Date.now() - start;
    const structuralChanged = force || indexed > 0 || removed.length > 0;
    if (degradedCount > 0) requireIndexRepair(db);
    else if (structuralChanged) db.bumpIndexGeneration();
    db.setMeta("last_reindex_at", String(Date.now()));
    db.setMeta("last_reindex_duration_ms", String(duration));
    db.setMeta("last_auto_hub_count", String(autoHubCount));
    db.setMeta("last_embed_files_populated", String(fileEmbedCount));
    db.setMeta("last_embed_identifiers_populated", String(identifierEmbedCount));
    db.setMeta("last_embed_memories_populated", String(memoryEmbedCount));
    db.setMeta("last_embed_skipped", noEmbed ? "true" : "false");
    db.setMeta("last_embed_error", embedError ?? "");
    if (!embedError && !noEmbed && !options.targetPath) db.clearEmbeddingsStaleFlag();
    setIndexStatus(db, IDLE_STATUS, { targetPath: options.targetPath, error: null });

    invalidateSearchCache();
    invalidateIdentifierSearchCache();

    if (!options.targetPath) {
      db.setMeta("extractor_stamp", extractorStamp);
      if (degradedCount === 0) db.setMeta("index_repair_required", "");
      await toolUpsertMemoryNode({
        rootDir: options.rootDir,
        type: "note",
        label: "index-snapshot",
        content: `Reindex completed at ${new Date().toISOString()}. Files: ${files.length} total, ${indexed} indexed, ${skipped} skipped. Symbols: ${totalSymbols}. Imports: ${totalImports}. Duration: ${duration}ms.`,
        scope: "project",
        skipEmbedding: noEmbed,
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
      lines.push(`  Embeddings: ${fileEmbedCount} files, ${identifierEmbedCount} identifiers, ${memoryEmbedCount} memories`);
    }
    if (force) lines.push(extractorChanged
      ? "  Mode: force (extractor changed; all files re-processed)"
      : "  Mode: force (all files re-processed)");
    if (degradedCount > 0) lines.push(`  Index repair required: ${degradedCount} files failed to process`);
    else if (!structuralChanged) lines.push("  Index generation: unchanged (no structural changes)");
    if (options.targetPath) lines.push(`  Scope: ${options.targetPath}`);

    return lines.join("\n");
  } catch (error) {
    requireIndexRepair(db);
    setIndexStatus(db, IDLE_STATUS, {
      targetPath: options.targetPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface QuickRefreshOptions {
  /** Refresh semantic embeddings too. Graph readers set false for a fast structural-only pass. */
  includeEmbeddings?: boolean;
}

export interface QuickRefreshResult {
  staleCount: number;
  remainingStaleCount?: number;
  refreshed: boolean;
  complete: boolean;
  fullReindex?: boolean;
  waitedForIndexing?: boolean;
  indexingTimedOut?: boolean;
  changedSymbols?: string[];
}

export async function quickRefresh(rootDir: string, options: QuickRefreshOptions = {}): Promise<QuickRefreshResult> {
  return quickRefreshAttempt(rootDir, options, 0);
}

async function quickRefreshAttempt(rootDir: string, options: QuickRefreshOptions, retry: number): ReturnType<typeof quickRefresh> {
  const startedAt = Date.now();
  const waitState = await waitForIndexingCompletion(rootDir);
  if (waitState.timedOut) {
    return {
      staleCount: 0,
      remainingStaleCount: 0,
      refreshed: false,
      complete: false,
      waitedForIndexing: waitState.waited,
      indexingTimedOut: true,
    };
  }
  const db = await getDB(rootDir);
  const indexedBefore = db.getAllFiles();
  const extractorStamp = getExtractorStamp();
  if (db.getMeta("index_repair_required") === "1"
    || (indexedBefore.length > 0 && db.getMeta("extractor_stamp") !== extractorStamp)) {
    const generationBefore = db.getIndexGeneration();
    await reindex({ rootDir, force: true, noEmbed: true, autoHubs: false });
    return {
      staleCount: indexedBefore.length,
      remainingStaleCount: db.getMeta("extractor_stamp") === extractorStamp && db.getMeta("index_repair_required") !== "1" ? 0 : Math.max(1, indexedBefore.length),
      refreshed: db.getIndexGeneration() > generationBefore,
      complete: db.getMeta("extractor_stamp") === extractorStamp && db.getMeta("index_repair_required") !== "1",
      fullReindex: true,
      waitedForIndexing: waitState.waited,
      indexingTimedOut: false,
    };
  }

  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((e) => !e.isDirectory && isSupportedFile(e.path));
  const indexedByPath = new Map(indexedBefore.map((file) => [file.path, file] as const));
  const hashMode = (process.env.CONTEXTPRO_REFRESH ?? process.env.CONTEXTPLUS_REFRESH ?? "").trim().toLowerCase() === "hash";
  const currentHashes = new Map<string, string>();
  const fingerprintUpdates: Array<{ path: string; size: number; mtimeMs: number; ctimeMs: number; hash: string }> = [];
  for (const file of files) {
    try {
      const fileStats = await stat(file.path);
      const existing = indexedByPath.get(file.relativePath);
      if (!hashMode && existing && matchesFileFingerprint(existing, fileStats)) {
        currentHashes.set(file.relativePath, existing.content_hash);
        continue;
      }
      const snapshot = await readSourceSnapshot(file.path);
      const hash = hashContent(snapshot.content);
      currentHashes.set(file.relativePath, hash);
      if (existing?.content_hash === hash
        && !matchesFileFingerprint(existing, snapshot.stats)) {
        fingerprintUpdates.push({ path: file.relativePath, size: snapshot.stats.size, mtimeMs: snapshot.stats.mtimeMs, ctimeMs: snapshot.stats.ctimeMs, hash });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/quickRefresh] read failed for ${file.relativePath}: ${message}\n`);
    }
  }

  const stale = db.getStaleFiles(currentHashes);
  const currentPaths = new Set(files.map((f) => f.relativePath));
  const added = [...currentPaths].filter((path) => !indexedByPath.has(path));
  const removed = db.getRemovedFiles(currentPaths);
  let totalStale = new Set([...stale, ...added, ...removed]).size;

  if (totalStale === 0) {
    for (const update of fingerprintUpdates) db.updateFileFingerprint(update.path, update.size, update.mtimeMs, update.ctimeMs, update.hash);
    return { staleCount: 0, remainingStaleCount: 0, refreshed: false, complete: true, waitedForIndexing: waitState.waited, indexingTimedOut: false };
  }

  const acquired = tryAcquireIndexLock(db, "<automatic-refresh>");
  if (!acquired) {
    const waited = await waitForIndexingCompletion(rootDir);
    if (waited.timedOut || retry >= 2) {
      return { staleCount: totalStale, remainingStaleCount: totalStale, refreshed: false, complete: false, waitedForIndexing: true, indexingTimedOut: waited.timedOut };
    }
    return quickRefreshAttempt(rootDir, options, retry + 1);
  }

  let refreshError: string | null = null;
  try {
    // Another process may have refreshed between our initial probe and lock
    // acquisition. Re-check the hashes against the current DB before doing work.
    const staleAfterLock = db.getStaleFiles(currentHashes);
    const indexedPathsAfterLock = new Set(db.getAllFiles().map((file) => file.path));
    const addedAfterLock = [...currentPaths].filter((path) => !indexedPathsAfterLock.has(path));
    const removedAfterLock = db.getRemovedFiles(currentPaths);
    const removedPathSet = new Set(removedAfterLock);
    // getStaleFiles also reports rows absent from currentHashes. Those paths are
    // deletions, not readable changed files; process them only via deleteFile.
    const changedAfterLock = [...new Set([...staleAfterLock, ...addedAfterLock])]
      .filter((path) => !removedPathSet.has(path));
    totalStale = new Set([...changedAfterLock, ...removedAfterLock]).size;
    if (totalStale === 0) {
      for (const update of fingerprintUpdates) db.updateFileFingerprint(update.path, update.size, update.mtimeMs, update.ctimeMs, update.hash);
      return { staleCount: 0, remainingStaleCount: 0, refreshed: false, complete: true, waitedForIndexing: true, indexingTimedOut: false };
    }

    const maxStale = Math.max(1, parseInt(process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES ?? process.env.CONTEXTPLUS_QUICKREFRESH_MAX_FILES ?? "30", 10));
    if (totalStale <= maxStale) {
      const changedSymbols: string[] = [];
      const resolvablePaths = new Set([...indexedPathsAfterLock, ...currentPaths]);
      const indexedPaths: string[] = [];
      let degradedCount = 0;
      for (const path of changedAfterLock) {
        try {
        const fullPath = resolveProjectPath(rootDir, path, "indexed file");
        const snapshot = await readSourceSnapshot(fullPath);
        const content = snapshot.content;
        const hash = hashContent(content);
        const analysis = await analyzeContent(fullPath, content);
        const flatSymbols = flattenSymbols(analysis.symbols);
        const lang = detectLanguage(fullPath);
        const fileStats = snapshot.stats;
        const fileSize = fileStats.size;
        const fileMtimeMs = fileStats.mtimeMs;

        const existingFile = db.getFile(path);
        const oldSymbolNames = existingFile ? new Set(db.getSymbolsByFile(existingFile.id).map((s) => s.name)) : new Set<string>();
        const newSymbolNames = new Set(flatSymbols.map((s) => s.name));
        const imports = extractImports(content, fullPath);
        const callSites = extractCallSites(content, path);
        const fileId = db.transaction(() => {
          const fileId = db.upsertFile(path, hash, analysis.header, lang, fileSize, fileMtimeMs, snapshot.stats.ctimeMs);
          db.upsertSymbols(fileId, flatSymbols.map((s) => ({
            name: s.name, kind: s.kind, lineStart: s.line, lineEnd: s.endLine, signature: s.signature, parentIndex: s.parentIndex,
          })));
          db.upsertFileSearchDocument({
            path,
            header: analysis.header,
            language: lang,
            symbols: flatSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature })),
            content: buildSearchBody(content),
          });
          replaceFileImports(db, rootDir, fileId, path, imports, resolvablePaths);
          db.upsertCallSites(fileId, callSites);
          return fileId;
        });
        for (const name of newSymbolNames) {
          if (!oldSymbolNames.has(name)) changedSymbols.push(`+${path}:${name}`);
        }
        for (const name of oldSymbolNames) {
          if (!newSymbolNames.has(name)) changedSymbols.push(`-${path}:${name}`);
        }
        indexedPaths.push(path);
      } catch (error) {
        // A failed quick-refresh of one file leaves its prior (stale) imports intact. Log it so
        // the user knows the graph for that file may be out of date until the next full reindex.
        degradedCount++;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/quickrefresh] skipped ${path}: ${message}\n`);
      }
    }
    if (degradedCount > 0) {
      process.stderr.write(`[contextpro/quickrefresh] ${degradedCount} file(s) failed quick refresh; run reindex --force for a clean rebuild\n`);
    }
    for (const path of removedAfterLock) db.deleteFile(path);
    if (removedAfterLock.length > 0 || indexedPaths.some((path) => !indexedPathsAfterLock.has(path))) {
      reconnectStoredImports(db, rootDir);
    }
    const structuralChanged = indexedPaths.length > 0 || removedAfterLock.length > 0;
    if (structuralChanged) {
      db.bumpIndexGeneration();
      invalidateSearchCache();
      invalidateIdentifierSearchCache();
    }
    db.setMeta("extractor_stamp", extractorStamp);
    db.setMeta("last_reindex_at", String(Date.now()));
    db.setMeta("last_reindex_duration_ms", String(Date.now() - startedAt));

    if (options.includeEmbeddings !== false) {
      db.recordEmbeddingProvider(getEmbedProvider(), getEmbedModel());
      // Deleted paths cannot be reread structurally, but embedding refreshers use
      // them to purge their persistent vectors and invalidate cached indexes.
      const embeddingRefreshPaths = [...new Set([...changedAfterLock, ...removedAfterLock])];
      await Promise.all([
        refreshFileSearchEmbeddings({ rootDir, relativePaths: embeddingRefreshPaths }).catch(() => 0),
        refreshIdentifierEmbeddings({ rootDir, relativePaths: embeddingRefreshPaths }).catch(() => 0),
      ]);
    }

    return {
      staleCount: totalStale,
      remainingStaleCount: degradedCount,
      refreshed: structuralChanged,
      complete: degradedCount === 0,
      waitedForIndexing: waitState.waited,
      indexingTimedOut: false,
      changedSymbols,
    };
  }

  return { staleCount: totalStale, remainingStaleCount: totalStale, refreshed: false, complete: false, waitedForIndexing: waitState.waited, indexingTimedOut: false };
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error);
    requireIndexRepair(db);
    throw error;
  } finally {
    setIndexStatus(db, IDLE_STATUS, { error: refreshError });
  }
}

export interface StructuralRefreshResult {
  /** Files whose symbols, imports, and call sites were re-indexed. */
  indexed: number;
  /** Files skipped because they are unsupported, missing, or unreadable. */
  skipped: number;
  /** Indexed files confirmed absent under the writer lock and removed. */
  removed?: number;
  /** `+path:name` / `-path:name` markers for symbols added/removed this pass. */
  changedSymbols: string[];
}

/**
 * Re-index the structural graph (symbols, imports, call sites) plus embeddings for
 * an EXPLICIT list of changed files — no directory walk, no whole-tree hashing.
 *
 * This is the per-file core of quickRefresh, exposed so the embedding tracker can
 * keep related/blast_radius/test_map current as agents edit, scaling with the size
 * of the edit rather than the size of the repo. Missing/unsupported files are
 * counted as skipped, never thrown.
 */
export async function refreshFilesStructural(
  rootDir: string,
  relativePaths: string[],
  options: { removedPaths?: string[]; includeEmbeddings?: boolean } = {},
): Promise<StructuralRefreshResult> {
  const unique = [...new Set(relativePaths.map((p) => p.replace(/\\/g, "/")))].filter((p) => p.length > 0);
  const targets = unique.filter((p) => isSupportedFile(p));
  const removalCandidates = [...new Set(options.removedPaths ?? [])].filter(isSupportedFile);
  if (targets.length === 0 && removalCandidates.length === 0) {
    return { indexed: 0, skipped: unique.length, changedSymbols: [] };
  }

  const initialWait = await waitForIndexingCompletion(rootDir);
  if (initialWait.timedOut) return { indexed: 0, skipped: unique.length, changedSymbols: [] };
  const db = await getDB(rootDir);
  let acquired = tryAcquireIndexLock(db, "<tracker-refresh>");
  if (!acquired) {
    const waited = await waitForIndexingCompletion(rootDir);
    if (waited.timedOut) return { indexed: 0, skipped: unique.length, changedSymbols: [] };
    acquired = tryAcquireIndexLock(db, "<tracker-refresh>");
    if (!acquired) return { indexed: 0, skipped: unique.length, changedSymbols: [] };
  }

  let refreshError: string | null = null;
  try {
  const changedSymbols: string[] = [];
  const indexedPaths: string[] = [];
  const indexedPathsBefore = new Set(db.getAllFiles().map((file) => file.path));
  const resolvablePaths = new Set([...indexedPathsBefore, ...targets]);
  const removedPaths: string[] = [];
  let skipped = unique.length - targets.length;

  for (const path of removalCandidates) {
    const fullPath = resolveProjectPath(rootDir, path, "removed indexed file");
    try {
      await stat(fullPath);
      // It was recreated while this refresh waited. Leave it for the next sweep.
      continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") continue;
    }
    const file = db.getFile(path);
    if (!file) continue;
    for (const symbol of db.getSymbolsByFile(file.id)) changedSymbols.push(`-${path}:${symbol.name}`);
    db.deleteFile(path);
    removedPaths.push(path);
    resolvablePaths.delete(path);
  }

  let processed = 0;
  for (const path of targets) {
    // Yield to the event loop between files. tree-sitter parsing is synchronous
    // and blocks the single thread; yielding lets concurrent tool calls and
    // transport heartbeats interleave so a large refresh never stalls the server.
    if (++processed % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
    try {
      const fullPath = resolveProjectPath(rootDir, path, "indexed file");
      const snapshot = await readSourceSnapshot(fullPath);
      const content = snapshot.content;
      const hash = hashContent(content);
      const analysis = await analyzeContent(fullPath, content);
      const flatSymbols = flattenSymbols(analysis.symbols);
      const lang = detectLanguage(fullPath);
      const fileStats = snapshot.stats;
      const fileSize = fileStats.size;
      const fileMtimeMs = fileStats.mtimeMs;

      const existingFile = db.getFile(path);
      const oldSymbolNames = existingFile ? new Set(db.getSymbolsByFile(existingFile.id).map((s) => s.name)) : new Set<string>();
      const newSymbolNames = new Set(flatSymbols.map((s) => s.name));
      const imports = extractImports(content, fullPath);
      const callSites = extractCallSites(content, path);
      const fileId = db.transaction(() => {
        const fileId = db.upsertFile(path, hash, analysis.header, lang, fileSize, fileMtimeMs, snapshot.stats.ctimeMs);
        db.upsertSymbols(fileId, flatSymbols.map((s) => ({
          name: s.name, kind: s.kind, lineStart: s.line, lineEnd: s.endLine, signature: s.signature, parentIndex: s.parentIndex,
        })));
        db.upsertFileSearchDocument({
          path,
          header: analysis.header,
          language: lang,
          symbols: flatSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature })),
          content: buildSearchBody(content),
        });
        replaceFileImports(db, rootDir, fileId, path, imports, resolvablePaths);
        db.upsertCallSites(fileId, callSites);
        return fileId;
      });
      for (const name of newSymbolNames) {
        if (!oldSymbolNames.has(name)) changedSymbols.push(`+${path}:${name}`);
      }
      for (const name of oldSymbolNames) {
        if (!newSymbolNames.has(name)) changedSymbols.push(`-${path}:${name}`);
      }
      indexedPaths.push(path);
    } catch (error) {
      skipped++;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[contextpro/structural-refresh] skipped ${path}: ${message}\n`);
    }
  }

  if (removedPaths.length > 0 || indexedPaths.some((path) => !indexedPathsBefore.has(path))) {
    reconnectStoredImports(db, rootDir);
  }

  if (indexedPaths.length > 0 || removedPaths.length > 0) {
    db.bumpIndexGeneration();
    db.setMeta("last_reindex_at", String(Date.now()));
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    if (options.includeEmbeddings !== false && !isReindexEmbedDisabled()) {
      db.recordEmbeddingProvider(getEmbedProvider(), getEmbedModel());
      const embeddingPaths = [...indexedPaths, ...removedPaths];
      await Promise.all([
        refreshFileSearchEmbeddings({ rootDir, relativePaths: embeddingPaths }).catch(() => 0),
        refreshIdentifierEmbeddings({ rootDir, relativePaths: embeddingPaths }).catch(() => 0),
      ]);
    }
  }

  return { indexed: indexedPaths.length, skipped, removed: removedPaths.length, changedSymbols };
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error);
    requireIndexRepair(db);
    throw error;
  } finally {
    setIndexStatus(db, IDLE_STATUS, { error: refreshError });
  }
}
