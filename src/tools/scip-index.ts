// MCP-facing SCIP import wrapper
// FEATURE: SCIP import tool — let agents attach exact external indexes to a project

import { importScipIndex, loadScipIndex } from "../core/scip-index.js";

export interface ScipImportOptions {
  rootDir: string;
  indexPath: string;
  format?: "text" | "json";
}

export interface ScipStatusOptions {
  rootDir: string;
  format?: "text" | "json";
}

interface ScipSummary {
  available: boolean;
  sourcePath?: string;
  importedAt?: string;
  documents?: number;
  symbols?: number;
  occurrences?: number;
}

function summary(index: Awaited<ReturnType<typeof loadScipIndex>>): ScipSummary {
  if (!index) return { available: false };
  return {
    available: true,
    sourcePath: index.sourcePath,
    importedAt: index.importedAt,
    documents: index.documents,
    symbols: index.symbols.length,
    occurrences: index.occurrences.length,
  };
}

export async function scipImportTool(options: ScipImportOptions): Promise<string> {
  const result = await importScipIndex(options.rootDir, options.indexPath);
  const payload = {
    cachePath: result.cachePath,
    ...summary(result.index),
  };
  if (options.format === "json") return JSON.stringify(payload, null, 2);
  return [
    "SCIP index imported.",
    `Cache: ${payload.cachePath}`,
    `Source: ${payload.sourcePath ?? ""}`,
    `Documents: ${payload.documents ?? 0}`,
    `Symbols: ${payload.symbols ?? 0}`,
    `Occurrences: ${payload.occurrences ?? 0}`,
  ].join("\n");
}

export async function scipStatusTool(options: ScipStatusOptions): Promise<string> {
  const payload = summary(await loadScipIndex(options.rootDir));
  if (options.format === "json") return JSON.stringify(payload, null, 2);
  if (!payload.available) return "No SCIP index is available for this project.";
  return [
    "SCIP index available.",
    `Source: ${payload.sourcePath}`,
    `Imported: ${payload.importedAt}`,
    `Documents: ${payload.documents}`,
    `Symbols: ${payload.symbols}`,
    `Occurrences: ${payload.occurrences}`,
  ].join("\n");
}
