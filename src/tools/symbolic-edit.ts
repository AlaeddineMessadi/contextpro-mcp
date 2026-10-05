// Symbolic find and edit tools — Serena-parity symbol-level operations
// FEATURE: Symbol-precise editing without LSP — parser-driven find / replace / insert / rename

import { readFile } from "fs/promises";
import { createHash } from "node:crypto";
import { extname } from "path";
import { resolveProjectPath } from "../core/path-guard.js";
import { analyzeContent, analyzeFile, flattenSymbols, isSupportedFile, type CodeSymbol, type SymbolLocation } from "../core/parser.js";
import { sourceMaskFlags } from "../core/source-mask.js";
import { getGrammarName, validateSyntax } from "../core/tree-sitter.js";
import { walkDirectory } from "../core/walker.js";
import { getDB } from "../core/db.js";
import { assertSourceUnchanged, captureSource, publishSource, withSourceMutation, type SourceSnapshot } from "../core/source-mutation.js";
import { createRestorePoint } from "../git/shadow.js";
import { invalidateSearchCache } from "./semantic-search.js";
import { invalidateIdentifierSearchCache } from "./semantic-identifiers.js";

export interface FindSymbolOptions {
  rootDir: string;
  namePathPattern: string;
  relativePath?: string;
  includeBody?: boolean;
  depth?: number;
  maxMatches?: number;
  substringMatching?: boolean;
  includeKinds?: string[];
  excludeKinds?: string[];
  format?: "text" | "json";
}

export interface SymbolicEditOptions {
  rootDir: string;
  relativePath: string;
  namePath: string;
  body: string;
  message?: string;
  expectedContentHash?: string;
}

export interface InsertSymbolOptions {
  rootDir: string;
  relativePath: string;
  namePath: string;
  body: string;
  position: "before" | "after";
  message?: string;
  expectedContentHash?: string;
}

export interface RenameSymbolOptions {
  rootDir: string;
  relativePath: string;
  namePath: string;
  newName: string;
  message?: string;
  expectedContentHash?: string;
}

export interface FoundSymbolEntry {
  name: string;
  kind: string;
  namePath: string;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  body?: string;
  contentHash?: string;
  children?: FoundSymbolEntry[];
}

interface MatchedSymbol {
  symbol: CodeSymbol;
  namePath: string;
  parentChain: string[];
}

function buildNamePath(parentChain: string[], name: string): string {
  return parentChain.length > 0 ? `${parentChain.join("/")}/${name}` : name;
}

function flattenWithNamePath(symbols: CodeSymbol[], parentChain: string[] = []): MatchedSymbol[] {
  const out: MatchedSymbol[] = [];
  for (const sym of symbols) {
    const namePath = buildNamePath(parentChain, sym.name);
    out.push({ symbol: sym, namePath, parentChain });
    if (sym.children.length > 0) {
      out.push(...flattenWithNamePath(sym.children, [...parentChain, sym.name]));
    }
  }
  return out;
}

function wildcardToRegExp(pattern: string): RegExp {
  // `*` matches any run of name characters (not /); `**` matches across path separators.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "@@DS@@")
    .replace(/\*/g, "[^/]*")
    .replace(/@@DS@@/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesNamePathPattern(candidate: string, pattern: string, substringMatching: boolean): boolean {
  // Bare "*" or "**" lists everything — common LLM expectation for "all symbols".
  if (pattern === "*" || pattern === "**") return true;

  // Wildcard support: any pattern containing * is treated as a glob over the name path.
  if (pattern.includes("*")) {
    const re = wildcardToRegExp(pattern.startsWith("/") ? pattern.slice(1) : pattern);
    if (re.test(candidate)) return true;
    // Also try matching just the last path segment for convenience (e.g. "get*").
    const last = candidate.split("/").pop() ?? candidate;
    return wildcardToRegExp(pattern).test(last);
  }

  if (pattern.startsWith("/")) {
    return candidate === pattern.slice(1);
  }
  if (pattern.includes("/")) {
    if (candidate === pattern) return true;
    return candidate.endsWith(`/${pattern}`);
  }
  const parts = candidate.split("/");
  const last = parts[parts.length - 1];
  if (substringMatching) return last.includes(pattern);
  return last === pattern;
}

function withinKindFilter(symbol: CodeSymbol, includeKinds: string[] | undefined, excludeKinds: string[] | undefined): boolean {
  if (includeKinds && includeKinds.length > 0 && !includeKinds.includes(symbol.kind)) return false;
  if (excludeKinds && excludeKinds.length > 0 && excludeKinds.includes(symbol.kind)) return false;
  return true;
}

function toFoundEntry(match: MatchedSymbol, filePath: string, content: string, includeBody: boolean, depth: number): FoundSymbolEntry {
  const entry: FoundSymbolEntry = {
    name: match.symbol.name,
    kind: match.symbol.kind,
    namePath: match.namePath,
    path: filePath,
    line: match.symbol.line,
    endLine: match.symbol.endLine,
    signature: match.symbol.signature,
  };
  if (includeBody) {
    const { startIndex, endIndex } = match.symbol;
    entry.body = startIndex !== undefined && endIndex !== undefined
      ? content.slice(startIndex, endIndex)
      : content.split("\n").slice(match.symbol.line - 1, match.symbol.endLine).join("\n");
  }
  if (depth > 0 && match.symbol.children.length > 0) {
    entry.children = match.symbol.children.map((child) =>
      toFoundEntry({ symbol: child, namePath: `${match.namePath}/${child.name}`, parentChain: [...match.parentChain, match.symbol.name] }, filePath, content, includeBody, depth - 1),
    );
  }
  return entry;
}

async function findInOneFile(rootDir: string, relativePath: string, options: FindSymbolOptions): Promise<FoundSymbolEntry[]> {
  const fullPath = resolveProjectPath(rootDir, relativePath, "relativePath");
  if (!isSupportedFile(fullPath)) return [];
  try {
    const content = await readFile(fullPath, "utf-8");
    const analysis = await analyzeContent(fullPath, content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const flat = flattenWithNamePath(analysis.symbols);
    const includeBody = options.includeBody === true;
    const depth = Math.max(0, Math.floor(options.depth ?? 0));
    return flat
      .filter((match) => matchesNamePathPattern(match.namePath, options.namePathPattern, options.substringMatching === true))
      .filter((match) => withinKindFilter(match.symbol, options.includeKinds, options.excludeKinds))
      .map((match) => ({ ...toFoundEntry(match, relativePath, content, includeBody, depth), contentHash }));
  } catch {
    return [];
  }
}

export async function findSymbol(options: FindSymbolOptions): Promise<string> {
  const max = Math.max(1, Math.floor(options.maxMatches ?? 50));
  const collected: FoundSymbolEntry[] = [];

  if (options.relativePath) {
    const file = options.relativePath;
    const matches = await findInOneFile(options.rootDir, file, options);
    collected.push(...matches);
  } else {
    const db = await getDB(options.rootDir);
    const dbFiles = db.getAllFiles();
    let files: string[];
    if (dbFiles.length > 0) {
      files = dbFiles.map((file) => file.path);
    } else {
      const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
      files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
    }
    for (const file of files) {
      if (collected.length >= max) break;
      const matches = await findInOneFile(options.rootDir, file, options);
      for (const match of matches) {
        if (collected.length >= max) break;
        collected.push(match);
      }
    }
  }

  if (options.format === "json") {
    return JSON.stringify({ pattern: options.namePathPattern, count: collected.length, results: collected.slice(0, max) }, null, 2);
  }

  if (collected.length === 0) {
    return `No symbols matched pattern "${options.namePathPattern}"${options.relativePath ? ` in ${options.relativePath}` : ""}.`;
  }

  const lines = [`Found ${collected.length} symbol(s) for "${options.namePathPattern}":`, ""];
  for (const entry of collected.slice(0, max)) {
    lines.push(`${entry.kind}: ${entry.namePath}`);
    lines.push(`  ${entry.path}:L${entry.line}${entry.endLine > entry.line ? `-L${entry.endLine}` : ""}`);
    if (entry.signature && entry.signature !== entry.name) lines.push(`  signature: ${entry.signature.substring(0, 200)}`);
    if (entry.body) {
      lines.push("  body:");
      for (const bodyLine of entry.body.split("\n").slice(0, 60)) {
        lines.push(`    ${bodyLine}`);
      }
      if (entry.body.split("\n").length > 60) lines.push(`    ... (${entry.body.split("\n").length - 60} more lines)`);
    }
    if (entry.children && entry.children.length > 0) {
      lines.push(`  children: ${entry.children.map((child) => `${child.kind}:${child.name}`).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function locateSymbolForEdit(rootDir: string, relativePath: string, namePath: string, content?: string): Promise<{ symbol: CodeSymbol; parentChain: string[]; analysis: Awaited<ReturnType<typeof analyzeFile>>; fullPath: string }> {
  const fullPath = resolveProjectPath(rootDir, relativePath, "relativePath");
  if (!isSupportedFile(fullPath)) {
    throw new Error(`File is not a supported source language: ${relativePath}`);
  }
  const analysis = content === undefined ? await analyzeFile(fullPath) : await analyzeContent(fullPath, content);
  const flat = flattenWithNamePath(analysis.symbols);
  const matches = flat.filter((match) => matchesNamePathPattern(match.namePath, namePath, false));
  if (matches.length === 0) {
    throw new Error(`Symbol "${namePath}" not found in ${relativePath}.`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((match) => match.namePath).join(", ");
    throw new Error(`Symbol pattern "${namePath}" is ambiguous in ${relativePath}: matched [${candidates}]. Pass an absolute name path starting with "/" (e.g., "/${matches[0].namePath}") to disambiguate.`);
  }
  return { symbol: matches[0].symbol, parentChain: matches[0].parentChain, analysis, fullPath };
}

function detectIndent(line: string): string {
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : "";
}


function insertLines(content: string, position: number, payload: string): string {
  const lines = content.split("\n");
  const head = lines.slice(0, position);
  const tail = lines.slice(position);
  return [...head, ...payload.split("\n"), ...tail].join("\n");
}

function looksLikeDefinitionStart(body: string, kind: string): boolean {
  // Export wrappers may precede the declaration on a separate line. Validate
  // the declaration start while retaining the original wrapper in the edit.
  const declaration = body.trimStart().replace(/^export\s+(?:default\s+)?/, "");
  const firstLine = declaration.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return false;
  // Generic checks that cover most languages and kinds
  if (kind === "function") {
    return /^(?:export\s+)?(?:async\s+)?(?:function|fn|func|def|pub\s+(?:async\s+)?fn)\b/.test(trimmed)
      || /=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/.test(trimmed)
      || /^(?:export\s+)?(?:const|let|var)\b.*=\s*(?:async\s*)?(?:function|\(|[a-zA-Z_$])/.test(trimmed);
  }
  if (kind === "method") {
    return /^(?:public|private|protected|static|async|readonly|get|set)?\s*[a-zA-Z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(trimmed)
      || /^(?:async\s+)?def\s+/.test(trimmed);
  }
  if (kind === "class" || kind === "interface" || kind === "enum" || kind === "type" || kind === "struct" || kind === "trait") {
    return new RegExp(`^(?:export\\s+|pub\\s+)?(?:abstract\\s+)?${kind}\\b`).test(trimmed)
      || /^export\s+default\s+(class|interface|enum|type)\b/.test(trimmed);
  }
  if (kind === "const" || kind === "variable") {
    return /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z_$]/.test(trimmed);
  }
  return true;
}

function detectBodyIndent(originalLines: string[], symbol: CodeSymbol): string {
  // Use indent from the FIRST non-blank line of the body (line after symbol.line),
  // not the definition line itself. Falls back to the definition-line indent if the body is empty.
  for (let i = symbol.line; i < symbol.endLine && i < originalLines.length; i++) {
    const line = originalLines[i];
    if (line.trim().length === 0) continue;
    return detectIndent(line);
  }
  return detectIndent(originalLines[symbol.line - 1] ?? "");
}

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function reindentBody(body: string, definitionIndent: string): string {
  const bodyLines = body.split("\n");
  if (bodyLines.length === 0) return body;

  // The provided body has its own internal indentation that MUST be preserved relative to the
  // first (signature) line. We re-anchor the whole block so the signature line sits at
  // `definitionIndent`, and every other line keeps its indent RELATIVE to the signature line.
  //
  // Find the base indent = indent of the first non-blank line (the signature). Then for each
  // line, the new indent = definitionIndent + (lineIndent - baseIndent), clamped at 0 so a body
  // line that is less-indented than the signature doesn't go negative.
  let baseIndent = 0;
  let baseFound = false;
  for (const line of bodyLines) {
    if (line.trim().length === 0) continue;
    baseIndent = indentWidth(line);
    baseFound = true;
    break;
  }
  if (!baseFound) return body;

  return bodyLines
    .map((line) => {
      if (line.trim().length === 0) return "";
      const lineIndent = indentWidth(line);
      const relativeIndent = Math.max(0, lineIndent - baseIndent);
      return `${definitionIndent}${" ".repeat(relativeIndent)}${line.trimStart()}`;
    })
    .join("\n");
}

function invalidateCaches(): void {
  invalidateSearchCache();
  invalidateIdentifierSearchCache();
}

async function assertEditKeepsSyntaxValid(
  relativePath: string,
  fullPath: string,
  originalContent: string,
  nextContent: string,
  operation: string,
): Promise<void> {
  const ext = extname(fullPath).toLowerCase();
  // Only enforce when the original file parsed cleanly — otherwise we'd block edits that fix
  // a pre-existing syntax error.
  const before = await validateSyntax(originalContent, ext);
  if (!before.checked || !before.ok) return;
  const after = await validateSyntax(nextContent, ext);
  if (after.checked && !after.ok) {
    const loc = after.firstError ? ` at L${after.firstError.line}:${after.firstError.column} (${after.firstError.type})` : "";
    throw new Error(
      `${operation}: the edit would introduce a syntax error${loc} in ${relativePath}. ` +
      `The file was NOT modified. Check the body's indentation and that it includes the full ` +
      `definition. (No restore point was created because nothing was written.)`
    );
  }
}

export async function replaceSymbolBody(options: SymbolicEditOptions): Promise<string> {
  return withSourceMutation(options.rootDir, () => replaceSymbolBodyLocked(options));
}

async function replaceSymbolBodyLocked(options: SymbolicEditOptions): Promise<string> {
  const snapshot = captureSource(options.rootDir, options.relativePath);
  assertExpectedHash(snapshot, options.expectedContentHash);
  const content = snapshot.content;
  if (content === null) throw new Error(`Source file does not exist: ${options.relativePath}`);
  const { symbol, fullPath } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath, content);
  const lines = content.split("\n");
  const definitionIndent = detectIndent(lines[symbol.line - 1] ?? "");

  if (!looksLikeDefinitionStart(options.body, symbol.kind)) {
    throw new Error(
      `replace_symbol_body: the provided 'body' does not look like a ${symbol.kind} definition. ` +
      `'body' must include the full definition (signature line through closing brace/dedent). ` +
      `For "${options.namePath}" in ${options.relativePath} the original signature starts with: ` +
      `"${(lines[symbol.line - 1] ?? "").trim().slice(0, 120)}". ` +
      `If you only want to change the inner body, include the original signature and braces; ` +
      `replace_symbol_body replaces the entire symbol span (L${symbol.line}-L${symbol.endLine}).`
    );
  }

  assertExactSpan(symbol);
  let replacement = reindentBody(options.body, definitionIndent).trimStart();
  if (content.includes("\r\n")) replacement = replacement.replace(/\r?\n/g, "\r\n");
  const next = content.slice(0, symbol.startIndex) + replacement + content.slice(symbol.endIndex);
  // Validate BEFORE writing or creating a restore point so a broken edit leaves no trace.
  await assertEditKeepsSyntaxValid(options.relativePath, fullPath, content, next, "replace_symbol_body");
  await createRestorePoint(options.rootDir, [options.relativePath], options.message ?? `replace_symbol_body:${options.namePath}`);
  await publishSource(options.rootDir, snapshot, next);
  invalidateCaches();
  return `Replaced ${symbol.kind} "${options.namePath}" in ${options.relativePath} (was L${symbol.line}-L${symbol.endLine}). Syntax validated.`;
}

const DECORATOR_LINE_RE = /^(@[\w$.]|#\[)/;

/**
 * Walk upward past any contiguous single-line decorator/annotation lines directly above a
 * symbol's own definition line (`@Injectable()`, `@Log()`, Python `@staticmethod`, Rust
 * `#[derive(...)]`), so a "before" insertion lands above the decorator block instead of
 * splicing between a decorator and the symbol it attaches to (which silently reassigns the
 * decorator to whatever gets inserted). `defLine0` is the symbol's own 0-based line index;
 * returns that unchanged when no decorator lines precede it. Does not attempt to span
 * multi-line decorator argument lists (e.g. `@Component({ ... })`) — those fall back to the
 * original position rather than risk misidentifying unrelated preceding code.
 */
function decoratorBlockStartLine(lines: string[], defLine0: number): number {
  let start = defLine0;
  let i = defLine0 - 1;
  while (i >= 0 && DECORATOR_LINE_RE.test(lines[i].trim())) {
    start = i;
    i--;
  }
  return start;
}

export async function insertAroundSymbol(options: InsertSymbolOptions): Promise<string> {
  return withSourceMutation(options.rootDir, () => insertAroundSymbolLocked(options));
}

async function insertAroundSymbolLocked(options: InsertSymbolOptions): Promise<string> {
  const snapshot = captureSource(options.rootDir, options.relativePath);
  assertExpectedHash(snapshot, options.expectedContentHash);
  const content = snapshot.content;
  if (content === null) throw new Error(`Source file does not exist: ${options.relativePath}`);
  const { symbol, fullPath } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath, content);
  const lines = content.split("\n");
  const insertion = options.position === "before"
    ? `${options.body}\n`
    : `\n${options.body}`;
  const insertLine = options.position === "before"
    ? decoratorBlockStartLine(lines, symbol.line - 1)
    : symbol.endLine;
  assertExactSpan(symbol);
  // Whole-line insertion is safe only when there is no neighboring code on the boundary.
  const boundary = options.position === "before" ? symbol.startIndex! : symbol.endIndex!;
  const lineStart = content.lastIndexOf("\n", boundary - 1) + 1;
  const lineEnd = content.indexOf("\n", boundary);
  const adjacent = options.position === "before"
    ? content.slice(lineStart, boundary)
    : content.slice(boundary, lineEnd < 0 ? content.length : lineEnd);
  const next = adjacent.trim().length === 0
    ? insertLines(content, insertLine, insertion)
    : content.slice(0, boundary) + "\n" + options.body + "\n" + content.slice(boundary);
  await assertEditKeepsSyntaxValid(options.relativePath, fullPath, content, next, `insert_${options.position}_symbol`);
  await createRestorePoint(options.rootDir, [options.relativePath], options.message ?? `insert_${options.position}_symbol:${options.namePath}`);
  await publishSource(options.rootDir, snapshot, next);
  invalidateCaches();
  return `Inserted ${options.position} ${symbol.kind} "${options.namePath}" in ${options.relativePath} at L${options.position === "before" ? insertLine + 1 : symbol.endLine + 1}. Syntax validated.`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Shared offset-preserving mask prevents renames inside comments and literal text. */
function maskStringsAndComments(content: string, filePath: string): boolean[] {
  return sourceMaskFlags(content, filePath);
}

/** Word-boundary rename that skips occurrences inside string literals and comments. */
function renameOutsideStringsAndComments(
  text: string,
  oldName: string,
  newName: string,
  filePath: string,
): { result: string; occurrences: number; skipped: number } {
  const masked = maskStringsAndComments(text, filePath);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegex(oldName)}(?![\\p{L}\\p{N}_$])`, "gu");
  let occurrences = 0;
  let skipped = 0;
  const result = text.replace(pattern, (match, offset: number) => {
    if (masked[offset]) { skipped++; return match; }
    occurrences++;
    return newName;
  });
  return { result, occurrences, skipped };
}

export async function renameSymbol(options: RenameSymbolOptions): Promise<string> {
  return withSourceMutation(options.rootDir, () => renameSymbolLocked(options));
}

async function renameSymbolLocked(options: RenameSymbolOptions): Promise<string> {
  const snapshot = captureSource(options.rootDir, options.relativePath);
  assertExpectedHash(snapshot, options.expectedContentHash);
  if (snapshot.content === null) throw new Error(`Source file does not exist: ${options.relativePath}`);
  const { symbol, fullPath, analysis } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath, snapshot.content);
  const oldName = symbol.name;
  assertRenameName(options.newName, fullPath);
  if (options.newName === oldName) throw new Error(`rename_symbol: new name "${options.newName}" is identical to the existing name. No rename performed.`);
  const collision = flattenSymbols(analysis.symbols).find((sym) => sym.name === options.newName);
  if (collision) throw new Error(`rename_symbol: a ${collision.kind} named "${options.newName}" already exists at L${collision.line}. Choose a different name.`);

  const candidateFiles = new Set<string>([options.relativePath]);
  const db = await getDB(options.rootDir);
  const dbFile = db.getFile(options.relativePath);
  if (dbFile) {
    const fileMap = new Map(db.getAllFiles().map((file) => [file.id, file.path] as const));
    for (const importer of db.getImportersOf(dbFile.id)) {
      const path = fileMap.get(importer.source_file_id);
      if (path) candidateFiles.add(path);
    }
    for (const caller of db.getCallersOf(oldName)) {
      const path = fileMap.get(caller.file_id);
      if (path) candidateFiles.add(path);
    }
  }
  const staged: { file: string; snapshot: SourceSnapshot; next: string; occurrences: number }[] = [];
  let totalSkipped = 0;
  for (const file of candidateFiles) {
    const source = file === options.relativePath ? snapshot : captureSource(options.rootDir, file);
    if (source.content === null) throw new Error(`rename_symbol: candidate ${file} is missing. No files were modified; refresh the index and retry.`);
    const renamed = renameOutsideStringsAndComments(source.content, oldName, options.newName, source.path);
    totalSkipped += renamed.skipped;
    if (renamed.occurrences === 0) continue;
    // Validate every candidate even when its original syntax is already broken: rename must
    // never publish an unchecked batch. Use the replacement tools to repair broken source.
    const validation = await validateSyntax(renamed.result, extname(source.path).toLowerCase());
    if (!validation.checked || !validation.ok) {
      throw new Error(`rename_symbol: proposed rename cannot be syntax validated in ${file}${validation.firstError ? ` at L${validation.firstError.line}` : ""}. No files were modified.`);
    }
    staged.push({ file, snapshot: source, next: renamed.result, occurrences: renamed.occurrences });
  }
  for (const item of staged) assertSourceUnchanged(options.rootDir, item.snapshot);
  const restore = await createRestorePoint(options.rootDir, staged.map((item) => item.file), options.message ?? `rename_symbol:${oldName}->${options.newName}`);
  const completed: string[] = [];
  try {
    for (const item of staged) {
      await publishSource(options.rootDir, item.snapshot, item.next);
      completed.push(item.file);
    }
  } catch (error) {
    throw new Error(`rename_symbol failed: ${error instanceof Error ? error.message : String(error)} Updated files: ${completed.join(", ") || "none"}. Pending files: ${staged.filter((item) => !completed.includes(item.file)).map((item) => item.file).join(", ")}. Restore point: ${restore.id}.`);
  } finally { invalidateCaches(); }
  const occurrences = staged.find((item) => item.file === options.relativePath)?.occurrences ?? 0;
  const skipNote = totalSkipped ? ` (${totalSkipped} occurrence(s) inside string literals/comments left untouched)` : "";
  return `Renamed ${symbol.kind} "${oldName}" → "${options.newName}" in ${options.relativePath} (${occurrences} occurrences in definition file, ${Math.max(0, completed.length - 1)} other file(s) updated based on import/call graph).${skipNote}`;
}

// Structural grammars sometimes accept keywords in identifier positions. Reject reserved
// names separately; syntax validation of every staged file remains necessary as well.
export function assertRenameName(name: string, filePath: string): void {
  const language = getGrammarName(extname(filePath).toLowerCase()) ?? "unknown";
  const js = ["typescript", "tsx", "javascript"].includes(language);
  if (!(js ? /^[A-Za-z_$][A-Za-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(name)) {
    throw new Error(`Invalid new symbol name "${name}" for ${language}.`);
  }
  const reserved: Record<string, string> = {
    javascript: "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield",
    python: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
    rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try",
    go: "break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var",
    java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _",
    c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local",
  };
  const words = reserved[js ? "javascript" : language]
    ?? "as break case catch class const continue default do else enum export extends false finally for function if import in new null private protected public return static struct super switch this throw true try type typeof var void while with yield";
  if (new Set(words.split(" ")).has(name)) throw new Error(`Invalid new symbol name "${name}": reserved keyword in ${language}. No files were modified.`);
}

function assertExpectedHash(snapshot: SourceSnapshot, expected: string | undefined): void {
  if (expected !== undefined && snapshot.hash !== expected) throw new Error(`Source conflict: ${snapshot.path} does not match expectedContentHash. Read current content and retry.`);
}

function assertExactSpan(symbol: CodeSymbol): void {
  if (symbol.startIndex === undefined || symbol.endIndex === undefined || symbol.sharedDeclaration) {
    throw new Error(`Cannot safely edit "${symbol.name}": an unambiguous exact source span is unavailable. Use a checked whole-file edit instead.`);
  }
}

export type { SymbolLocation };
