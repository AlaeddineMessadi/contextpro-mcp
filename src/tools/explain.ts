// Extract function/class body with immediate dependencies for targeted understanding
// FEATURE: Explain — read specific symbols without loading entire files

import { readFile } from "fs/promises";
import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { getDB } from "../core/db.js";
import { resolveSymbolData } from "./resolve-symbol.js";
import { resolveProjectPath } from "../core/path-guard.js";

export interface ExplainOptions {
  rootDir: string;
  symbol?: string;
  file?: string;
  depth?: number;
}

interface SymbolBody {
  name: string;
  kind: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  body: string;
}

interface CallReference {
  name: string;
  kind?: string;
}

async function findSymbolInFile(rootDir: string, filePath: string, symbolName: string, preferredLine?: number): Promise<SymbolBody | null> {
  const fullPath = resolveProjectPath(rootDir, filePath, "file");
  try {
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    const analysis = await analyzeFile(fullPath);
    const flat = flattenSymbols(analysis.symbols);
    const match = preferredLine
      ? flat.find((symbol) => symbol.name === symbolName && symbol.line === preferredLine) ?? flat.find((symbol) => symbol.name === symbolName)
      : flat.find((symbol) => symbol.name === symbolName);
    if (!match) return null;

    const bodyLines = lines.slice(match.line - 1, match.endLine);
    return {
      name: match.name,
      kind: match.kind,
      file: filePath,
      lineStart: match.line,
      lineEnd: match.endLine,
      signature: match.signature,
      body: bodyLines.join("\n"),
    };
  } catch {
    return null;
  }
}

async function findSymbolAcrossProject(rootDir: string, symbolName: string, fileContext?: string, kind?: string): Promise<SymbolBody | null> {
  const resolution = await resolveSymbolData({
    rootDir,
    symbolName,
    fileContext,
    kind,
    limit: 5,
  });
  const bestMatch = resolution.bestMatch;

  if (bestMatch) {
    const result = await findSymbolInFile(rootDir, bestMatch.path, bestMatch.name, bestMatch.line);
    if (result) return result;
  }

  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const sourceFiles = entries.filter((e) => !e.isDirectory && isSupportedFile(e.path));

  for (const entry of sourceFiles) {
    const result = await findSymbolInFile(rootDir, entry.relativePath, symbolName);
    if (result) return result;
  }

  return null;
}

function collectCallReferences(body: string): CallReference[] {
  const refs = new Map<string, CallReference>();

  const memberPattern = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(/g;
  let memberMatch;
  while ((memberMatch = memberPattern.exec(body)) !== null) {
    const name = memberMatch[2];
    refs.set(`method:${name}`, { name, kind: "method" });
  }

  const functionPattern = /(?<!\.)\b([a-zA-Z_]\w*)\s*\(/g;
  let functionMatch;
  while ((functionMatch = functionPattern.exec(body)) !== null) {
    const name = functionMatch[1];
    refs.set(`call:${name}`, { name });
  }

  return [...refs.values()];
}

async function getCalledSymbols(rootDir: string, body: string, currentFile: string, depth: number): Promise<SymbolBody[]> {
  if (depth <= 0) return [];

  const db = await getDB(rootDir);
  const allDbFiles = db.getAllFiles();
  const allSymbolNames = new Set<string>();

  for (const file of allDbFiles) {
    const symbols = db.getSymbolsByFile(file.id);
    for (const s of symbols) allSymbolNames.add(s.name);
  }

  const callReferences = collectCallReferences(body).filter((ref) => allSymbolNames.has(ref.name) && ref.name.length > 2);

  const results: SymbolBody[] = [];
  for (const ref of callReferences) {
    const found = await findSymbolAcrossProject(rootDir, ref.name, currentFile, ref.kind);
    if (found && found.file !== currentFile) {
      results.push(found);
      if (depth > 1) {
        const deeper = await getCalledSymbols(rootDir, found.body, found.file, depth - 1);
        results.push(...deeper);
      }
    }
    if (results.length >= 10) break;
  }

  return results;
}

function extractDocComment(body: string): string | null {
  const lines = body.split("\n");
  const docLines: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      inBlock = true;
      const cleaned = trimmed.replace(/^\/\*+/, "").replace(/\*+\/$/, "").trim();
      if (cleaned) docLines.push(cleaned);
      if (trimmed.endsWith("*/")) { inBlock = false; break; }
      continue;
    }
    if (inBlock) {
      if (trimmed.endsWith("*/")) {
        const cleaned = trimmed.replace(/\*+\/$/, "").replace(/^\*+/, "").trim();
        if (cleaned) docLines.push(cleaned);
        inBlock = false;
        break;
      }
      docLines.push(trimmed.replace(/^\*+\s?/, ""));
      continue;
    }
    if (trimmed.startsWith("//")) {
      docLines.push(trimmed.replace(/^\/\/\s?/, ""));
      continue;
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      docLines.push(trimmed.replace(/^["']{3}|["']{3}$/g, "").trim());
      continue;
    }
    if (docLines.length > 0 || trimmed.length === 0) break;
    break;
  }
  const joined = docLines.filter(Boolean).join(" ").trim();
  return joined.length > 0 ? joined : null;
}

async function summarizeCallers(rootDir: string, symbolName: string, definitionFile: string): Promise<{ count: number; files: string[]; preview: Array<{ path: string; line: number; context: string }> }> {
  const db = await getDB(rootDir);
  const callers = db.getCallersOf(symbolName);
  if (callers.length === 0) return { count: 0, files: [], preview: [] };
  const allFiles = db.getAllFiles();
  const fileMap = new Map(allFiles.map((file) => [file.id, file.path] as const));
  const files = new Set<string>();
  const preview: Array<{ path: string; line: number; context: string }> = [];
  for (const caller of callers) {
    const path = fileMap.get(caller.file_id);
    if (!path || path === definitionFile) continue;
    files.add(path);
    if (preview.length < 5) {
      preview.push({ path, line: caller.line, context: caller.context.substring(0, 110) });
    }
  }
  return { count: callers.length, files: [...files].sort(), preview };
}

async function findRelatedTests(rootDir: string, definitionFile: string, symbolName: string): Promise<string[]> {
  const db = await getDB(rootDir);
  const file = db.getFile(definitionFile);
  if (!file) return [];
  const allFiles = db.getAllFiles();
  const fileMap = new Map(allFiles.map((f) => [f.id, f.path] as const));
  const testFiles = new Set<string>();

  for (const importer of db.getImportersOf(file.id)) {
    const path = fileMap.get(importer.source_file_id);
    if (path && /\.(test|spec|demo)\./.test(path)) testFiles.add(path);
  }

  for (const caller of db.getCallersOf(symbolName)) {
    const path = fileMap.get(caller.file_id);
    if (path && /\.(test|spec|demo)\./.test(path)) testFiles.add(path);
  }

  return [...testFiles].sort().slice(0, 5);
}

function findSiblingSymbols(symbols: ReturnType<typeof flattenSymbols>, targetName: string): string[] {
  const target = symbols.find((symbol) => symbol.name === targetName);
  if (!target) return [];
  return symbols
    .filter((symbol) => symbol.name !== targetName && symbol.parentName === target.parentName)
    .slice(0, 8)
    .map((symbol) => `${symbol.kind}:${symbol.name}`);
}

export async function explain(options: ExplainOptions): Promise<string> {
  const depth = options.depth ?? 1;

  if (options.file && !options.symbol) {
    const fullPath = resolveProjectPath(options.rootDir, options.file, "file");
    try {
      const analysis = await analyzeFile(fullPath);
      const flat = flattenSymbols(analysis.symbols);
      const lines = [
        `=== ${options.file} ===`,
        `Header: ${analysis.header}`,
        `Lines: ${analysis.lineCount}`,
        `Symbols: ${flat.length}`,
        "",
      ];
      for (const s of flat) {
        lines.push(`  ${s.kind}: ${s.name} (L${s.line}-L${s.endLine})`);
        if (s.signature !== s.name) lines.push(`    ${s.signature}`);
      }
      return lines.join("\n");
    } catch {
      return `Could not analyze file: ${options.file}`;
    }
  }

  if (!options.symbol) {
    return "Provide a symbol name to explain, or a file path for a file overview.";
  }

  let symbolBody: SymbolBody | null = null;

  if (options.file) {
    symbolBody = await findSymbolInFile(options.rootDir, options.file, options.symbol);
  } else {
    symbolBody = await findSymbolAcrossProject(options.rootDir, options.symbol, options.file);
  }

  if (!symbolBody) {
    return `Symbol "${options.symbol}" not found${options.file ? ` in ${options.file}` : " in the project"}.`;
  }

  const doc = extractDocComment(symbolBody.body);
  const callerSummary = await summarizeCallers(options.rootDir, symbolBody.name, symbolBody.file);
  const relatedTests = await findRelatedTests(options.rootDir, symbolBody.file, symbolBody.name);
  let siblings: string[] = [];
  try {
    const analysis = await analyzeFile(resolveProjectPath(options.rootDir, symbolBody.file, "definitionFile"));
    siblings = findSiblingSymbols(flattenSymbols(analysis.symbols), symbolBody.name);
  } catch {
    siblings = [];
  }

  const lines = [
    `=== ${symbolBody.kind}: ${symbolBody.name} ===`,
    `File: ${symbolBody.file}`,
    `Lines: ${symbolBody.lineStart}-${symbolBody.lineEnd}`,
    `Signature: ${symbolBody.signature.trim().substring(0, 200)}`,
  ];
  if (doc) lines.push(`Doc: ${doc.substring(0, 240)}`);
  lines.push(
    `Usage: ${callerSummary.count} call sites across ${callerSummary.files.length} file(s)`,
    "",
    `\`\`\``,
    symbolBody.body,
    `\`\`\``,
  );

  if (callerSummary.preview.length > 0) {
    lines.push("");
    lines.push("--- Top callers ---");
    for (const caller of callerSummary.preview) {
      lines.push(`  ${caller.path}:L${caller.line}  ${caller.context}`);
    }
  }

  if (relatedTests.length > 0) {
    lines.push("");
    lines.push("--- Related tests ---");
    for (const test of relatedTests) lines.push(`  ${test}`);
  }

  if (siblings.length > 0) {
    lines.push("");
    lines.push(`Siblings: ${siblings.join(", ")}`);
  }

  if (depth > 0) {
    const called = await getCalledSymbols(options.rootDir, symbolBody.body, symbolBody.file, depth);
    if (called.length > 0) {
      lines.push("");
      lines.push(`--- Called functions (depth ${depth}) ---`);
      const seen = new Set<string>();
      for (const c of called) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        lines.push("");
        lines.push(`${c.kind}: ${c.name} (${c.file} L${c.lineStart}-L${c.lineEnd})`);
        lines.push("```");
        const bodyLines = c.body.split("\n");
        if (bodyLines.length > 20) {
          lines.push(bodyLines.slice(0, 15).join("\n"));
          lines.push(`  ... (${bodyLines.length - 15} more lines)`);
        } else {
          lines.push(c.body);
        }
        lines.push("```");
      }
    }
  }

  return lines.join("\n");
}
