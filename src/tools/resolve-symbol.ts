// Symbol resolution with ambiguity scoring and file-context-aware ranking
// FEATURE: ResolveSymbol — precise definition lookup for ambiguous identifiers

import { dirname, resolve } from "path";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";

export interface ResolveSymbolOptions {
  rootDir: string;
  symbolName: string;
  fileContext?: string;
  kind?: string;
  limit?: number;
  format?: "text" | "json";
}

export interface ResolvedSymbolCandidate {
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine: number | null;
  signature: string | null;
  parentName: string | null;
  score: number;
  reasons: string[];
}

export interface ResolveSymbolData {
  repo: {
    root: string;
    fileContext: string | null;
  };
  query: {
    symbolName: string;
    kind: string | null;
  };
  bestMatch: ResolvedSymbolCandidate | null;
  ambiguous: boolean;
  candidates: ResolvedSymbolCandidate[];
}

function scoreSymbolCandidate(input: {
  symbolName: string;
  expectedKind: string | undefined;
  symbol: SymbolRow;
  file: FileRow;
  fileContext: string | undefined;
  importedFileIds: Set<number>;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const exactMatch = input.symbol.name === input.symbolName;
  const normalizedQuery = input.symbolName.toLowerCase();
  const normalizedName = input.symbol.name.toLowerCase();

  if (exactMatch) {
    score += 100;
    reasons.push("exact name match");
  } else if (normalizedName === normalizedQuery) {
    score += 90;
    reasons.push("case-insensitive exact name match");
  } else if (normalizedName.includes(normalizedQuery)) {
    score += 35;
    reasons.push("partial name match");
  }

  if (input.expectedKind && input.symbol.kind === input.expectedKind) {
    score += 35;
    reasons.push(`kind match (${input.expectedKind})`);
  } else if (input.expectedKind && input.symbol.kind !== input.expectedKind) {
    score -= 10;
    reasons.push(`kind mismatch (${input.symbol.kind})`);
  }

  if (input.fileContext && input.file.path === input.fileContext) {
    score += 40;
    reasons.push("same file as file_context");
  }

  if (input.importedFileIds.has(input.file.id)) {
    score += 30;
    reasons.push("definition is in a directly imported file");
  }

  if (input.fileContext && dirname(input.file.path) === dirname(input.fileContext)) {
    score += 10;
    reasons.push("same directory as file_context");
  }

  if (input.symbol.parent_symbol_id !== null) {
    score += 5;
    reasons.push("nested/member definition");
  }

  return { score, reasons };
}

function resolveParentName(symbol: SymbolRow, siblings: SymbolRow[]): string | null {
  if (symbol.parent_symbol_id === null) return null;
  return siblings.find((candidate) => candidate.id === symbol.parent_symbol_id)?.name ?? null;
}

export async function resolveSymbolData(options: ResolveSymbolOptions): Promise<ResolveSymbolData> {
  const db = await getDB(options.rootDir);
  const allFiles = db.getAllFiles();
  const filesById = new Map<number, FileRow>(allFiles.map((file) => [file.id, file]));
  const currentFile = options.fileContext ? db.getFile(options.fileContext) : null;
  const importedFileIds = new Set<number>();

  if (currentFile) {
    for (const imp of db.getImportsFrom(currentFile.id)) {
      if (imp.target_file_id !== null) importedFileIds.add(imp.target_file_id);
    }
  }

  const rawMatches = db.searchSymbolsByName(options.symbolName);
  const exactMatches = rawMatches.filter((symbol) => symbol.name === options.symbolName);
  const candidateRows = exactMatches.length > 0 ? exactMatches : rawMatches;

  const ranked = candidateRows
    .map((symbol) => {
      const file = filesById.get(symbol.file_id);
      if (!file) return null;
      const siblings = db.getSymbolsByFile(file.id);
      const { score, reasons } = scoreSymbolCandidate({
        symbolName: options.symbolName,
        expectedKind: options.kind,
        symbol,
        file,
        fileContext: options.fileContext,
        importedFileIds,
      });
      const candidate: ResolvedSymbolCandidate = {
        name: symbol.name,
        kind: symbol.kind,
        path: file.path,
        line: symbol.line_start,
        endLine: symbol.line_end,
        signature: symbol.signature,
        parentName: resolveParentName(symbol, siblings),
        score,
        reasons,
      };
      return candidate;
    })
    .filter((candidate): candidate is ResolvedSymbolCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);

  const limited = ranked.slice(0, options.limit ?? 8);
  const bestMatch = limited[0] ?? null;
  const ambiguous = limited.length > 1 && bestMatch !== null && (bestMatch.score - limited[1].score) < 20;

  return {
    repo: {
      root: resolve(options.rootDir),
      fileContext: options.fileContext ?? null,
    },
    query: {
      symbolName: options.symbolName,
      kind: options.kind ?? null,
    },
    bestMatch,
    ambiguous,
    candidates: limited,
  };
}

export async function resolveSymbol(options: ResolveSymbolOptions): Promise<string> {
  const data = await resolveSymbolData(options);

  if (options.format === "json") {
    return JSON.stringify(data, null, 2);
  }

  if (data.candidates.length === 0) {
    return `No symbol matches found for "${options.symbolName}".`;
  }

  const lines = [
    `=== Resolve Symbol: ${options.symbolName} ===`,
    `File Context: ${data.repo.fileContext ?? "none"}`,
    `Ambiguous: ${data.ambiguous ? "yes" : "no"}`,
    "",
  ];

  for (const candidate of data.candidates) {
    lines.push(`${candidate.kind}: ${candidate.path} L${candidate.line}${candidate.endLine && candidate.endLine > candidate.line ? `-L${candidate.endLine}` : ""}`);
    if (candidate.signature) lines.push(`  ${candidate.signature}`);
    if (candidate.parentName) lines.push(`  parent: ${candidate.parentName}`);
    lines.push(`  score: ${candidate.score} | ${candidate.reasons.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}
