// Detailed function signature extractor without reading full file bodies
// Returns structural skeleton: signatures, leading docs, imports, exports

import { analyzeFile, isSupportedFile, extractImports, type FileAnalysis, type CodeSymbol } from "../core/parser.js";
import { readFile } from "fs/promises";
import { resolveProjectPath } from "../core/path-guard.js";

export interface SkeletonOptions {
  filePath: string;
  rootDir: string;
}

const MAX_SIGNATURE_LENGTH = 200;
const MAX_DOC_LINES = 4;
const MAX_IMPORTS_DISPLAYED = 8;

function formatLineRange(line: number, endLine: number): string {
  return endLine > line ? `L${line}-L${endLine}` : `L${line}`;
}

function truncateSignature(signature: string): string {
  const trimmed = signature.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_SIGNATURE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
}

function extractLeadingDoc(lines: string[], symbolLine: number, minLine: number = 0): string | null {
  if (symbolLine <= 1) return null;
  const docLines: string[] = [];
  let cursor = symbolLine - 2;
  let sawDocBoundary = false;
  const floor = Math.max(0, minLine);

  while (cursor >= floor) {
    const raw = lines[cursor];
    const stripped = raw.trim();
    if (stripped.length === 0) {
      if (docLines.length > 0) break;
      cursor--;
      continue;
    }
    if (stripped.startsWith("//") || stripped.startsWith("#")) {
      docLines.unshift(stripped.replace(/^\/\/\s?|^#\s?/, ""));
    } else if (stripped.endsWith("*/") || stripped.startsWith("*") || stripped.startsWith("/**") || stripped.startsWith("/*")) {
      const cleaned = stripped.replace(/^\/\*+|^\*+|\*+\/$|^\/+/g, "").trim();
      if (cleaned.length > 0) docLines.unshift(cleaned);
      if (stripped.startsWith("/**") || stripped.startsWith("/*")) {
        sawDocBoundary = true;
        break;
      }
    } else if (stripped.startsWith('"""') || stripped.startsWith("'''")) {
      sawDocBoundary = true;
      break;
    } else {
      break;
    }
    cursor--;
    if (docLines.length >= MAX_DOC_LINES * 2) break;
  }

  if (docLines.length === 0 && !sawDocBoundary) return null;
  const limited = docLines.slice(0, MAX_DOC_LINES);
  const joined = limited.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 0 ? joined : null;
}

const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);

function isStructuralChild(child: CodeSymbol): boolean {
  return STRUCTURAL_KINDS.has(child.kind);
}

function renderSymbol(sym: CodeSymbol, lines: string[], depth: number, previousEndLine: number = 0): string[] {
  const indent = "  ".repeat(depth);
  const out: string[] = [];
  const range = formatLineRange(sym.line, sym.endLine);
  const signature = truncateSignature(sym.signature || sym.name);
  out.push(`${indent}[${sym.kind}] ${range}  ${signature}`);
  const doc = extractLeadingDoc(lines, sym.line, previousEndLine);
  if (doc) out.push(`${indent}  ⤷ ${doc}`);
  const structuralChildren = sym.children.filter(isStructuralChild);
  let lastChildEnd = sym.line;
  for (const child of structuralChildren) {
    out.push(...renderSymbol(child, lines, depth + 1, lastChildEnd));
    lastChildEnd = child.endLine;
  }
  return out;
}

function summarizeImports(content: string, filePath: string): string[] {
  const imports = extractImports(content, filePath);
  if (imports.length === 0) return [];
  const grouped = new Map<string, Set<string>>();
  for (const imp of imports) {
    const bucket = grouped.get(imp.source) ?? new Set<string>();
    for (const spec of imp.specifiers) bucket.add(spec);
    grouped.set(imp.source, bucket);
  }
  const entries = [...grouped.entries()].slice(0, MAX_IMPORTS_DISPLAYED);
  const lines: string[] = [];
  for (const [source, specs] of entries) {
    const specList = [...specs].slice(0, 6).join(", ");
    if (specList.length > 0) {
      lines.push(`  ${source}: ${specList}${specs.size > 6 ? ` (+${specs.size - 6} more)` : ""}`);
    } else {
      lines.push(`  ${source}`);
    }
  }
  if (grouped.size > MAX_IMPORTS_DISPLAYED) {
    lines.push(`  … and ${grouped.size - MAX_IMPORTS_DISPLAYED} more sources`);
  }
  return lines;
}

function summarizeExports(symbols: CodeSymbol[], content: string): string[] {
  const exportNames = new Set<string>();
  for (const sym of symbols) {
    if (new RegExp(`^export\\s+(?:async\\s+|default\\s+|abstract\\s+|const\\s+|let\\s+|var\\s+|function\\s+|class\\s+|interface\\s+|enum\\s+|type\\s+)*${sym.name}\\b`, "m").test(content)) {
      exportNames.add(sym.name);
    }
  }
  const reExportPattern = /^export\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+))/gm;
  let match: RegExpExecArray | null;
  while ((match = reExportPattern.exec(content)) !== null) {
    if (match[1]) {
      for (const item of match[1].split(",")) {
        const name = item.trim().split(/\s+as\s+/i).pop()?.trim();
        if (name) exportNames.add(name);
      }
    } else if (match[2]) {
      exportNames.add(match[2]);
    }
  }
  return exportNames.size > 0 ? [...exportNames].sort() : [];
}

function formatSignatureBlock(analysis: FileAnalysis, content: string): string[] {
  const lines = content.split("\n");
  const out: string[] = [];
  if (analysis.header) {
    out.push(`// ${analysis.header}`);
    out.push("");
  }
  let previousEnd = 0;
  for (const sym of analysis.symbols) {
    out.push(...renderSymbol(sym, lines, 0, previousEnd));
    previousEnd = sym.endLine;
  }
  return out;
}

export async function getFileSkeleton(options: SkeletonOptions): Promise<string> {
  const fullPath = resolveProjectPath(options.rootDir, options.filePath, "filePath");

  if (!isSupportedFile(fullPath)) {
    const content = await readFile(fullPath, "utf-8");
    const preview = content.split("\n").slice(0, 20).join("\n");
    return `[Unsupported language, showing first 20 lines]\n\n${preview}`;
  }

  const content = await readFile(fullPath, "utf-8");
  const analysis = await analyzeFile(fullPath);

  if (analysis.symbols.length === 0) {
    const preview = content.split("\n").slice(0, 30).join("\n");
    return `[No symbols detected, showing first 30 lines]\n\n${preview}`;
  }

  const importsBlock = summarizeImports(content, fullPath);
  const exportsBlock = summarizeExports(analysis.symbols, content);
  const symbolsBlock = formatSignatureBlock(analysis, content);
  const sections: string[] = [
    `File: ${options.filePath} (${analysis.lineCount} lines)`,
    `Symbols: ${analysis.symbols.length} top-level definitions`,
  ];
  if (importsBlock.length > 0) {
    sections.push("", "Imports:");
    sections.push(...importsBlock);
  }
  if (exportsBlock.length > 0) {
    sections.push("", `Exports: ${exportsBlock.join(", ")}`);
  }
  sections.push("");
  sections.push(...symbolsBlock);
  return sections.join("\n");
}
