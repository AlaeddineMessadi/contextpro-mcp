// Bounded lexical candidates for queries naming a source area or identifier.
// These are filename/text hints, never compiler-resolved references.
import type { ContextPlusDB } from "../core/db.js";
import { searchTerms } from "../core/embeddings.js";
import { discoveryPathWeight, SCOPE_CLAUSE_BOUNDARY } from "./discovery-hints.js";

const GENERIC = new Set("find show read locate implementation function code source file files path paths usage usages props surrounding semantics pages page src app apps index components component lib packages public private main exact return relevant control controls".split(" "));
// Exclusions apply to their clause regardless of intervening modifiers, and can
// cover a list of paths. Explicit positive clauses reset them. Match prose words
// at whitespace boundaries so directory names like apps/outside are not commands.
const EXCLUDED_SCOPE_CLAUSE = /(?:^|[\s(])(?:exclude|excluding|ignore|ignoring|not\s+(?:in|under|inside|within))(?=\s|:|$)/i;
// Bare "outside" and "without" must introduce a directory mention (possibly
// earlier in a path list), not describe a click-outside handler or routes without
// authentication that are followed by a positive directory hint.
const DIRECTORY_EXCLUSION_PHRASE = /(?:^|[\s(])(?:(?:outside\s+of|except)(?=\s|:|$)|(?:outside|without|not)(?:\s*[`"']?$|\s+[`"']?[^\s`"',;]*\/[^\s`"',;]*))/gi;
const POSITIVE_SCOPE_LOCATION = /(?:^|\s)(?:in|under|inside|within)(?=\s|$)/gi;

export interface ScopedSourceCandidate { file: string; terms: string[]; }

export function scopedSourceCandidates(db: ContextPlusDB, query: string, hints: string[]): ScopedSourceCandidate[] {
  const indexedFiles = db.getAllFiles().filter(file => discoveryPathWeight(query, file.path) >= 1);
  const browserTests = /\b(?:browser|playwright|e2e|end[ -]to[ -]end)\b/i.test(query) && /\b(?:tests?|testing|coverage|suite|journey)\b/i.test(query);
  const excludedScopes: string[] = [];
  const maskedRanges: Array<{start: number; end: number}> = [];
  // Only existing, repository-relative directory prefixes qualify. Never turn
  // a query token into a filesystem read, and don't interpret exclusions as scope.
  const scopes = [...query.matchAll(/[^\s`"',;]+\/[^\s`"',;]*/g)].flatMap(match => {
    const token = match[0].replace(/^\.\//, "");
    if (/(?:^|\/)\.\.(?:\/|$|[.:])/.test(token)) return [];
    const path = token.replace(/[/:.]+$/, "");
    if (path.startsWith("/") || path.split("/").includes("..")) return [];
    const exists = indexedFiles.some(file => file.path.startsWith(path + "/"));
    const prefix = query.slice(0, match.index);
    const clause = prefix.split(SCOPE_CLAUSE_BOUNDARY).at(-1) ?? "";
    // Bind the latest location across descriptive words ("in the source tree").
    // A later directory exclusion wins; explicit commands and "not in" remain
    // negative even when they contain a location preposition themselves.
    const location = [...clause.matchAll(POSITIVE_SCOPE_LOCATION)].at(-1);
    const directoryExclusion = [...clause.matchAll(DIRECTORY_EXCLUSION_PHRASE)].at(-1);
    const exclusion = EXCLUDED_SCOPE_CLAUSE.exec(clause)
      ?? (directoryExclusion && (!location || directoryExclusion.index > location.index) ? directoryExclusion : null);
    if (exclusion) {
      if (exists) excludedScopes.push(path + "/");
      maskedRanges.push({start: prefix.length - clause.length + exclusion.index, end: match.index + match[0].length});
      return [];
    }
    if (exists) maskedRanges.push({start: match.index, end: match.index + match[0].length});
    return exists ? [path + "/"] : [];
  }).slice(0, 4);
  // A positive ancestor or identifier hit must not reintroduce an excluded
  // subtree into this lane. The slash boundary preserves similarly named peers.
  const files = indexedFiles.filter(file => !excludedScopes.some(scope => file.path.startsWith(scope)));
  // Mask directory mentions and negative clauses, not their vocabulary globally:
  // independently requested "menu" or "legacy" topics must remain searchable.
  let positiveQuery = query;
  for (const {start, end} of maskedRanges) positiveQuery = positiveQuery.slice(0, start)
    + " ".repeat(end - start) + positiveQuery.slice(end);
  const positiveText = positiveQuery.toLowerCase();
  // Capitalized prose ("Find", "RPC") is not a named implementation. CamelCase,
  // acronym compounds and underscore keys can anchor local text candidates.
  const identifiers = [...new Set(hints.filter(hint => /[a-z][A-Z]|[A-Z]{2}[a-z]|[_$]/.test(hint)
    && positiveText.includes(hint.toLowerCase())))].slice(0, 8);
  if (!scopes.length && !identifiers.length && !browserTests) return [];
  const hits = new Map<string, Set<string>>();
  for (const identifier of identifiers) for (const hit of db.searchFileText(identifier, 64, true)) {
    const names = hits.get(hit.path) ?? new Set<string>();
    names.add(identifier); hits.set(hit.path, names);
  }
  const topics = new Set(searchTerms(positiveQuery).filter(term => !GENERIC.has(term)));
  const paths = files.map(file => ({ file: file.path, words: new Set(searchTerms(file.path)), depth: file.path.split("/").length }));
  const weights = new Map([...topics].map(term => [term,
    1 + Math.log(1 + files.length / (1 + paths.filter(path => path.words.has(term)).length)),
  ]));
  return paths.map(path => {
    const matched = [...topics].filter(term => path.words.has(term));
    const scoped = scopes.some(scope => path.file.startsWith(scope)) || (browserTests && /(?:^|\/)(?:e2e|browser|playwright)\/.*\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(path.file));
    const names = hits.get(path.file);
    // Require corroborating path topics for identifier hits. This avoids
    // injecting every unrelated occurrence of a common error or UI component.
    const score = (scoped ? 100 : 0) + matched.reduce((sum, term) => sum + weights.get(term)!, 0)
      + (names?.size ?? 0);
    return { file: path.file, terms: [...new Set([...matched, ...[...names ?? []].flatMap(searchTerms)])],
      score, depth: path.depth, eligible: (scoped || !!names?.size) && matched.length > 0 };
  }).filter(item => item.eligible)
    .sort((a,b) => b.score - a.score || a.depth - b.depth || a.file.localeCompare(b.file)).slice(0, 8)
    .map(({file,terms}) => ({file,terms}));
}
