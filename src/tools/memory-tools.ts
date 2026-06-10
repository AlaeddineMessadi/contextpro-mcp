// SQLite-backed memory tool wrappers with scope-aware task context retrieval
// FEATURE: Agent memory operations over project-scoped persistent storage

import { fetchEmbedding } from "../core/embeddings.js";
import { createMemoryEdgeId, createMemoryNodeId } from "../core/memory-graph.js";
import { getDB, type MemoryNodeInput, type MemoryNodeRow, type TraversalResult } from "../core/db.js";
import { type ContextScope, loadProjectConfig } from "../core/project-config.js";

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
  relation: "relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains" | "resolved_by" | "contradicts";
  weight?: number;
  metadata?: Record<string, string>;
}

export interface SearchMemoryGraphOptions {
  rootDir: string;
  query: string;
  maxDepth?: number;
  topK?: number;
  edgeFilter?: Array<"relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains" | "resolved_by" | "contradicts">;
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
  edgeFilter?: Array<"relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains" | "resolved_by" | "contradicts">;
}

export interface ListMemoryNodesOptions {
  rootDir: string;
  scope?: ContextScope;
  kind?: string;
  limit?: number;
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

interface ResolvedProjectConfig {
  projectId: string;
  clientId: string;
  sessionId: string;
}

async function resolveProjectConfig(rootDir: string): Promise<ResolvedProjectConfig> {
  const config = await loadProjectConfig(rootDir);
  return {
    projectId: config?.projectId ?? "",
    clientId: config?.clientId ?? "",
    sessionId: process.env.CONTEXTPLUS_SESSION_ID ?? "",
  };
}

function scopeMatchesSync(node: MemoryNodeRow, requestedScope: ContextScope, resolved: ResolvedProjectConfig): boolean {
  const metadata = parseMetadata(node.metadata);
  const nodeScope = scopeForNode(node);
  const { projectId, clientId, sessionId } = resolved;

  if (requestedScope === "global") return nodeScope === "global";
  if (requestedScope === "client") {
    return (nodeScope === "client" && metadata.client_id === clientId) || nodeScope === "global";
  }
  if (requestedScope === "session") {
    if (nodeScope !== "session") return false;
    if (sessionId.length === 0) return metadata.project_id === projectId;
    return metadata.project_id === projectId && metadata.session_id === sessionId;
  }
  return nodeScope === "project" && metadata.project_id === projectId;
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
  let embedding: number[] = [];
  try {
    [embedding] = await fetchEmbedding(`${options.label} ${options.content}`);
  } catch {
    // Embedding provider unavailable — store without vector; keyword search still works.
  }
  const node = {
    id: createMemoryNodeId(),
    type: options.type,
    label: options.label,
    content: options.content,
    metadata,
  } satisfies MemoryNodeInput;
  const id = db.upsertMemoryNode(node, embedding);
  db.ensureGraphFresh();
  const stats = db.getGraphStats();
  return [
    `✅ Memory node upserted: ${options.label}`,
    `  ID: ${id}`,
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
      id: createMemoryEdgeId(),
      source: options.sourceId,
      target: options.targetId,
      relation: options.relation,
      weight: options.weight,
      metadata: options.metadata,
    });
  } catch {}
  if (!edgeId) {
    return `❌ Failed: one or both node IDs not found (source: ${options.sourceId}, target: ${options.targetId})`;
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
  db.pruneStaleEdges();
  let queryVector: number[] = [];
  try {
    [queryVector] = await fetchEmbedding(options.query);
  } catch {
    // Embedding provider unavailable — fall back to returning empty results.
  }
  const requestedScope = options.scope ?? "project";
  const resolved = await resolveProjectConfig(options.rootDir);
  const directHits = db.searchMemoryNodes(queryVector, Math.max((options.topK ?? 5) * 8, 20));
  const filteredDirect: TraversalResult[] = [];

  for (const hit of directHits) {
    if (!scopeMatchesSync(hit.node, requestedScope, resolved)) continue;
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
      if (!scopeMatchesSync(traversal.node, requestedScope, resolved)) continue;
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
    let embedding: number[] = [];
    try {
      [embedding] = await fetchEmbedding(`${item.label} ${item.content}`);
    } catch {
      // Embedding provider unavailable — store without vector; keyword search still works.
    }
    const id = db.upsertMemoryNode({
      id: createMemoryNodeId(),
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
          id: createMemoryEdgeId(),
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

export interface DeleteMemoryNodeOptions {
  rootDir: string;
  nodeId: string;
}

export async function toolDeleteMemoryNode(options: DeleteMemoryNodeOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const node = db.getMemoryNode(options.nodeId);
  if (!node) return `❌ Node not found: ${options.nodeId}`;
  const label = node.label;
  db.deleteMemoryNode(options.nodeId);
  db.ensureGraphFresh();
  const stats = db.getGraphStats();
  return [
    `🗑️ Memory node deleted: ${label}`,
    `  ID: ${options.nodeId}`,
    `\nGraph: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`,
  ].join("\n");
}

export async function toolRetrieveWithTraversal(options: RetrieveWithTraversalOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  db.ensureGraphFresh();
  db.pruneStaleEdges();
  const results = db.getNeighbors(options.startNodeId, options.maxDepth ?? 2, options.edgeFilter);
  if (results.length === 0) return `❌ Node not found: ${options.startNodeId}`;
  const sections = [`Traversal from: ${results[0].node.label} (depth limit: ${options.maxDepth ?? 2})\n`];
  for (const result of results) sections.push(formatTraversalResult(result));
  return sections.join("\n");
}

export async function toolListMemoryNodes(options: ListMemoryNodesOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const resolved = await resolveProjectConfig(options.rootDir);
  const requestedScope = options.scope ?? "project";
  const limit = Math.min(options.limit ?? 20, 100);

  const all = db.listMemoryNodes();
  const filtered = all.filter((node) => {
    if (!scopeMatchesSync(node, requestedScope, resolved)) return false;
    if (options.kind) {
      const metadata = parseMetadata(node.metadata);
      const recordKind = metadata.record_kind ?? node.type;
      if (recordKind !== options.kind && node.type !== options.kind) return false;
    }
    return true;
  }).slice(0, limit);

  if (filtered.length === 0) {
    return `No memory nodes found (scope: ${requestedScope}${options.kind ? `, kind: ${options.kind}` : ""}).`;
  }

  const stats = db.getGraphStats();
  const lines = [
    `Memory Nodes (${filtered.length} of ${all.length} total | scope: ${requestedScope}${options.kind ? ` | kind: ${options.kind}` : ""})`,
    `Graph: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`,
    "",
  ];
  for (const node of filtered) {
    const metadata = parseMetadata(node.metadata);
    const recordKind = metadata.record_kind ?? node.type;
    const age = Math.round((Date.now() - node.created_at) / (1000 * 60 * 60 * 24));
    lines.push(`  [${recordKind}] ${node.label}`);
    lines.push(`    ID: ${node.id} | Accessed: ${node.access_count}x | Age: ${age}d`);
    lines.push(`    ${node.content.slice(0, 100)}${node.content.length > 100 ? "..." : ""}`);
  }
  return lines.join("\n");
}
