// Extract function/class body with immediate dependencies for targeted understanding
// FEATURE: Explain — read specific symbols without loading entire files

import { readFile } from "fs/promises";
import { resolve } from "path";
import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { getDB } from "../core/db.js";

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

async function findSymbolInFile(rootDir: string, filePath: string, symbolName: string): Promise<SymbolBody | null> {
  const fullPath = resolve(rootDir, filePath);
  try {
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    const analysis = await analyzeFile(fullPath);
    const flat = flattenSymbols(analysis.symbols);
    const match = flat.find((s) => s.name === symbolName);
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

async function findSymbolAcrossProject(rootDir: string, symbolName: string): Promise<SymbolBody | null> {
  const db = await getDB(rootDir);
  const dbSymbols = db.searchSymbolsByName(symbolName);
  const exactMatch = dbSymbols.find((s) => s.name === symbolName);

  if (exactMatch) {
    const allFiles = db.getAllFiles();
    const file = allFiles.find((f) => f.id === exactMatch.file_id);
    if (file) {
      const result = await findSymbolInFile(rootDir, file.path, symbolName);
      if (result) return result;
    }
  }

  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const sourceFiles = entries.filter((e) => !e.isDirectory && isSupportedFile(e.path));

  for (const entry of sourceFiles) {
    const result = await findSymbolInFile(rootDir, entry.relativePath, symbolName);
    if (result) return result;
  }

  return null;
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

  const wordPattern = /\b([a-zA-Z_]\w+)\s*\(/g;
  const calledNames = new Set<string>();
  let match;
  while ((match = wordPattern.exec(body)) !== null) {
    const name = match[1];
    if (allSymbolNames.has(name) && name.length > 2) calledNames.add(name);
  }

  const results: SymbolBody[] = [];
  for (const name of calledNames) {
    const found = await findSymbolAcrossProject(rootDir, name);
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
    const fullPath = resolve(options.rootDir, options.file);
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
    symbolBody = await findSymbolAcrossProject(options.rootDir, options.symbol);
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
