// Compatibility adapter for legacy memory graph tests and callers
// FEATURE: Memory graph compatibility over SQLite-backed project storage

import { fetchEmbedding, embedMemoryText, hasCompatibleEmbeddingModel, currentEmbeddingModel } from "./embeddings.js";
import { getDB, type MemoryEdgeRow, type MemoryNodeInput, type MemoryNodeRow } from "./db.js";

type MemoryType = "concept" | "file" | "symbol" | "note";
type MemoryRelation = "relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains" | "resolved_by" | "contradicts";

export interface LegacyMemoryNode {
  id: string;
  type: string;
  label: string;
  content: string;
  metadata: Record<string, string>;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  embedding: number[];
}

export interface LegacyMemoryEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
  createdAt: number;
  metadata: Record<string, string>;
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

function createMemoryId(prefix: "mn" | "me"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryNodeId(): string {
  return createMemoryId("mn");
}

export function createMemoryEdgeId(): string {
  return createMemoryId("me");
}

function legacyNode(row: MemoryNodeRow, embedding: number[] = []): LegacyMemoryNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    content: row.content,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    embedding,
  };
}

function legacyEdge(row: MemoryEdgeRow): LegacyMemoryEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    relation: row.relation,
    weight: row.weight,
    createdAt: row.created_at,
    metadata: parseMetadata(row.metadata),
  };
}

async function embedText(text: string): Promise<number[]> {
  try {
    const [embedding] = await fetchEmbedding(text);
    return embedding;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[contextpro/memory-graph] degraded: embedText failed (${message}); node will have no embedding\n`);
    return [];
  }
}

export async function upsertNode(
  rootDir: string,
  type: MemoryType,
  label: string,
  content: string,
  metadata?: Record<string, string>,
): Promise<LegacyMemoryNode> {
  const db = await getDB(rootDir);
  const embedding = await embedMemoryText(db, `${label} ${content}`).catch(() => []);
  const input = { id: createMemoryNodeId(), type, label, content, metadata } satisfies MemoryNodeInput;
  const id = db.upsertMemoryNode(input, embedding, currentEmbeddingModel());
  const node = db.peekMemoryNode(id);
  if (!node) throw new Error(`Memory node was not created: ${label}`);
  return legacyNode(node, embedding);
}

export async function createRelation(
  rootDir: string,
  source: string,
  target: string,
  relation: MemoryRelation,
  weight: number = 1,
  metadata?: Record<string, string>,
): Promise<LegacyMemoryEdge | null> {
  const db = await getDB(rootDir);
  if (!db.peekMemoryNode(source) || !db.peekMemoryNode(target)) return null;
  const id = db.upsertMemoryEdge({
    id: createMemoryEdgeId(),
    source,
    target,
    relation,
    weight,
    metadata,
  });
  return legacyEdge(db.getMemoryEdgesForNode(source).find((edge) => edge.id === id)!);
}

export async function searchGraph(rootDir: string, query: string, maxDepth: number = 1, topK: number = 5) {
  const db = await getDB(rootDir);
  const queryVector = hasCompatibleEmbeddingModel(db) ? await embedText(query) : [];
  const direct = queryVector.length > 0 && hasCompatibleEmbeddingModel(db)
    ? db.searchMemoryNodes(queryVector, topK).map((hit) => ({
      node: legacyNode(hit.node),
      distance: hit.distance,
      relevanceScore: Math.max(0, 1 - hit.distance),
    }))
    : [];
  const neighbors = direct.flatMap((hit) =>
    db.getNeighbors(hit.node.id, maxDepth).slice(1).map((result) => ({
      node: legacyNode(result.node),
      depth: result.depth,
      pathRelations: result.pathRelations,
      relevanceScore: result.relevanceScore,
    })),
  );
  const stats = db.getGraphStats();
  return { direct, neighbors, totalNodes: stats.totalNodes, totalEdges: stats.totalEdges };
}

export async function pruneStaleLinks(rootDir: string, threshold?: number): Promise<{ removed: number; remaining: number }> {
  const db = await getDB(rootDir);
  const result = db.pruneStaleEdges(threshold);
  return { removed: result.edgesRemoved + result.nodesRemoved, remaining: db.getGraphStats().totalEdges };
}

export async function addInterlinkedContext(
  rootDir: string,
  items: Array<{ type: MemoryType; label: string; content: string; metadata?: Record<string, string> }>,
  autoLink: boolean = true,
): Promise<{ nodes: LegacyMemoryNode[]; edges: LegacyMemoryEdge[] }> {
  const nodes: LegacyMemoryNode[] = [];
  const edges: LegacyMemoryEdge[] = [];
  for (const item of items) {
    nodes.push(await upsertNode(rootDir, item.type, item.label, item.content, item.metadata));
  }
  if (autoLink) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const edge = await createRelation(rootDir, nodes[i].id, nodes[j].id, "similar_to", 0.75);
        if (edge) edges.push(edge);
      }
    }
  }
  return { nodes, edges };
}

export async function retrieveWithTraversal(rootDir: string, startNodeId: string, maxDepth: number = 2, edgeFilter?: MemoryRelation[]) {
  const db = await getDB(rootDir);
  return db.getNeighbors(startNodeId, maxDepth, edgeFilter).map((result) => ({
    node: legacyNode(result.node),
    depth: result.depth,
    pathRelations: result.pathRelations,
    relevanceScore: result.relevanceScore,
  }));
}

export async function getGraphStats(rootDir: string): Promise<{
  nodes: number;
  edges: number;
  types: Record<string, number>;
  relations: Record<string, number>;
}> {
  const db = await getDB(rootDir);
  const types: Record<string, number> = {};
  const relations: Record<string, number> = {};
  for (const node of db.listMemoryNodes()) types[node.type] = (types[node.type] ?? 0) + 1;
  const seenEdges = new Set<string>();
  for (const node of db.listMemoryNodes()) {
    for (const edge of db.getMemoryEdgesForNode(node.id)) {
      if (seenEdges.has(edge.id)) continue;
      seenEdges.add(edge.id);
      relations[edge.relation] = (relations[edge.relation] ?? 0) + 1;
    }
  }
  const stats = db.getGraphStats();
  return { nodes: stats.totalNodes, edges: stats.totalEdges, types, relations };
}
