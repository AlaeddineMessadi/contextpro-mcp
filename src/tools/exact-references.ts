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
  confidence: "LSP_RESOLVED" | "SCIP_RESOLVED" | "PYTHON_INDEX_RESOLVED";
  kind?: "definition" | "import" | "call" | "reference";
}

function isTypeScriptLike(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function isPython(path: string): boolean {
  return extname(path).toLowerCase() === ".py";
}

interface ResolvedTarget {
  file: string;
  line: number;
  /** Present when the symbol name matched more than one definition site and the pick below
   * (structural kind, non-test file, lowest line) is a best guess, not a certainty. */
  ambiguousCandidates?: Array<{ file: string; line: number; kind: string }>;
}

const EXACT_REF_STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);

function looksLikeTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./.test(path);
}

async function resolveTarget(options: ExactReferencesOptions): Promise<ResolvedTarget | null> {
  if (options.file && options.line !== undefined) {
    return {
      file: toProjectRelativePath(options.rootDir, options.file, "file"),
      line: options.line,
    };
  }
  const db = await getDB(options.rootDir);
  const relativeFile = options.file ? toProjectRelativePath(options.rootDir, options.file, "file") : null;
  const exact = db.searchSymbolsByName(options.symbolName)
    .filter((symbol) => symbol.name === options.symbolName);
  if (relativeFile) {
    const dbFile = db.getFile(relativeFile);
    if (dbFile) {
      const inFile = exact
        .filter((symbol) => symbol.file_id === dbFile.id)
        .sort((a, b) => a.line_start - b.line_start);
      if (inFile.length > 0) {
        return { file: relativeFile, line: inFile[0].line_start };
      }
    }
    return { file: relativeFile, line: options.line ?? 1 };
  }
  const files = db.getAllFiles();
  const fileById = new Map(files.map((file) => [file.id, file]));
  // Prefer a real structural definition (function/class/...) over a same-named local
  // variable, and a non-test file over a test file, before falling back to line order —
  // this is a best-guess ranking, not a resolution: multiple distinct sites still surface
  // as an ambiguity warning below rather than being silently picked between.
  const ranked = exact
    .map((symbol) => ({ symbol, file: fileById.get(symbol.file_id) }))
    .filter((entry): entry is { symbol: (typeof exact)[number]; file: NonNullable<(typeof entry)["file"]> } => Boolean(entry.file))
    .sort((a, b) => {
      const structural = Number(EXACT_REF_STRUCTURAL_KINDS.has(b.symbol.kind)) - Number(EXACT_REF_STRUCTURAL_KINDS.has(a.symbol.kind));
      if (structural !== 0) return structural;
      const nonTest = Number(looksLikeTestPath(a.file.path)) - Number(looksLikeTestPath(b.file.path));
      if (nonTest !== 0) return nonTest;
      return a.symbol.line_start - b.symbol.line_start;
    });
  const selected = ranked[0];
  if (!selected) return null;
  const distinctSites = new Set(ranked.map((entry) => `${entry.file.path}:${entry.symbol.line_start}`));
  const ambiguousCandidates = distinctSites.size > 1
    ? ranked.slice(0, 5).map((entry) => ({ file: entry.file.path, line: entry.symbol.line_start, kind: entry.symbol.kind }))
    : undefined;
  return { file: selected.file.path, line: selected.symbol.line_start, ambiguousCandidates };
}

function formatReferencePayload(input: {
  symbolName: string;
  target?: ResolvedTarget | null;
  confidence: "LSP_RESOLVED" | "SCIP_RESOLVED" | "PYTHON_INDEX_RESOLVED";
  references: ExactReference[];
  format?: "text" | "json";
  scipSymbols?: string[];
  total?: number;
  warnings?: string[];
  scope?: unknown;
  counts?: Record<string, number>;
  callsByFile?: Array<{ file: string; calls: number }>;
  callFileCount?: number;
}): string {
  const ambiguousCandidates = input.target?.ambiguousCandidates ?? [];
  const total = input.total ?? input.references.length;
  const truncated = total > input.references.length;
  const warnings = [...(input.warnings ?? []), ...(truncated ? ["Only the first results are shown; raise limit up to 500, or verify the remaining matches with native tools."] : [])];
  const callFilesTruncated = input.callFileCount !== undefined && input.callFileCount > (input.callsByFile?.length ?? 0);
  if (callFilesTruncated) warnings.push(`Call-file summary shows ${input.callsByFile?.length ?? 0} of ${input.callFileCount} files; aggregate call count includes all checked files.`);
  const scope = input.scope ?? { kind: "indexed_candidates", completeness: "not_guaranteed" };
  if (input.format === "json") {
    return JSON.stringify({
      symbol: input.symbolName,
      target: input.target,
      ambiguous: ambiguousCandidates.length > 0,
      ambiguousCandidates,
      confidence: input.confidence,
      scipSymbols: input.scipSymbols,
      references: input.references,
      total, returned: input.references.length, truncated, counts: input.counts, scope, warnings,
      ...(input.callsByFile ? { callsByFile: input.callsByFile, callFileCount: input.callFileCount, callFilesTruncated } : {}),
    }, null, 2);
  }
  const ambiguityLines = ambiguousCandidates.length > 0
    ? [
        `⚠ AMBIGUOUS: "${input.symbolName}" matched ${ambiguousCandidates.length} definition sites; the target below is a best guess (prefers a real definition over a same-named local variable, non-test files first), not a certainty:`,
        ...ambiguousCandidates.map((c) => `    ${c.file}:L${c.line} [${c.kind}]`),
        `  Pass file/line explicitly to disambiguate if this looks wrong.`,
        "",
      ]
    : [];
  if (input.references.length === 0) {
    return [...ambiguityLines, ...warnings.map(w => `Warning: ${w}`), `No exact references found for "${input.symbolName}"${input.target ? ` from ${input.target.file}:${input.target.line}` : ""}.`].join("\n");
  }
  const lines = [
    `Exact references for "${input.symbolName}": ${input.references.length} returned of ${total} matched occurrences${truncated ? " (TRUNCATED)" : ""}`,
    ...(input.target ? [`Target: ${input.target.file}:${input.target.line}`] : []),
    `Evidence: ${input.confidence}; scope is limited to indexed files, not all possible runtime references.`,
    ...(input.counts ? [`Occurrences: ${Object.entries(input.counts).map(([kind, count]) => `${kind}=${count}`).join(", ")}`] : []),
    ...(input.callsByFile?.length ? [`Calls by file (before result limit): ${input.callsByFile.map(entry => `${entry.file}=${entry.calls}`).join(", ")}`] : []),
    ...warnings.map(w => `Warning: ${w}`),
    "",
    ...ambiguityLines,
  ];
  const shownSnippets = new Set<string>();
  let repeatedSnippets = 0;
  for (const ref of input.references) {
    lines.push(`${ref.file}:${ref.line}:${ref.column}${ref.kind ? ` [${ref.kind}]` : ref.isDefinition ? " [definition]" : ""}`);
    if (ref.context) {
      const key = JSON.stringify([ref.file, ref.context]);
      if (shownSnippets.has(key)) repeatedSnippets++;
      else { shownSnippets.add(key); lines.push(`  ${ref.context}`); }
    }
  }
  if (repeatedSnippets) lines.push(`Identical snippets shown once per file (${repeatedSnippets} repeats); all returned locations retained.`);
  return lines.join("\n");
}

async function formatScipFallback(options: ExactReferencesOptions, target?: ResolvedTarget | null, warnings: string[] = []): Promise<string | null> {
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
    total: scip.total,
    warnings: [...warnings, "Imported SCIP evidence has not been checked against the current source revision; reimport after source changes."],
    scope: { kind: "imported_scip", completeness: "not_guaranteed", freshness: "unverified" },
  });
}

function symbolPattern(symbolName: string): RegExp {
  return new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pythonIndexReferences(options: ExactReferencesOptions, target: { file: string; line: number }): Promise<string | null> {
  const db = await getDB(options.rootDir);
  const targetFile = db.getFile(target.file);
  if (!targetFile) return null;

  const indexedFiles = db.getAllFiles();
  const fileById = new Map(indexedFiles.map((file) => [file.id, file]));
  const candidates = new Set<number>([targetFile.id]);
  const queue: Array<{ fileId: number; depth: number }> = [{ fileId: targetFile.id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 6) continue;
    for (const importer of db.getImportersOf(current.fileId)) {
      const source = fileById.get(importer.source_file_id);
      if (!source || !isPython(source.path) || candidates.has(source.id)) continue;
      candidates.add(source.id);
      queue.push({ fileId: source.id, depth: current.depth + 1 });
    }
  }

  const graphCandidateCount = candidates.size;
  for (const call of db.getCallersOf(options.symbolName)) {
    const source = fileById.get(call.file_id);
    if (!source || !isPython(source.path)) continue;
    if (graphCandidateCount > 1 && !candidates.has(source.id)) continue;
    candidates.add(source.id);
  }

  const definitionLines = new Set(
    db.getSymbolsByFile(targetFile.id)
      .filter((symbol) => symbol.name === options.symbolName)
      .map((symbol) => symbol.line_start),
  );
  const references: ExactReference[] = [];
  const pattern = symbolPattern(options.symbolName);
  const escapedSymbol = escapeRegex(options.symbolName);

  for (const fileId of candidates) {
    const file = fileById.get(fileId);
    if (!file) continue;
    let content = "";
    try {
      content = await readFile(resolveProjectPath(options.rootDir, file.path, "python reference file"), "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const lineNumber = lineIndex + 1;
        const trimmed = line.trim();
        const isDefinition = file.path === target.file && (
          definitionLines.has(lineNumber)
          || new RegExp(`^def\\s+${escapedSymbol}\\b`).test(trimmed)
          || new RegExp(`^class\\s+${escapedSymbol}\\b`).test(trimmed)
        );
        const looksRelevant = isDefinition
          || /^from\s+[\w.]+\s+import\b/.test(trimmed)
          || /^import\s+[\w.]+/.test(trimmed)
          || /\w+\s*\(/.test(trimmed)
          || trimmed.includes(options.symbolName);
        if (!looksRelevant) continue;
        references.push({
          file: file.path,
          line: lineNumber,
          column: match.index + 1,
          context: trimmed.slice(0, 160),
          isDefinition,
          confidence: "PYTHON_INDEX_RESOLVED",
        });
      }
    }
  }

  const unique = new Map<string, ExactReference>();
  for (const ref of references) unique.set(`${ref.file}:${ref.line}:${ref.column}:${ref.isDefinition}`, ref);
  const total = unique.size;
  const limited = [...unique.values()]
    .sort((a, b) => Number(b.isDefinition) - Number(a.isDefinition) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)));

  if (limited.length === 0) return null;
  return formatReferencePayload({
    symbolName: options.symbolName,
    target,
    confidence: "PYTHON_INDEX_RESOLVED",
    total,
    warnings: ["Python import/call candidates are heuristic; this is not binding-resolved or exhaustive."],
    references: limited,
    format: options.format,
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
    if (isPython(target.file)) {
      const pythonResult = await pythonIndexReferences(options, target);
      if (pythonResult) return pythonResult;
    }
    return `Exact references require TypeScript/JavaScript language-service support, Python import/call index evidence, or an imported SCIP JSON index. Target file: ${target.file}`;
  }

  const { queryTypeScriptReferences } = await import("../core/typescript-reference-process.js");
  const db = await getDB(options.rootDir);
  const found = await queryTypeScriptReferences({
    rootDir: options.rootDir,
    files: db.getAllFiles().filter(file => isTypeScriptLike(file.path)).map(file => resolveProjectPath(options.rootDir, file.path, "indexed file")),
    file: resolveProjectPath(options.rootDir, target.file, "reference target"),
    line: target.line, symbol: options.symbolName,
    limit: Math.max(1, Math.min(options.limit ?? 100, 500)),
  });
  if (found.total === 0) {
    const scipResult = await formatScipFallback(options, target, [
      ...found.warnings, "TypeScript returned no references; using imported SCIP evidence as a fallback.",
    ]);
    if (scipResult) return scipResult;
  }
  const references: ExactReference[] = found.references.map(ref => ({ ...ref, confidence: "LSP_RESOLVED" }));
  return formatReferencePayload({
    symbolName: options.symbolName, target, confidence: "LSP_RESOLVED",
    references,
    total: found.total, counts: found.counts, callsByFile: found.callsByFile, callFileCount: found.callFileCount,
    warnings: found.warnings, scope: found.scope, format: options.format,
  });
}
