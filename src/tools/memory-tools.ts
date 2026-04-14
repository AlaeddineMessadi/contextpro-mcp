// SQLite-backed memory tool wrappers with scope-aware task context retrieval
// FEATURE: Agent memory operations over project-scoped persistent storage

import { fetchEmbedding } from "../core/embeddings.js";
import { getDB, type MemoryNodeInput, type MemoryNodeRow, type TraversalResult } from "../core/db.js";
import { type ContextScope, loadProjectConfig } from "../core/project-config.js";
import {
  addInterlinkedContext as legacyAddInterlinkedContext,
  createRelation as legacyCreateRelation,
  getGraphStats as legacyGetGraphStats,
  retrieveWithTraversal as legacyRetrieveWithTraversal,
  upsertNode as legacyUpsertNode,
} from "../core/memory-graph.js";

export interface UpsertMemoryNodeOptions {
  rootDir: string;
  type: "concept" | "file" | "symbol" | "note";
  label: string;
  content: string;
  metadata?: Record<string, string>;
  scope?: ContextScope;
}

export interface CreateRelationOptions {
  rootDir: string;
  sourceId: string;
  targetId: string;
  relation: "relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains";
  weight?: number;
  metadata?: Record<string, string>;
}

export interface SearchMemoryGraphOptions {
  rootDir: string;
  query: string;
  maxDepth?: number;
  topK?: number;
  edgeFilter?: Array<"relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains">;
  scope?: ContextScope;
}

export interface PruneStaleLinksOptions {
  rootDir: string;
  threshold?: number;
}

export interface AddInterlinkedContextOptions {
  rootDir: string;
  items: Array<{ type: "concept" | "file" | "symbol" | "note"; label: string; content: string; metadata?: Record<string, string> }>;
  autoLink?: boolean;
  scope?: ContextScope;
}

export interface RetrieveWithTraversalOptions {
  rootDir: string;
  startNodeId: string;
  maxDepth?: number;
  edgeFilter?: Array<"relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains">;
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
  } catch {
    return {};
  }
}

function scopeForNode(node: MemoryNodeRow): ContextScope {
  const metadata = parseMetadata(node.metadata);
  const scope = metadata.scope;
  if (scope === "session" || scope === "project" || scope === "client" || scope === "global") return scope;
  return "project";
}

async function buildScopedMetadata(rootDir: string, metadata: Record<string, string> | undefined, scope: ContextScope | undefined): Promise<Record<string, string>> {
  const config = await loadProjectConfig(rootDir);
  return {
    ...(metadata ?? {}),
    scope: scope ?? metadata?.scope ?? "project",
    project_id: config?.projectId ?? "",
    client_id: config?.clientId ?? "",
    workspace_root: config?.workspaceRoot ?? rootDir,
    git_root: config?.gitRoot ?? rootDir,
    session_source: process.env.CONTEXTPLUS_SESSION_SOURCE ?? config?.sessionSource ?? "mcp",
    session_id: process.env.CONTEXTPLUS_SESSION_ID ?? "",
  };
}

async function scopeMatches(rootDir: string, node: MemoryNodeRow, requestedScope: ContextScope): Promise<boolean> {
  const config = await loadProjectConfig(rootDir);
  const metadata = parseMetadata(node.metadata);
  const nodeScope = scopeForNode(node);
  const currentProjectId = config?.projectId ?? "";
  const currentClientId = config?.clientId ?? "";
  const currentSessionId = process.env.CONTEXTPLUS_SESSION_ID ?? "";

  if (requestedScope === "global") return nodeScope === "global";
  if (requestedScope === "client") {
    return (nodeScope === "client" && metadata.client_id === currentClientId) || nodeScope === "global";
  }
  if (requestedScope === "session") {
    if (nodeScope !== "session") return false;
    if (currentSessionId.length === 0) return metadata.project_id === currentProjectId;
    return metadata.project_id === currentProjectId && metadata.session_id === currentSessionId;
  }
  return nodeScope === "project" && metadata.project_id === currentProjectId;
}

function formatTraversalResult(result: TraversalResult): string {
  const metadata = parseMetadata(result.node.metadata);
  return [
    `  [${result.node.type}] ${result.node.label} (depth: ${result.depth}, score: ${Math.round(result.relevanceScore * 1000) / 10})`,
    `    Content: ${result.node.content.slice(0, 120)}${result.node.content.length > 120 ? "..." : ""}`,
    result.pathRelations.length > 0 ? `    Path: ${result.pathRelations.join(" -> ")}` : "",
    `    Scope: ${metadata.scope ?? "project"} | ID: ${result.node.id} | Accessed: ${result.node.access_count}x`,
  ].filter(Boolean).join("\n");
}

export async function toolUpsertMemoryNode(options: UpsertMemoryNodeOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const metadata = await buildScopedMetadata(options.rootDir, options.metadata, options.scope);
  const [embedding] = await fetchEmbedding(`${options.label} ${options.content}`);
  const node = {
    type: options.type,
    label: options.label,
    content: options.content,
    metadata,
  } satisfies MemoryNodeInput;
  const id = db.upsertMemoryNode(node, embedding);
  const legacyNode = await legacyUpsertNode(options.rootDir, options.type, options.label, options.content, metadata);
  db.ensureGraphFresh();
  const stats = db.getGraphStats();
  return [
    `✅ Memory node upserted: ${options.label}`,
    `  ID: ${legacyNode.id} | DB: ${id}`,
    `  Type: ${options.type}`,
    `  Scope: ${metadata.scope}`,
    `\nGraph: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`,
  ].join("\n");
}

export async function toolCreateRelation(options: CreateRelationOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  let edgeId: string | null = null;
  try {
    edgeId = db.upsertMemoryEdge({
      source: options.sourceId,
      target: options.targetId,
      relation: options.relation,
      weight: options.weight,
      metadata: options.metadata,
    });
  } catch {}
  if (!edgeId) {
    const legacyEdge = await legacyCreateRelation(
      options.rootDir,
      options.sourceId,
      options.targetId,
      options.relation,
      options.weight,
      options.metadata,
    );
    if (!legacyEdge) return `❌ Failed: one or both node IDs not found (source: ${options.sourceId}, target: ${options.targetId})`;
    edgeId = legacyEdge.id;
  }
  db.ensureGraphFresh();
  const stats = db.getGraphStats();
  return [
    `✅ Relation created: ${options.sourceId} --[${options.relation}]--> ${options.targetId}`,
    `  Edge ID: ${edgeId}`,
    `  Weight: ${options.weight ?? 1}`,
    `\nGraph: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`,
  ].join("\n");
}

export async function toolSearchMemoryGraph(options: SearchMemoryGraphOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  db.ensureGraphFresh();
  const [queryVector] = await fetchEmbedding(options.query);
  const requestedScope = options.scope ?? "project";
  const directHits = db.searchMemoryNodes(queryVector, Math.max((options.topK ?? 5) * 8, 20));
  const filteredDirect: TraversalResult[] = [];

  for (const hit of directHits) {
    if (!(await scopeMatches(options.rootDir, hit.node, requestedScope))) continue;
    filteredDirect.push({
      node: hit.node,
      depth: 0,
      pathRelations: [],
      relevanceScore: Math.max(0, 1 - hit.distance),
    });
    if (filteredDirect.length >= (options.topK ?? 5)) break;
  }

  if (filteredDirect.length === 0) {
    const stats = db.getGraphStats();
    return `No memory nodes found for: "${options.query}"\nGraph has ${stats.totalNodes} nodes, ${stats.totalEdges} edges.`;
  }

  const neighborResults: TraversalResult[] = [];
  const seen = new Set(filteredDirect.map((result) => result.node.id));
  for (const hit of filteredDirect) {
    const traversed = db.getNeighbors(hit.node.id, options.maxDepth ?? 1, options.edgeFilter);
    for (const traversal of traversed) {
      if (seen.has(traversal.node.id)) continue;
      if (!(await scopeMatches(options.rootDir, traversal.node, requestedScope))) continue;
      seen.add(traversal.node.id);
      neighborResults.push(traversal);
    }
  }

  const sections: string[] = [
    `Memory Graph Search: "${options.query}"`,
    `Scope: ${requestedScope}`,
    `Graph: ${db.getGraphStats().totalNodes} nodes, ${db.getGraphStats().totalEdges} edges\n`,
    "Direct Matches:",
  ];
  for (const hit of filteredDirect) sections.push(formatTraversalResult(hit));
  if (neighborResults.length > 0) {
    sections.push("\nLinked Neighbors:");
    for (const result of neighborResults.slice(0, Math.max((options.topK ?? 5) * 2, 6))) {
      sections.push(formatTraversalResult(result));
    }
  }
  return sections.join("\n");
}

export async function toolPruneStaleLinks(options: PruneStaleLinksOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const result = db.pruneStaleEdges(options.threshold);
  return [
    `🧹 Pruning complete`,
    `  Removed: ${result.edgesRemoved} stale links and ${result.nodesRemoved} orphan nodes`,
    `  Remaining edges: ${db.getGraphStats().totalEdges}`,
  ].join("\n");
}

export async function toolAddInterlinkedContext(options: AddInterlinkedContextOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const nodes: Array<{ id: string; type: string; label: string }> = [];
  const createdVectors = new Map<string, number[]>();
  const metadataItems = await Promise.all(
    options.items.map((item) => buildScopedMetadata(options.rootDir, item.metadata, options.scope)),
  );

  for (let i = 0; i < options.items.length; i++) {
    const item = options.items[i];
    const [embedding] = await fetchEmbedding(`${item.label} ${item.content}`);
    const id = db.upsertMemoryNode({
      type: item.type,
      label: item.label,
      content: item.content,
      metadata: metadataItems[i],
    }, embedding);
    createdVectors.set(id, embedding);
    nodes.push({ id, type: item.type, label: item.label });
  }

  const edges: Array<{ source: string; target: string; relation: string; weight: number }> = [];
  if (options.autoLink !== false) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const similarity = cosine(createdVectors.get(nodes[i].id) ?? [], createdVectors.get(nodes[j].id) ?? []);
        if (similarity < 0.72) continue;
        db.upsertMemoryEdge({
          source: nodes[i].id,
          target: nodes[j].id,
          relation: "similar_to",
          weight: similarity,
        });
        edges.push({
          source: nodes[i].id,
          target: nodes[j].id,
          relation: "similar_to",
          weight: similarity,
        });
      }
    }
  }
  await legacyAddInterlinkedContext(options.rootDir, options.items, options.autoLink !== false);

  const sections = [
    `✅ Added ${nodes.length} interlinked nodes`,
    `  Scope: ${options.scope ?? "project"}`,
    edges.length > 0 ? `  Auto-linked: ${edges.length} similarity edges (threshold ≥ 0.72)` : "  No auto-links above threshold",
    "\nNodes:",
  ];
  for (const node of nodes) sections.push(`  [${node.type}] ${node.label} → ${node.id}`);
  if (edges.length > 0) {
    sections.push("\nEdges:");
    for (const edge of edges) {
      sections.push(`  ${edge.source} --[${edge.relation} w:${Math.round(edge.weight * 100) / 100}]--> ${edge.target}`);
    }
  }
  const stats = db.getGraphStats();
  sections.push(`\nGraph total: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`);
  return sections.join("\n");
}

export async function toolRetrieveWithTraversal(options: RetrieveWithTraversalOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  db.ensureGraphFresh();
  let results = db.getNeighbors(options.startNodeId, options.maxDepth ?? 2, options.edgeFilter);
  if (results.length === 0) {
    const legacyResults = await legacyRetrieveWithTraversal(options.rootDir, options.startNodeId, options.maxDepth ?? 2, options.edgeFilter);
    if (legacyResults.length === 0) return `❌ Node not found: ${options.startNodeId}`;
    return [
      `Traversal from: ${legacyResults[0].node.label} (depth limit: ${options.maxDepth ?? 2})\n`,
      ...legacyResults.map((result) => [
        `  [${result.node.type}] ${result.node.label} (depth: ${result.depth}, score: ${Math.round(result.relevanceScore * 1000) / 10})`,
        `    Content: ${result.node.content.slice(0, 120)}${result.node.content.length > 120 ? "..." : ""}`,
        result.pathRelations.length > 0 ? `    Path: ${result.pathRelations.join(" -> ")}` : "",
        `    ID: ${result.node.id} | Accessed: ${result.node.accessCount}x`,
      ].filter(Boolean).join("\n")),
    ].join("\n");
  }
  const sections = [`Traversal from: ${results[0].node.label} (depth limit: ${options.maxDepth ?? 2})\n`];
  for (const result of results) sections.push(formatTraversalResult(result));
  return sections.join("\n");
}
