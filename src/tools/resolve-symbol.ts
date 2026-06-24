// Symbol resolution with ambiguity scoring and file-context-aware ranking
// FEATURE: ResolveSymbol — precise definition lookup for ambiguous identifiers

import { dirname, resolve } from "path";
import { getDB, type FileRow, type SymbolRow } from "../core/db.js";
import { loadProjectConfig } from "../core/project-config.js";
import { persistArtifact } from "../core/artifacts.js";
import { buildFreshnessMetadata, buildTrustMetadata, getIndexState, type FreshnessMetadata, type TrustMetadata } from "../core/context-metadata.js";

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
    projectId: string | null;
    clientId: string | null;
    fingerprint: string | null;
  };
  query: {
    symbolName: string;
    kind: string | null;
  };
  freshness: FreshnessMetadata;
  trust: TrustMetadata;
  bestMatch: ResolvedSymbolCandidate | null;
  ambiguous: boolean;
  candidates: ResolvedSymbolCandidate[];
}

function nameSegments(name: string): string[] {
  // Split camelCase and snake_case into lowercase word segments.
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isLikelyTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path)
    || /\.(test|spec|demo)\./.test(path)
    || /(^|\/)test_[^/]+\.py$/.test(path)
    || /_test\.go$/.test(path);
}

function scoreSymbolCandidate(input: {
  symbolName: string;
  expectedKind: string | undefined;
  symbol: SymbolRow;
  file: FileRow;
  fileContext: string | undefined;
  importedFileIds: Set<number>;
  importerCount: number;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const exactMatch = input.symbol.name === input.symbolName;
  const normalizedQuery = input.symbolName.toLowerCase();
  const normalizedName = input.symbol.name.toLowerCase();
  const querySegments = nameSegments(input.symbolName);
  const nameSegs = nameSegments(input.symbol.name);

  if (exactMatch) {
    score += 100;
    reasons.push("exact name match");
  } else if (normalizedName === normalizedQuery) {
    score += 90;
    reasons.push("case-insensitive exact name match");
  } else if (querySegments.length > 0 && querySegments.every((seg) => nameSegs.includes(seg))) {
    // All query word-segments are present as whole words in the symbol name.
    // e.g. "fee model" matches "FeeModel"; "run" matches "run_scanner" but NOT "drunk".
    score += 55;
    reasons.push("word-boundary segment match");
  } else if (nameSegs.includes(normalizedQuery)) {
    // The whole query is one of the symbol's word segments. This is what kills the
    // fee-in-feed substring collision: "fee" is NOT a segment of "run_venue_a_feed".
    score += 50;
    reasons.push("matches a whole word segment");
  } else if (normalizedName.includes(normalizedQuery)) {
    // Pure substring — lowest tier, and only counts when the query is reasonably long
    // so 2-3 char queries don't spray across unrelated names.
    score += normalizedQuery.length >= 4 ? 20 : 8;
    reasons.push("partial (substring) name match");
  }

  if (input.expectedKind && input.symbol.kind === input.expectedKind) {
    score += 35;
    reasons.push(`kind match (${input.expectedKind})`);
  } else if (input.expectedKind && input.symbol.kind !== input.expectedKind) {
    score -= 15;
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

  // Tie-breakers when file_context is absent: prefer non-test, well-imported definitions.
  if (isLikelyTestPath(input.file.path)) {
    score -= 6;
    reasons.push("in a test file (de-prioritized)");
  }
  if (input.importerCount > 0) {
    const bump = Math.min(8, input.importerCount);
    score += bump;
    reasons.push(`${input.importerCount} importer(s)`);
  }

  return { score, reasons };
}

function resolveParentName(symbol: SymbolRow, siblings: SymbolRow[]): string | null {
  if (symbol.parent_symbol_id === null) return null;
  return siblings.find((candidate) => candidate.id === symbol.parent_symbol_id)?.name ?? null;
}

export async function resolveSymbolData(options: ResolveSymbolOptions): Promise<ResolveSymbolData> {
  const [db, config, indexState] = await Promise.all([
    getDB(options.rootDir),
    loadProjectConfig(options.rootDir),
    getIndexState(options.rootDir),
  ]);
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
      const importerCount = db.getImportersOf(file.id).length;
      const { score, reasons } = scoreSymbolCandidate({
        symbolName: options.symbolName,
        expectedKind: options.kind,
        symbol,
        file,
        fileContext: options.fileContext,
        importedFileIds,
        importerCount,
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
  const freshness = buildFreshnessMetadata(indexState, {
    staleCount: 0,
    refreshed: false,
    warning: indexState.state === "empty"
      ? "Index is empty. Run reindex before resolving symbols."
      : indexState.state === "indexing"
        ? "Indexing is still in progress. Wait for completion before trusting symbol resolution."
        : indexState.state === "stale"
          ? "Index is stale relative to the workspace. Run reindex before trusting symbol resolution."
          : null,
  });
  const evidence = [
    ...(bestMatch ? [`best candidate ${bestMatch.path}:L${bestMatch.line}`] : []),
    ...(currentFile ? [`file context ${currentFile.path}`] : []),
    ...(importedFileIds.size > 0 ? [`${importedFileIds.size} directly imported files considered`] : []),
  ];
  const ambiguities = [
    ...(limited.length === 0 ? ["no symbol candidates found"] : []),
    ...(ambiguous ? ["top symbol candidates are close in score"] : []),
  ];
  const partial: ResolveSymbolData = {
    repo: {
      root: resolve(options.rootDir),
      fileContext: options.fileContext ?? null,
      projectId: config?.projectId ?? null,
      clientId: config?.clientId ?? null,
      fingerprint: config?.repoFingerprint ?? null,
    },
    query: {
      symbolName: options.symbolName,
      kind: options.kind ?? null,
    },
    freshness,
    trust: buildTrustMetadata({
      baseConfidence: bestMatch ? (ambiguous ? 0.62 : 0.84) : 0.24,
      freshness,
      evidence,
      ambiguities,
      artifact: null,
    }),
    bestMatch,
    ambiguous,
    candidates: limited,
  };
  const artifact = await persistArtifact({
    rootDir: options.rootDir,
    kind: "resolve_symbol",
    key: JSON.stringify({
      symbolName: options.symbolName,
      fileContext: options.fileContext ?? null,
      kind: options.kind ?? null,
      limit: options.limit ?? 8,
    }),
    repoFingerprint: partial.repo.fingerprint,
    projectId: partial.repo.projectId,
    clientId: partial.repo.clientId,
    metadata: {
      symbolName: options.symbolName,
      kind: options.kind ?? "",
    },
    payload: partial,
  });

  return {
    ...partial,
    trust: buildTrustMetadata({
      baseConfidence: bestMatch ? (ambiguous ? 0.62 : 0.84) : 0.24,
      freshness,
      evidence,
      ambiguities,
      artifact,
    }),
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
    data.trust.artifact ? `Artifact: ${data.trust.artifact.id}` : "",
    "",
  ].filter(Boolean);

  for (const candidate of data.candidates) {
    lines.push(`${candidate.kind}: ${candidate.path} L${candidate.line}${candidate.endLine && candidate.endLine > candidate.line ? `-L${candidate.endLine}` : ""}`);
    if (candidate.signature) lines.push(`  ${candidate.signature}`);
    if (candidate.parentName) lines.push(`  parent: ${candidate.parentName}`);
    lines.push(`  score: ${candidate.score} | ${candidate.reasons.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}
