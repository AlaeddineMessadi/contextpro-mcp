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
  kind?: "summary" | "file" | "symbol" | "impact" | "path" | "hotspots" | "communities";
  file?: string;
  symbol?: string;
  source?: string;
  target?: string;
  maxHops?: number;
  limit?: number;
  maxTokens?: number;
  format?: "text" | "json";
}

function resolvedTokenBudget(maxTokens?: number): number {
  return Math.max(256, Math.min(maxTokens ?? 2500, 12_000));
}

function applyTextBudget(text: string, maxTokens?: number): string {
  const maxChars = resolvedTokenBudget(maxTokens) * 4;
  if (text.length <= maxChars) return text;
  const trailer = "\n… response truncated to max_tokens; raise the budget or lower limit for more detail.";
  const boundary = text.lastIndexOf("\n", Math.max(0, maxChars - trailer.length));
  return text.slice(0, boundary > 0 ? boundary : maxChars - trailer.length) + trailer;
}

function formatJsonResult(result: ProjectGraphQueryResult, fuzzyNote: string | null, maxTokens?: number): string {
  const maxChars = resolvedTokenBudget(maxTokens) * 4;
  let nodes = result.nodes.slice();
  let edges = result.edges.slice();
  let analysis = result.analysis ? structuredClone(result.analysis) : undefined;
  let truncated = false;
  const render = () => JSON.stringify({
    ...result,
    nodes,
    edges,
    analysis,
    fuzzyNote,
    ...(truncated ? { truncation: { truncated: true, maxTokens: resolvedTokenBudget(maxTokens) } } : {}),
  }, null, 2);
  let output = render();
  while (output.length > maxChars) {
    truncated = true;
    if (edges.length > 4) edges = edges.slice(0, Math.max(4, Math.floor(edges.length * 0.7)));
    else if (nodes.length > 4) nodes = nodes.slice(0, Math.max(4, Math.floor(nodes.length * 0.7)));
    else if (analysis?.kind === "hotspots" && analysis.rankings.length > 4) {
      analysis.rankings = analysis.rankings.slice(0, Math.max(4, Math.floor(analysis.rankings.length * 0.7)));
    } else if (analysis?.kind === "communities") {
      const largest = analysis.communities
        .filter((community) => community.files.length > 3)
        .sort((left, right) => right.files.length - left.files.length)[0];
      if (!largest) break;
      largest.files = largest.files.slice(0, Math.max(3, Math.floor(largest.files.length * 0.7)));
    } else break;
    output = render();
  }
  if (output.length <= maxChars) return output;
  return JSON.stringify({
    graph: result.graph,
    analysis: result.analysis?.kind === "path" ? result.analysis : { kind: result.analysis?.kind ?? "scoped" },
    fuzzyNote,
    truncation: { truncated: true, maxTokens: resolvedTokenBudget(maxTokens), message: "Raise max_tokens or lower limit." },
  }, null, 2);
}

function formatQueryResult(result: ProjectGraphQueryResult, maxTokens?: number): string {
  if (result.analysis?.kind === "path") {
    const analysis = result.analysis;
    if (analysis.status !== "found") {
      const candidates = [
        ...(analysis.sourceCandidates?.length ? [`Source candidates: ${analysis.sourceCandidates.join(" | ")}`] : []),
        ...(analysis.targetCandidates?.length ? [`Target candidates: ${analysis.targetCandidates.join(" | ")}`] : []),
      ];
      return applyTextBudget([
        `Project Graph Path: ${analysis.status}`,
        `From: ${analysis.sourceSelector}`,
        `To: ${analysis.targetSelector}`,
        ...candidates,
        analysis.status === "no_path" ? "No relationship path was found within max_hops." : "Use an exact node id or project-relative path to disambiguate.",
      ].join("\n"), maxTokens);
    }
    const lines = [
      `Project Graph Path: ${analysis.hops} hops | weighted cost ${analysis.totalCost}`,
      `Index generation: ${result.graph.indexGeneration}`,
      "",
    ];
    for (let index = 0; index < result.nodes.length; index++) {
      const node = result.nodes[index];
      lines.push(`${index + 1}. ${node.label} [${node.type}]${node.path ? ` — ${node.path}${node.lineStart ? `:L${node.lineStart}` : ""}` : ""}`);
      const edge = result.edges[index];
      if (edge) lines.push(`   ↳ ${edge.type} · ${edge.confidence} · ${edge.evidence}`);
    }
    return applyTextBudget(lines.join("\n"), maxTokens);
  }
  if (result.analysis?.kind === "hotspots") {
    const byId = new Map(result.nodes.map((node) => [node.id, node] as const));
    const lines = [
      "Project Graph Hotspots (weighted PageRank + degree)",
      `Index generation: ${result.graph.indexGeneration}`,
      "",
    ];
    for (const [index, ranking] of result.analysis.rankings.entries()) {
      const node = byId.get(ranking.nodeId);
      if (!node) continue;
      lines.push(`${index + 1}. ${node.label} [${node.type}] — score ${ranking.score} | in ${ranking.inDegree} | out ${ranking.outDegree}${node.path ? ` | ${node.path}${node.lineStart ? `:L${node.lineStart}` : ""}` : ""}`);
    }
    return applyTextBudget(lines.join("\n"), maxTokens);
  }
  if (result.analysis?.kind === "communities") {
    const lines = [
      "Project Graph Communities (deterministic Louvain pass)",
      `Index generation: ${result.graph.indexGeneration}`,
      "",
    ];
    for (const [index, community] of result.analysis.communities.entries()) {
      lines.push(`${index + 1}. ${community.label} — ${community.size} files | cohesion ${community.cohesion}`);
      lines.push(`   ${community.files.slice(0, 12).join(", ")}${community.files.length > 12 ? `, … +${community.files.length - 12}` : ""}`);
    }
    return applyTextBudget(lines.join("\n"), maxTokens);
  }
  const lines = [
    `Project Graph (scoped view)`,
    `Index generation: ${result.graph.indexGeneration}`,
    `This view: ${result.nodes.length} nodes | ${result.edges.length} edges`,
    `Project total: ${result.graph.stats.nodes} nodes | ${result.graph.stats.edges} edges | ${result.graph.stats.files} files | ${result.graph.stats.symbols} symbols`,
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
  return applyTextBudget(lines.join("\n"), maxTokens);
}

export async function exportProjectGraphTool(options: GraphExportOptions): Promise<string> {
  // Defend against a transient "database connection is not open" race when the DB pool is
  // mid-bootstrap. Pre-warm with getDB() then retry once on failure.
  let result;
  try {
    result = await writeProjectGraphArtifacts(options.rootDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/database (connection )?is not open|SQLITE_MISUSE/i.test(message)) {
      const { getDB } = await import("../core/db.js");
      await getDB(options.rootDir);
      result = await writeProjectGraphArtifacts(options.rootDir);
    } else {
      throw error;
    }
  }
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
  if (kind === "path" && (!options.source || !options.target)) {
    return `Error: graph_query kind="path" requires both "source" and "target" selectors.`;
  }
  let file = options.file ? toProjectRelativePath(options.rootDir, options.file, "file") : undefined;
  let fuzzyNote: string | null = null;
  if ((kind === "file" || kind === "impact") && file) {
    const fullGraph = await buildProjectGraph(options.rootDir);
    const exists = fullGraph.nodes.some((node) => node.path === file);
    if (!exists) {
      // Fuzzy resolve: try common src-layout prefixes and a basename suffix match.
      const candidatePaths = ["src", "app", "lib", "packages"]
        .map((prefix) => `${prefix}/${file}`)
        .filter((c) => fullGraph.nodes.some((node) => node.path === c));
      if (candidatePaths.length === 1) {
        fuzzyNote = `Fuzzy-resolved "${file}" → "${candidatePaths[0]}". Pass the full project-relative path next time.`;
        file = candidatePaths[0];
      } else if (candidatePaths.length > 1) {
        return `No graph node found for "${options.file}". Did you mean one of: ${candidatePaths.join(", ")}? Pass the full project-relative path.`;
      } else if (options.file) {
        const suffix = options.file.split("/").pop();
        const basenameHits = suffix ? fullGraph.nodes.filter((node) => node.type === "file" && node.path?.endsWith(`/${suffix}`)).map((n) => n.path).slice(0, 5) : [];
        if (basenameHits.length > 0) {
          return `No graph node found for "${options.file}". Files with that basename exist at: ${basenameHits.join(", ")}.`;
        }
      }
    }
  }
  const result = await queryProjectGraph(options.rootDir, {
    kind,
    file,
    symbol: options.symbol,
    source: options.source,
    target: options.target,
    maxHops: options.maxHops,
    limit: options.limit,
  });
  if (options.format === "json") return formatJsonResult(result, fuzzyNote, options.maxTokens);
  if (kind === "summary" && !options.file && !options.symbol) {
    return applyTextBudget(formatGraphReport(await buildProjectGraph(options.rootDir)), options.maxTokens);
  }
  const prefix = fuzzyNote ? `[${fuzzyNote}]\n\n` : "";
  if (kind === "file" || kind === "impact") {
    if (result.nodes.length === 0) {
      const fullGraph = await buildProjectGraph(options.rootDir);
      const startNodeExists = fullGraph.nodes.some((node) => node.path === file);
      if (!startNodeExists) {
        return `No graph node found for file "${file}". The file may not be indexed yet — run reindex, or check the path is correct (project-relative).`;
      }
      if (kind === "impact") {
        return prefix + `File "${file}" is indexed but has no incoming dependencies (no other files import it, call its symbols, or test it). This usually means it's a leaf module, types-only file, or entry point.`;
      }
      return prefix + `File "${file}" is indexed but has no graph edges. The file may have no imports, calls, or test relationships.`;
    }
    if (kind === "impact") {
      // For impact, check if any node OTHER than the start file or its own symbols is in the result.
      const hasDependents = result.nodes.some((node) => {
        if (node.path === file) return false;
        if (node.type === "symbol" && node.path === file) return false;
        return node.type === "file" || (node.type === "symbol" && node.path !== file);
      });
      const hasFileDependent = result.nodes.some((node) => node.type === "file" && node.path !== file);
      if (!hasFileDependent && !hasDependents) {
        return `File "${file}" is indexed but has no incoming dependencies (no other files import it, call its symbols, or test it). This usually means it's a leaf module, types-only file, or entry point.`;
      }
    }
  }
  if (kind === "symbol" && result.nodes.length === 0) {
    return `No graph nodes found for symbol "${options.symbol}". The symbol may not be indexed yet, or the name is wrong (case-sensitive exact match).`;
  }
  return formatQueryResult(result, options.maxTokens);
}
