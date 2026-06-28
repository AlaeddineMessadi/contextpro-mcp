// PageRank over the file import graph — transitive importance for ranking.
//
// FEATURE: Local degree counts ("how many files import me") miss transitive
// importance: a file imported by a few *important* files matters more than one
// imported by many leaf files. PageRank captures that — it's the algorithm behind
// Aider's repo map. We run it over the import graph (edge source→target means
// "source imports target", so rank flows toward heavily-depended-on modules) and
// support a personalization vector so a query/target subtree pulls rank toward it.
//
// Pure and dependency-free (no DB, no graph lib) so it stays unit-testable.

export interface PageRankOptions {
  /** Damping factor (probability of following an edge). Standard 0.85. */
  damping?: number;
  /** Max power-iterations before giving up. */
  maxIterations?: number;
  /** L1 convergence threshold across one iteration. */
  tolerance?: number;
  /**
   * Nodes to bias rank toward (the "teleport" set). When provided, random jumps
   * land only on these nodes instead of uniformly — pulling rank into the subtree
   * the agent cares about (e.g. files under a target path).
   */
  personalization?: Set<string>;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TOLERANCE = 1e-6;

/**
 * Compute PageRank for `nodes` given directed `edges` ([from, to]).
 *
 * Returns a map node → rank, with ranks summing to ~1. Edges referencing nodes
 * not in `nodes` are ignored. Dangling nodes (no out-edges) redistribute their
 * mass uniformly across the teleport set, so the total stays normalized.
 */
export function computePageRank(
  nodes: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
  options: PageRankOptions = {},
): Map<string, number> {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

  const n = nodes.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node, i));

  // Build adjacency (only edges whose endpoints both exist).
  const outLinks: number[][] = Array.from({ length: n }, () => []);
  for (const [from, to] of edges) {
    const fromIdx = index.get(from);
    const toIdx = index.get(to);
    if (fromIdx === undefined || toIdx === undefined) continue;
    outLinks[fromIdx].push(toIdx);
  }

  // Teleport distribution: uniform, or restricted to the personalization set.
  const teleport = new Float64Array(n);
  const personalIdx = options.personalization
    ? [...options.personalization].map((node) => index.get(node)).filter((i): i is number => i !== undefined)
    : [];
  if (personalIdx.length > 0) {
    const share = 1 / personalIdx.length;
    for (const i of personalIdx) teleport[i] = share;
  } else {
    teleport.fill(1 / n);
  }

  let rank = new Float64Array(n).fill(1 / n);

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n);

    // Mass from dangling nodes (no out-edges) is redistributed via the teleport
    // distribution so rank is conserved.
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outLinks[i].length === 0) danglingMass += rank[i];
    }

    for (let i = 0; i < n; i++) {
      // Teleport component + redistributed dangling mass.
      next[i] = (1 - damping) * teleport[i] + damping * danglingMass * teleport[i];
    }

    for (let i = 0; i < n; i++) {
      const links = outLinks[i];
      if (links.length === 0) continue;
      const contribution = (damping * rank[i]) / links.length;
      for (const j of links) next[j] += contribution;
    }

    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i]);
    rank = next;
    if (delta < tolerance) break;
  }

  nodes.forEach((node, i) => ranks.set(node, rank[i]));
  return ranks;
}
