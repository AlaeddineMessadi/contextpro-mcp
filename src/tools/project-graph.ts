// MCP-facing project graph tools with portable export and query formatting
// FEATURE: Exact graph tools — expose indexed project structure to coding agents

import {
  buildProjectGraph,
  formatGraphReport,
  queryProjectGraph,
  writeProjectGraphArtifacts,
  type ProjectGraphQueryResult,
} from "../core/project-graph.js";
import { toProjectRelativePath } from "../core/path-guard.js";

export interface GraphExportOptions {
  rootDir: string;
  format?: "text" | "json";
}

export interface GraphQueryOptions {
  rootDir: string;
  kind?: "summary" | "file" | "symbol" | "impact";
  file?: string;
  symbol?: string;
  limit?: number;
  format?: "text" | "json";
}

function formatQueryResult(result: ProjectGraphQueryResult): string {
  const lines = [
    `Project Graph`,
    `Index generation: ${result.graph.indexGeneration}`,
    `Nodes: ${result.graph.stats.nodes} | Edges: ${result.graph.stats.edges}`,
    `Files: ${result.graph.stats.files} | Symbols: ${result.graph.stats.symbols} | Imports: ${result.graph.stats.imports} | Tests: ${result.graph.stats.tests}`,
    "",
    "Nodes:",
  ];
  for (const node of result.nodes) {
    lines.push(`  ${node.id} [${node.type}] ${node.path ?? node.label}${node.lineStart ? ` L${node.lineStart}` : ""}`);
  }
  if (result.edges.length > 0) {
    lines.push("");
    lines.push("Edges:");
    for (const edge of result.edges) {
      lines.push(`  ${edge.source} --${edge.type}/${edge.confidence}--> ${edge.target}`);
    }
  }
  return lines.join("\n");
}

export async function exportProjectGraphTool(options: GraphExportOptions): Promise<string> {
  const result = await writeProjectGraphArtifacts(options.rootDir);
  if (options.format === "json") {
    return JSON.stringify({
      graphPath: result.graphPath,
      reportPath: result.reportPath,
      dashboardPath: result.dashboardPath,
      stats: result.graph.stats,
      indexGeneration: result.graph.indexGeneration,
    }, null, 2);
  }
  return [
    `Project graph exported.`,
    `Graph: ${result.graphPath}`,
    `Report: ${result.reportPath}`,
    `Dashboard: ${result.dashboardPath}`,
    "",
    `Nodes: ${result.graph.stats.nodes} | Edges: ${result.graph.stats.edges}`,
    `Files: ${result.graph.stats.files} | Symbols: ${result.graph.stats.symbols} | Imports: ${result.graph.stats.imports}`,
  ].join("\n");
}

export async function queryProjectGraphTool(options: GraphQueryOptions): Promise<string> {
  const kind = options.kind ?? "summary";
  if ((kind === "file" || kind === "impact") && !options.file) {
    return `Error: graph_query kind="${kind}" requires a "file" argument.`;
  }
  if (kind === "symbol" && !options.symbol) {
    return `Error: graph_query kind="symbol" requires a "symbol" argument.`;
  }
  const file = options.file ? toProjectRelativePath(options.rootDir, options.file, "file") : undefined;
  const result = await queryProjectGraph(options.rootDir, {
    kind,
    file,
    symbol: options.symbol,
    limit: options.limit,
  });
  if (options.format === "json") return JSON.stringify(result, null, 2);
  if (kind === "summary" && !options.file && !options.symbol) {
    return formatGraphReport(await buildProjectGraph(options.rootDir));
  }
  if (kind === "file" || kind === "impact") {
    if (result.nodes.length === 0) {
      return `No graph nodes found for file "${file}". The file may not be indexed yet — run reindex, or check the path is correct (project-relative).`;
    }
  }
  if (kind === "symbol" && result.nodes.length === 0) {
    return `No graph nodes found for symbol "${options.symbol}". The symbol may not be indexed yet, or the name is wrong (case-sensitive exact match).`;
  }
  return formatQueryResult(result);
}
