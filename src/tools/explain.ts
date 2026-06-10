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

  const lines = [
    `=== ${symbolBody.kind}: ${symbolBody.name} ===`,
    `File: ${symbolBody.file}`,
    `Lines: ${symbolBody.lineStart}-${symbolBody.lineEnd}`,
    ``,
    `\`\`\``,
    symbolBody.body,
    `\`\`\``,
  ];

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
