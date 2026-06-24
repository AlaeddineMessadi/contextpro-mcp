// Dependency graph analyzer tracing symbol usage via SQLite import graph and call_sites
// FEATURE: Blast radius — find every usage of a symbol before modifying it

import { getDB } from "../core/db.js";
import { isSupportedFile } from "../core/parser.js";
import { walkDirectory } from "../core/walker.js";
import { readFile } from "fs/promises";
import { resolveProjectPath } from "../core/path-guard.js";

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
  if (!options.symbolName || options.symbolName.trim().length === 0) {
    return "Error: symbol_name must be a non-empty string. blast_radius traces a specific named symbol and cannot run on an empty value.";
  }
  const db = await getDB(options.rootDir);
  const usages: SymbolUsage[] = [];
  const seenUsageKeys = new Set<string>();

  const pushUsages = (items: SymbolUsage[]) => {
    for (const item of items) {
      const key = `${item.file}:${item.line}:${item.context}`;
      if (seenUsageKeys.has(key)) continue;
      seenUsageKeys.add(key);
      usages.push(item);
    }
  };

  const callSiteRows = db.getCallersOf(options.symbolName);
  const contextFile = options.fileContext ? db.getFile(options.fileContext) : null;
  const importers = contextFile ? db.getImportersOf(contextFile.id) : null;
  const candidateFiles = new Set<string>();

  if (callSiteRows.length > 0) {
    const allFiles = db.getAllFiles();
    const fileMap = new Map(allFiles.map((f) => [f.id, f.path] as const));
    const seen = new Set<number>();
    for (const row of callSiteRows) {
      if (seen.has(row.file_id)) continue;
      seen.add(row.file_id);
      const filePath = fileMap.get(row.file_id);
      if (!filePath) continue;
      candidateFiles.add(filePath);
    }
  }

  if (importers && importers.length > 0) {
    const allFiles = db.getAllFiles();
    const fileMap = new Map(allFiles.map((f) => [f.id, f.path] as const));
    for (const r of importers) {
      const p = fileMap.get(r.source_file_id);
      if (p) candidateFiles.add(p);
    }
  }

  const workspaceEntries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  for (const entry of workspaceEntries) {
    if (entry.isDirectory || !isSupportedFile(entry.path)) continue;
    candidateFiles.add(entry.relativePath);
  }

  await Promise.all(
    [...candidateFiles]
      .filter((relativePath) => isSupportedFile(relativePath))
      .map(async (relativePath) => {
        const found = await scanFileForSymbol(resolveProjectPath(options.rootDir, relativePath, "candidate file"), relativePath, options.symbolName, options.fileContext);
        pushUsages(found);
      }),
  );

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

  if (usages.length <= 2) {
    lines.push(`\n⚠ LOW USAGE: This symbol is used only ${usages.length} time(s). If it's a short helper (under 20 lines), consider inlining at the call site.`);
  } else if (usages.length <= 5) {
    lines.push(`\n• Modest usage: ${usages.length} call sites. Safe to refactor; review each before signature changes.`);
  }

  return lines.join("\n");
}
