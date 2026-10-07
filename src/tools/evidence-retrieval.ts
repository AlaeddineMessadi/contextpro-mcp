// Shared, bounded candidate assembly. Relations here are indexed heuristics,
// never compiler-resolved references. Source selection happens in context.ts.
import { getDB } from "../core/db.js";
import { basename, dirname } from "node:path";
import { searchTerms, withQueryEmbeddingCache } from "../core/embeddings.js";
import { unifiedSearchData, extractIdentifierHints, type UnifiedSearchOptions } from "./search.js";
import { discoveryPathWeight, facetPathWeight, mentionedFiles, queryLiterals } from "./discovery-hints.js";
import { findTestsForFiles, isTestFile } from "./retrieval-helpers.js";
import { maybeChatRerankPlanningFiles } from "./planning-helpers.js";

export type EvidenceRole = "implementation" | "dependency" | "caller" | "test";
export interface EvidenceCandidate {
  path: string; score: number; reason: string; symbols: string[];
  roles: EvidenceRole[]; anchors: number[];
  /** Absolute similarity, never a rank-derived confidence. */
  semanticScore?: number;
}
export const connectedRetrievalEnabled = (): boolean => process.env.CONTEXTPRO_CONNECTED_CONTEXT === "true";

export async function retrieveEvidence(options: {
  rootDir: string; query: string; graphHops?: 0 | 1 | 2; graphMaxFiles?: number;
  includeTests?: boolean; preset?: UnifiedSearchOptions["preset"];
}) {
  return withQueryEmbeddingCache(async () => {
    const { rootDir, query } = options;
    const search = await unifiedSearchData({ rootDir, query, mode: "hybrid", topK: 24,
      preset: options.preset ?? "balanced", fusion: "rrf", inlineCode: "off", expandCallers: false, persistArtifact: false });
    const db = await getDB(rootDir), files = db.getAllFiles();
    const byId = new Map(files.map(file => [file.id, file.path]));
    const pool = new Map<string, EvidenceCandidate>();
    const facetOwners = new Set<string>();
    const topicOwners = new Set<string>();
    let weakSemanticMatches = 0;
    const add = (path: string, rank: number, lane: string, role: EvidenceRole = "implementation", anchor?: number, symbols: string[] = []) => {
      if (isTestFile(path)) role = "test";
      const prior = discoveryPathWeight(query, path, lane === "named definition");
      // Graph links are evidence in their own right, including tests that do not
      // repeat the query words. Lexical decoys still receive the normal penalty.
      const weight = lane.startsWith("graph:") || lane === "test association" ? 1 : prior;
      const item = pool.get(path) ?? { path, score: 0, reason: "", symbols: [], roles: [], anchors: [] };
      // RRF contributes once per file per lane. Ten identifiers in one test
      // file are not ten independent retrieval signals for that file.
      if (!item.reason.split("; ").includes(lane)) item.score += weight / (60 + rank + 1);
      item.reason = [...new Set([...item.reason.split("; ").filter(Boolean), lane])].join("; ");
      if (!item.roles.includes(role)) item.roles.push(role);
      if (anchor && !item.anchors.includes(anchor)) item.anchors.push(anchor);
      item.symbols = [...new Set([...item.symbols, ...symbols])];
      pool.set(path, item);
    };
    // Rank fusion must not turn weak, zero-overlap neighbors into graph seeds.
    // Match the existing search caller-expansion floor (40/100 cosine score).
    // This is a conservative retrieval heuristic, not a calibrated probability.
    const supported = (item: { keywordScore: number; semanticScore: number }) => {
      const accepted = item.keywordScore > 0 || item.semanticScore > 40;
      if (!accepted && item.semanticScore > 0) weakSemanticMatches++;
      return accepted;
    };
    (search.files?.results ?? []).forEach((file, rank) => {
      if (!supported(file)) return;
      add(file.path, rank, "file retrieval", "implementation", undefined, file.matchedSymbols);
      pool.get(file.path)!.semanticScore = file.semanticScore;
    });
    (search.identifiers?.results ?? []).forEach((symbol, rank) => {
      if (!supported(symbol)) return;
      add(symbol.path, rank, "symbol retrieval", "implementation", undefined, [symbol.name]);
      const item = pool.get(symbol.path)!;
      item.semanticScore = Math.max(item.semanticScore ?? 0, symbol.semanticScore);
    });
    const terms = new Set(searchTerms(query));
    if (options.preset !== "semantic_only") {
      db.searchFileText(query, 32).forEach((file, rank) => add(file.path, rank, "source text"));
      for (const literal of queryLiterals(query).slice(0, 8)) db.searchFileText(literal, 8, true).forEach((file, rank) => add(file.path, rank, "literal"));
      // A broad OR query can fill every slot with one popular topic. Give each
      // concrete query term its own small lane before truncating the union.
      const generic = new Set(["find", "where", "implementation", "function", "code", "file", "files", "explain", "logic", "checks", "check", "system", "does", "which", "existing", "relevant", "include", "only", "all", "any", "remaining", "identify", "paths", "path", "across", "locate", "source"]);
      for (const term of [...terms].filter(term => term.length >= 3 && !generic.has(term)).slice(0, 24)) {
        const hits = db.searchFileText(term, 64).sort((a, b) => facetPathWeight(query, term, b.path) - facetPathWeight(query, term, a.path) || a.score - b.score || a.path.localeCompare(b.path));
        hits.slice(0, 2).forEach((hit, rank) => add(hit.path, rank, `facet:${term}`));
        if (hits[0]) facetOwners.add(hits[0].path);
      }
      mentionedFiles(rootDir, query, files).slice(0, 8).forEach((file, rank) => add(file, rank, "explicit path"));
      files.map(file => ({ path: file.path, hits: searchTerms(file.path).filter(term => terms.has(term)).length }))
        .filter(file => file.hits > 0).sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path)).slice(0, 16)
        .forEach((file, rank) => add(file.path, rank, "path terms"));
      // A basename carrying several concrete query topics is stronger than a
      // ubiquitous directory token (tests, web, native). Keep those modules in
      // the union even when unrelated single-term facets have many matches.
      const topics = new Set([...terms].filter(term => !generic.has(term) && !["tests", "test", "web", "native", "server", "api"].includes(term)));
      files.map(file => ({ path: file.path, hits: new Set(searchTerms(basename(file.path)).filter(term => topics.has(term))).size }))
        .filter(file => file.hits >= 2).sort((a, b) => b.hits - a.hits || (pool.get(b.path)?.score ?? 0) - (pool.get(a.path)?.score ?? 0) || a.path.localeCompare(b.path)).slice(0, 8)
        .forEach((file, rank) => { add(file.path, rank, "path topics"); topicOwners.add(file.path); });
      for (const hint of extractIdentifierHints(query).slice(0, 16)) {
        for (const symbol of db.searchSymbolsByName(hint).filter(symbol => symbol.name === hint).slice(0, 8)) {
          const path = byId.get(symbol.file_id);
          if (path && discoveryPathWeight(query, path, true) >= 1) add(path, 0, "named definition", "implementation", symbol.line_start, [hint]);
        }
      }
    }
    const ranked = () => [...pool.values()].sort((a, b) => Number(b.reason.includes("named definition")) - Number(a.reason.includes("named definition")) || b.score - a.score || a.path.localeCompare(b.path));
    // Four seeds leave space for connected evidence instead of saturating all
    // slots with repetitive hits before graph expansion starts.
    const seedPool = ranked().filter(item => !isTestFile(item.path));
    const seeds: EvidenceCandidate[] = [], coveredFacets = new Set<string>();
    while (seeds.length < 4 && seedPool.length) {
      const facets = (item: EvidenceCandidate) => item.reason.split("; ").filter(reason => reason.startsWith("facet:"));
      seedPool.sort((a, b) => (facets(b).filter(term => !coveredFacets.has(term)).length - facets(a).filter(term => !coveredFacets.has(term)).length) || b.score - a.score || a.path.localeCompare(b.path));
      const seed = seedPool.shift()!; seeds.push(seed); facets(seed).forEach(term => coveredFacets.add(term));
    }
    const graphLimit = Math.min(16, Math.max(0, options.graphMaxFiles ?? 8));
    const linked = new Set<string>(), visited = new Set(seeds.map(item => item.path));
    // Broad multi-topic questions need a hop from each represented facet, not
    // just the first four globally popular files. Visit edges round-robin so a
    // large import hub cannot spend the entire expansion budget on its own.
    let frontier = [...new Map([...seeds, ...ranked().filter(item => facetOwners.has(item.path) && !isTestFile(item.path))].map(item => [item.path, item])).values()].slice(0, 16);
    for (const item of frontier) visited.add(item.path);
    for (let depth = 0; depth < (options.graphHops ?? 1) && frontier.length && linked.size < graphLimit; depth++) {
      const next: EvidenceCandidate[] = [];
      const queues = frontier.map(seed => {
        const file = db.getFile(seed.path);
        if (!file) return [];
        const edges = [
          ...db.getImportsFrom(file.id).map(edge => ({ path: edge.target_file_id ? byId.get(edge.target_file_id) : undefined, role: "dependency" as EvidenceRole, reason: `graph: imported by ${seed.path}` })),
          ...db.getImportersOf(file.id).map(edge => ({ path: byId.get(edge.source_file_id), role: "caller" as EvidenceRole, reason: `graph: imports ${seed.path}` })),
        ];
        // Name-only call links may be ambiguous. Retrieve their source files,
        // but do not infer binding identity from them.
        for (const symbol of seed.symbols.slice(0, 4)) for (const call of db.getCallersOf(symbol).slice(0, 12)) {
          edges.push({ path: byId.get(call.file_id), role: "caller", reason: `graph: textual caller of ${symbol} (ambiguous binding)` });
        }
        edges.sort((a, b) => {
          const score = (edge: typeof a) => edge.path ?
            (edge.role === "dependency" ? 1 : 0) + (dirname(edge.path) === dirname(seed.path) ? 2 : 0)
            + Math.min(4, searchTerms(edge.path).filter(term => terms.has(term)).length) * .2 : -1;
          return score(b) - score(a) || (a.path ?? "").localeCompare(b.path ?? "");
        });
        return edges.filter(edge => edge.path && edge.path !== seed.path);
      });
      while (queues.some(queue => queue.length) && linked.size < graphLimit) for (const queue of queues) {
        while (queue.length) {
          const edge = queue.shift()!;
          if (!edge.path) continue;
          const role = isTestFile(edge.path) ? "test" : edge.role;
          if (visited.has(edge.path)) {
            // Existing seeds/previous-hop paths may gain a role, but consume no
            // expansion slot and must not be queued or score-boosted again.
            const existing = pool.get(edge.path);
            if (existing) {
              if (!existing.roles.includes(role)) existing.roles.push(role);
              existing.reason = [...new Set([...existing.reason.split("; "), edge.reason, "indexed heuristic"])].join("; ");
            }
            continue;
          }
          if (!linked.has(edge.path) && linked.size >= graphLimit) break;
          add(edge.path, depth, edge.reason + "; indexed heuristic", role);
          linked.add(edge.path);
          visited.add(edge.path); next.push(pool.get(edge.path)!);
          break;
        }
      }
      frontier = next;
    }
    const tests = options.includeTests === false ? [] : (await findTestsForFiles(rootDir, seeds.map(seed => seed.path))).slice(0, 4);
    tests.forEach((test, rank) => add(test.path, rank, "test association", "test"));
    const order = ranked();
    // Reserve at most 4 seeds + 16 graph files + 4 associated tests first.
    // Facet/topic owners share the remaining slots; an oversized owner union
    // must not silently evict the connected evidence we already budgeted for.
    const selected = new Set([...seeds.map(seed => seed.path), ...linked, ...tests.map(test => test.path)]);
    const owners = order.filter(item => facetOwners.has(item.path) || topicOwners.has(item.path));
    for (const item of [...owners, ...order]) {
      if (selected.size >= 32) break;
      selected.add(item.path);
    }
    let candidates = order.filter(item => selected.has(item.path));
    const reordered = await maybeChatRerankPlanningFiles(rootDir, query, candidates);
    const map = new Map(candidates.map(item => [item.path, item]));
    candidates = reordered.map(item => ({ ...map.get(item.path)!, score: item.score, reason: item.reason }));
    return { search, candidates, tests, limited: pool.size > 32,
      relevanceNotice: weakSemanticMatches ? "Weak semantic-only neighbors omitted before graph expansion; no lexical match or sufficient absolute similarity. Use exact targets if scope is known." : undefined,
      relationNotice: candidates.some(item => item.reason.includes("graph:")) ? "Connected paths use indexed import/test and name-only call heuristics; verify bindings with exact_references." : undefined };
  });
}
