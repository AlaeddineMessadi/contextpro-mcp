// Thin data-access wrapper over the contextpro-mcp build. The dashboard reuses the
// MCP's own status/graph/DB code (imported from its shipped `build/`) so we never
// re-implement query logic. better-sqlite3 runs in WAL mode, so these reads are
// safe to run concurrently with a live MCP server writing to the same DB.
//
// The MCP's built modules (which pull in the native better-sqlite3 binding) live
// outside this Next app's module tree at <repo>/build. Static bundling of those
// trips the bundler ("Invalid symlink" through the package symlink, or out-of-root
// for relative paths). So we load them at RUNTIME via dynamic import of an ABSOLUTE
// file:// URL, which bypasses the bundler's static graph entirely. This code only
// ever runs server-side (API routes), never in the browser.

import { pathToFileURL } from "url";
import { join } from "path";

// The dashboard runs with cwd at <repo>/dashboard (next dev) or is invoked from the
// repo; allow an explicit override for safety.
function repoRoot(): string {
  if (process.env.CONTEXTPRO_MCP_ROOT) return process.env.CONTEXTPRO_MCP_ROOT;
  // next dev runs with cwd = dashboard/; the MCP build is one level up.
  const cwd = process.cwd();
  return cwd.endsWith("/dashboard") ? join(cwd, "..") : cwd;
}

function buildModuleUrl(rel: string): string {
  return pathToFileURL(join(repoRoot(), "build", rel)).href;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function mcpDB() {
  const mod: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ buildModuleUrl("core/db.js"));
  return mod;
}
async function mcpStatus() {
  const mod: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ buildModuleUrl("tools/status.js"));
  return mod;
}
async function mcpGraph() {
  const mod: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ buildModuleUrl("core/project-graph.js"));
  return mod;
}

export interface ToolCall {
  tool: string;
  status: string;
  durationMs: number;
  calledAt: number;
}

export interface ToolAggregate {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  lastAt: number;
}

export async function status(rootDir: string): Promise<unknown> {
  const { getStatusData } = await mcpStatus();
  return getStatusData({ rootDir });
}

export async function toolHistory(rootDir: string, limit = 200): Promise<ToolCall[]> {
  const { getDB } = await mcpDB();
  const db = await getDB(rootDir);
  return db.getToolCallHistory(limit);
}

export async function toolAggregates(rootDir: string, sinceMs?: number): Promise<ToolAggregate[]> {
  const { getDB } = await mcpDB();
  const db = await getDB(rootDir);
  return db.getToolCallAggregates(sinceMs);
}

export async function toolTotal(rootDir: string): Promise<number> {
  const { getDB } = await mcpDB();
  const db = await getDB(rootDir);
  return db.getToolCallTotal();
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  path?: string;
}
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

/**
 * Code graph for visualization. We build the full project graph (files + symbols +
 * imports/calls) and return a compact, file-level view sized for the browser:
 * file/test nodes plus the import edges between them. PageRank-style importance is
 * approximated by in-degree so node size conveys "depended-on-ness".
 */
export async function codeGraph(rootDir: string, maxNodes = 200): Promise<{
  nodes: Array<GraphNode & { importance: number }>;
  edges: GraphEdge[];
  stats: Record<string, number>;
}> {
  const { buildProjectGraph } = await mcpGraph();
  const graph = await buildProjectGraph(rootDir);
  const fileNodes = graph.nodes.filter((n: GraphNode) => n.type === "file" || n.type === "test");
  const fileIds = new Set(fileNodes.map((n: GraphNode) => n.id));

  // Keep only import/contains edges among file nodes for a readable file-level map.
  const importEdges = graph.edges.filter(
    (e: GraphEdge) => (e.type === "imports") && fileIds.has(e.source) && fileIds.has(e.target),
  );

  // In-degree = how many files import this one → importance proxy.
  const inDegree = new Map<string, number>();
  for (const e of importEdges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);

  const ranked = fileNodes
    .map((n: GraphNode) => ({ ...n, importance: inDegree.get(n.id) ?? 0 }))
    .sort((a: { importance: number }, b: { importance: number }) => b.importance - a.importance)
    .slice(0, maxNodes);

  const keepIds = new Set(ranked.map((n: GraphNode) => n.id));
  const keptEdges = importEdges.filter((e: GraphEdge) => keepIds.has(e.source) && keepIds.has(e.target));

  return { nodes: ranked, edges: keptEdges, stats: graph.stats };
}

export interface MemoryNode {
  id: string;
  type: string;
  label: string;
  accessCount?: number;
}
export interface MemoryEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export async function memoryGraph(rootDir: string): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
  const { getDB } = await mcpDB();
  const db = await getDB(rootDir);
  const rawNodes = db.listMemoryNodes() as Array<{ id: string; type: string; label: string; access_count?: number }>;
  const nodes: MemoryNode[] = rawNodes.map((n) => ({ id: n.id, type: n.type, label: n.label, accessCount: n.access_count }));

  const edges: MemoryEdge[] = [];
  const seen = new Set<string>();
  for (const node of rawNodes) {
    const nodeEdges = db.getMemoryEdgesForNode(node.id) as Array<{ source: string; target: string; relation: string; weight: number }>;
    for (const e of nodeEdges) {
      const key = `${e.source}->${e.target}:${e.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: e.source, target: e.target, relation: e.relation, weight: e.weight });
    }
  }
  return { nodes, edges };
}
