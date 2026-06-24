// Portable project graph builder from the SQLite index
// FEATURE: Exact code graph — typed nodes, edges, confidence, and export artifacts

import { createHash } from "crypto";
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { dirname, posix } from "path";
import { promisify } from "util";
import { getDB, type ContextPlusDB, type FileRow, type SymbolRow } from "./db.js";
import { resolveProjectPath } from "./path-guard.js";
import { loadScipIndex, scipSymbolDisplayName, scipSymbolNodeId } from "./scip-index.js";

const execFileAsync = promisify(execFile);

export type GraphNodeType = "project" | "folder" | "file" | "test" | "config" | "document" | "symbol" | "package" | "route";
export type GraphEdgeType = "contains" | "defines" | "imports" | "calls" | "references" | "tests" | "configures" | "inherits" | "implements" | "route_handles" | "co_changes_with";
export type GraphConfidence = "SCIP_RESOLVED" | "LSP_RESOLVED" | "AST_EXTRACTED" | "HEURISTIC" | "AMBIGUOUS";

export interface ProjectGraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  path?: string;
  language?: string | null;
  lineStart?: number;
  lineEnd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectGraphEdge {
  id: string;
  type: GraphEdgeType;
  source: string;
  target: string;
  confidence: GraphConfidence;
  evidence: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectGraph {
  version: 1;
  generatedAt: string;
  rootDir: string;
  indexGeneration: number;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    files: number;
    symbols: number;
    imports: number;
    calls: number;
    tests: number;
    ambiguousCalls: number;
  };
}

export interface ProjectGraphQueryResult {
  graph: Pick<ProjectGraph, "generatedAt" | "indexGeneration" | "stats">;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

function stableId(parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
}

const GRAPH_STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);

function isGraphRelevantSymbol(
  symbol: { name: string; kind: string; signature?: string | null; line_start: number; parent_symbol_id?: number | null },
  structuralRanges: Array<{ start: number; end: number }>,
): boolean {
  if (GRAPH_STRUCTURAL_KINDS.has(symbol.kind)) return true;
  if (symbol.kind !== "const" && symbol.kind !== "variable") return false;
  const sig = symbol.signature ?? "";
  if (/^export\s/.test(sig)) return true;
  if (symbol.parent_symbol_id != null) return false;
  for (const range of structuralRanges) {
    if (symbol.line_start > range.start && symbol.line_start <= range.end) return false;
  }
  if (symbol.name.length < 3) return false;
  return true;
}

function edgeId(type: GraphEdgeType, source: string, target: string, evidence: string): string {
  return `edge:${stableId([type, source, target, evidence])}`;
}

function classifyPath(path: string): GraphNodeType {
  if (/\.(test|spec|demo)\.[^.]+$/.test(path) || /(^|\/)(__tests__|test|tests)\//.test(path)) return "test";
  if (/(^|\/)(package\.json|tsconfig\.json|go\.mod|Cargo\.toml|pyproject\.toml|eslint\.config\.[cm]?js|\.eslintrc\.)/.test(path)) return "config";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(path)) return "document";
  return "file";
}

function classifyFile(file: FileRow): GraphNodeType {
  return classifyPath(file.path);
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function addNode(nodes: Map<string, ProjectGraphNode>, node: ProjectGraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, ProjectGraphEdge>, edge: Omit<ProjectGraphEdge, "id">): void {
  const id = edgeId(edge.type, edge.source, edge.target, edge.evidence);
  if (!edges.has(id)) edges.set(id, { id, ...edge });
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

function folderNodeId(path: string): string {
  return `folder:${path || "."}`;
}

function symbolNodeId(filePath: string, symbol: SymbolRow): string {
  return `symbol:${filePath}:${symbol.line_start}:${symbol.name}`;
}

function packageNodeId(specifier: string): string {
  return `package:${specifier}`;
}

function routeNodeId(route: string): string {
  return `route:${route}`;
}

function ensureFolderChain(nodes: Map<string, ProjectGraphNode>, edges: Map<string, ProjectGraphEdge>, projectId: string, filePath: string): string {
  const parts = dirname(filePath).split("/").filter((part) => part !== ".");
  let parentId = projectId;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const id = folderNodeId(currentPath);
    addNode(nodes, { id, type: "folder", label: part, path: currentPath });
    addEdge(edges, {
      type: "contains",
      source: parentId,
      target: id,
      confidence: "AST_EXTRACTED",
      evidence: "path hierarchy",
    });
    parentId = id;
  }
  return parentId;
}

function parseImportedSymbols(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function testBase(path: string): string {
  return basename(path).replace(/\.(test|spec|demo)\.[^.]+$/, "").replace(/\.[^.]+$/, "");
}

function sourceBase(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

function inferRoutePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const withoutExt = normalized.replace(/\.[^.]+$/, "");
  if (normalized.includes("/routes/")) {
    const route = withoutExt.slice(withoutExt.indexOf("/routes/") + "/routes/".length);
    return `/${route.replace(/\/index$/, "").replace(/\$/g, ":")}` || "/";
  }
  if (normalized.startsWith("routes/")) {
    const route = withoutExt.slice("routes/".length);
    return `/${route.replace(/\/index$/, "").replace(/\$/g, ":")}` || "/";
  }
  if (normalized.startsWith("pages/")) {
    const route = withoutExt.slice("pages/".length);
    if (route.startsWith("api/")) return null;
    return `/${route.replace(/\/index$/, "").replace(/index$/, "").replace(/\[(.+?)\]/g, ":$1")}` || "/";
  }
  const appPage = normalized.match(/^app\/(.+)\/page\.(tsx|ts|jsx|js)$/);
  if (appPage) return `/${appPage[1].replace(/\[(.+?)\]/g, ":$1")}`;
  return null;
}

function relationTargets(signature: string | null, keyword: "extends" | "implements"): string[] {
  if (!signature) return [];
  const regex = keyword === "extends"
    ? /\bextends\s+([A-Za-z_$][\w$]*)/
    : /\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/;
  const match = signature.match(regex);
  if (!match) return [];
  return match[1].split(",").map((value) => value.trim()).filter(Boolean);
}

async function collectCoChangePairs(rootDir: string, filesByPath: Map<string, FileRow>): Promise<Array<{ left: string; right: string; count: number }>> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--name-only", "--pretty=format:--contextplus-commit--", "-n", "200"], {
      cwd: rootDir,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const counts = new Map<string, number>();
    let current = new Set<string>();
    const flush = () => {
      const files = [...current].filter((path) => filesByPath.has(path)).sort();
      current = new Set<string>();
      if (files.length < 2 || files.length > 20) return;
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = `${files[i]}\0${files[j]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    };
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "--contextplus-commit--") {
        flush();
        continue;
      }
      if (trimmed.length > 0) current.add(trimmed);
    }
    flush();
    return [...counts.entries()]
      .map(([key, count]) => {
        const [left, right] = key.split("\0");
        return { left, right, count };
      })
      .filter((pair) => pair.count >= 2)
      .sort((a, b) => b.count - a.count || a.left.localeCompare(b.left))
      .slice(0, 100);
  } catch {
    return [];
  }
}

function resolveRelativeImport(sourcePath: string, specifier: string, filesByPath: Map<string, FileRow>): FileRow | null {
  if (!specifier.startsWith(".")) return null;
  const sourceDir = dirname(sourcePath);
  const base = posix.normalize(sourceDir === "." ? specifier : `${sourceDir}/${specifier}`);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    base.replace(/\.js$/, ".ts"),
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    const found = filesByPath.get(candidate);
    if (found) return found;
  }
  return null;
}

export async function buildProjectGraph(rootDir: string): Promise<ProjectGraph> {
  const db = await getDB(rootDir);
  return buildProjectGraphFromDB(rootDir, db);
}

export async function buildProjectGraphFromDB(rootDir: string, db: ContextPlusDB): Promise<ProjectGraph> {
  const nodes = new Map<string, ProjectGraphNode>();
  const edges = new Map<string, ProjectGraphEdge>();
  const files = db.getAllFiles().sort((a, b) => a.path.localeCompare(b.path));
  const filesById = new Map(files.map((file) => [file.id, file]));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const projectId = "project:root";
  addNode(nodes, {
    id: projectId,
    type: "project",
    label: basename(rootDir),
    path: ".",
    metadata: { rootDir },
  });

  const symbolsByFile = new Map<number, SymbolRow[]>();
  const symbolsByName = new Map<string, Array<{ file: FileRow; symbol: SymbolRow; id: string }>>();
  let symbolCount = 0;

  for (const file of files) {
    const parentId = ensureFolderChain(nodes, edges, projectId, file.path);
    const nodeId = fileNodeId(file.path);
    const type = classifyFile(file);
    addNode(nodes, {
      id: nodeId,
      type,
      label: basename(file.path),
      path: file.path,
      language: file.language,
      metadata: {
        contentHash: file.content_hash,
        header: file.header,
        size: file.file_size,
        symbols: file.symbol_count,
      },
    });
    addEdge(edges, {
      type: "contains",
      source: parentId,
      target: nodeId,
      confidence: "AST_EXTRACTED",
      evidence: "path hierarchy",
    });
    if (type === "config") {
      addEdge(edges, {
        type: "configures",
        source: nodeId,
        target: projectId,
        confidence: "HEURISTIC",
        evidence: "config filename",
      });
    }
    const routePath = inferRoutePath(file.path);
    if (routePath) {
      const routeId = routeNodeId(routePath);
      addNode(nodes, { id: routeId, type: "route", label: routePath, path: routePath });
      addEdge(edges, {
        type: "route_handles",
        source: nodeId,
        target: routeId,
        confidence: "HEURISTIC",
        evidence: "route file path convention",
      });
    }

    const symbols = db.getSymbolsByFile(file.id);
    symbolsByFile.set(file.id, symbols);
    symbolCount += symbols.length;
    const structuralRanges = symbols
      .filter((sym) => GRAPH_STRUCTURAL_KINDS.has(sym.kind))
      .map((sym) => ({ start: sym.line_start, end: sym.line_end ?? sym.line_start }));
    for (const symbol of symbols) {
      if (!isGraphRelevantSymbol(symbol, structuralRanges)) continue;
      const symbolId = symbolNodeId(file.path, symbol);
      addNode(nodes, {
        id: symbolId,
        type: "symbol",
        label: symbol.name,
        path: file.path,
        language: file.language,
        lineStart: symbol.line_start,
        lineEnd: symbol.line_end,
        metadata: {
          kind: symbol.kind,
          signature: symbol.signature,
        },
      });
      addEdge(edges, {
        type: "defines",
        source: nodeId,
        target: symbolId,
        confidence: "AST_EXTRACTED",
        evidence: "tree-sitter symbol extraction",
      });
      const existing = symbolsByName.get(symbol.name) ?? [];
      existing.push({ file, symbol, id: symbolId });
      symbolsByName.set(symbol.name, existing);
    }
  }

  for (const entriesForName of symbolsByName.values()) {
    for (const entry of entriesForName) {
      for (const targetName of relationTargets(entry.symbol.signature, "extends")) {
        const targets = symbolsByName.get(targetName) ?? [];
        for (const target of targets.slice(0, 3)) {
          addEdge(edges, {
            type: "inherits",
            source: entry.id,
            target: target.id,
            confidence: targets.length === 1 ? "HEURISTIC" : "AMBIGUOUS",
            evidence: "symbol signature extends clause",
            metadata: { targetName, candidateCount: targets.length },
          });
        }
      }
      for (const targetName of relationTargets(entry.symbol.signature, "implements")) {
        const targets = symbolsByName.get(targetName) ?? [];
        for (const target of targets.slice(0, 3)) {
          addEdge(edges, {
            type: "implements",
            source: entry.id,
            target: target.id,
            confidence: targets.length === 1 ? "HEURISTIC" : "AMBIGUOUS",
            evidence: "symbol signature implements clause",
            metadata: { targetName, candidateCount: targets.length },
          });
        }
      }
    }
  }

  let importCount = 0;
  let callCount = 0;
  let ambiguousCalls = 0;
  let testCount = 0;

  for (const file of files) {
    const sourceFileId = fileNodeId(file.path);
    for (const imp of db.getImportsFrom(file.id)) {
      importCount++;
      const targetFile = imp.target_file_id ? filesById.get(imp.target_file_id) : resolveRelativeImport(file.path, imp.target_path, filesByPath);
      const targetId = targetFile ? fileNodeId(targetFile.path) : packageNodeId(imp.target_path);
      if (!targetFile) {
        addNode(nodes, {
          id: targetId,
          type: "package",
          label: imp.target_path,
          metadata: { unresolved: true },
        });
      }
      addEdge(edges, {
        type: "imports",
        source: sourceFileId,
        target: targetId,
        confidence: targetFile ? "AST_EXTRACTED" : "HEURISTIC",
        evidence: "import table",
        metadata: {
          importType: imp.import_type,
          specifiers: parseImportedSymbols(imp.symbols_imported),
        },
      });
      if (classifyFile(file) === "test" && targetFile && classifyFile(targetFile) !== "test") {
        addEdge(edges, {
          type: "tests",
          source: sourceFileId,
          target: targetId,
          confidence: "AST_EXTRACTED",
          evidence: "test imports source file",
        });
        testCount++;
      }
    }

    for (const site of db.getCallSitesByFile(file.id)) {
      const candidates = symbolsByName.get(site.callee) ?? [];
      if (candidates.length === 0) continue;
      callCount++;
      const selected = candidates.length === 1 ? candidates : candidates.slice(0, 5);
      if (candidates.length > 1) ambiguousCalls++;
      for (const candidate of selected) {
        addEdge(edges, {
          type: candidates.length === 1 ? "calls" : "references",
          source: sourceFileId,
          target: candidate.id,
          confidence: candidates.length === 1 ? "HEURISTIC" : "AMBIGUOUS",
          evidence: "call site extraction",
          metadata: {
            callee: site.callee,
            line: site.line,
            context: site.context,
            candidateCount: candidates.length,
          },
        });
      }
    }
  }

  const sourceFiles = files.filter((file) => classifyFile(file) !== "test");
  const tests = files.filter((file) => classifyFile(file) === "test");
  for (const test of tests) {
    const base = testBase(test.path);
    for (const source of sourceFiles) {
      if (sourceBase(source.path) !== base) continue;
      addEdge(edges, {
        type: "tests",
        source: fileNodeId(test.path),
        target: fileNodeId(source.path),
        confidence: "HEURISTIC",
        evidence: "test filename convention",
      });
    }
  }

  const ensureFileNode = (filePath: string): string => {
    const id = fileNodeId(filePath);
    if (!nodes.has(id)) {
      const parentId = ensureFolderChain(nodes, edges, projectId, filePath);
      addNode(nodes, {
        id,
        type: classifyPath(filePath),
        label: basename(filePath),
        path: filePath,
        metadata: { source: "scip" },
      });
      addEdge(edges, {
        type: "contains",
        source: parentId,
        target: id,
        confidence: "SCIP_RESOLVED",
        evidence: "SCIP document path",
      });
    }
    return id;
  };

  const scipSymbolIds = new Map<string, string>();
  const resolveScipSymbolId = (symbol: string, name: string, file?: string, line?: number): string => {
    const existing = scipSymbolIds.get(symbol);
    if (existing) return existing;
    const candidates = symbolsByName.get(name) ?? [];
    const matched = candidates.find((candidate) => {
      if (file && candidate.file.path !== file) return false;
      if (line && Math.abs(candidate.symbol.line_start - line) > 1) return false;
      return true;
    }) ?? candidates.find((candidate) => !file || candidate.file.path === file);
    const id = matched?.id ?? scipSymbolNodeId(symbol);
    scipSymbolIds.set(symbol, id);
    return id;
  };

  const scipIndex = await loadScipIndex(rootDir);
  if (scipIndex) {
    for (const symbol of scipIndex.symbols) {
      const id = resolveScipSymbolId(symbol.symbol, symbol.name, symbol.file, symbol.line);
      if (!nodes.has(id)) {
        addNode(nodes, {
          id,
          type: "symbol",
          label: symbol.name,
          path: symbol.file,
          lineStart: symbol.line,
          metadata: {
            kind: symbol.kind,
            signature: symbol.signature,
            scipSymbol: symbol.symbol,
            source: "scip",
          },
        });
      }
      if (symbol.file) {
        addEdge(edges, {
          type: "defines",
          source: ensureFileNode(symbol.file),
          target: id,
          confidence: "SCIP_RESOLVED",
          evidence: "SCIP symbol definition",
          metadata: { symbol: symbol.symbol, line: symbol.line },
        });
      }
    }

    for (const occurrence of scipIndex.occurrences) {
      const sourceId = ensureFileNode(occurrence.file);
      const targetId = resolveScipSymbolId(occurrence.symbol, occurrence.name, occurrence.role === "definition" ? occurrence.file : undefined, occurrence.role === "definition" ? occurrence.line : undefined);
      if (!nodes.has(targetId)) {
        addNode(nodes, {
          id: targetId,
          type: "symbol",
          label: occurrence.name,
          path: occurrence.role === "definition" ? occurrence.file : undefined,
          lineStart: occurrence.role === "definition" ? occurrence.line : undefined,
          metadata: {
            scipSymbol: occurrence.symbol,
            source: "scip",
          },
        });
      }
      addEdge(edges, {
        type: occurrence.role === "definition" ? "defines" : "references",
        source: sourceId,
        target: targetId,
        confidence: "SCIP_RESOLVED",
        evidence: occurrence.role === "definition" ? "SCIP definition occurrence" : "SCIP reference occurrence",
        metadata: {
          symbol: occurrence.symbol,
          line: occurrence.line,
          column: occurrence.column,
          syntaxKind: occurrence.syntaxKind,
        },
      });
    }

    for (const symbol of scipIndex.symbols) {
      const sourceId = resolveScipSymbolId(symbol.symbol, symbol.name, symbol.file, symbol.line);
      for (const relationship of symbol.relationships) {
        const targetName = scipIndex.symbols.find((candidate) => candidate.symbol === relationship.targetSymbol)?.name
          ?? scipSymbolDisplayName(relationship.targetSymbol);
        const targetId = resolveScipSymbolId(relationship.targetSymbol, targetName);
        if (!nodes.has(targetId)) {
          addNode(nodes, {
            id: targetId,
            type: "symbol",
            label: targetName,
            metadata: {
              scipSymbol: relationship.targetSymbol,
              source: "scip",
            },
          });
        }
        addEdge(edges, {
          type: relationship.isImplementation ? "implements" : "references",
          source: sourceId,
          target: targetId,
          confidence: "SCIP_RESOLVED",
          evidence: "SCIP symbol relationship",
          metadata: {
            symbol: symbol.symbol,
            targetSymbol: relationship.targetSymbol,
            isReference: relationship.isReference,
            isImplementation: relationship.isImplementation,
            isTypeDefinition: relationship.isTypeDefinition,
            isDefinition: relationship.isDefinition,
          },
        });
      }
    }
  }

  for (const pair of await collectCoChangePairs(rootDir, filesByPath)) {
    addEdge(edges, {
      type: "co_changes_with",
      source: fileNodeId(pair.left),
      target: fileNodeId(pair.right),
      confidence: "HEURISTIC",
      evidence: "recent git co-change history",
      metadata: { commits: pair.count },
    });
  }

  const graphNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const graphEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const stats = {
    nodes: graphNodes.length,
    edges: graphEdges.length,
    files: files.length,
    symbols: symbolCount,
    imports: importCount,
    calls: callCount,
    tests: graphEdges.filter((edge) => edge.type === "tests").length,
    ambiguousCalls,
  };
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootDir,
    indexGeneration: db.getIndexGeneration(),
    nodes: graphNodes,
    edges: graphEdges,
    stats,
  };
}

export function formatGraphReport(graph: ProjectGraph): string {
  const byType = new Map<string, number>();
  const edgesByType = new Map<string, number>();
  for (const node of graph.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
  for (const edge of graph.edges) edgesByType.set(edge.type, (edgesByType.get(edge.type) ?? 0) + 1);
  const topImporters = graph.nodes
    .filter((node) => ["file", "test"].includes(node.type) && node.path)
    .map((node) => ({
      node,
      outbound: graph.edges.filter((edge) => edge.source === node.id && edge.type === "imports").length,
      inbound: graph.edges.filter((edge) => edge.target === node.id && edge.type === "imports").length,
    }))
    .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound))
    .slice(0, 12);

  return [
    "# ContextPro Graph Report",
    "",
    `Generated: ${graph.generatedAt}`,
    `Index generation: ${graph.indexGeneration}`,
    "",
    "## Summary",
    "",
    `- Nodes: ${graph.stats.nodes}`,
    `- Edges: ${graph.stats.edges}`,
    `- Files: ${graph.stats.files}`,
    `- Symbols: ${graph.stats.symbols}`,
    `- Imports: ${graph.stats.imports}`,
    `- Calls: ${graph.stats.calls}`,
    `- Test edges: ${graph.stats.tests}`,
    `- Ambiguous call references: ${graph.stats.ambiguousCalls}`,
    "",
    "## Node Types",
    "",
    ...[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Edge Types",
    "",
    ...[...edgesByType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## High-Connectivity Files",
    "",
    ...topImporters.map(({ node, inbound, outbound }) => `- ${node.path}: ${inbound} inbound imports, ${outbound} outbound imports`),
    "",
    "## Confidence Notes",
    "",
    "- `AST_EXTRACTED`: derived from parser/index tables.",
    "- `HEURISTIC`: inferred from filenames, unresolved imports, or call-site names.",
    "- `AMBIGUOUS`: call name matched multiple symbols; inspect before editing.",
    "- `SCIP_RESOLVED`: exact facts imported from a project-provided SCIP JSON index.",
    "- `LSP_RESOLVED`: exact references resolved by a local language service adapter.",
    "",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatGraphDashboard(graph: ProjectGraph): string {
  const nodeTypes = new Map<string, number>();
  const edgeTypes = new Map<string, number>();
  for (const node of graph.nodes) nodeTypes.set(node.type, (nodeTypes.get(node.type) ?? 0) + 1);
  for (const edge of graph.edges) edgeTypes.set(edge.type, (edgeTypes.get(edge.type) ?? 0) + 1);
  const topFiles = graph.nodes
    .filter((node) => ["file", "test", "config", "document"].includes(node.type) && node.path)
    .map((node) => ({
      path: node.path ?? node.label,
      type: node.type,
      degree: graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length,
    }))
    .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path))
    .slice(0, 30);
  const rows = topFiles.map((file) =>
    `<tr><td>${escapeHtml(file.path)}</td><td>${escapeHtml(file.type)}</td><td>${file.degree}</td></tr>`,
  ).join("\n");
  const nodeCards = [...nodeTypes.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><span>${escapeHtml(type)}</span><strong>${count}</strong></li>`).join("\n");
  const edgeCards = [...edgeTypes.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><span>${escapeHtml(type)}</span><strong>${count}</strong></li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ContextPro Graph Dashboard</title>
  <style>
    body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; background: #f8fafc; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    h1, h2 { margin: 0; line-height: 1.15; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin-top: 30px; }
    .meta { color: #64748b; margin-top: 8px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 24px; }
    .stat { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
    .stat span { color: #64748b; display: block; font-size: 12px; }
    .stat strong { display: block; font-size: 24px; margin-top: 4px; }
    .lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 12px; }
    ul { list-style: none; padding: 0; margin: 0; background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
    li:last-child { border-bottom: 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
    th { color: #475569; background: #f1f5f9; font-size: 12px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
  </style>
</head>
<body>
  <main>
    <h1>ContextPro Graph Dashboard</h1>
    <div class="meta">Generated ${escapeHtml(graph.generatedAt)} | Index generation ${graph.indexGeneration}</div>
    <section class="stats">
      <div class="stat"><span>Nodes</span><strong>${graph.stats.nodes}</strong></div>
      <div class="stat"><span>Edges</span><strong>${graph.stats.edges}</strong></div>
      <div class="stat"><span>Files</span><strong>${graph.stats.files}</strong></div>
      <div class="stat"><span>Symbols</span><strong>${graph.stats.symbols}</strong></div>
      <div class="stat"><span>Imports</span><strong>${graph.stats.imports}</strong></div>
      <div class="stat"><span>Ambiguous Calls</span><strong>${graph.stats.ambiguousCalls}</strong></div>
    </section>
    <section class="lists">
      <div><h2>Node Types</h2><ul>${nodeCards}</ul></div>
      <div><h2>Edge Types</h2><ul>${edgeCards}</ul></div>
    </section>
    <h2>High-Connectivity Files</h2>
    <table>
      <thead><tr><th>Path</th><th>Type</th><th>Degree</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>
`;
}

export async function writeProjectGraphArtifacts(rootDir: string): Promise<{ graph: ProjectGraph; graphPath: string; reportPath: string; dashboardPath: string }> {
  const graph = await buildProjectGraph(rootDir);
  const graphPath = resolveProjectPath(rootDir, ".contextpro/graph.json", "graphPath");
  const reportPath = resolveProjectPath(rootDir, ".contextpro/GRAPH_REPORT.md", "reportPath");
  const dashboardPath = resolveProjectPath(rootDir, ".contextpro/graph-dashboard.html", "dashboardPath");
  await mkdir(dirname(graphPath), { recursive: true });
  await writeFile(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf-8");
  await writeFile(reportPath, formatGraphReport(graph), "utf-8");
  await writeFile(dashboardPath, formatGraphDashboard(graph), "utf-8");
  return { graph, graphPath, reportPath, dashboardPath };
}

export async function queryProjectGraph(rootDir: string, input: {
  kind?: "summary" | "file" | "symbol" | "impact";
  file?: string;
  symbol?: string;
  limit?: number;
}): Promise<ProjectGraphQueryResult> {
  const graph = await buildProjectGraph(rootDir);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const kind = input.kind ?? "summary";
  if (kind === "summary") {
    return { graph, nodes: graph.nodes.slice(0, limit), edges: graph.edges.slice(0, limit) };
  }
  const startNodes = graph.nodes.filter((node) => {
    if (kind === "file" || kind === "impact") {
      return input.file ? node.path === input.file : false;
    }
    return input.symbol ? node.type === "symbol" && node.label === input.symbol : false;
  });
  const startIds = new Set(startNodes.map((node) => node.id));

  if (kind === "impact") {
    // Impact: BFS over INCOMING dependencies — files that would need attention if the start file changes.
    // Edge selection: an edge from S→T contributes S to the dependent frontier when:
    //   - T is in the current frontier (a file) AND edge.type ∈ {imports, tests}
    //   - T is a symbol DEFINED by a file in the current frontier AND edge.type ∈ {calls, references, tests}
    // Limit is a SINGLE budget for edges in the output. Nodes are derived from the bounded edge set.
    const MAX_HOPS = 3;
    const fileFrontier = new Set<string>(startIds);
    const symbolFrontier = new Set<string>();
    const collectedEdges: ProjectGraphEdge[] = [];
    const edgeBudget = limit;

    for (let hop = 0; hop < MAX_HOPS && collectedEdges.length < edgeBudget; hop++) {
      // For each new file in the frontier, collect its defined symbols once.
      const newSymbols = new Set<string>();
      for (const edge of graph.edges) {
        if (!fileFrontier.has(edge.source)) continue;
        if (edge.type !== "defines") continue;
        if (symbolFrontier.has(edge.target)) continue;
        symbolFrontier.add(edge.target);
        newSymbols.add(edge.target);
      }
      const newDependents = new Set<string>();
      for (const edge of graph.edges) {
        if (collectedEdges.length >= edgeBudget) break;
        const targetsFile = fileFrontier.has(edge.target) && (edge.type === "imports" || edge.type === "tests");
        const targetsSymbol = symbolFrontier.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
        if (!targetsFile && !targetsSymbol) continue;
        if (fileFrontier.has(edge.source)) continue;
        collectedEdges.push(edge);
        newDependents.add(edge.source);
      }
      if (newDependents.size === 0) break;
      for (const id of newDependents) fileFrontier.add(id);
    }

    const nodeIds = new Set<string>([...fileFrontier, ...symbolFrontier]);
    const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
    return { graph, nodes, edges: collectedEdges };
  }

  const edges = graph.edges
    .filter((edge) => startIds.has(edge.source) || startIds.has(edge.target))
    .slice(0, limit);
  const nodeIds = new Set([...startIds]);
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id)).slice(0, limit);
  return { graph, nodes, edges };
}
