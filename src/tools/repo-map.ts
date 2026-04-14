// Compact repository map built from indexed files and top-level symbols
// FEATURE: RepoMap — low-token whole-repo outline for first-turn agent orientation

import { resolve } from "path";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";

export interface RepoMapOptions {
  rootDir: string;
  targetPath?: string;
  includeSignatures?: boolean;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
  maxTokens?: number;
  format?: "text" | "json";
}

export interface RepoMapFileEntry {
  path: string;
  header: string | null;
  symbolCount: number;
  importance: number;
  importsFromCount: number;
  importedByCount: number;
  symbols: Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number | null;
    signature: string | null;
  }>;
}

export interface RepoMapData {
  repo: {
    root: string;
    targetPath: string | null;
  };
  summary: {
    totalIndexedFiles: number;
    returnedFiles: number;
    includeSignatures: boolean;
  };
  files: RepoMapFileEntry[];
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function scoreFileImportance(dbFile: FileRow, symbols: SymbolRow[], importsFromCount: number, importedByCount: number): number {
  const topLevelCount = symbols.filter((symbol) => symbol.parent_symbol_id === null).length;
  return importedByCount * 4 + importsFromCount * 2 + topLevelCount * 1.5 + Math.min(dbFile.symbol_count, 20) * 0.5;
}

function formatSymbolLine(symbol: RepoMapFileEntry["symbols"][number], includeSignatures: boolean): string {
  const lineRange = symbol.endLine && symbol.endLine > symbol.line ? `L${symbol.line}-L${symbol.endLine}` : `L${symbol.line}`;
  if (includeSignatures && symbol.signature) {
    return `  ${symbol.kind}: ${symbol.signature} (${lineRange})`;
  }
  return `  ${symbol.kind}: ${symbol.name} (${lineRange})`;
}

export async function getRepoMapData(options: RepoMapOptions): Promise<RepoMapData> {
  const db = await getDB(options.rootDir);
  const allFiles = db.getAllFiles()
    .filter((file) => !options.targetPath || file.path.startsWith(options.targetPath));

  const files = allFiles
    .map((file) => {
      const symbols = db.getSymbolsByFile(file.id);
      const topLevelSymbols = symbols
        .filter((symbol) => symbol.parent_symbol_id === null)
        .sort((left, right) => left.line_start - right.line_start)
        .slice(0, options.maxSymbolsPerFile ?? 8)
        .map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line_start,
          endLine: symbol.line_end,
          signature: symbol.signature,
        }));
      const importsFromCount = db.getImportsFrom(file.id).length;
      const importedByCount = db.getImportersOf(file.id).length;

      return {
        path: file.path,
        header: file.header,
        symbolCount: file.symbol_count,
        importance: scoreFileImportance(file, symbols, importsFromCount, importedByCount),
        importsFromCount,
        importedByCount,
        symbols: topLevelSymbols,
      } satisfies RepoMapFileEntry;
    })
    .sort((left, right) => right.importance - left.importance || left.path.localeCompare(right.path))
    .slice(0, options.maxFiles ?? 40);

  return {
    repo: {
      root: resolve(options.rootDir),
      targetPath: options.targetPath ?? null,
    },
    summary: {
      totalIndexedFiles: allFiles.length,
      returnedFiles: files.length,
      includeSignatures: options.includeSignatures !== false,
    },
    files,
  };
}

export async function getRepoMap(options: RepoMapOptions): Promise<string> {
  const data = await getRepoMapData(options);
  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }

  const includeSignatures = options.includeSignatures !== false;
  const maxTokens = options.maxTokens ?? 2000;
  const lines = [
    `=== Repo Map ===`,
    `Root: ${data.repo.root}`,
    `Indexed files: ${data.summary.totalIndexedFiles} | Returned: ${data.summary.returnedFiles}`,
    "",
  ];

  for (const file of data.files) {
    lines.push(`${file.path}${file.header ? ` | ${file.header}` : ""}`);
    for (const symbol of file.symbols) {
      lines.push(formatSymbolLine(symbol, includeSignatures));
    }
    lines.push("");

    if (estimateTokens(lines.join("\n")) > maxTokens) {
      lines.push(`[truncated to fit ${maxTokens} tokens]`);
      break;
    }
  }

  return lines.join("\n");
}
