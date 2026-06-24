// Compare a saved project graph to the current graph after edits
// FEATURE: Impact delta — verify actual graph changes against the planned edit scope

import { readFile } from "fs/promises";
import { buildProjectGraph, type ProjectGraph, type ProjectGraphEdge, type ProjectGraphNode } from "../core/project-graph.js";
import { resolveProjectPath } from "../core/path-guard.js";

export interface ImpactDeltaOptions {
  rootDir: string;
  baselinePath?: string;
  format?: "text" | "json";
}

interface ImpactDelta {
  baselinePath: string;
  baselineGeneratedAt: string;
  currentGeneratedAt: string;
  addedNodes: ProjectGraphNode[];
  removedNodes: ProjectGraphNode[];
  addedEdges: ProjectGraphEdge[];
  removedEdges: ProjectGraphEdge[];
  impactedFiles: string[];
}

function nodePath(node: ProjectGraphNode | undefined): string | null {
  if (!node) return null;
  if (node.path && ["file", "test", "config", "document", "symbol"].includes(node.type)) return node.path;
  return null;
}

function collectImpactedFiles(delta: Omit<ImpactDelta, "impactedFiles">, before: ProjectGraph, after: ProjectGraph): string[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const files = new Set<string>();
  for (const node of [...delta.addedNodes, ...delta.removedNodes]) {
    const path = nodePath(node);
    if (path) files.add(path);
  }
  for (const edge of [...delta.addedEdges, ...delta.removedEdges]) {
    for (const id of [edge.source, edge.target]) {
      const path = nodePath(afterNodes.get(id) ?? beforeNodes.get(id));
      if (path) files.add(path);
    }
  }
  return [...files].sort();
}

function compareGraphs(baselinePath: string, before: ProjectGraph, after: ProjectGraph): ImpactDelta {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const partial = {
    baselinePath,
    baselineGeneratedAt: before.generatedAt,
    currentGeneratedAt: after.generatedAt,
    addedNodes: after.nodes.filter((node) => !beforeNodes.has(node.id)),
    removedNodes: before.nodes.filter((node) => !afterNodes.has(node.id)),
    addedEdges: after.edges.filter((edge) => !beforeEdges.has(edge.id)),
    removedEdges: before.edges.filter((edge) => !afterEdges.has(edge.id)),
  };
  return {
    ...partial,
    impactedFiles: collectImpactedFiles(partial, before, after),
  };
}

function formatImpactDelta(delta: ImpactDelta): string {
  const lines = [
    "Impact Delta",
    `Baseline: ${delta.baselinePath}`,
    `Generated: ${delta.baselineGeneratedAt} -> ${delta.currentGeneratedAt}`,
    "",
    `Nodes: +${delta.addedNodes.length} -${delta.removedNodes.length}`,
    `Edges: +${delta.addedEdges.length} -${delta.removedEdges.length}`,
    `Impacted files: ${delta.impactedFiles.length}`,
  ];
  if (delta.impactedFiles.length > 0) {
    lines.push("");
    lines.push("Impacted Files:");
    for (const file of delta.impactedFiles.slice(0, 30)) lines.push(`  ${file}`);
    if (delta.impactedFiles.length > 30) lines.push(`  ... and ${delta.impactedFiles.length - 30} more`);
  }
  if (delta.addedEdges.length > 0 || delta.removedEdges.length > 0) {
    lines.push("");
    lines.push("Edge Changes:");
    for (const edge of delta.addedEdges.slice(0, 12)) lines.push(`  + ${edge.source} --${edge.type}/${edge.confidence}--> ${edge.target}`);
    for (const edge of delta.removedEdges.slice(0, 12)) lines.push(`  - ${edge.source} --${edge.type}/${edge.confidence}--> ${edge.target}`);
  }
  return lines.join("\n");
}

export async function impactDeltaTool(options: ImpactDeltaOptions): Promise<string> {
  const relativeBaseline = options.baselinePath ?? ".contextpro/graph.json";
  const baselinePath = resolveProjectPath(options.rootDir, relativeBaseline, "baselinePath");
  let rawBaseline: string;
  try {
    rawBaseline = await readFile(baselinePath, "utf-8");
  } catch {
    return `No baseline graph found at "${relativeBaseline}". Run graph_export first to create a baseline, then edit + reindex + impact_delta to see structural changes.`;
  }
  let before: ProjectGraph;
  try {
    before = JSON.parse(rawBaseline) as ProjectGraph;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Baseline graph at "${relativeBaseline}" is corrupt (${message}). Re-run graph_export to regenerate it.`;
  }
  const after = await buildProjectGraph(options.rootDir);
  const delta = compareGraphs(baselinePath, before, after);
  if (options.format === "json") return JSON.stringify(delta, null, 2);
  return formatImpactDelta(delta);
}
