// TypeScript language-service backed exact reference lookup
// FEATURE: Exact references — local TS/JS adapter with LSP-grade symbol references

import { readFile } from "fs/promises";
import { extname } from "path";
import { getDB } from "../core/db.js";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";
import { findScipReferences } from "../core/scip-index.js";

export interface ExactReferencesOptions {
  rootDir: string;
  symbolName: string;
  file?: string;
  line?: number;
  limit?: number;
  format?: "text" | "json";
}

interface ExactReference {
  file: string;
  line: number;
  column: number;
  context: string;
  isDefinition: boolean;
  confidence: "LSP_RESOLVED" | "SCIP_RESOLVED";
}

function isTypeScriptLike(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function offsetAtLineSymbol(content: string, line: number, symbolName: string): number {
  const lines = content.split("\n");
  const targetLine = Math.max(1, line) - 1;
  const before = lines.slice(0, targetLine).reduce((sum, item) => sum + item.length + 1, 0);
  const lineText = lines[targetLine] ?? "";
  const index = lineText.indexOf(symbolName);
  return before + Math.max(0, index);
}

async function resolveTarget(options: ExactReferencesOptions): Promise<{ file: string; line: number } | null> {
  if (options.file) {
    return {
      file: toProjectRelativePath(options.rootDir, options.file, "file"),
      line: options.line ?? 1,
    };
  }
  const db = await getDB(options.rootDir);
  const exact = db.searchSymbolsByName(options.symbolName)
    .filter((symbol) => symbol.name === options.symbolName)
    .sort((a, b) => a.line_start - b.line_start);
  const files = db.getAllFiles();
  const selected = exact[0];
  if (!selected) return null;
  const file = files.find((candidate) => candidate.id === selected.file_id);
  if (!file) return null;
  return { file: file.path, line: selected.line_start };
}

function formatReferencePayload(input: {
  symbolName: string;
  target?: { file: string; line: number } | null;
  confidence: "LSP_RESOLVED" | "SCIP_RESOLVED";
  references: ExactReference[];
  format?: "text" | "json";
  scipSymbols?: string[];
}): string {
  if (input.format === "json") {
    return JSON.stringify({
      symbol: input.symbolName,
      target: input.target,
      confidence: input.confidence,
      scipSymbols: input.scipSymbols,
      references: input.references,
    }, null, 2);
  }
  if (input.references.length === 0) {
    return `No exact references found for "${input.symbolName}"${input.target ? ` from ${input.target.file}:${input.target.line}` : ""}.`;
  }
  const lines = [
    `Exact references for "${input.symbolName}" (${input.references.length})`,
    ...(input.target ? [`Target: ${input.target.file}:${input.target.line}`] : []),
    `Confidence: ${input.confidence}`,
    "",
  ];
  for (const ref of input.references) {
    lines.push(`${ref.file}:${ref.line}:${ref.column}${ref.isDefinition ? " [definition]" : ""}`);
    if (ref.context) lines.push(`  ${ref.context}`);
  }
  return lines.join("\n");
}

async function formatScipFallback(options: ExactReferencesOptions, target?: { file: string; line: number } | null): Promise<string | null> {
  const scip = await findScipReferences({
    rootDir: options.rootDir,
    symbolName: options.symbolName,
    file: target?.file ?? options.file,
    line: target?.line ?? options.line,
    limit: options.limit,
  });
  if (!scip) return null;
  return formatReferencePayload({
    symbolName: options.symbolName,
    target,
    confidence: "SCIP_RESOLVED",
    references: scip.references.map((ref) => ({
      file: ref.file,
      line: ref.line,
      column: ref.column,
      context: ref.context,
      isDefinition: ref.isDefinition,
      confidence: "SCIP_RESOLVED",
    })),
    format: options.format,
    scipSymbols: scip.symbols,
  });
}

export async function exactReferencesTool(options: ExactReferencesOptions): Promise<string> {
  const target = await resolveTarget(options);
  if (!target) {
    const scipResult = await formatScipFallback(options);
    if (scipResult) return scipResult;
    return `No indexed definition found for symbol "${options.symbolName}". Run reindex, import a SCIP JSON index, or provide file and line.`;
  }
  if (!isTypeScriptLike(target.file)) {
    const scipResult = await formatScipFallback(options, target);
    if (scipResult) return scipResult;
    return `Exact references require TypeScript/JavaScript language-service support or an imported SCIP JSON index. Target file: ${target.file}`;
  }

  const ts = await import("typescript");
  const db = await getDB(options.rootDir);
  const indexedFiles = db.getAllFiles().filter((file) => isTypeScriptLike(file.path));
  const fileNames = indexedFiles.map((file) => resolveProjectPath(options.rootDir, file.path, "indexed file"));
  const snapshots = new Map<string, string>();
  for (const fileName of fileNames) {
    try {
      snapshots.set(fileName, await readFile(fileName, "utf-8"));
    } catch {}
  }
  const targetFullPath = resolveProjectPath(options.rootDir, target.file, "file");
  const targetContent = snapshots.get(targetFullPath) ?? await readFile(targetFullPath, "utf-8");
  snapshots.set(targetFullPath, targetContent);
  if (!fileNames.includes(targetFullPath)) fileNames.push(targetFullPath);

  const host: import("typescript").LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const content = snapshots.get(fileName) ?? ts.sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => options.rootDir,
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    }),
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host);
  const offset = offsetAtLineSymbol(targetContent, target.line, options.symbolName);
  const referencedSymbols = service.findReferences(targetFullPath, offset) ?? [];
  const references: ExactReference[] = [];
  for (const referenced of referencedSymbols) {
    for (const ref of referenced.references) {
      if (!snapshots.has(ref.fileName) || !fileNames.includes(ref.fileName)) continue;
      const content = snapshots.get(ref.fileName)!;
      const sourceFile = service.getProgram()?.getSourceFile(ref.fileName);
      if (!sourceFile) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
      const relativeFile = toProjectRelativePath(options.rootDir, ref.fileName, "reference file");
      references.push({
        file: relativeFile,
        line: position.line + 1,
        column: position.character + 1,
        context: content.split("\n")[position.line]?.trim().slice(0, 160) ?? "",
        isDefinition: ref.isDefinition === true,
        confidence: "LSP_RESOLVED",
      });
    }
  }
  const unique = new Map<string, ExactReference>();
  for (const ref of references) unique.set(`${ref.file}:${ref.line}:${ref.column}:${ref.isDefinition}`, ref);
  const limited = [...unique.values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)));

  if (limited.length === 0) {
    const scipResult = await formatScipFallback(options, target);
    if (scipResult) return scipResult;
  }
  return formatReferencePayload({
    symbolName: options.symbolName,
    target,
    confidence: "LSP_RESOLVED",
    references: limited,
    format: options.format,
  });
}
