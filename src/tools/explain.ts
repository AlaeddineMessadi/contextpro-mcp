// Extract function/class body with immediate dependencies for targeted understanding
// FEATURE: Explain — read specific symbols without loading entire files

import { readFile } from "fs/promises";
import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { getDB } from "../core/db.js";
import { resolveSymbolData } from "./resolve-symbol.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { maskSourceText } from "../core/source-mask.js";

export interface ExplainOptions {
  rootDir: string;
  symbol?: string;
  file?: string;
  depth?: number;
  symbols?: Array<{ symbol: string; file?: string }>;
  maxTokens?: number;
  format?: "full" | "source";
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
  receiver?: string;
}

// Without receiver type information these ubiquitous platform/container methods
// are more likely to resolve to an unrelated project definition than a real callee.
const GENERIC_MEMBER_CALLS = new Set([
  "add", "all", "append", "at", "catch", "clear", "concat", "delete", "entries",
  "every", "filter", "finally", "find", "flat", "flatMap", "forEach", "get", "has",
  "includes", "join", "keys", "map", "pop", "push", "reduce", "set", "shift", "slice",
  "some", "sort", "splice", "split", "startsWith", "substring", "then", "trim",
  "unshift", "values", "write",
]);
const BUILTIN_CALL_RECEIVERS = new Set([
  "Array", "BigInt", "Boolean", "Buffer", "Date", "Error", "JSON", "Map", "Math",
  "Number", "Object", "Promise", "Reflect", "RegExp", "Set", "String", "Symbol",
  "WeakMap", "WeakSet", "console",
]);

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

function collectCallReferences(body: string, currentFile: string): CallReference[] {
  const refs = new Map<string, CallReference>();
  const executableBody = maskSourceText(body, currentFile);

  const memberPattern = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(/g;
  let memberMatch;
  while ((memberMatch = memberPattern.exec(executableBody)) !== null) {
    const receiver = memberMatch[1];
    const name = memberMatch[2];
    if (BUILTIN_CALL_RECEIVERS.has(receiver) || GENERIC_MEMBER_CALLS.has(name)) continue;
    refs.set(`method:${receiver}:${name}`, { name, kind: "method", receiver });
  }

  const functionPattern = /(?<!\.)\b([a-zA-Z_]\w*)\s*\(/g;
  let functionMatch;
  while ((functionMatch = functionPattern.exec(executableBody)) !== null) {
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

  const callReferences = collectCallReferences(body, currentFile).filter((ref) => allSymbolNames.has(ref.name) && ref.name.length > 2);

  const results: SymbolBody[] = [];
  for (const ref of callReferences) {
    // Bare calls should prefer a helper in the same module. Member calls need the
    // import-aware resolver because a same-named method in this file may belong to
    // an unrelated class.
    const local = ref.kind ? null : await findSymbolInFile(rootDir, currentFile, ref.name);
    const found = local ?? await findSymbolAcrossProject(rootDir, ref.name, currentFile, ref.kind);
    const isSelf = found?.file === currentFile && found.body === body;
    if (found && !isSelf) {
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
  if (options.symbols) {
    if (options.symbol || options.file) throw new Error("Use symbols or symbol/file, not both.");
    if (!options.symbols.length || options.symbols.length > 6) throw new Error("Batch explain accepts one to six symbols.");
    const budget = options.maxTokens ?? 4000;
    if (!Number.isInteger(budget) || budget < 512 || budget > 12000) throw new Error("max_tokens must be an integer from 512 to 12000.");
    const results = await Promise.all(options.symbols.map(item => explain({ rootDir: options.rootDir, ...item, depth: options.depth ?? 0, format: options.format })));
    const sections: string[] = [];
    const omitted: Array<{ symbol: string; file?: string }> = [];
    // Reserve room for explicit omitted targets; never return a truncated function body.
    const allowance = budget * 4 - Buffer.byteLength(JSON.stringify(options.symbols)) - 100;
    if (allowance < 100) throw new Error("Batch target descriptions exceed the response budget; use fewer targets or a larger max_tokens.");
    let bytes = 0;
    for (let i = 0; i < results.length; i++) {
      const size = Buffer.byteLength(results[i]) + 2;
      if (bytes + size > allowance) { omitted.push(options.symbols[i]); continue; }
      sections.push(results[i]); bytes += size;
    }
    if (omitted.length) sections.push(`Omitted to fit response budget; request these separately: ${JSON.stringify(omitted)}`);
    return sections.join("\n\n");
  }
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

  if (options.format === "source") return `${symbolBody.file}:${symbolBody.lineStart}-${symbolBody.lineEnd}\n${symbolBody.body}`;

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
      let directCount = 0;
      for (const c of called) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        if (c.file === symbolBody.file || called.indexOf(c) < called.length) directCount++;
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
      if (depth > 1) {
        const directCalled = await getCalledSymbols(options.rootDir, symbolBody.body, symbolBody.file, 1);
        const deeperAdded = seen.size - new Set(directCalled.map((c) => c.name)).size;
        if (deeperAdded === 0) {
          lines.push("");
          lines.push(`(depth ${depth} added 0 nodes beyond depth 1 — the call graph saturates at depth 1 for this symbol.)`);
        } else {
          lines.push("");
          lines.push(`(depth ${depth} added ${deeperAdded} additional node(s) beyond depth 1.)`);
        }
      }
    } else {
      lines.push("");
      lines.push(`(No called functions resolved at depth ${depth}. The body has no recognizable identifier calls, or callees are not in the indexed symbol set.)`);
    }
  }

  return lines.join("\n");
}
