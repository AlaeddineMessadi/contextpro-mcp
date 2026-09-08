// Dependency graph analyzer tracing symbol usage via SQLite import graph and call_sites
// FEATURE: Blast radius — find every usage of a symbol before modifying it

import { getDB } from "../core/db.js";
import { analyzeContent, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { walkDirectory } from "../core/walker.js";
import { readFile } from "fs/promises";
import { resolveProjectPath } from "../core/path-guard.js";
import { maskSourceText } from "../core/source-mask.js";
import pLimit from "p-limit";

export interface BlastRadiusOptions {
  rootDir: string;
  symbolName: string;
  fileContext?: string;
  mode?: "summary" | "detailed";
  kind?: UsageKind;
}

export type UsageKind = "import" | "call" | "mock/stub" | "type-reference" | "comment/string";

interface EnclosingSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

interface SymbolSpan {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

export interface SymbolUsage {
  file: string;
  line: number;
  context: string;
  kind: UsageKind;
  enclosing: EnclosingSymbol;
}

function classifyUsage(codeLine: string, symbolName: string, hasCodeOccurrence: boolean): UsageKind {
  if (!hasCodeOccurrence) return "comment/string";
  const escaped = escapeRegex(symbolName);
  if (/^\s*import\b/.test(codeLine) || /^\s*export\s*(?:\{|\*)/.test(codeLine) || /^\s*(?:from|use)\b/.test(codeLine) || /\brequire\s*\(/.test(codeLine)) {
    return "import";
  }
  if (/\b(?:mock|mocked|spyOn|stub|patch|monkeypatch|mockImplementation|mockReturnValue|mockResolvedValue)\b/i.test(codeLine)) {
    return "mock/stub";
  }
  if (!isDefinitionLine(codeLine, symbolName) && new RegExp(`\\b${escaped}\\s*(?:<[^;{}()]*>)?\\s*\\(`).test(codeLine)) return "call";
  return "type-reference";
}

function enclosingSymbolForLine(
  symbols: SymbolSpan[],
  line: number,
  totalLines: number,
): EnclosingSymbol {
  const containing = symbols
    .filter((symbol) => ["function", "method", "class"].includes(symbol.kind))
    .filter((symbol) => symbol.line <= line && symbol.endLine >= line)
    .sort((left, right) => {
      const leftCallable = left.kind === "function" || left.kind === "method" ? 0 : 1;
      const rightCallable = right.kind === "function" || right.kind === "method" ? 0 : 1;
      return leftCallable - rightCallable || (left.endLine - left.line) - (right.endLine - right.line);
    });
  const selected = containing[0];
  return selected
    ? { name: selected.name, kind: selected.kind, line: selected.line, endLine: selected.endLine }
    : { name: "<module>", kind: "module", line: 1, endLine: Math.max(1, totalLines) };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDefinitionLine(line: string, symbolName: string): boolean {
  const definitionPatterns = [
    new RegExp(`(?:function|class|enum|interface|struct|type|trait|fn|def|func)\\s+${escapeRegex(symbolName)}\\b`),
    new RegExp(`(?:const|let|var|pub|export)\\s+(?:async\\s+)?(?:function\\s+)?${escapeRegex(symbolName)}\\b`),
  ];
  return definitionPatterns.some((p) => p.test(line));
}

async function scanFileForSymbol(
  filePath: string,
  relativePath: string,
  symbolName: string,
  fileContext: string | undefined,
  indexedSymbols?: SymbolSpan[],
  onFailure?: () => void,
): Promise<SymbolUsage[]> {
  const symbolPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g");
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const codeLines = maskSourceText(content, relativePath).split("\n");
    const symbols = indexedSymbols ?? flattenSymbols((await analyzeContent(filePath, content)).symbols);
    const usages: SymbolUsage[] = [];
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const codeLine = codeLines[i] ?? "";
      const rawMatches = [...rawLine.matchAll(symbolPattern)];
      if (rawMatches.length > 0) {
        const isDefinition = fileContext && relativePath === fileContext && isDefinitionLine(codeLine, symbolName);
        if (!isDefinition) {
          const hasCodeOccurrence = rawMatches.some((match) => {
            const column = match.index ?? 0;
            return codeLine.slice(column, column + symbolName.length) === rawLine.slice(column, column + symbolName.length);
          });
          usages.push({
            file: relativePath,
            line: i + 1,
            context: rawLine.trim().substring(0, 160),
            kind: classifyUsage(codeLine, symbolName, hasCodeOccurrence),
            enclosing: enclosingSymbolForLine(symbols, i + 1, lines.length),
          });
        }
      }
      symbolPattern.lastIndex = 0;
    }
    return usages;
  } catch {
    onFailure?.();
    return [];
  }
}

export async function getBlastRadius(options: BlastRadiusOptions): Promise<string> {
  if (!options.symbolName || options.symbolName.trim().length === 0) {
    return "Error: symbol_name must be a non-empty string. blast_radius traces a specific named symbol and cannot run on an empty value.";
  }
  const db = await getDB(options.rootDir);
  let usages: SymbolUsage[] = [];
  const unreadable: string[] = [];
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

  const allFiles = db.getAllFiles();
  const indexedFileByPath = new Map(allFiles.map((file) => [file.path, file] as const));
  if (callSiteRows.length > 0) {
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

  const scanLimit = pLimit(8);
  await Promise.all(
    [...candidateFiles]
      .filter((relativePath) => isSupportedFile(relativePath))
      .map((relativePath) => scanLimit(async () => {
        const indexedFile = indexedFileByPath.get(relativePath);
        const indexedSymbols = indexedFile
          ? db.getSymbolsByFile(indexedFile.id).map((symbol) => ({
              name: symbol.name,
              kind: symbol.kind,
              line: symbol.line_start,
              endLine: symbol.line_end ?? symbol.line_start,
            }))
          : undefined;
        const found = await scanFileForSymbol(
          resolveProjectPath(options.rootDir, relativePath, "candidate file"),
          relativePath,
          options.symbolName,
          options.fileContext,
          indexedSymbols,
          () => unreadable.push(relativePath),
        );
        pushUsages(found);
      })),
  );

  const kinds: UsageKind[] = ["call", "import", "type-reference", "mock/stub", "comment/string"];
  const counts = kinds.map(kind => `${kind}=${usages.filter(usage => usage.kind === kind).length}`).join(", ");
  if (options.kind) usages = usages.filter(usage => usage.kind === options.kind);
  if (usages.length === 0) {
    if (unreadable.length) return `No matching usages found in readable files. INCOMPLETE: ${unreadable.length} files could not be read; verify with native tools.`;
    if (options.kind) return `No ${options.kind} matching lines found for "${options.symbolName}". Counts by matching line: ${counts}. Textual candidates, not binding-resolved references.`;
    return `No textual usage candidates found for "${options.symbolName}" in scanned supported files. This does not prove the symbol is unused; verify binding-resolved references before removal.`;
  }

  usages.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.kind.localeCompare(right.kind));
  const byFile = new Map<string, SymbolUsage[]>();
  for (const u of usages) {
    const existing = byFile.get(u.file) ?? [];
    existing.push(u);
    byFile.set(u.file, existing);
  }

  const lines: string[] = [
    `Blast radius for "${options.symbolName}": ${usages.length} usages in ${byFile.size} files\n`,
    `Counts by matching line: ${counts}. One line may contain multiple occurrences.`,
    "Textual candidates, not binding-resolved references. Use exact_references for TS/JS rename checks.",
    ...(unreadable.length ? [`INCOMPLETE: ${unreadable.length} files could not be read; verify scope with native tools.`] : []),
  ];
  if ((options.mode ?? "summary") === "detailed") {
    for (const [file, fileUsages] of byFile) {
      lines.push(`  ${file}:`);
      for (const usage of fileUsages) {
        const range = usage.enclosing.endLine > usage.enclosing.line
          ? `L${usage.enclosing.line}-L${usage.enclosing.endLine}`
          : `L${usage.enclosing.line}`;
        lines.push(`    L${usage.line} [${usage.kind}] in ${usage.enclosing.name} (${range}): ${usage.context}`);
      }
    }
  } else {
    const groups = new Map<string, SymbolUsage[]>();
    for (const usage of usages) {
      const enclosing = usage.enclosing;
      const key = `${usage.kind}:${usage.file}:${enclosing.name}:${enclosing.line}:${enclosing.endLine}`;
      const group = groups.get(key) ?? [];
      group.push(usage);
      groups.set(key, group);
    }
    const labels: Record<UsageKind, string> = {
      import: "imports",
      call: "calls",
      "mock/stub": "mocks/stubs",
      "type-reference": "type-references",
      "comment/string": "comments/strings",
    };
    for (const group of groups.values()) {
      const first = group[0];
      const enclosing = first.enclosing;
      const range = enclosing.endLine > enclosing.line ? `L${enclosing.line}-L${enclosing.endLine}` : `L${enclosing.line}`;
      const count = group.length > 1 ? ` [${group.length} usages]` : "";
      lines.push(`  ${labels[first.kind]} <- ${enclosing.name} (${first.file}:${range})${count}`);
    }
  }

  if (usages.length <= 2) {
    // Look up the symbol's actual line span so we only suggest inlining for genuinely short helpers.
    const symbols = db.searchSymbolsByName(options.symbolName).filter((s) => s.name === options.symbolName);
    const lineSpan = symbols.length > 0
      ? Math.max(0, (symbols[0].line_end ?? symbols[0].line_start) - symbols[0].line_start + 1)
      : null;
    if (lineSpan !== null && lineSpan <= 20) {
      lines.push(`\n⚠ LOW USAGE: only ${usages.length} usage(s), and the definition is ${lineSpan} lines — a clear inline candidate.`);
    } else if (lineSpan !== null) {
      lines.push(`\n⚠ LOW USAGE: only ${usages.length} usage(s), but the definition is ${lineSpan} lines. Probably worth keeping as a function, but review the abstraction.`);
    } else {
      lines.push(`\n⚠ LOW USAGE: ${usages.length} usage(s). Definition size unknown; verify before deciding.`);
    }
  } else if (usages.length <= 5) {
    lines.push(`\n• Modest usage: ${usages.length} matching lines. Review references before signature changes.`);
  }

  return lines.join("\n");
}
