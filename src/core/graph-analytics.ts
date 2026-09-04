// Deterministic graph analytics for agent-facing project navigation
// FEATURE: Weighted shortest paths, PageRank hotspots, and Louvain-style communities

import type { GraphConfidence, GraphEdgeType, ProjectGraph, ProjectGraphEdge, ProjectGraphNode } from "./project-graph.js";

export interface GraphPathAnalysis {
  kind: "path";
  status: "found" | "not_found" | "ambiguous" | "no_path";
  sourceSelector: string;
  targetSelector: string;
  sourceId?: string;
  targetId?: string;
  sourceCandidates?: string[];
  targetCandidates?: string[];
  hops?: number;
  totalCost?: number;
}

export interface GraphHotspotRanking {
  nodeId: string;
  score: number;
  pageRank: number;
  inDegree: number;
  outDegree: number;
}

export interface GraphHotspotAnalysis {
  kind: "hotspots";
  rankings: GraphHotspotRanking[];
}

export interface GraphCommunitySummary {
  id: string;
  label: string;
  size: number;
  cohesion: number;
  internalWeight: number;
  files: string[];
}

export interface GraphCommunityAnalysis {
  kind: "communities";
  communities: GraphCommunitySummary[];
}

export type ProjectGraphAnalysis = GraphPathAnalysis | GraphHotspotAnalysis | GraphCommunityAnalysis;

const CONFIDENCE_STRENGTH: Record<GraphConfidence, number> = {
  SCIP_RESOLVED: 1.3,
  LSP_RESOLVED: 1.2,
  AST_EXTRACTED: 1,
  HEURISTIC: 0.62,
  AMBIGUOUS: 0.3,
};

const EDGE_STRENGTH: Record<GraphEdgeType, number> = {
  contains: 0.12,
  defines: 0.7,
  imports: 1.2,
  calls: 1.35,
  references: 0.85,
  tests: 1.05,
  configures: 0.45,
  inherits: 1.15,
  implements: 1.15,
  route_handles: 0.9,
  co_changes_with: 0.55,
};

function edgeStrength(edge: ProjectGraphEdge): number {
  const repetitions = edge.type === "co_changes_with"
    ? Math.min(2, Math.log2(Number(edge.metadata?.commits ?? 1) + 1))
    : 1;
  return CONFIDENCE_STRENGTH[edge.confidence] * EDGE_STRENGTH[edge.type] * repetitions;
}

function displayNode(node: ProjectGraphNode): string {
  const location = node.path ? ` (${node.path}${node.lineStart ? `:L${node.lineStart}` : ""})` : "";
  return `${node.id} [${node.type}] ${node.label}${location}`;
}

export function resolveGraphNodeSelector(graph: ProjectGraph, selector: string): ProjectGraphNode[] {
  const exactId = graph.nodes.find((node) => node.id === selector);
  if (exactId) return [exactId];
  const exactPath = graph.nodes.filter((node) => node.path === selector);
  if (exactPath.length > 0) {
    const files = exactPath.filter((node) => ["file", "test", "config", "document"].includes(node.type));
    return files.length > 0 ? files : exactPath;
  }
  const exactLabel = graph.nodes.filter((node) => node.label === selector);
  if (exactLabel.length > 0) return exactLabel;
  const lower = selector.toLowerCase();
  return graph.nodes.filter((node) => node.label.toLowerCase() === lower || node.path?.toLowerCase() === lower);
}

interface HeapEntry {
  nodeId: string;
  hops: number;
  cost: number;
}

class MinHeap {
  private readonly values: HeapEntry[] = [];

  push(value: HeapEntry): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].cost <= value.cost) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): HeapEntry | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right].cost < this.values[left].cost ? right : left;
      if (this.values[child].cost >= last.cost) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

export function findWeightedShortestPath(
  graph: ProjectGraph,
  sourceSelector: string,
  targetSelector: string,
  maxHops: number = 8,
): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[]; analysis: GraphPathAnalysis } {
  const sources = resolveGraphNodeSelector(graph, sourceSelector);
  const targets = resolveGraphNodeSelector(graph, targetSelector);
  const base: GraphPathAnalysis = { kind: "path", status: "not_found", sourceSelector, targetSelector };
  if (sources.length !== 1 || targets.length !== 1) {
    return {
      nodes: [...sources, ...targets],
      edges: [],
      analysis: {
        ...base,
        status: sources.length > 1 || targets.length > 1 ? "ambiguous" : "not_found",
        sourceCandidates: sources.slice(0, 8).map(displayNode),
        targetCandidates: targets.slice(0, 8).map(displayNode),
      },
    };
  }

  const source = sources[0];
  const target = targets[0];
  if (source.id === target.id) {
    return {
      nodes: [source],
      edges: [],
      analysis: { ...base, status: "found", sourceId: source.id, targetId: target.id, hops: 0, totalCost: 0 },
    };
  }

  const allowHierarchy = [source.type, target.type].some((type) => type === "project" || type === "folder");
  const adjacency = new Map<string, Array<{ next: string; edge: ProjectGraphEdge; cost: number }>>();
  for (const edge of graph.edges) {
    if (!allowHierarchy && edge.type === "contains") continue;
    const cost = 1 / Math.max(0.05, edgeStrength(edge));
    const sourceList = adjacency.get(edge.source) ?? [];
    sourceList.push({ next: edge.target, edge, cost });
    adjacency.set(edge.source, sourceList);
    const targetList = adjacency.get(edge.target) ?? [];
    targetList.push({ next: edge.source, edge, cost });
    adjacency.set(edge.target, targetList);
  }

  // A constrained path cannot collapse all arrivals at a node into one distance:
  // a slightly costlier arrival with fewer hops remaining may be the only route to
  // the target. Keep Dijkstra state as (node, hops-used) instead.
  const stateKey = (nodeId: string, hops: number) => `${nodeId}\u0000${hops}`;
  const sourceState = stateKey(source.id, 0);
  const heap = new MinHeap();
  const distances = new Map<string, number>([[sourceState, 0]]);
  const previous = new Map<string, { stateKey: string; nodeId: string; edge: ProjectGraphEdge }>();
  heap.push({ nodeId: source.id, hops: 0, cost: 0 });
  let targetState: string | undefined;

  while (true) {
    const current = heap.pop();
    if (!current) break;
    const currentState = stateKey(current.nodeId, current.hops);
    if (current.cost !== distances.get(currentState)) continue;
    if (current.nodeId === target.id) {
      targetState = currentState;
      break;
    }
    if (current.hops >= maxHops) continue;
    for (const neighbor of adjacency.get(current.nodeId) ?? []) {
      const nextCost = current.cost + neighbor.cost;
      const nextHops = current.hops + 1;
      const nextState = stateKey(neighbor.next, nextHops);
      if (nextCost >= (distances.get(nextState) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(nextState, nextCost);
      previous.set(nextState, { stateKey: currentState, nodeId: current.nodeId, edge: neighbor.edge });
      heap.push({ nodeId: neighbor.next, hops: nextHops, cost: nextCost });
    }
  }

  if (!targetState) {
    return {
      nodes: [source, target],
      edges: [],
      analysis: { ...base, status: "no_path", sourceId: source.id, targetId: target.id },
    };
  }

  const pathNodeIds = [target.id];
  const pathEdges: ProjectGraphEdge[] = [];
  let cursorState = targetState;
  while (cursorState !== sourceState) {
    const step = previous.get(cursorState);
    if (!step) break;
    pathEdges.push(step.edge);
    cursorState = step.stateKey;
    pathNodeIds.push(step.nodeId);
  }
  pathNodeIds.reverse();
  pathEdges.reverse();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return {
    nodes: pathNodeIds.map((id) => nodeById.get(id)).filter((node): node is ProjectGraphNode => Boolean(node)),
    edges: pathEdges,
    analysis: {
      ...base,
      status: "found",
      sourceId: source.id,
      targetId: target.id,
      hops: pathEdges.length,
      totalCost: Number((distances.get(targetState) ?? 0).toFixed(3)),
    },
  };
}

export function rankGraphHotspots(graph: ProjectGraph, limit: number = 20): GraphHotspotRanking[] {
  // External package sinks naturally collect many imports but are rarely actionable edit
  // locations. Keep hotspots focused on repository-owned files, symbols, and routes.
  const eligible = graph.nodes.filter((node) => node.type !== "project" && node.type !== "folder" && node.type !== "package");
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const outgoing = new Map<string, Array<{ target: string; weight: number }>>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!eligibleIds.has(edge.source) || !eligibleIds.has(edge.target) || edge.type === "contains") continue;
    const weight = edgeStrength(edge);
    const list = outgoing.get(edge.source) ?? [];
    list.push({ target: edge.target, weight });
    outgoing.set(edge.source, list);
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  if (eligible.length === 0) return [];

  const damping = 0.85;
  let ranks = new Map(eligible.map((node) => [node.id, 1 / eligible.length] as const));
  for (let iteration = 0; iteration < 24; iteration++) {
    const next = new Map(eligible.map((node) => [node.id, (1 - damping) / eligible.length] as const));
    let dangling = 0;
    for (const node of eligible) {
      const links = outgoing.get(node.id) ?? [];
      const rank = ranks.get(node.id) ?? 0;
      const totalWeight = links.reduce((sum, link) => sum + link.weight, 0);
      if (totalWeight === 0) {
        dangling += rank;
        continue;
      }
      for (const link of links) {
        next.set(link.target, (next.get(link.target) ?? 0) + damping * rank * (link.weight / totalWeight));
      }
    }
    const danglingShare = damping * dangling / eligible.length;
    if (danglingShare > 0) for (const node of eligible) next.set(node.id, (next.get(node.id) ?? 0) + danglingShare);
    ranks = next;
  }

  const maxRank = Math.max(...ranks.values(), 1 / eligible.length);
  const maxDegree = Math.max(...eligible.map((node) => (inDegree.get(node.id) ?? 0) + (outDegree.get(node.id) ?? 0)), 1);
  return eligible
    .map((node) => {
      const pageRank = ranks.get(node.id) ?? 0;
      const degree = (inDegree.get(node.id) ?? 0) + (outDegree.get(node.id) ?? 0);
      return {
        nodeId: node.id,
        score: Number((100 * (0.72 * pageRank / maxRank + 0.28 * degree / maxDegree)).toFixed(2)),
        pageRank: Number(pageRank.toFixed(6)),
        inDegree: inDegree.get(node.id) ?? 0,
        outDegree: outDegree.get(node.id) ?? 0,
      };
    })
    .sort((left, right) => right.score - left.score || right.inDegree - left.inDegree || left.nodeId.localeCompare(right.nodeId))
    .slice(0, Math.max(1, limit));
}

function communityLabel(files: string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      if (["src", "app", "lib", "packages", "test", "tests"].includes(prefix)) continue;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].split("/").length - left[0].split("/").length || left[0].localeCompare(right[0]))[0];
  return best?.[0] ?? fallback;
}

export function detectGraphCommunities(graph: ProjectGraph, limit: number = 20): GraphCommunitySummary[] {
  const fileNodes = graph.nodes.filter((node) => ["file", "test", "config", "document"].includes(node.type) && node.path);
  const fileIds = new Set(fileNodes.map((node) => node.id));
  const fileIdByPath = new Map(fileNodes.map((node) => [node.path!, node.id] as const));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const owningFile = (nodeId: string): string | undefined => {
    if (fileIds.has(nodeId)) return nodeId;
    const node = nodeById.get(nodeId);
    return node?.path ? fileIdByPath.get(node.path) : undefined;
  };
  const adjacency = new Map<string, Map<string, number>>(fileNodes.map((node) => [node.id, new Map()]));
  for (const edge of graph.edges) {
    if (edge.type === "contains" || edge.type === "defines" || edge.type === "configures") continue;
    const source = owningFile(edge.source);
    const target = owningFile(edge.target);
    if (!source || !target || source === target) continue;
    const weight = edgeStrength(edge);
    adjacency.get(source)!.set(target, (adjacency.get(source)!.get(target) ?? 0) + weight);
    adjacency.get(target)!.set(source, (adjacency.get(target)!.get(source) ?? 0) + weight);
  }

  const degrees = new Map<string, number>();
  for (const [nodeId, neighbors] of adjacency) degrees.set(nodeId, [...neighbors.values()].reduce((sum, weight) => sum + weight, 0));
  const totalWeight2 = [...degrees.values()].reduce((sum, weight) => sum + weight, 0);
  const assignment = new Map(fileNodes.map((node) => [node.id, node.id] as const));
  const communityTotals = new Map(degrees);
  const order = fileNodes.map((node) => node.id).sort((left, right) => (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0) || left.localeCompare(right));

  if (totalWeight2 > 0) {
    for (let iteration = 0; iteration < 20; iteration++) {
      let moved = false;
      for (const nodeId of order) {
        const degree = degrees.get(nodeId) ?? 0;
        if (degree === 0) continue;
        const current = assignment.get(nodeId)!;
        communityTotals.set(current, (communityTotals.get(current) ?? 0) - degree);
        const weightsByCommunity = new Map<string, number>();
        for (const [neighbor, weight] of adjacency.get(nodeId) ?? []) {
          const community = assignment.get(neighbor)!;
          weightsByCommunity.set(community, (weightsByCommunity.get(community) ?? 0) + weight);
        }
        let best = current;
        let bestGain = (weightsByCommunity.get(current) ?? 0) - ((communityTotals.get(current) ?? 0) * degree / totalWeight2);
        for (const [community, internalWeight] of weightsByCommunity) {
          const gain = internalWeight - ((communityTotals.get(community) ?? 0) * degree / totalWeight2);
          if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && community < best)) {
            best = community;
            bestGain = gain;
          }
        }
        assignment.set(nodeId, best);
        communityTotals.set(best, (communityTotals.get(best) ?? 0) + degree);
        if (best !== current) moved = true;
      }
      if (!moved) break;
    }
  }

  const groups = new Map<string, string[]>();
  for (const nodeId of order) {
    const community = assignment.get(nodeId)!;
    const members = groups.get(community) ?? [];
    members.push(nodeId);
    groups.set(community, members);
  }
  const fileById = new Map(fileNodes.map((node) => [node.id, node.path!] as const));
  const communities = [...groups.values()]
    .map((members, index) => {
      const memberSet = new Set(members);
      let internalWeight2 = 0;
      let incidentWeight = 0;
      for (const member of members) {
        for (const [neighbor, weight] of adjacency.get(member) ?? []) {
          incidentWeight += weight;
          if (memberSet.has(neighbor)) internalWeight2 += weight;
        }
      }
      const files = members.map((id) => fileById.get(id)!).sort();
      const internalWeight = internalWeight2 / 2;
      return {
        id: `community:${index + 1}`,
        label: communityLabel(files, `community-${index + 1}`),
        size: files.length,
        cohesion: Number((incidentWeight > 0 ? internalWeight2 / incidentWeight : 1).toFixed(3)),
        internalWeight: Number(internalWeight.toFixed(3)),
        files,
      };
    })
    .sort((left, right) => right.size - left.size || right.cohesion - left.cohesion || left.label.localeCompare(right.label))
    .slice(0, Math.max(1, limit));
  const labelTotals = new Map<string, number>();
  for (const community of communities) labelTotals.set(community.label, (labelTotals.get(community.label) ?? 0) + 1);
  const labelCounts = new Map<string, number>();
  return communities.map((community) => {
    if ((labelTotals.get(community.label) ?? 0) <= 1) return community;
    const ordinal = (labelCounts.get(community.label) ?? 0) + 1;
    labelCounts.set(community.label, ordinal);
    return { ...community, label: `${community.label} · ${ordinal}` };
  });
}
