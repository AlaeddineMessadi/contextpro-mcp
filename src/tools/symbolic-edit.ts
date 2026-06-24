// Symbolic find and edit tools — Serena-parity symbol-level operations
// FEATURE: Symbol-precise editing without LSP — parser-driven find / replace / insert / rename

import { readFile, writeFile } from "fs/promises";
import { resolveProjectPath } from "../core/path-guard.js";
import { analyzeFile, flattenSymbols, isSupportedFile, type CodeSymbol, type SymbolLocation } from "../core/parser.js";
import { walkDirectory } from "../core/walker.js";
import { getDB } from "../core/db.js";
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
}

export interface InsertSymbolOptions {
  rootDir: string;
  relativePath: string;
  namePath: string;
  body: string;
  position: "before" | "after";
  message?: string;
}

export interface RenameSymbolOptions {
  rootDir: string;
  relativePath: string;
  namePath: string;
  newName: string;
  message?: string;
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

function matchesNamePathPattern(candidate: string, pattern: string, substringMatching: boolean): boolean {
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

function toFoundEntry(match: MatchedSymbol, filePath: string, fileLines: string[], includeBody: boolean, depth: number): FoundSymbolEntry {
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
    entry.body = fileLines.slice(match.symbol.line - 1, match.symbol.endLine).join("\n");
  }
  if (depth > 0 && match.symbol.children.length > 0) {
    entry.children = match.symbol.children.map((child) =>
      toFoundEntry({ symbol: child, namePath: `${match.namePath}/${child.name}`, parentChain: [...match.parentChain, match.symbol.name] }, filePath, fileLines, includeBody, depth - 1),
    );
  }
  return entry;
}

async function findInOneFile(rootDir: string, relativePath: string, options: FindSymbolOptions): Promise<FoundSymbolEntry[]> {
  const fullPath = resolveProjectPath(rootDir, relativePath, "relativePath");
  if (!isSupportedFile(fullPath)) return [];
  try {
    const analysis = await analyzeFile(fullPath);
    const flat = flattenWithNamePath(analysis.symbols);
    const fileLines = (options.includeBody ? (await readFile(fullPath, "utf-8")).split("\n") : []);
    const includeBody = options.includeBody === true;
    const depth = Math.max(0, Math.floor(options.depth ?? 0));
    return flat
      .filter((match) => matchesNamePathPattern(match.namePath, options.namePathPattern, options.substringMatching === true))
      .filter((match) => withinKindFilter(match.symbol, options.includeKinds, options.excludeKinds))
      .map((match) => toFoundEntry(match, relativePath, fileLines, includeBody, depth));
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

async function locateSymbolForEdit(rootDir: string, relativePath: string, namePath: string): Promise<{ symbol: CodeSymbol; parentChain: string[]; analysis: Awaited<ReturnType<typeof analyzeFile>>; fullPath: string }> {
  const fullPath = resolveProjectPath(rootDir, relativePath, "relativePath");
  if (!isSupportedFile(fullPath)) {
    throw new Error(`File is not a supported source language: ${relativePath}`);
  }
  const analysis = await analyzeFile(fullPath);
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

function applyLineEdit(content: string, startLine: number, endLine: number, replacement: string): string {
  const lines = content.split("\n");
  const head = lines.slice(0, startLine - 1);
  const tail = lines.slice(endLine);
  return [...head, ...replacement.split("\n"), ...tail].join("\n");
}

function insertLines(content: string, position: number, payload: string): string {
  const lines = content.split("\n");
  const head = lines.slice(0, position);
  const tail = lines.slice(position);
  return [...head, ...payload.split("\n"), ...tail].join("\n");
}

function looksLikeDefinitionStart(body: string, kind: string): boolean {
  const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
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

function reindentBody(body: string, definitionIndent: string): string {
  const bodyLines = body.split("\n");
  if (bodyLines.length === 0) return body;
  // Find the minimum indent across non-empty lines AFTER the first line — these are the "body"
  // lines whose indent should be normalized relative to the new definitionIndent.
  let minBodyIndent = Infinity;
  for (let i = 1; i < bodyLines.length; i++) {
    const trimmed = bodyLines[i].trim();
    if (trimmed.length === 0) continue;
    const indent = bodyLines[i].length - bodyLines[i].trimStart().length;
    if (indent < minBodyIndent) minBodyIndent = indent;
  }
  if (!Number.isFinite(minBodyIndent)) minBodyIndent = 0;
  return bodyLines
    .map((line, idx) => {
      if (idx === 0) return `${definitionIndent}${line.replace(/^[ \t]*/, "")}`;
      if (line.length === 0) return "";
      const stripped = line.length >= minBodyIndent ? line.slice(minBodyIndent) : line.trimStart();
      return `${definitionIndent}${stripped}`;
    })
    .join("\n");
}

function invalidateCaches(): void {
  invalidateSearchCache();
  invalidateIdentifierSearchCache();
}

export async function replaceSymbolBody(options: SymbolicEditOptions): Promise<string> {
  const { symbol, fullPath } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath);
  const content = await readFile(fullPath, "utf-8");
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

  const replacement = reindentBody(options.body, definitionIndent);
  await createRestorePoint(options.rootDir, [options.relativePath], options.message ?? `replace_symbol_body:${options.namePath}`);
  const next = applyLineEdit(content, symbol.line, symbol.endLine, replacement);
  await writeFile(fullPath, next, "utf-8");
  invalidateCaches();
  return `Replaced ${symbol.kind} "${options.namePath}" in ${options.relativePath} (was L${symbol.line}-L${symbol.endLine}).`;
}

export async function insertAroundSymbol(options: InsertSymbolOptions): Promise<string> {
  const { symbol, fullPath } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath);
  const content = await readFile(fullPath, "utf-8");
  await createRestorePoint(options.rootDir, [options.relativePath], options.message ?? `insert_${options.position}_symbol:${options.namePath}`);
  const insertion = options.position === "before"
    ? `${options.body}\n`
    : `\n${options.body}`;
  const insertLine = options.position === "before" ? symbol.line - 1 : symbol.endLine;
  const next = insertLines(content, insertLine, insertion);
  await writeFile(fullPath, next, "utf-8");
  invalidateCaches();
  return `Inserted ${options.position} ${symbol.kind} "${options.namePath}" in ${options.relativePath} at L${options.position === "before" ? symbol.line : symbol.endLine + 1}.`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function renameSymbol(options: RenameSymbolOptions): Promise<string> {
  const { symbol, fullPath } = await locateSymbolForEdit(options.rootDir, options.relativePath, options.namePath);
  const oldName = symbol.name;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.newName)) {
    throw new Error(`Invalid new symbol name "${options.newName}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
  }
  if (options.newName === oldName) {
    throw new Error(`rename_symbol: new name "${options.newName}" is identical to the existing name. No rename performed.`);
  }

  // Collision check: refuse if a different symbol with the new name already exists in the same file.
  const analysis = await analyzeFile(fullPath);
  const flat = flattenSymbols(analysis.symbols);
  const collision = flat.find((sym) => sym.name === options.newName && sym.line !== symbol.line);
  if (collision) {
    throw new Error(
      `rename_symbol: cannot rename "${oldName}" → "${options.newName}" in ${options.relativePath} because ` +
      `a ${collision.kind} named "${options.newName}" already exists at L${collision.line}. ` +
      `Choose a different name or rename/remove the existing symbol first.`
    );
  }
  await createRestorePoint(options.rootDir, [options.relativePath], options.message ?? `rename_symbol:${oldName}->${options.newName}`);
  const original = await readFile(fullPath, "utf-8");
  const pattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");
  const next = original.replace(pattern, options.newName);
  const occurrences = (original.match(pattern) ?? []).length;
  await writeFile(fullPath, next, "utf-8");

  const db = await getDB(options.rootDir);
  const dbFile = db.getFile(options.relativePath);
  let crossFileEdited = 0;
  if (dbFile) {
    const importers = db.getImportersOf(dbFile.id);
    const callers = db.getCallersOf(oldName);
    const allFiles = db.getAllFiles();
    const fileMap = new Map(allFiles.map((file) => [file.id, file.path] as const));
    const candidateFiles = new Set<string>();
    for (const importer of importers) {
      const path = fileMap.get(importer.source_file_id);
      if (path) candidateFiles.add(path);
    }
    for (const caller of callers) {
      const path = fileMap.get(caller.file_id);
      if (path && path !== options.relativePath) candidateFiles.add(path);
    }

    if (candidateFiles.size > 0) {
      await createRestorePoint(options.rootDir, [...candidateFiles], `rename_symbol_cross:${oldName}->${options.newName}`);
      for (const path of candidateFiles) {
        try {
          const candidatePath = resolveProjectPath(options.rootDir, path, "renameCandidate");
          const text = await readFile(candidatePath, "utf-8");
          const filePattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");
          if (!filePattern.test(text)) continue;
          const replaced = text.replace(new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g"), options.newName);
          if (replaced !== text) {
            await writeFile(candidatePath, replaced, "utf-8");
            crossFileEdited++;
          }
        } catch {
          // best-effort cross-file rename
        }
      }
    }
  }
  invalidateCaches();
  return `Renamed ${symbol.kind} "${oldName}" → "${options.newName}" in ${options.relativePath} (${occurrences} occurrences in definition file, ${crossFileEdited} other file(s) updated based on import/call graph).`;
}

export type { SymbolLocation };
