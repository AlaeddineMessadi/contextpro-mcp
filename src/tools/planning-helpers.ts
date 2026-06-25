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

const STOPWORD_VERBS = new Set([
  "add", "get", "set", "put", "update", "delete", "remove", "create", "make",
  "run", "use", "call", "send", "fetch", "load", "save", "find", "search",
  "build", "init", "start", "stop", "open", "close", "handle", "process",
  "the", "and", "for", "from", "with", "into", "this", "that", "these",
  "have", "has", "was", "were", "are", "can", "will", "should", "would",
  "new", "old", "all", "any", "any", "some", "more", "less",
]);

function lemmatize(term: string): string {
  // Tiny English lemmatizer for plurals/-ing/-ed. Enough to match `fees` ↔ `fee`,
  // `models` ↔ `model`, `running` ↔ `run`, `executed` ↔ `execute`.
  if (term.length < 4) return term;
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ses") || term.endsWith("xes") || term.endsWith("zes")) return term.slice(0, -2);
  if (term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us")) return term.slice(0, -1);
  if (term.endsWith("ing") && term.length > 5) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 4) return term.slice(0, -2);
  return term;
}

function buildQueryTermSet(query: string): Set<string> {
  const terms = splitQueryTerms(query);
  const out = new Set<string>();
  for (const term of terms) {
    if (STOPWORD_VERBS.has(term)) continue;
    out.add(term);
    const lemma = lemmatize(term);
    if (lemma !== term) out.add(lemma);
  }
  return out;
}

function pathSegments(path: string): string[] {
  return path.split("/").flatMap((seg) => splitQueryTerms(seg.replace(/\.\w+$/, "")));
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

interface PlanningCandidateReasoning {
  score: number;
  reasons: string[];
}

function termMatches(term: string, queryTerms: Set<string>, lemmatizedQueryTerms: Set<string>): boolean {
  if (queryTerms.has(term)) return true;
  const lemma = lemmatize(term);
  if (queryTerms.has(lemma) || lemmatizedQueryTerms.has(lemma)) return true;
  // Deliberately NO prefix/substring fallback. A startsWith() check let "fee" match "feeds" (and
  // "auth" match "author"), flooding a "fee model" task_pack with feeds/ websocket files — the
  // Round-4 audit's headline scope-quality bug. Lemmatization already handles fees↔fee, feeds↔feed,
  // models↔model; anything it can't normalize is a genuinely different word and must not match.
  return false;
}

function scorePlanningCandidate(
  candidate: PlanningFileCandidate,
  query: string,
  codeChangeIntent: boolean,
  exactIdentifierPaths: Set<string>,
): PlanningCandidateReasoning {
  let adjusted = candidate.score;
  const reasons: string[] = [];
  const queryTerms = buildQueryTermSet(query);
  const lemmatizedQueryTerms = new Set([...queryTerms].map(lemmatize));

  const basenameTerms = splitQueryTerms(basename(candidate.path).replace(/\.\w+$/, "")).filter((term) => !STOPWORD_VERBS.has(term));
  const basenameMatches = basenameTerms.filter((term) => termMatches(term, queryTerms, lemmatizedQueryTerms));
  const basenameOverlap = basenameMatches.length;
  if (basenameOverlap > 0) reasons.push(`basename matches "${basenameMatches.join(",")}"`);

  const dirTerms = pathSegments(candidate.path.replace(/[^/]+$/, "")).filter((term) => !STOPWORD_VERBS.has(term));
  const dirMatches = dirTerms.filter((term) => termMatches(term, queryTerms, lemmatizedQueryTerms));
  const dirOverlap = dirMatches.length;
  if (dirOverlap > 0) reasons.push(`directory matches "${dirMatches.join(",")}"`);

  const symbolTerms = splitQueryTerms(candidate.symbols.join(" ")).filter((term) => !STOPWORD_VERBS.has(term));
  const symbolMatches = symbolTerms.filter((term) => termMatches(term, queryTerms, lemmatizedQueryTerms));
  const symbolOverlap = symbolMatches.length;
  if (symbolOverlap > 0) reasons.push(`symbols match "${symbolMatches.slice(0, 3).join(",")}"`);

  if (codeChangeIntent) {
    if (isSourcePath(candidate.path)) adjusted += 0.18;
    if (candidate.path.startsWith("src/")) adjusted += 0.04;
    if (isTestPath(candidate.path)) adjusted += 0.08;
    if (isDocumentationPath(candidate.path)) adjusted -= 0.42;
    if (isHubPath(candidate.path)) adjusted -= 0.3;
    if (candidate.symbols.length > 0) adjusted += 0.03;
    adjusted += Math.min(0.16, basenameOverlap * 0.10);
    adjusted += Math.min(0.18, symbolOverlap * 0.09);
    // Directory-name match is the strongest signal that a file belongs to a feature folder
    // (e.g., src/fees/* for a "fee model" task). Bump weight so it outranks pure semantic hits
    // on unrelated files.
    adjusted += Math.min(0.24, dirOverlap * 0.14);
    if (basenameOverlap > 0 && symbolOverlap > 0) adjusted += 0.05;
    if (dirOverlap > 0 && symbolOverlap > 0) adjusted += 0.05;
    if (dirOverlap > 0 && basenameOverlap > 0) adjusted += 0.04;
  }
  if (exactIdentifierPaths.has(candidate.path)) {
    adjusted += 0.12;
    reasons.push("exact symbol match");
  }
  return { score: Math.min(0.97, clamp01(adjusted)), reasons };
}

export function rerankPlanningFiles(
  candidates: PlanningFileCandidate[],
  query: string,
  exactIdentifierPaths: Set<string>,
): PlanningFileCandidate[] {
  const codeChangeIntent = detectCodeChangeIntent(query);
  return candidates
    .map((candidate) => {
      const scoring = scorePlanningCandidate(candidate, query, codeChangeIntent, exactIdentifierPaths);
      const reasonParts: string[] = [candidate.reason];
      if (scoring.reasons.length > 0) reasonParts.push(scoring.reasons.join("; "));
      if (codeChangeIntent && isDocumentationPath(candidate.path)) reasonParts.push("doc file down-ranked for code-change intent");
      return {
        ...candidate,
        score: scoring.score,
        reason: reasonParts.join("; "),
      };
    })
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
