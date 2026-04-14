// Dependency graph analyzer tracing symbol usage via SQLite import graph and call_sites
// FEATURE: Blast radius — find every usage of a symbol before modifying it

import { getDB } from "../core/db.js";
import { isSupportedFile } from "../core/parser.js";
import { readFile } from "fs/promises";
import { resolve } from "path";

export interface BlastRadiusOptions {
  rootDir: string;
  symbolName: string;
  fileContext?: string;
}

interface SymbolUsage {
  file: string;
  line: number;
  context: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDefinitionLine(line: string, symbolName: string): boolean {
  const definitionPatterns = [
    new RegExp(`(?:function|class|enum|interface|struct|type|trait|fn|def|func)\\s+${escapeRegex(symbolName)}`),
    new RegExp(`(?:const|let|var|pub|export)\\s+(?:async\\s+)?(?:function\\s+)?${escapeRegex(symbolName)}`),
  ];
  return definitionPatterns.some((p) => p.test(line));
}

async function scanFileForSymbol(
  filePath: string,
  relativePath: string,
  symbolName: string,
  fileContext: string | undefined,
): Promise<SymbolUsage[]> {
  const symbolPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g");
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const usages: SymbolUsage[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (symbolPattern.test(lines[i])) {
        const isDefinition = fileContext && relativePath === fileContext && isDefinitionLine(lines[i], symbolName);
        if (!isDefinition) {
          usages.push({ file: relativePath, line: i + 1, context: lines[i].trim().substring(0, 120) });
        }
        symbolPattern.lastIndex = 0;
      }
    }
    return usages;
  } catch {
    return [];
  }
}

export async function getBlastRadius(options: BlastRadiusOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const usages: SymbolUsage[] = [];

  const callSiteRows = db.getCallersOf(options.symbolName);
  const contextFile = options.fileContext ? db.getFile(options.fileContext) : null;
  const importers = contextFile ? db.getImportersOf(contextFile.id) : null;

  if (callSiteRows.length > 0) {
    const allFiles = db.getAllFiles();
    const fileMap = new Map(allFiles.map((f) => [f.id, f.path]));
    const seen = new Set<number>();
    for (const row of callSiteRows) {
      if (seen.has(row.file_id)) continue;
      seen.add(row.file_id);
      const filePath = fileMap.get(row.file_id);
      if (!filePath || (options.fileContext && filePath === options.fileContext)) continue;
      const fullPath = resolve(options.rootDir, filePath);
      const found = await scanFileForSymbol(fullPath, filePath, options.symbolName, options.fileContext);
      usages.push(...found);
    }
  } else if (importers && importers.length > 0) {
    const allFiles = db.getAllFiles();
    const fileMap = new Map(allFiles.map((f) => [f.id, f.path]));
    const candidates = new Set<string>();
    if (options.fileContext) candidates.add(options.fileContext);
    for (const r of importers) {
      const p = fileMap.get(r.source_file_id);
      if (p) candidates.add(p);
    }
    for (const relativePath of candidates) {
      if (!isSupportedFile(relativePath)) continue;
      const found = await scanFileForSymbol(resolve(options.rootDir, relativePath), relativePath, options.symbolName, options.fileContext);
      usages.push(...found);
    }
  } else {
    const allFiles = db.getAllFiles();
    await Promise.all(
      allFiles
        .filter((f) => isSupportedFile(f.path))
        .map(async (f) => {
          const found = await scanFileForSymbol(resolve(options.rootDir, f.path), f.path, options.symbolName, options.fileContext);
          usages.push(...found);
        }),
    );
  }

  if (usages.length === 0) {
    return `Symbol "${options.symbolName}" is not used anywhere in the codebase.`;
  }

  const byFile = new Map<string, SymbolUsage[]>();
  for (const u of usages) {
    const existing = byFile.get(u.file) ?? [];
    existing.push(u);
    byFile.set(u.file, existing);
  }

  const lines: string[] = [
    `Blast radius for "${options.symbolName}": ${usages.length} usages in ${byFile.size} files\n`,
  ];
  for (const [file, fileUsages] of byFile) {
    lines.push(`  ${file}:`);
    for (const u of fileUsages) lines.push(`    L${u.line}: ${u.context}`);
  }

  if (usages.length <= 1) {
    lines.push(`\n⚠ LOW USAGE: This symbol is used only ${usages.length} time(s). Consider inlining if it's under 20 lines.`);
  }

  return lines.join("\n");
}
