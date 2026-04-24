// Shared repo, freshness, and trust metadata for agent-facing JSON responses
// FEATURE: Trust envelope — explicit index state, evidence, and confidence

import { getDB } from "./db.js";
import type { ArtifactReference } from "./artifacts.js";
import { walkDirectory } from "./walker.js";
import { isSupportedFile } from "./parser.js";

export interface IndexState {
  generation: number;
  indexedFiles: number;
  sourceFiles: number;
  missingIndexedFiles: number;
  removedIndexedFiles: number;
  lastIndexedAt: string | null;
  lastReindexAt: string | null;
  lastReindexDurationMs: number | null;
  autoHubCount: number | null;
  indexStartedAt: string | null;
  state: "empty" | "indexing" | "stale" | "fresh";
}

export interface FreshnessMetadata {
  staleCount: number;
  refreshed: boolean;
  warning: string | null;
  indexGeneration: number;
  indexedFiles: number;
  lastIndexedAt: string | null;
  lastReindexAt: string | null;
  lastReindexDurationMs: number | null;
  autoHubCount: number | null;
  indexState: "empty" | "indexing" | "fresh" | "stale" | "refreshed";
}

export interface TrustMetadata {
  confidence: number;
  evidence: string[];
  ambiguities: string[];
  freshness: FreshnessMetadata;
  artifact: ArtifactReference | null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(timestamp: number | null): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function getIndexState(rootDir: string): Promise<IndexState> {
  const db = await getDB(rootDir);
  const latestIndexedAt = db.getLatestIndexedAt();
  const indexedSourceFiles = db.getAllFiles().filter((file) => isSupportedFile(file.path));
  const indexedFiles = indexedSourceFiles.length;
  const indexedPaths = new Set(indexedSourceFiles.map((file) => file.path));
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const sourceEntries = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const sourcePaths = new Set(sourceEntries.map((entry) => entry.relativePath));
  const missingIndexedFiles = sourceEntries.filter((entry) => !indexedPaths.has(entry.relativePath)).length;
  const removedIndexedFiles = db.getRemovedFiles(sourcePaths).length;
  const generation = db.getIndexGeneration();
  const activeStatus = db.getMeta("index_status");
  const state = indexedFiles === 0
    ? "empty"
    : activeStatus === "indexing"
      ? "indexing"
      : generation === 0 || missingIndexedFiles > 0 || removedIndexedFiles > 0 || sourceEntries.length !== indexedFiles
        ? "stale"
        : "fresh";
  return {
    generation,
    indexedFiles,
    sourceFiles: sourceEntries.length,
    missingIndexedFiles,
    removedIndexedFiles,
    lastIndexedAt: toIso(latestIndexedAt),
    lastReindexAt: toIso(parseNumber(db.getMeta("last_reindex_at"))),
    lastReindexDurationMs: parseNumber(db.getMeta("last_reindex_duration_ms")),
    autoHubCount: parseNumber(db.getMeta("last_auto_hub_count")),
    indexStartedAt: toIso(parseNumber(db.getMeta("index_started_at"))),
    state,
  };
}

export function buildFreshnessMetadata(
  indexState: IndexState,
  input: { staleCount: number; refreshed: boolean; warning: string | null },
): FreshnessMetadata {
  const indexStateLabel = indexState.state === "empty"
    ? "empty"
    : indexState.state === "indexing"
      ? "indexing"
      : input.staleCount > 0 || indexState.state === "stale"
        ? input.refreshed ? "refreshed" : "stale"
        : "fresh";
  return {
    staleCount: input.staleCount,
    refreshed: input.refreshed,
    warning: input.warning,
    indexGeneration: indexState.generation,
    indexedFiles: indexState.indexedFiles,
    lastIndexedAt: indexState.lastIndexedAt,
    lastReindexAt: indexState.lastReindexAt,
    lastReindexDurationMs: indexState.lastReindexDurationMs,
    autoHubCount: indexState.autoHubCount,
    indexState: indexStateLabel,
  };
}

export function buildTrustMetadata(input: {
  baseConfidence?: number;
  freshness: FreshnessMetadata;
  evidence?: string[];
  ambiguities?: string[];
  artifact?: ArtifactReference | null;
}): TrustMetadata {
  const evidence = [...new Set((input.evidence ?? []).filter(Boolean))];
  const ambiguities = [...new Set((input.ambiguities ?? []).filter(Boolean))];
  let confidence = input.baseConfidence ?? 0.72;
  confidence += Math.min(evidence.length, 4) * 0.04;
  confidence -= Math.min(ambiguities.length, 3) * 0.08;
  if (input.freshness.indexState === "empty") confidence -= 0.25;
  if (input.freshness.indexState === "indexing") confidence -= 0.14;
  if (input.freshness.indexState === "stale") confidence -= 0.18;
  if (input.freshness.indexState === "refreshed") confidence -= 0.08;
  if (input.freshness.warning) confidence -= 0.03;
  return {
    confidence: clamp(Number(confidence.toFixed(2)), 0.1, 0.99),
    evidence,
    ambiguities,
    freshness: input.freshness,
    artifact: input.artifact ?? null,
  };
}
