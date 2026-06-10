// Optional SCIP JSON index adapter for exact cross-language reference facts
// FEATURE: SCIP import — normalize external code indexes into portable Context+ evidence

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { resolveProjectPath, toProjectRelativePath } from "./path-guard.js";

export const DEFAULT_SCIP_CACHE_PATH = ".contextplus/scip-index.json";

export interface NormalizedScipRelationship {
  targetSymbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface NormalizedScipSymbol {
  symbol: string;
  name: string;
  kind?: string;
  file?: string;
  line?: number;
  documentation?: string;
  signature?: string;
  relationships: NormalizedScipRelationship[];
}

export interface NormalizedScipOccurrence {
  file: string;
  symbol: string;
  name: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  role: "definition" | "reference";
  syntaxKind?: string;
}

export interface NormalizedScipIndex {
  version: 1;
  sourcePath: string;
  importedAt: string;
  documents: number;
  symbols: NormalizedScipSymbol[];
  occurrences: NormalizedScipOccurrence[];
}

export interface ScipExactReference {
  file: string;
  line: number;
  column: number;
  context: string;
  isDefinition: boolean;
  confidence: "SCIP_RESOLVED";
  symbol: string;
}

export interface ScipReferenceResult {
  symbol: string;
  symbols: string[];
  confidence: "SCIP_RESOLVED";
  references: ScipExactReference[];
}

export interface ScipImportResult {
  cachePath: string;
  index: NormalizedScipIndex;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRelativeScipPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "") || ".";
}

function parseScipSymbolName(symbol: string): string {
  const parts = symbol.trim().split(/\s+/).filter(Boolean);
  const descriptor = [...parts].reverse().find((part) => part !== "." && part !== "local") ?? symbol;
  const segments = descriptor.split(/[\/#.:]/).map((part) => part.trim()).filter(Boolean);
  const raw = segments.at(-1) ?? descriptor;
  return raw.replace(/\(\)$/, "").replace(/[^\w$-]+$/g, "") || symbol.slice(0, 80);
}

export function scipSymbolDisplayName(symbol: string): string {
  return parseScipSymbolName(symbol);
}

function parseRange(value: unknown): { line: number; column: number; endLine?: number; endColumn?: number } | null {
  const numbers = asArray(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (numbers.length < 3) return null;
  if (numbers.length === 3) {
    return {
      line: numbers[0] + 1,
      column: numbers[1] + 1,
      endLine: numbers[0] + 1,
      endColumn: numbers[2] + 1,
    };
  }
  return {
    line: numbers[0] + 1,
    column: numbers[1] + 1,
    endLine: numbers[2] + 1,
    endColumn: numbers[3] + 1,
  };
}

function parseSymbolRole(value: unknown): "definition" | "reference" {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && (numeric & 65) !== 0 ? "definition" : "reference";
}

function parseSignature(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return undefined;
  return asString(getField(record, "text", "markdown", "language"));
}

function parseDocumentation(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const entries = asArray(value).map((entry) => typeof entry === "string" ? entry : "").filter(Boolean);
  return entries.length > 0 ? entries.join("\n") : undefined;
}

function parseRelationships(value: unknown): NormalizedScipRelationship[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const targetSymbol = asString(getField(record, "symbol", "target_symbol", "targetSymbol"));
    if (!targetSymbol) return [];
    return [{
      targetSymbol,
      isReference: asBoolean(getField(record, "is_reference", "isReference")),
      isImplementation: asBoolean(getField(record, "is_implementation", "isImplementation")),
      isTypeDefinition: asBoolean(getField(record, "is_type_definition", "isTypeDefinition")),
      isDefinition: asBoolean(getField(record, "is_definition", "isDefinition")),
    }];
  });
}

function coerceNormalizedIndex(raw: unknown, sourcePath: string): NormalizedScipIndex | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1 || !Array.isArray(record.symbols) || !Array.isArray(record.occurrences)) {
    return null;
  }
  return {
    version: 1,
    sourcePath: asString(record.sourcePath) ?? sourcePath,
    importedAt: asString(record.importedAt) ?? new Date().toISOString(),
    documents: Number(record.documents ?? 0),
    symbols: record.symbols.flatMap((item) => {
      const symbol = asRecord(item);
      if (!symbol || !asString(symbol.symbol) || !asString(symbol.name)) return [];
      return [{
        symbol: asString(symbol.symbol)!,
        name: asString(symbol.name)!,
        kind: asString(symbol.kind),
        file: asString(symbol.file),
        line: typeof symbol.line === "number" ? symbol.line : undefined,
        documentation: asString(symbol.documentation),
        signature: asString(symbol.signature),
        relationships: parseRelationships(symbol.relationships),
      }];
    }),
    occurrences: record.occurrences.flatMap((item) => {
      const occurrence = asRecord(item);
      if (!occurrence || !asString(occurrence.file) || !asString(occurrence.symbol) || !asString(occurrence.name)) return [];
      const line = Number(occurrence.line);
      const column = Number(occurrence.column);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
      return [{
        file: normalizeRelativeScipPath(asString(occurrence.file)!),
        symbol: asString(occurrence.symbol)!,
        name: asString(occurrence.name)!,
        line,
        column,
        endLine: typeof occurrence.endLine === "number" ? occurrence.endLine : undefined,
        endColumn: typeof occurrence.endColumn === "number" ? occurrence.endColumn : undefined,
        role: occurrence.role === "definition" ? "definition" : "reference",
        syntaxKind: asString(occurrence.syntaxKind),
      }];
    }),
  };
}

export function normalizeScipIndex(raw: unknown, sourcePath: string): NormalizedScipIndex {
  const normalized = coerceNormalizedIndex(raw, sourcePath);
  if (normalized) return normalized;

  const root = asRecord(raw);
  const documents = asArray(root ? getField(root, "documents") : undefined);
  const symbols = new Map<string, NormalizedScipSymbol>();
  const occurrences: NormalizedScipOccurrence[] = [];

  const ensureSymbol = (symbol: string, patch: Partial<NormalizedScipSymbol> = {}) => {
    const existing = symbols.get(symbol);
    const next: NormalizedScipSymbol = {
      symbol,
      name: patch.name ?? existing?.name ?? parseScipSymbolName(symbol),
      kind: patch.kind ?? existing?.kind,
      file: patch.file ?? existing?.file,
      line: patch.line ?? existing?.line,
      documentation: patch.documentation ?? existing?.documentation,
      signature: patch.signature ?? existing?.signature,
      relationships: patch.relationships ?? existing?.relationships ?? [],
    };
    symbols.set(symbol, next);
  };

  for (const document of documents) {
    const doc = asRecord(document);
    if (!doc) continue;
    const path = asString(getField(doc, "relative_path", "relativePath", "path"));
    if (!path) continue;
    const file = normalizeRelativeScipPath(path);

    for (const item of asArray(getField(doc, "symbols"))) {
      const record = asRecord(item);
      const symbol = record ? asString(getField(record, "symbol")) : undefined;
      if (!record || !symbol) continue;
      ensureSymbol(symbol, {
        name: asString(getField(record, "display_name", "displayName", "name")) ?? parseScipSymbolName(symbol),
        kind: asString(getField(record, "kind")),
        documentation: parseDocumentation(getField(record, "documentation")),
        signature: parseSignature(getField(record, "signature_documentation", "signatureDocumentation")),
        relationships: parseRelationships(getField(record, "relationships")),
      });
    }

    for (const item of asArray(getField(doc, "occurrences"))) {
      const record = asRecord(item);
      const symbol = record ? asString(getField(record, "symbol")) : undefined;
      const range = record ? parseRange(getField(record, "range")) : null;
      if (!record || !symbol || !range) continue;
      const role = parseSymbolRole(getField(record, "symbol_roles", "symbolRoles"));
      const name = parseScipSymbolName(symbol);
      const occurrence: NormalizedScipOccurrence = {
        file,
        symbol,
        name,
        line: range.line,
        column: range.column,
        endLine: range.endLine,
        endColumn: range.endColumn,
        role,
        syntaxKind: asString(getField(record, "syntax_kind", "syntaxKind")),
      };
      occurrences.push(occurrence);
      ensureSymbol(symbol, role === "definition" ? { name, file, line: range.line } : { name });
    }
  }

  return {
    version: 1,
    sourcePath,
    importedAt: new Date().toISOString(),
    documents: documents.length,
    symbols: [...symbols.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    occurrences: occurrences.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column),
  };
}

export async function importScipIndex(rootDir: string, indexPath: string): Promise<ScipImportResult> {
  const sourceFullPath = resolveProjectPath(rootDir, indexPath, "index_path");
  const sourcePath = toProjectRelativePath(rootDir, sourceFullPath, "index_path");
  const raw = JSON.parse(await readFile(sourceFullPath, "utf-8")) as unknown;
  const index = normalizeScipIndex(raw, sourcePath);
  const cachePath = resolveProjectPath(rootDir, DEFAULT_SCIP_CACHE_PATH, "scip cache");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  return { cachePath, index };
}

export async function loadScipIndex(rootDir: string, indexPath?: string): Promise<NormalizedScipIndex | null> {
  const candidates = indexPath
    ? [indexPath]
    : [DEFAULT_SCIP_CACHE_PATH, ".contextplus/index.scip.json", "index.scip.json"];
  for (const candidate of candidates) {
    try {
      const fullPath = resolveProjectPath(rootDir, candidate, "scip index");
      const sourcePath = toProjectRelativePath(rootDir, fullPath, "scip index");
      const raw = JSON.parse(await readFile(fullPath, "utf-8")) as unknown;
      return normalizeScipIndex(raw, sourcePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function readContextLine(rootDir: string, file: string, line: number): Promise<string> {
  try {
    const fullPath = resolveProjectPath(rootDir, file, "reference file");
    const content = await readFile(fullPath, "utf-8");
    return content.split("\n")[Math.max(0, line - 1)]?.trim().slice(0, 160) ?? "";
  } catch {
    return "";
  }
}

function symbolDigest(symbol: string): string {
  return createHash("sha1").update(symbol).digest("hex").slice(0, 16);
}

export function scipSymbolNodeId(symbol: string): string {
  return `symbol:scip:${symbolDigest(symbol)}`;
}

export async function findScipReferences(options: {
  rootDir: string;
  symbolName: string;
  file?: string;
  line?: number;
  limit?: number;
  indexPath?: string;
}): Promise<ScipReferenceResult | null> {
  const index = await loadScipIndex(options.rootDir, options.indexPath);
  if (!index) return null;
  const file = options.file ? toProjectRelativePath(options.rootDir, options.file, "file") : undefined;
  const targetSymbols = new Set<string>();

  if (file && options.line) {
    for (const occurrence of index.occurrences) {
      if (occurrence.file !== file) continue;
      if (occurrence.line !== options.line) continue;
      if (occurrence.name === options.symbolName || occurrence.symbol.includes(options.symbolName)) {
        targetSymbols.add(occurrence.symbol);
      }
    }
  }

  if (targetSymbols.size === 0) {
    for (const symbol of index.symbols) {
      if (symbol.name === options.symbolName || symbol.symbol.includes(options.symbolName)) {
        targetSymbols.add(symbol.symbol);
      }
    }
  }

  if (targetSymbols.size === 0) {
    for (const occurrence of index.occurrences) {
      if (occurrence.name === options.symbolName) targetSymbols.add(occurrence.symbol);
    }
  }

  if (targetSymbols.size === 0) return null;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const occurrences = index.occurrences
    .filter((occurrence) => targetSymbols.has(occurrence.symbol))
    .sort((a, b) => Number(b.role === "definition") - Number(a.role === "definition") || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .slice(0, limit);
  const references: ScipExactReference[] = [];
  for (const occurrence of occurrences) {
    references.push({
      file: occurrence.file,
      line: occurrence.line,
      column: occurrence.column,
      context: await readContextLine(options.rootDir, occurrence.file, occurrence.line),
      isDefinition: occurrence.role === "definition",
      confidence: "SCIP_RESOLVED",
      symbol: occurrence.symbol,
    });
  }
  return {
    symbol: options.symbolName,
    symbols: [...targetSymbols].sort(),
    confidence: "SCIP_RESOLVED",
    references,
  };
}
