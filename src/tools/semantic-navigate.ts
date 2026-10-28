// Semantic project navigator using spectral clustering and provider-agnostic labeling
// Browse codebase by meaning: embeds files, clusters vectors, generates labels

import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { fetchEmbedding } from "../core/embeddings.js";
import { getProvider } from "../core/provider-config.js";
import { chatCompletion, hasConfiguredChatModel } from "../core/chat-model.js";
import { readFile } from "fs/promises";
import { spectralCluster, findPathPattern } from "../core/clustering.js";
import { extname } from "path";

export interface SemanticNavigateOptions {
  rootDir: string;
  maxDepth?: number;
  maxClusters?: number;
}

interface FileInfo {
  relativePath: string;
  header: string;
  content: string;
  symbolPreview: string[];
}

interface ClusterNode {
  label: string;
  pathPattern: string | null;
  files: FileInfo[];
  children: ClusterNode[];
}

const MAX_FILES_PER_LEAF = 20;

// Structural / layout directories that group code by KIND, not by FEATURE. A cluster sharing one of
// these is not telling us anything about what the feature is, so they're excluded from dir-anchor
// labeling. Feature folders (fees/, scanners/, venues/) are deliberately NOT here.
const STRUCTURAL_DIR_SEGMENTS = new Set([
  "src", "lib", "test", "tests", "spec", "specs", "__tests__", "dist", "build", "out",
  "node_modules", "vendor", "main", "app", "pkg", "internal", "common", "shared", "core",
  "utils", "util", "helpers", "helper", "tools", "scripts", "bin", "public", "static",
  "assets", "docs", "examples", "demo", "demos", "fixtures", "mocks", "__mocks__", "types",
]);
const NON_CODE_NAVIGATE_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".geojson",
  ".csv",
  ".tsv",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".lock",
  ".env",
]);

async function fetchEmbeddings(inputs: string[]): Promise<number[][]> {
  return fetchEmbedding(inputs);
}

function isNavigableSourceCandidate(filePath: string): boolean {
  return isSupportedFile(filePath) && !NON_CODE_NAVIGATE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function embedFilesWithFallback(files: FileInfo[]): Promise<{ files: FileInfo[]; vectors: number[][]; skipped: number }> {
  if (files.length === 0) return { files: [], vectors: [], skipped: 0 };
  const texts = files.map((file) => `${file.header} ${file.relativePath} ${file.content}`);

  try {
    return { files, vectors: await fetchEmbeddings(texts), skipped: 0 };
  } catch (error) {
    const keptFiles: FileInfo[] = [];
    const vectors: number[][] = [];

    for (let i = 0; i < files.length; i++) {
      try {
        const [vector] = await fetchEmbeddings([texts[i]]);
        keptFiles.push(files[i]);
        vectors.push(vector);
      } catch {
      }
    }

    if (keptFiles.length === 0) throw error;
    return { files: keptFiles, vectors, skipped: files.length - keptFiles.length };
  }
}

// A comment line that is really just restating an import (e.g. a docstring line
// "from decimal import InvalidOperation") must not seed cluster labels — those tokens
// are module/stdlib vocabulary, not feature vocabulary. Strip them at the source.
function isImportLikeLine(text: string): boolean {
  return /^\s*(from\s+[\w.]+\s+import\b|import\s+[\w.]+|const\s+\{?[\w\s,]+\}?\s*=\s*require\(|export\s+\*\s+from\b)/.test(text);
}

function extractHeader(content: string): string {
  const lines = content.split("\n");
  const headerLines: string[] = [];
  for (const line of lines.slice(0, 5)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) {
      const text = trimmed.replace(/^\/\/\s*|^#\s*|^--\s*/, "");
      if (isImportLikeLine(text)) continue;
      headerLines.push(text);
    } else if (trimmed.length > 0) {
      break;
    }
  }
  return headerLines.join(" ").substring(0, 200);
}

function formatLineRange(line: number, endLine: number): string {
  return endLine > line ? `L${line}-L${endLine}` : `L${line}`;
}

// Exported for testing — the cluster-label heuristic is the audited surface (import-vocab leakage,
// bare repo-name labels, raw path globs). Tests assert it recovers feature-dir names.
export function deriveHeuristicLabel(cluster: { files: FileInfo[]; pathPattern: string | null }, index: number, allFiles?: FileInfo[]): string {
  if (cluster.pathPattern) return cluster.pathPattern;
  const stop = new Set([
    "the", "and", "for", "src", "test", "main", "tools", "core", "lib", "index", "is", "of",
    "to", "a", "in", "on", "with", "from", "into", "this", "that", "feature",
    "module", "modules", "file", "files", "function", "functions", "class", "classes", "type",
    "types", "test", "tests", "spec", "specs", "demo", "demos", "common", "shared", "util",
    "utils", "helper", "helpers", "import", "imports", "as",
    "const", "let", "var", "use", "client", "server", "default", "export", "import",
    "interface", "enum", "trait", "struct", "fn", "func", "def", "pub", "async", "await",
    "return", "true", "false", "null", "undefined", "new", "delete", "typeof",
    "value", "values", "data", "info", "result", "results", "item", "items", "list", "obj",
    "object", "objects", "param", "params", "arg", "args", "ref", "refs",
    // Generic project terms that show up everywhere; bad cluster labels.
    "project", "build", "system", "library", "framework", "runtime", "api", "service",
    "config", "configuration", "settings", "options", "preferences", "manage", "manager",
    "factory", "provider", "controller", "handler", "context", "node", "edge",
    // Python import vocabulary — these appear in headers/import lines across the whole project
    // and were producing cluster labels like [future], [annotations], [decimal].
    "future", "annotations", "decimal", "dataclass", "dataclasses", "pathlib", "typing",
    "collections", "abc", "abstractmethod", "enum", "datetime", "asyncio", "logging", "json",
    "os", "sys", "re", "math", "functools", "itertools", "contextlib", "warnings", "copy",
    "optional", "union", "any", "dict", "tuple", "callable", "iterator", "sequence", "mapping",
    "field", "namedtuple", "defaultdict", "counter", "path", "decimal",
    // Exception/type names that ride along on import lines and aren't feature vocabulary.
    "invalidoperation", "exception", "error", "errors", "valueerror", "keyerror", "typeerror",
    "runtimeerror", "getcontext", "localcontext", "rounding",
  ]);

  // 1) STRONGEST signal: a directory segment shared by ≥60% of cluster files IS the feature name.
  //    The clustering geometry already co-locates a feature's files, so the directory they share
  //    (`fees/`, `auth/`, `scanners/`) is the most reliable label — far more so than header tokens,
  //    which leak import/stdlib vocabulary. We exclude the repo-root segment so a cluster that simply
  //    spans the whole repo can't be labeled with the bare project name.
  //
  //    A directory name is filtered ONLY against structural-layout dirs (src/, lib/, tests/, …) — NOT
  //    the content stopword set. A folder named `scanners/` or `decimal/` is a real feature label even
  //    though those words are stopworded as header tokens; a directory name is intrinsically meaningful.
  const repoRootSegment = inferRepoRootSegment(cluster.files);
  const dirSegmentCounts = new Map<string, number>();
  for (const file of cluster.files) {
    // Only count the *immediate* parent directory of each file — the segment that actually groups
    // siblings — not every ancestor. Counting ancestors let a shallow common root win spuriously.
    const segs = file.relativePath.split("/").slice(0, -1);
    const parent = segs[segs.length - 1];
    if (!parent) continue;
    const lower = parent.toLowerCase();
    if (lower.length < 3 || STRUCTURAL_DIR_SEGMENTS.has(lower) || lower === repoRootSegment) continue;
    dirSegmentCounts.set(lower, (dirSegmentCounts.get(lower) ?? 0) + 1);
  }
  const sortedDirs = [...dirSegmentCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dirThreshold = Math.max(2, Math.ceil(cluster.files.length * 0.6));
  const dominantDir = sortedDirs.find(([, count]) => count >= dirThreshold);

  // 2) TF-IDF over header docstrings. A word's score = freq-in-cluster × log(totalClusters / freq-in-corpus).
  //    Without TF-IDF, common words like "manager" or "config" tie. With TF-IDF, distinctive feature
  //    nouns (e.g., "scanner", "venue", "fees") win.
  const clusterTermFreq = new Map<string, number>();
  for (const file of cluster.files) {
    if (!file.header) continue;
    const words = tokenizeHeader(file.header, stop);
    for (const word of words) clusterTermFreq.set(word, (clusterTermFreq.get(word) ?? 0) + 1);
  }
  const corpusTermFreq = new Map<string, number>();
  const totalFiles = allFiles?.length ?? cluster.files.length;
  if (allFiles) {
    for (const file of allFiles) {
      if (!file.header) continue;
      const words = new Set(tokenizeHeader(file.header, stop));
      for (const word of words) corpusTermFreq.set(word, (corpusTermFreq.get(word) ?? 0) + 1);
    }
  }
  const scored: Array<[string, number]> = [];
  for (const [word, freq] of clusterTermFreq) {
    if (freq < 2) continue;
    const df = corpusTermFreq.get(word) ?? freq;
    const idf = allFiles ? Math.log(1 + totalFiles / df) : 1;
    const score = freq * idf;
    scored.push([word, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const dominantHeader = scored[0];

  // 3) Combine. The directory name is the trusted anchor; the header word only refines it when it is
  //    a genuinely distinctive feature noun (passed TF-IDF with freq ≥ 2 across the cluster).
  if (dominantDir && dominantHeader && dominantDir[0] !== dominantHeader[0]) {
    return `${dominantDir[0]} (${dominantHeader[0]})`;
  }
  if (dominantDir) return dominantDir[0];
  if (dominantHeader) return dominantHeader[0];

  // 4) No dir anchor and no distinctive header term. Rather than emit a bare repo name or a raw path
  //    glob, summarize from filename basenames — but stopword-filter them so import/stdlib vocabulary
  //    (e.g. a `decimal.py` shim) can't become the label, and drop the repo-root token.
  const basenameTokens = new Map<string, number>();
  for (const f of cluster.files) {
    const base = f.relativePath.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
    for (const tok of base.toLowerCase().split(/[\s._-]+/)) {
      if (tok.length < 3 || stop.has(tok) || tok === repoRootSegment) continue;
      basenameTokens.set(tok, (basenameTokens.get(tok) ?? 0) + 1);
    }
  }
  const topBasenames = [...basenameTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  if (topBasenames.length > 0) return topBasenames.join(", ").substring(0, 50);
  return `Cluster ${index + 1}`;
}

// The repo-root directory segment (e.g. the project folder name) is NOT a useful feature label —
// it's shared by every file. Infer it as the first path segment common to all cluster files, if any.
function inferRepoRootSegment(files: { relativePath: string }[]): string | null {
  if (files.length === 0) return null;
  const firstSegs = files.map((f) => f.relativePath.split("/")[0]?.toLowerCase() ?? "");
  const candidate = firstSegs[0];
  if (!candidate) return null;
  return firstSegs.every((s) => s === candidate) ? candidate : null;
}

function tokenizeHeader(header: string, stop: Set<string>): string[] {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .split(/[\s/_-]+/)
    .filter((t) => t.length > 3 && !stop.has(t));
}

async function labelSiblingClusters(
  rootDir: string,
  clusters: { files: FileInfo[]; pathPattern: string | null }[],
  useChatModel: boolean,
): Promise<string[]> {
  if (clusters.length === 0) return [];
  if (clusters.length === 1) {
    const pp = clusters[0].pathPattern;
    if (pp) return [pp];
    return [clusters[0].files.map((f) => f.relativePath.split("/").pop()).join(", ").substring(0, 40)];
  }

  const allFilesCorpus = clusters.flatMap((c) => c.files);
  const heuristicLabels = clusters.map((c, i) => deriveHeuristicLabel(c, i, allFilesCorpus));
  if (!useChatModel) return heuristicLabels;

  const clusterDescriptions = clusters.map((c, i) => {
    const fileList = c.files.map((f) => `${f.relativePath}: ${f.header || "no description"}`).join("\n  ");
    const pattern = c.pathPattern ? ` (pattern: ${c.pathPattern})` : "";
    return `Cluster ${i + 1}${pattern}:\n  ${fileList}`;
  });

  const prompt = `You are labeling clusters of code files. For each cluster below, produce EXACTLY one JSON array of objects, each with:
- "overarchingTheme": a sentence about the cluster's theme
- "distinguishingFeature": what makes this cluster unique vs siblings
- "label": EXACTLY 2 words describing the cluster

${clusterDescriptions.join("\n\n")}

Respond with ONLY a JSON array of ${clusters.length} objects. No other text.`;

  try {
    const response = await chatCompletion(rootDir, prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      process.stderr.write(`[contextpro/cluster] degraded: chat model returned no JSON; using heuristic labels\n`);
      return heuristicLabels;
    }
    const labels = JSON.parse(jsonMatch[0]) as { label: string }[];
    return labels.map((l, i) => {
      const pp = clusters[i].pathPattern;
      const base = (l.label && l.label.trim().length > 0) ? l.label : heuristicLabels[i];
      return pp ? `${base} (${pp})` : base;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[contextpro/cluster] degraded: chat-model labeling failed (${message}); using heuristic labels\n`);
    return heuristicLabels;
  }
}

async function buildHierarchy(
  rootDir: string,
  files: FileInfo[],
  vectors: number[][],
  maxClusters: number,
  depth: number,
  maxDepth: number,
  useChatModel: boolean,
): Promise<ClusterNode> {
  if (files.length <= MAX_FILES_PER_LEAF || depth >= maxDepth) {
    return {
      label: "",
      pathPattern: findPathPattern(files.map((f) => f.relativePath)),
      files,
      children: [],
    };
  }

  const clusterResults = spectralCluster(vectors, maxClusters);

  if (clusterResults.length <= 1) {
    return {
      label: "",
      pathPattern: findPathPattern(files.map((f) => f.relativePath)),
      files,
      children: [],
    };
  }

  const childMetas = clusterResults.map((cluster) => ({
    files: cluster.indices.map((i) => files[i]),
    vectors: cluster.indices.map((i) => vectors[i]),
    pathPattern: findPathPattern(cluster.indices.map((i) => files[i].relativePath)),
  }));

  const labels = await labelSiblingClusters(
    rootDir,
    childMetas.map((c) => ({ files: c.files, pathPattern: c.pathPattern })),
    useChatModel,
  );

  const children: ClusterNode[] = [];
  for (let i = 0; i < childMetas.length; i++) {
    const child = await buildHierarchy(
      rootDir,
      childMetas[i].files,
      childMetas[i].vectors,
      maxClusters,
      depth + 1,
      maxDepth,
      useChatModel,
    );
    child.label = labels[i];
    children.push(child);
  }

  return {
    label: "",
    pathPattern: findPathPattern(files.map((f) => f.relativePath)),
    files: [],
    children,
  };
}

function renderClusterTree(node: ClusterNode, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  let result = "";

  if (node.label) {
    result += `${pad}[${node.label}]\n`;
  }

  if (node.children.length > 0) {
    for (const child of node.children) {
      result += renderClusterTree(child, indent + 1);
    }
  } else {
    for (const file of node.files) {
      const label = file.header ? ` - ${file.header}` : "";
      const symbols = file.symbolPreview.length > 0 ? ` | symbols: ${file.symbolPreview.join(", ")}` : "";
      result += `${pad}  ${file.relativePath}${label}${symbols}\n`;
    }
  }

  return result;
}

export async function semanticNavigate(options: SemanticNavigateOptions): Promise<string> {
  const maxClusters = options.maxClusters ?? 20;
  const maxDepth = options.maxDepth ?? 3;
  const useChatModel = await hasConfiguredChatModel(options.rootDir);

  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const fileEntries = entries.filter((e) => !e.isDirectory && isNavigableSourceCandidate(e.path));

  if (fileEntries.length === 0) return "No supported source files found in the project.";

  const files: FileInfo[] = [];
  for (const entry of fileEntries) {
    try {
      const content = await readFile(entry.path, "utf-8");
      let header = extractHeader(content);
      let symbolPreview: string[] = [];
      try {
        const analysis = await analyzeFile(entry.path);
        if (analysis.header) header = analysis.header;
        symbolPreview = flattenSymbols(analysis.symbols)
          .slice(0, 3)
          .map((s) => `${s.name}@${formatLineRange(s.line, s.endLine)}`);
      } catch {
      }
      files.push({
        relativePath: entry.relativePath,
        header,
        content: content.substring(0, 500),
        symbolPreview,
      });
    } catch {
    }
  }

  if (files.length === 0) return "Could not read any source files.";

  let embeddableFiles: FileInfo[] = files;
  let vectors: number[][] = [];
  let skippedForEmbedding = 0;
  try {
    const embedded = await embedFilesWithFallback(files);
    embeddableFiles = embedded.files;
    vectors = embedded.vectors;
    skippedForEmbedding = embedded.skipped;
  } catch (err) {
    const provider = getProvider();
    const providerHint = provider === "openai"
      ? `Check CONTEXTPRO_API_KEY and CONTEXTPRO_BASE_URL.`
      : `Make sure Ollama is running (check OLLAMA_HOST) and that the embedding model configured in CONTEXTPRO_EMBED_MODEL is available.`;
    return `Embedding provider (${provider}) not available: ${err instanceof Error ? err.message : String(err)}\n${providerHint}`;
  }

  if (embeddableFiles.length === 0) return "No embeddable source files found in the project.";

  if (embeddableFiles.length <= MAX_FILES_PER_LEAF) {
    let fileLabels = embeddableFiles.map((file) => file.header);
    if (useChatModel) {
      try {
        const prompt = `For each file below, produce a 3-7 word description. Return ONLY a JSON array of strings.\n\n${embeddableFiles.map((f) => `${f.relativePath}: ${f.header}`).join("\n")}`;
        const response = await chatCompletion(options.rootDir, prompt);
        const match = response.match(/\[[\s\S]*\]/);
        fileLabels = match ? JSON.parse(match[0]) : fileLabels;
      } catch {
      }
    }

    const summary = skippedForEmbedding > 0
      ? `Semantic Navigator: ${embeddableFiles.length} files (${skippedForEmbedding} skipped due embedding limits)\n`
      : `Semantic Navigator: ${embeddableFiles.length} files\n`;
    const lines = [summary];
    for (let i = 0; i < embeddableFiles.length; i++) {
      const symbols = embeddableFiles[i].symbolPreview.length > 0 ? ` | symbols: ${embeddableFiles[i].symbolPreview.join(", ")}` : "";
      lines.push(`  ${embeddableFiles[i].relativePath} - ${fileLabels[i] || embeddableFiles[i].header}${symbols}`);
    }
    return lines.join("\n");
  }

  const tree = await buildHierarchy(options.rootDir, embeddableFiles, vectors, maxClusters, 0, maxDepth, useChatModel);
  tree.label = "Project";

  const summary = skippedForEmbedding > 0
    ? `Semantic Navigator: ${embeddableFiles.length} files organized by meaning (${skippedForEmbedding} skipped due embedding limits)`
    : `Semantic Navigator: ${embeddableFiles.length} files organized by meaning`;

  return `${summary}\n\n${renderClusterTree(tree)}`;
}
