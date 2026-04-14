#!/usr/bin/env node
// Context+ MCP - Semantic codebase navigator for AI agents
// Structural AST tree, blast radius, semantic search, commit gatekeeper

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { copyFile, mkdir, readdir, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { z } from "zod";
import { createEmbeddingTrackerController } from "./core/embedding-tracker.js";
import { createIdleMonitor, getIdleShutdownMs, getParentPollMs, isBrokenPipeError, runCleanup, startParentMonitor } from "./core/process-lifecycle.js";
import { getContextTree } from "./tools/context-tree.js";
import { getFileSkeleton } from "./tools/file-skeleton.js";
import { cancelAllEmbeddings } from "./core/embeddings.js";
import { unifiedSearch, invalidateSearchCache, invalidateIdentifierSearchCache } from "./tools/search.js";
import { getBlastRadius } from "./tools/blast-radius.js";
import { runStaticAnalysis } from "./tools/static-analysis.js";
import { proposeCommit } from "./tools/propose-commit.js";
import { listRestorePoints, restorePoint } from "./git/shadow.js";
import { semanticNavigate } from "./tools/semantic-navigate.js";
import { getFeatureHub } from "./tools/feature-hub.js";
import { toolUpsertMemoryNode, toolCreateRelation, toolSearchMemoryGraph, toolAddInterlinkedContext, toolRetrieveWithTraversal } from "./tools/memory-tools.js";
import { reindex, quickRefresh } from "./tools/reindex.js";
import { getStatus } from "./tools/status.js";
import { getDiff } from "./tools/diff.js";
import { getRelated } from "./tools/related.js";
import { getTestMap } from "./tools/test-map.js";
import { explain } from "./tools/explain.js";
import { getRepoMap } from "./tools/repo-map.js";
import { resolveSymbol } from "./tools/resolve-symbol.js";
import { ensureProjectConfig, registerWorkspace, verifyProjectContext } from "./core/project-config.js";
import { buildTaskPack, buildChangeImpact, buildEditScope, buildDecisionBrief, recordTaskMemory, getWorkspaceContext, promotePattern } from "./tools/agentic-context.js";
import { formatStartupHealthReport, runStartupHealthCheck } from "./core/startup-health.js";
import { formatDoctorReport, runDoctor } from "./core/doctor.js";

type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode";

const AGENT_CONFIG_PATH: Record<AgentTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  windsurf: ".windsurf/mcp.json",
  opencode: "opencode.json",
};

const SUB_COMMANDS = ["init", "skeleton", "tree", "doctor"];
const INSTRUCTIONS_SOURCE_URL = "https://contextplus.vercel.app/api/instructions";
const INSTRUCTIONS_RESOURCE_URI = "contextplus://instructions";

let noteServerActivity = () => { };
let ensureTrackerRunning = () => { };

interface ParsedCliArgs {
  command?: string;
  rootDir: string;
  runner?: string;
  projectId?: string;
  clientId?: string;
  sessionSource?: string;
  fix?: boolean;
  positional: string[];
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    rootDir: process.cwd(),
    positional: [],
  };
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (index === 0 && SUB_COMMANDS.includes(arg)) {
      parsed.command = arg;
      index += 1;
      continue;
    }
    if (arg.startsWith("--runner=")) {
      parsed.runner = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--runner") {
      parsed.runner = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--project-id=")) {
      parsed.projectId = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--client-id=")) {
      parsed.clientId = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--client-id") {
      parsed.clientId = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--session-source=")) {
      parsed.sessionSource = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--session-source") {
      parsed.sessionSource = args[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--fix") {
      parsed.fix = true;
      index += 1;
      continue;
    }
    parsed.positional.push(arg);
    index += 1;
  }
  if (parsed.command === "init") {
    if (parsed.positional.length > 0) parsed.positional = parsed.positional.slice(0, 1);
  } else if (parsed.command === "tree" || parsed.command === "skeleton") {
    if (parsed.positional.length > 0) parsed.rootDir = resolve(parsed.positional[0]);
  } else if (parsed.positional.length > 0) {
    parsed.rootDir = resolve(parsed.positional[0]);
  }
  return parsed;
}

const parsedCliArgs = parseCliArgs(process.argv.slice(2));
const ROOT_DIR = parsedCliArgs.rootDir;

function withRequestActivity<TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean },
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    noteServerActivity();
    if (options?.useEmbeddingTracker) ensureTrackerRunning();
    await verifyProjectContext(ROOT_DIR);
    return handler(args);
  };
}

function parseAgentTarget(input?: string): AgentTarget {
  const normalized = (input ?? "claude").toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "vscode" || normalized === "vs-code" || normalized === "vs") return "vscode";
  if (normalized === "windsurf") return "windsurf";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  throw new Error(`Unsupported coding agent \"${input}\". Use one of: claude, cursor, vscode, windsurf, opencode.`);
}

function parseRunner(args: string[]): "npx" | "bunx" {
  const parsed = parseCliArgs(args);
  if (parsed.runner) {
    if (parsed.runner === "npx" || parsed.runner === "bunx") return parsed.runner;
    throw new Error(`Unsupported runner \"${parsed.runner}\". Use --runner=npx or --runner=bunx.`);
  }
  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();
  if (userAgent.includes("bun/") || execPath.includes("bun")) return "bunx";
  return "npx";
}

async function migrateFromMcpData(rootDir: string): Promise<void> {
  const oldDir = join(rootDir, ".mcp_data");
  const newDir = join(rootDir, ".contextplus");
  try {
    await stat(oldDir);
  } catch {
    return;
  }
  try {
    await stat(newDir);
    return;
  } catch {}

  console.error("Migrating .mcp_data/ → .contextplus/ ...");
  await mkdir(join(newDir, "backups"), { recursive: true });
  await mkdir(join(newDir, "hubs"), { recursive: true });

  const entries = await readdir(oldDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "backups" && entry.isDirectory()) {
      const backupEntries = await readdir(join(oldDir, "backups"), { withFileTypes: true });
      for (const be of backupEntries) {
        const src = join(oldDir, "backups", be.name);
        const dst = join(newDir, "backups", be.name);
        if (be.isDirectory()) {
          await mkdir(dst, { recursive: true });
          const files = await readdir(src);
          for (const f of files) {
            await copyFile(join(src, f), join(dst, f));
          }
        } else {
          await copyFile(src, dst);
        }
      }
    } else if (entry.isFile()) {
      await copyFile(join(oldDir, entry.name), join(newDir, entry.name));
    }
  }
  console.error("Migration complete. You can safely delete .mcp_data/");
}

async function ensureContextPlusDir(rootDir: string): Promise<void> {
  await migrateFromMcpData(rootDir);
  await mkdir(join(rootDir, ".contextplus", "backups"), { recursive: true });
  await mkdir(join(rootDir, ".contextplus", "hubs"), { recursive: true });
}

function buildMcpConfig(runner: "npx" | "bunx") {
  const commandArgs = runner === "npx" ? ["-y", "contextplus"] : ["contextplus"];
  return JSON.stringify(
    {
      mcpServers: {
        contextplus: {
          command: runner,
          args: commandArgs,
          env: {
            OLLAMA_EMBED_MODEL: "nomic-embed-text",
            OLLAMA_CHAT_MODEL: "gemma2:27b",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
          },
        },
      },
    },
    null,
    2,
  );
}

async function runDoctorCommand(args: string[]) {
  const parsed = parseCliArgs(["doctor", ...args]);
  const report = await runDoctor(parsed.rootDir, parsed.fix === true);
  process.stdout.write(formatDoctorReport(report) + "\n");
}

function buildOpenCodeConfig(runner: "npx" | "bunx") {
  const command = runner === "npx" ? ["npx", "-y", "contextplus"] : ["bunx", "contextplus"];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        contextplus: {
          type: "local",
          command,
          enabled: true,
          environment: {
            OLLAMA_EMBED_MODEL: "nomic-embed-text",
            OLLAMA_CHAT_MODEL: "gemma2:27b",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
          },
        },
      },
    },
    null,
    2,
  );
}

async function runInitCommand(args: string[]) {
  const parsed = parseCliArgs(["init", ...args]);
  const target = parseAgentTarget(parsed.positional[0]);
  const runner = parseRunner(args);
  const outputPath = resolve(process.cwd(), AGENT_CONFIG_PATH[target]);
  const content = target === "opencode" ? buildOpenCodeConfig(runner) : buildMcpConfig(runner);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${content}\n`, "utf8");

  const contextPlusDir = join(process.cwd(), ".contextplus");
  await mkdir(join(contextPlusDir, "backups"), { recursive: true });
  await mkdir(join(contextPlusDir, "hubs"), { recursive: true });
  const configPath = join(contextPlusDir, "config.json");
  try {
    await stat(configPath);
  } catch {
    await writeFile(configPath, JSON.stringify({ provider: "ollama", embedModel: "nomic-embed-text", chatModel: "llama3.2" }, null, 2) + "\n");
  }
  await ensureProjectConfig({
    rootDir: process.cwd(),
    projectId: parsed.projectId,
    clientId: parsed.clientId,
    sessionSource: parsed.sessionSource ?? "mcp",
  });

  console.error(`Context+ initialized for ${target} using ${runner}.`);
  console.error(`Wrote MCP config: ${outputPath}`);
  console.error(`Created .contextplus/ directory with config.json`);
}

const server = new McpServer({
  name: "contextplus",
  version: "1.0.0",
}, {
  capabilities: { logging: {} },
});

server.resource(
  "contextplus_instructions",
  INSTRUCTIONS_RESOURCE_URI,
  withRequestActivity(async (uri) => {
    const response = await fetch(INSTRUCTIONS_SOURCE_URL);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: await response.text(),
      }],
    };
  }),
);

server.tool(
  "health",
  "Report Context+ startup health, including active root, project identity, Node ABI, native storage status, and database readiness.",
  {
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  async ({ format }) => {
    noteServerActivity();
    const report = await runStartupHealthCheck(ROOT_DIR);
    return {
      content: [{
        type: "text" as const,
        text: format === "json" ? JSON.stringify(report, null, 2) : formatStartupHealthReport(report),
      }],
    };
  },
);

server.tool(
  "repo_map",
  "Return a compact repository map with important files and top-level symbols. Optimized for first-turn agent orientation with low token usage.",
  {
    target_path: z.string().optional().describe("Optional subdirectory prefix to scope the map."),
    include_signatures: z.boolean().optional().describe("Include symbol signatures. Defaults to true."),
    max_files: z.number().optional().describe("Maximum files to include. Default: 40."),
    max_symbols_per_file: z.number().optional().describe("Maximum top-level symbols per file. Default: 8."),
    max_tokens: z.number().optional().describe("Approximate token budget for text output. Default: 2000."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ target_path, include_signatures, max_files, max_symbols_per_file, max_tokens, format }) => ({
    content: [{
      type: "text" as const,
      text: await getRepoMap({
        rootDir: ROOT_DIR,
        targetPath: target_path,
        includeSignatures: include_signatures,
        maxFiles: max_files,
        maxSymbolsPerFile: max_symbols_per_file,
        maxTokens: max_tokens,
        format,
      }),
    }],
  })),
);

server.tool(
  "resolve_symbol",
  "Resolve an identifier to the most likely definition with ambiguity scoring. Use this before explain/refactor work when a symbol name appears in multiple files.",
  {
    symbol_name: z.string().describe("The symbol or identifier name to resolve."),
    file_context: z.string().optional().describe("Optional current file path to bias resolution using import context and locality."),
    kind: z.string().optional().describe("Optional expected kind, e.g. function, method, class, interface."),
    limit: z.number().optional().describe("Maximum candidates to return. Default: 8."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ symbol_name, file_context, kind, limit, format }) => ({
    content: [{
      type: "text" as const,
      text: await resolveSymbol({
        rootDir: ROOT_DIR,
        symbolName: symbol_name,
        fileContext: file_context,
        kind,
        limit,
        format,
      }),
    }],
  })),
);

server.tool(
  "tree",
  "Get the structural tree of the project with file headers, function names, classes, enums, and line ranges. " +
  "Automatically reads 2-line headers for file purpose. Dynamic token-aware pruning: " +
  "Level 2 (deep symbols) -> Level 1 (headers only) -> Level 0 (file names only) based on project size.",
  {
    target_path: z.string().optional().describe("Specific directory or file to analyze (relative to project root). Defaults to root."),
    depth_limit: z.number().optional().describe("How many folder levels deep to scan. Use 1-2 for large projects."),
    include_symbols: z.boolean().optional().describe("Include function/class/enum names in the tree. Defaults to true."),
    max_tokens: z.number().optional().describe("Maximum tokens for output. Auto-prunes if exceeded. Default: 20000."),
  },
  withRequestActivity(async ({ target_path, depth_limit, include_symbols, max_tokens }) => ({
    content: [{
      type: "text" as const,
      text: await getContextTree({
        rootDir: ROOT_DIR,
        targetPath: target_path,
        depthLimit: depth_limit,
        includeSymbols: include_symbols,
        maxTokens: max_tokens,
      }),
    }],
  })),
);

server.tool(
  "skeleton",
  "Get detailed function signatures, class methods, and type definitions of a specific file WITHOUT reading the full body. " +
  "Shows the API surface: function names, parameters, return types, and line ranges. Perfect for understanding how to use code without loading it all.",
  {
    file_path: z.string().describe("Path to the file to inspect (relative to project root)."),
  },
  withRequestActivity(async ({ file_path }) => ({
    content: [{
      type: "text" as const,
      text: await getFileSkeleton({ rootDir: ROOT_DIR, filePath: file_path }),
    }],
  })),
);

server.tool(
  "search",
  "Search the codebase by MEANING. Modes: 'file' searches file headers/symbols, 'identifier' searches function/class definitions with call chains, " +
  "'hybrid' (default) runs both and returns combined results. Uses embeddings for semantic matching plus keyword overlap scoring.",
  {
    query: z.string().describe("Natural language description of what you're looking for."),
    mode: z.enum(["file", "identifier", "hybrid"]).optional().describe("Search mode: 'file' for files, 'identifier' for functions/classes, 'hybrid' for both. Default: hybrid."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    top_k: z.number().optional().describe("Number of matches to return. Default: 5."),
    top_calls_per_identifier: z.number().optional().describe("How many ranked call sites per identifier (identifier/hybrid mode). Default: 10."),
    include_kinds: z.array(z.string()).optional().describe("Filter identifier kinds, e.g. [\"function\", \"method\"]. Only for identifier/hybrid mode."),
    semantic_weight: z.number().optional().describe("Weight for embedding similarity. Default: 0.72."),
    keyword_weight: z.number().optional().describe("Weight for keyword overlap. Default: 0.28."),
    min_semantic_score: z.number().optional().describe("Minimum semantic score filter. Accepts 0-1 or 0-100."),
    min_keyword_score: z.number().optional().describe("Minimum keyword score filter. Accepts 0-1 or 0-100."),
    min_combined_score: z.number().optional().describe("Minimum final score filter. Accepts 0-1 or 0-100."),
    require_keyword_match: z.boolean().optional().describe("When true, only return results with keyword overlap."),
    require_semantic_match: z.boolean().optional().describe("When true, only return results with positive semantic similarity."),
  },
  withRequestActivity(async (args) => ({
    content: [{
      type: "text" as const,
      text: await unifiedSearch({
        rootDir: ROOT_DIR,
        query: args.query,
        mode: args.mode,
        format: args.format,
        topK: args.top_k,
        topCallsPerIdentifier: args.top_calls_per_identifier,
        includeKinds: args.include_kinds,
        semanticWeight: args.semantic_weight,
        keywordWeight: args.keyword_weight,
        minSemanticScore: args.min_semantic_score,
        minKeywordScore: args.min_keyword_score,
        minCombinedScore: args.min_combined_score,
        requireKeywordMatch: args.require_keyword_match,
        requireSemanticMatch: args.require_semantic_match,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "blast_radius",
  "Before deleting or modifying code, check the BLAST RADIUS. Traces every file and line where a specific symbol " +
  "(function, class, variable) is imported or used. Prevents orphaned code. Also warns if usage count is low (candidate for inlining).",
  {
    symbol_name: z.string().describe("The function, class, or variable name to trace across the codebase."),
    file_context: z.string().optional().describe("The file where the symbol is defined. Excludes the definition line from results."),
  },
  withRequestActivity(async ({ symbol_name, file_context }) => ({
    content: [{
      type: "text" as const,
      text: await getBlastRadius({ rootDir: ROOT_DIR, symbolName: symbol_name, fileContext: file_context }),
    }],
  })),
);

server.tool(
  "lint",
  "Auto-detects and runs project linters (tsc, eslint, ruff, cargo check, go vet). " +
  "Also checks code skill score: 2-line headers, no inline comments, nesting depth, file length.",
  {
    target_path: z.string().optional().describe("Specific file or folder to lint (relative to root). Omit for full project."),
  },
  withRequestActivity(async ({ target_path }) => ({
    content: [{
      type: "text" as const,
      text: await runStaticAnalysis({ rootDir: ROOT_DIR, targetPath: target_path }),
    }],
  })),
);

server.tool(
  "checkpoint",
  "Save code with validation. Checks 2-line headers, no inline comments, max nesting depth, max file length. " +
  "Creates a shadow restore point before writing. Use during long work sessions for safe mid-work saves.",
  {
    file_path: z.string().describe("Where to save the file (relative to project root)."),
    new_content: z.string().describe("The complete file content to save."),
  },
  withRequestActivity(async ({ file_path, new_content }) => {
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    return {
      content: [{
        type: "text" as const,
        text: await proposeCommit({ rootDir: ROOT_DIR, filePath: file_path, newContent: new_content }),
      }],
    };
  }),
);

server.tool(
  "checkpoints",
  "List all shadow restore points created by checkpoint. Each point captures the file state before changes. " +
  "Use this to find a restore point ID for undoing a bad change.",
  {},
  withRequestActivity(async () => {
    const points = await listRestorePoints(ROOT_DIR);
    if (points.length === 0) return { content: [{ type: "text" as const, text: "No restore points found." }] };

    const lines = points.map((p) =>
      `${p.id} | ${new Date(p.timestamp).toISOString()} | ${p.files.join(", ")} | ${p.message}`,
    );
    return { content: [{ type: "text" as const, text: `Restore Points (${points.length}):\n\n${lines.join("\n")}` }] };
  }),
);

server.tool(
  "restore",
  "Restore files to their state before a specific change. Uses the shadow restore point system. " +
  "Does NOT affect git history. Call checkpoints first to find the point ID.",
  {
    point_id: z.string().describe("The restore point ID (format: rp-timestamp-hash). Get from list_restore_points."),
  },
  withRequestActivity(async ({ point_id }) => {
    const restored = await restorePoint(ROOT_DIR, point_id);
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    return {
      content: [{
        type: "text" as const,
        text: restored.length > 0
          ? `Restored ${restored.length} file(s):\n${restored.join("\n")}`
          : "No files were restored. The backup may be empty.",
      }],
    };
  }),
);

server.tool(
  "cluster",
  "Browse the codebase by MEANING, not directory structure. Uses spectral clustering on embeddings to group " +
  "semantically related files into labeled clusters. Requires an embedding model and a chat model for labeling.",
  {
    max_depth: z.number().optional().describe("Maximum nesting depth of clusters. Default: 3."),
    max_clusters: z.number().optional().describe("Maximum sub-clusters per level. Default: 20."),
  },
  withRequestActivity(async ({ max_depth, max_clusters }) => ({
    content: [{
      type: "text" as const,
      text: await semanticNavigate({ rootDir: ROOT_DIR, maxDepth: max_depth, maxClusters: max_clusters }),
    }],
  })),
);

server.tool(
  "hub",
  "Feature hub navigator. Hub files are .md files containing [[path/to/file]] wikilinks that act as a Map of Content. " +
  "No args = list all hubs. hub_path or feature_name = show hub with bundled skeletons. show_orphans = find unlinked files.",
  {
    hub_path: z.string().optional().describe("Path to a specific hub .md file (relative to root)."),
    feature_name: z.string().optional().describe("Feature name to search for. Finds matching hub file automatically."),
    show_orphans: z.boolean().optional().describe("If true, lists all source files not linked to any feature hub."),
  },
  withRequestActivity(async ({ hub_path, feature_name, show_orphans }) => ({
    content: [{
      type: "text" as const,
      text: await getFeatureHub({
        rootDir: ROOT_DIR,
        hubPath: hub_path,
        featureName: feature_name,
        showOrphans: show_orphans,
      }),
    }],
  })),
);

server.tool(
  "memory_create",
  "Create or update a memory node. Nodes represent concepts, files, symbols, or notes with auto-generated embeddings. " +
  "If a node with the same label and type exists, it updates content. Returns the node ID for use in memory_link.",
  {
    type: z.enum(["concept", "file", "symbol", "note"]).describe("Node type: concept (abstract ideas), file (source files), symbol (functions/classes), note (free-form)."),
    label: z.string().describe("Short identifier for the node. Used for deduplication with type."),
    content: z.string().describe("Detailed content for the node. Used for embedding generation."),
    metadata: z.record(z.string()).optional().describe("Optional key-value metadata pairs."),
    scope: z.enum(["session", "project", "client", "global"]).optional().describe("Memory scope. Defaults to project."),
  },
  withRequestActivity(async ({ type, label, content, metadata, scope }) => ({
    content: [{
      type: "text" as const,
      text: await toolUpsertMemoryNode({ rootDir: ROOT_DIR, type, label, content, metadata, scope }),
    }],
  })),
);

server.tool(
  "memory_link",
  "Create a typed edge between two memory nodes. Supports: relates_to, depends_on, implements, references, similar_to, contains. " +
  "Edges have weights (0-1) that decay over time. Duplicate edges update weight.",
  {
    source_id: z.string().describe("ID of the source memory node."),
    target_id: z.string().describe("ID of the target memory node."),
    relation: z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains"]).describe("Relationship type between nodes."),
    weight: z.number().optional().describe("Edge weight 0-1. Higher = stronger relationship. Default: 1.0."),
    metadata: z.record(z.string()).optional().describe("Optional key-value metadata for the edge."),
  },
  withRequestActivity(async ({ source_id, target_id, relation, weight, metadata }) => ({
    content: [{
      type: "text" as const,
      text: await toolCreateRelation({ rootDir: ROOT_DIR, sourceId: source_id, targetId: target_id, relation, weight, metadata }),
    }],
  })),
);

server.tool(
  "memory_search",
  "Search the memory graph by meaning with graph traversal. Finds direct matches via embedding similarity, " +
  "then traverses neighbors to discover linked context. Returns hits and graph-connected neighbors with relevance scores.",
  {
    query: z.string().describe("Natural language query to search the memory graph."),
    max_depth: z.number().optional().describe("How many hops to traverse from direct matches. Default: 1."),
    top_k: z.number().optional().describe("Number of direct matches to return. Default: 5."),
    scope: z.enum(["session", "project", "client", "global"]).optional().describe("Retrieval scope. Defaults to project."),
    edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains"])).optional()
      .describe("Only traverse edges of these types. Omit for all types."),
  },
  withRequestActivity(async ({ query, max_depth, top_k, edge_filter, scope }) => ({
    content: [{
      type: "text" as const,
      text: await toolSearchMemoryGraph({ rootDir: ROOT_DIR, query, maxDepth: max_depth, topK: top_k, edgeFilter: edge_filter, scope }),
    }],
  })),
);

server.tool(
  "memory_bulk",
  "Bulk-add multiple memory nodes with automatic similarity linking. Creates similarity edges between pairs " +
  "with cosine similarity ≥ 0.72. Ideal for importing related concepts, files, or notes at once.",
  {
    items: z.array(z.object({
      type: z.enum(["concept", "file", "symbol", "note"]),
      label: z.string(),
      content: z.string(),
      metadata: z.record(z.string()).optional(),
    })).describe("Array of nodes to add. Each needs type, label, and content."),
    auto_link: z.boolean().optional().describe("Whether to auto-create similarity edges. Default: true."),
    scope: z.enum(["session", "project", "client", "global"]).optional().describe("Memory scope. Defaults to project."),
  },
  withRequestActivity(async ({ items, auto_link, scope }) => ({
    content: [{
      type: "text" as const,
      text: await toolAddInterlinkedContext({ rootDir: ROOT_DIR, items, autoLink: auto_link, scope }),
    }],
  })),
);

server.tool(
  "memory_explore",
  "Start from a memory node and traverse outward. Returns the starting node plus all reachable neighbors " +
  "within the depth limit, scored by edge weight decay and depth penalty. Use after memory_search to explore a node's neighborhood.",
  {
    start_node_id: z.string().describe("ID of the memory node to start traversal from."),
    max_depth: z.number().optional().describe("Maximum traversal depth from start node. Default: 2."),
    edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains"])).optional()
      .describe("Only traverse edges of these types. Omit for all."),
  },
  withRequestActivity(async ({ start_node_id, max_depth, edge_filter }) => ({
    content: [{
      type: "text" as const,
      text: await toolRetrieveWithTraversal({ rootDir: ROOT_DIR, startNodeId: start_node_id, maxDepth: max_depth, edgeFilter: edge_filter }),
    }],
  })),
);

server.tool(
  "reindex",
  "Re-walk, re-parse, and re-index project files into the database. Detects changed files via content hash and only re-processes what changed. " +
  "Use after git pull, branch switch, or external edits. Builds the import graph for related/test_map tools.",
  {
    target_path: z.string().optional().describe("Scope reindex to a specific directory (relative to root)."),
    force: z.boolean().optional().describe("Force re-process all files, ignoring cache. Default: false."),
  },
  withRequestActivity(async ({ target_path, force }) => ({
    content: [{
      type: "text" as const,
      text: await reindex({ rootDir: ROOT_DIR, targetPath: target_path, force }),
    }],
  })),
);

server.tool(
  "status",
  "Project overview dashboard. Returns file counts, index state, memory graph stats, git branch, uncommitted changes, and recent commits. " +
  "One call for complete situational awareness at the start of a session.",
  {
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ format }) => ({
    content: [{
      type: "text" as const,
      text: await getStatus({ rootDir: ROOT_DIR, format }),
    }],
  })),
);

server.tool(
  "diff",
  "Structured git diff showing changed files, lines added/removed, and affected symbols. " +
  "Supports: working tree (default), since a commit, vs a branch, or a specific file.",
  {
    since: z.string().optional().describe("Show changes since this commit (e.g. HEAD~3, abc123)."),
    branch: z.string().optional().describe("Compare current branch against this branch (e.g. main)."),
    file: z.string().optional().describe("Show diff for a specific file (includes raw diff output)."),
  },
  withRequestActivity(async ({ since, branch, file }) => ({
    content: [{
      type: "text" as const,
      text: await getDiff({ rootDir: ROOT_DIR, since, branch, file }),
    }],
  })),
);

server.tool(
  "related",
  "Show files related to a given file: what it imports, what imports it, same-directory siblings, test file, and hub membership. " +
  "Requires reindex to have been run for import graph data.",
  {
    file: z.string().describe("File path to find related files for (relative to root)."),
  },
  withRequestActivity(async ({ file }) => ({
    content: [{
      type: "text" as const,
      text: await getRelated({ rootDir: ROOT_DIR, file }),
    }],
  })),
);

server.tool(
  "test_map",
  "Map source files to their test files using import graph and naming conventions. " +
  "Modes: specific file, specific symbol, or all uncommitted changed files.",
  {
    file: z.string().optional().describe("Source file to find tests for."),
    symbol: z.string().optional().describe("Symbol name — finds which file defines it, then its tests."),
    changed: z.boolean().optional().describe("Find tests for all uncommitted changed files."),
  },
  withRequestActivity(async ({ file, symbol, changed }) => ({
    content: [{
      type: "text" as const,
      text: await getTestMap({ rootDir: ROOT_DIR, file, symbol, changed }),
    }],
  })),
);

server.tool(
  "explain",
  "Extract a specific function/class body with its dependencies, without reading the entire file. " +
  "Provide symbol name to get its code + called functions. Provide file path for a structural overview.",
  {
    symbol: z.string().optional().describe("Function, class, or variable name to explain."),
    file: z.string().optional().describe("File to explain (overview mode if no symbol given)."),
    depth: z.number().optional().describe("How many levels of called functions to include. Default: 1. Use 0 for just the symbol."),
  },
  withRequestActivity(async ({ symbol, file, depth }) => ({
    content: [{
      type: "text" as const,
      text: await explain({ rootDir: ROOT_DIR, symbol, file, depth }),
    }],
  })),
);

server.tool(
  "task_pack",
  "Assemble the minimum useful working set for a task: ranked files, nearby tests, recent diffs, memory, and risks.",
  {
    task: z.string().describe("Task description or engineering objective."),
    max_files: z.number().optional().describe("Maximum ranked files to include. Default: 8."),
    include_tests: z.boolean().optional().describe("Include nearby tests. Default: true."),
    include_recent_diffs: z.boolean().optional().describe("Include recent file-level diffs. Default: true."),
    include_memory: z.boolean().optional().describe("Include project memory hits. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ task, max_files, include_tests, include_recent_diffs, include_memory, format }) => ({
    content: [{
      type: "text" as const,
      text: await buildTaskPack({
        rootDir: ROOT_DIR,
        task,
        maxFiles: max_files,
        includeTests: include_tests,
        includeRecentDiffs: include_recent_diffs,
        includeMemory: include_memory,
        format,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "change_impact",
  "Estimate what could break if specific files or symbols change, including related files, tests, churn, and reasons.",
  {
    files: z.array(z.string()).optional().describe("Files to analyze for impact."),
    symbols: z.array(z.string()).optional().describe("Symbols to analyze for impact."),
    include_tests: z.boolean().optional().describe("Include likely impacted tests. Default: true."),
    include_recent_churn: z.boolean().optional().describe("Include recent churn in risk scoring. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ files, symbols, include_tests, include_recent_churn, format }) => ({
    content: [{
      type: "text" as const,
      text: await buildChangeImpact({
        rootDir: ROOT_DIR,
        files,
        symbols,
        includeTests: include_tests,
        includeRecentChurn: include_recent_churn,
        format,
      }),
    }],
  })),
);

server.tool(
  "edit_scope",
  "Identify the smallest likely safe edit set for a task, including likely source files and nearby tests.",
  {
    task: z.string().describe("Task description or intended change."),
    max_files: z.number().optional().describe("Maximum files to recommend. Default: 5."),
    prefer_smallest_scope: z.boolean().optional().describe("Bias toward the smallest safe scope. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ task, max_files, prefer_smallest_scope, format }) => ({
    content: [{
      type: "text" as const,
      text: await buildEditScope({
        rootDir: ROOT_DIR,
        task,
        maxFiles: max_files,
        preferSmallestScope: prefer_smallest_scope,
        format,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "decision_brief",
  "Compress a subsystem or task into a short decision-oriented brief with ranked files, symbols, tests, hubs, and memory.",
  {
    query: z.string().describe("Subsystem, area, or task query."),
    include_hubs: z.boolean().optional().describe("Include matching hubs. Default: true."),
    include_memory: z.boolean().optional().describe("Include project memory. Default: true."),
    include_tests: z.boolean().optional().describe("Include nearby tests. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ query, include_hubs, include_memory, include_tests, format }) => ({
    content: [{
      type: "text" as const,
      text: await buildDecisionBrief({
        rootDir: ROOT_DIR,
        query,
        includeHubs: include_hubs,
        includeMemory: include_memory,
        includeTests: include_tests,
        format,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "memory_record_task",
  "Persist useful task outcomes with linked files, assumptions, evidence, and open risks for future sessions.",
  {
    task: z.string().describe("Task or issue name."),
    summary: z.string().describe("What changed or was learned."),
    files: z.array(z.string()).optional().describe("Files touched or relevant to the task."),
    assumptions: z.array(z.string()).optional().describe("Assumptions made during the task."),
    evidence: z.array(z.string()).optional().describe("Evidence supporting the outcome."),
    open_risks: z.array(z.string()).optional().describe("Risks that remain unresolved."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ task, summary, files, assumptions, evidence, open_risks, format }) => ({
    content: [{
      type: "text" as const,
      text: await recordTaskMemory({
        rootDir: ROOT_DIR,
        task,
        summary,
        files,
        assumptions,
        evidence,
        openRisks: open_risks,
        format,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "workspace_context",
  "List active registered projects and recent sessions without merging project-internal code context.",
  {
    client_id: z.string().optional().describe("Filter to a specific client or engagement."),
    include_projects: z.boolean().optional().describe("Include project entries. Default: true."),
    include_recent_sessions: z.boolean().optional().describe("Include recent session summaries. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ client_id, include_projects, include_recent_sessions, format }) => ({
    content: [{
      type: "text" as const,
      text: await getWorkspaceContext({
        clientId: client_id,
        includeProjects: include_projects,
        includeRecentSessions: include_recent_sessions,
        format,
      }),
    }],
  })),
);

server.tool(
  "promote_pattern",
  "Promote a project memory item into a client-level or global reusable pattern record.",
  {
    source_memory_id: z.string().describe("Memory node ID to promote."),
    target_scope: z.enum(["client", "global"]).describe("Where to promote the pattern."),
    sanitize: z.boolean().optional().describe("Mark the promoted pattern as sanitized. Default: true."),
    summary: z.string().describe("Reusable pattern summary."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  },
  withRequestActivity(async ({ source_memory_id, target_scope, sanitize, summary, format }) => ({
    content: [{
      type: "text" as const,
      text: await promotePattern({
        rootDir: ROOT_DIR,
        sourceMemoryId: source_memory_id,
        targetScope: target_scope,
        sanitize,
        summary,
        format,
      }),
    }],
  })),
);

async function main() {
  const args = process.argv.slice(2);
  if (parsedCliArgs.command === "init") {
    await runInitCommand(args.slice(1));
    return;
  }
  if (parsedCliArgs.command === "doctor") {
    await runDoctorCommand(args.slice(1));
    return;
  }
  if (parsedCliArgs.command === "skeleton" || parsedCliArgs.command === "tree") {
    const targetRoot = parsedCliArgs.rootDir;
    const tree = await getContextTree({
      rootDir: targetRoot,
      includeSymbols: true,
      maxTokens: 50000,
    });
    process.stdout.write(tree + "\n");
    return;
  }
  await ensureContextPlusDir(ROOT_DIR);
  const projectConfig = await ensureProjectConfig({
    rootDir: ROOT_DIR,
    projectId: parsedCliArgs.projectId ?? process.env.CONTEXTPLUS_PROJECT_ID,
    clientId: parsedCliArgs.clientId ?? process.env.CONTEXTPLUS_CLIENT_ID,
    sessionSource: parsedCliArgs.sessionSource ?? process.env.CONTEXTPLUS_SESSION_SOURCE ?? "mcp",
  });
  await registerWorkspace(projectConfig);
  const startupHealth = await runStartupHealthCheck(ROOT_DIR);
  console.error(formatStartupHealthReport(startupHealth));
  const trackerController = createEmbeddingTrackerController({
    rootDir: ROOT_DIR,
    mode: process.env.CONTEXTPLUS_EMBED_TRACKER,
    debounceMs: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS ?? "700", 10),
    maxFilesPerTick: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_MAX_FILES ?? "8", 10),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  let stopParentMonitor = () => { };
  const idleMonitor = createIdleMonitor({
    timeoutMs: getIdleShutdownMs(process.env.CONTEXTPLUS_IDLE_TIMEOUT_MS),
    onIdle: () => requestShutdown("idle-timeout", 0),
    isTransportAlive: () => process.stdin.readable && !process.stdin.destroyed,
  });

  noteServerActivity = idleMonitor.touch;
  ensureTrackerRunning = trackerController.ensureStarted;

  const closeServer = async () => {
    const closable = server as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const closeTransport = async () => {
    const closable = transport as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const shutdown = async (reason: string, exitCode: number = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Context+ MCP shutdown requested: ${reason}`);
    await runCleanup({
      cancelEmbeddings: cancelAllEmbeddings,
      stopTracker: trackerController.stop,
      closeServer,
      closeTransport,
      stopMonitors: () => {
        idleMonitor.stop();
        stopParentMonitor();
      },
    });
    process.exit(exitCode);
  };
  const requestShutdown = (reason: string, exitCode: number = 0) => {
    void shutdown(reason, exitCode);
  };

  stopParentMonitor = startParentMonitor({
    parentPid: process.ppid,
    pollIntervalMs: getParentPollMs(process.env.CONTEXTPLUS_PARENT_POLL_MS),
    onParentExit: () => requestShutdown("parent-exit", 0),
  });

  process.once("SIGINT", () => requestShutdown("SIGINT", 0));
  process.once("SIGTERM", () => requestShutdown("SIGTERM", 0));
  process.once("SIGHUP", () => requestShutdown("SIGHUP", 0));
  process.once("disconnect", () => requestShutdown("disconnect", 0));
  process.once("exit", () => {
    idleMonitor.stop();
    stopParentMonitor();
    trackerController.stop();
  });
  process.stdin.once("end", () => requestShutdown("stdin-end", 0));
  process.stdin.once("close", () => requestShutdown("stdin-close", 0));
  process.stdin.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdin-error", 0);
  });
  process.stdout.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdout-error", 0);
  });
  process.stderr.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stderr-error", 0);
  });

  noteServerActivity();
  console.error(`Context+ MCP server running on stdio | root: ${ROOT_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
