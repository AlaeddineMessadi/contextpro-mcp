// Planning file ranking, scoring, and chat-assisted reranking for task-oriented context
// FEATURE: Helper layer for agentic-context — file candidate ranking pipeline

import { basename } from "path";
import { chatCompletion, extractJsonBlock, hasConfiguredChatModel } from "../core/chat-model.js";
import { unifiedSearchData } from "./search.js";
import { unique } from "./retrieval-helpers.js";

export interface PlanningFileCandidate {
  path: string;
  reason: string;
  score: number;
  symbols: string[];
}

function isTestPath(filePath: string): boolean {
  return /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(filePath) || filePath.startsWith("test/");
}

function isDocumentationPath(filePath: string): boolean {
  return filePath.endsWith(".md")
    || /(^|\/)(README|TODO|CHANGELOG|INSTRUCTIONS)(\.md)?$/i.test(filePath)
    || filePath.startsWith("docs/");
}

function isHubPath(filePath: string): boolean {
  return filePath.startsWith(".contextpro/hubs/");
}

function isSourcePath(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|cpp|c|swift|kt)$/.test(filePath) && !isTestPath(filePath);
}

function detectCodeChangeIntent(query: string): boolean {
  const lower = query.toLowerCase();
  const codeSignals = [
    "fix", "bug", "regression", "status", "freshness", "index", "reindex", "search", "symbol",
    "function", "module", "file", "src/", "test", "error", "scope", "ranking", "artifact", "manifest",
  ];
  const docSignals = ["readme", "docs", "documentation", "roadmap", "todo", "plan", "spec", "guide", "instructions"];
  const hasCodeSignal = codeSignals.some((signal) => lower.includes(signal));
  const hasDocSignal = docSignals.some((signal) => lower.includes(signal));
  return hasCodeSignal || !hasDocSignal;
}

function extractIdentifierHints(query: string): string[] {
  const rawTokens = query.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const unique2 = new Map<string, string>();
  const queryTrimmed = query.trim();
  for (const token of rawTokens) {
    if (token.length < 3) continue;
    const looksIdentifier = /[A-Z_]/.test(token) || rawTokens.length === 1 || queryTrimmed === token;
    if (!looksIdentifier) continue;
    unique2.set(token.toLowerCase(), token);
  }
  return [...unique2.values()];
}

function splitQueryTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) ?? [];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function buildExactIdentifierPathSet(search: Awaited<ReturnType<typeof unifiedSearchData>>, query: string): Set<string> {
  const hints = new Set(extractIdentifierHints(query).map((hint) => hint.toLowerCase()));
  return new Set(
    (search.identifiers?.results ?? [])
      .filter((item) => hints.has(item.name.toLowerCase()) || item.keywordScore >= 95)
      .map((item) => item.path),
  );
}

function scorePlanningCandidate(
  candidate: PlanningFileCandidate,
  query: string,
  codeChangeIntent: boolean,
  exactIdentifierPaths: Set<string>,
): number {
  let adjusted = candidate.score;
  const queryTerms = new Set(splitQueryTerms(query));
  const basenameTerms = splitQueryTerms(basename(candidate.path).replace(/\.\w+$/, ""));
  const symbolTerms = splitQueryTerms(candidate.symbols.join(" "));
  const basenameOverlap = basenameTerms.filter((term) => queryTerms.has(term)).length;
  const symbolOverlap = symbolTerms.filter((term) => queryTerms.has(term)).length;
  if (codeChangeIntent) {
    if (isSourcePath(candidate.path)) adjusted += 0.34;
    if (candidate.path.startsWith("src/")) adjusted += 0.08;
    if (isTestPath(candidate.path)) adjusted += 0.16;
    if (isDocumentationPath(candidate.path)) adjusted -= 0.42;
    if (isHubPath(candidate.path)) adjusted -= 0.3;
    if (candidate.symbols.length > 0) adjusted += 0.05;
    adjusted += Math.min(0.24, basenameOverlap * 0.16);
    adjusted += Math.min(0.28, symbolOverlap * 0.14);
    if (basenameOverlap > 0 && symbolOverlap > 0) adjusted += 0.08;
  }
  if (exactIdentifierPaths.has(candidate.path)) adjusted += 0.24;
  return clamp01(adjusted);
}

export function rerankPlanningFiles(
  candidates: PlanningFileCandidate[],
  query: string,
  exactIdentifierPaths: Set<string>,
): PlanningFileCandidate[] {
  const codeChangeIntent = detectCodeChangeIntent(query);
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scorePlanningCandidate(candidate, query, codeChangeIntent, exactIdentifierPaths),
      reason: codeChangeIntent && isDocumentationPath(candidate.path)
        ? `${candidate.reason}; doc file down-ranked for code-change intent`
        : candidate.reason,
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function shouldUseChatRerank(candidates: PlanningFileCandidate[], query: string): boolean {
  if (!detectCodeChangeIntent(query) || candidates.length < 3) return false;
  const top = candidates[0];
  const second = candidates[1];
  if (!top || !second) return false;
  return isDocumentationPath(top.path) || Math.abs(top.score - second.score) < 0.08;
}

export async function maybeChatRerankPlanningFiles(
  rootDir: string,
  query: string,
  candidates: PlanningFileCandidate[],
): Promise<PlanningFileCandidate[]> {
  if (!shouldUseChatRerank(candidates, query)) return candidates;
  if (!(await hasConfiguredChatModel(rootDir))) return candidates;

  const prompt = [
    "Rank these candidate files for implementing the task.",
    "Prefer directly editable source files first, then nearby tests.",
    "Heavily down-rank docs, roadmap files, TODOs, and generated hubs unless the task is explicitly documentation.",
    "Return JSON only: {\"ranked_paths\":[\"path1\",\"path2\"]}.",
    `Task: ${query}`,
    "",
    "Candidates:",
    ...candidates.slice(0, 8).map((candidate) => `- ${candidate.path} | score=${candidate.score.toFixed(2)} | ${candidate.reason}`),
  ].join("\n");

  try {
    const raw = await chatCompletion(rootDir, prompt);
    const json = extractJsonBlock(raw);
    if (!json) return candidates;
    const parsed = JSON.parse(json) as { ranked_paths?: string[] };
    const rankedPaths = parsed.ranked_paths?.filter(Boolean) ?? [];
    if (rankedPaths.length === 0) return candidates;
    const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
    const reranked: PlanningFileCandidate[] = [];
    for (const path of rankedPaths) {
      const candidate = byPath.get(path);
      if (!candidate) continue;
      reranked.push({ ...candidate, score: clamp01(candidate.score + 0.02), reason: `${candidate.reason}; chat reranked` });
      byPath.delete(path);
    }
    reranked.push(...[...byPath.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)));
    return reranked;
  } catch {
    return candidates;
  }
}

export function upsertRanked<T extends { path: string; score: number; kind: string }>(map: Map<string, T>, value: T): void {
  const existing = map.get(value.path);
  if (!existing || value.score > existing.score) map.set(value.path, value);
}

export { detectCodeChangeIntent, extractIdentifierHints, isDocumentationPath, isHubPath, isSourcePath, isTestPath, splitQueryTerms, clamp01, unique };
