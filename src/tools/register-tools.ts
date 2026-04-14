// MCP tool registration — wires all 34 server.tool() calls to their handlers
// FEATURE: Tool registration layer extracted from index.ts for readability

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getContextTree } from "./context-tree.js";
import { getFileSkeleton } from "./file-skeleton.js";
import { unifiedSearch, invalidateSearchCache, invalidateIdentifierSearchCache } from "./search.js";
import { getBlastRadius } from "./blast-radius.js";
import { runStaticAnalysis } from "./static-analysis.js";
import { proposeCommit } from "./propose-commit.js";
import { listRestorePoints, restorePoint } from "../git/shadow.js";
import { semanticNavigate } from "./semantic-navigate.js";
import { getFeatureHub } from "./feature-hub.js";
import { toolUpsertMemoryNode, toolCreateRelation, toolSearchMemoryGraph, toolAddInterlinkedContext, toolRetrieveWithTraversal, toolDeleteMemoryNode, toolListMemoryNodes } from "./memory-tools.js";
import { reindex } from "./reindex.js";
import { getStatus } from "./status.js";
import { getDiff } from "./diff.js";
import { getRelated } from "./related.js";
import { getTestMap } from "./test-map.js";
import { explain } from "./explain.js";
import { getRepoMap } from "./repo-map.js";
import { resolveSymbol } from "./resolve-symbol.js";
import { buildTaskPack, buildChangeImpact, buildEditScope, buildDecisionBrief, buildValidateScope, recordTaskMemory, getWorkspaceContext, promotePattern } from "./agentic-context.js";
import { listArtifacts, readArtifact } from "../core/artifacts.js";
import { formatStartupHealthReport, runStartupHealthCheck } from "../core/startup-health.js";
import { recordToolTiming } from "../core/tool-metrics.js";

type ActivityWrapper = <TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean; toolName?: string; waitForIndexing?: boolean },
) => (args: TArgs) => Promise<TResult>;

export function registerTools(
  server: McpServer,
  rootDir: string,
  withRequestActivity: ActivityWrapper,
  noteServerActivity: () => void,
): void {
  server.tool(
    "health",
    "Report Context+ startup health, including active root, project identity, Node ABI, native storage status, and database readiness.",
    {
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    async ({ format }) => {
      const started = Date.now();
      noteServerActivity();
      try {
        const report = await runStartupHealthCheck(rootDir);
        recordToolTiming(rootDir, "health", Date.now() - started, "ok");
        return {
          content: [{
            type: "text" as const,
            text: format === "json" ? JSON.stringify(report, null, 2) : formatStartupHealthReport(report),
          }],
        };
      } catch (error) {
        recordToolTiming(rootDir, "health", Date.now() - started, "error");
        throw error;
      }
    },
  );

  server.tool(
    "artifact_read",
    "Load a previously generated context artifact by ID so agents can reuse earlier task packets, repo maps, and decisions without regenerating them.",
    {
      artifact_id: z.string().describe("Artifact ID returned by repo_map, search, task_pack, change_impact, edit_scope, or decision_brief."),
    },
    withRequestActivity(async ({ artifact_id }) => {
      const artifact = await readArtifact(rootDir, artifact_id);
      return {
        content: [{
          type: "text" as const,
          text: artifact ? JSON.stringify(artifact, null, 2) : JSON.stringify({ error: `Artifact not found: ${artifact_id}` }, null, 2),
        }],
      };
    }, { toolName: "artifact_read", waitForIndexing: false }),
  );

  server.tool(
    "artifact_list",
    "List recent reusable context artifacts generated for this project. Use it to discover cached repo maps, task packs, and impact summaries.",
    {
      kind: z.string().optional().describe("Optional artifact kind filter, e.g. repo_map, search, task_pack."),
      limit: z.number().optional().describe("Maximum artifacts to return. Default: 20."),
    },
    withRequestActivity(async ({ kind, limit }) => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await listArtifacts(rootDir, kind, limit), null, 2),
      }],
    }), { toolName: "artifact_list", waitForIndexing: false }),
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
          rootDir,
          targetPath: target_path,
          includeSignatures: include_signatures,
          maxFiles: max_files,
          maxSymbolsPerFile: max_symbols_per_file,
          maxTokens: max_tokens,
          format,
        }),
      }],
    }), { toolName: "repo_map" }),
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
          rootDir,
          symbolName: symbol_name,
          fileContext: file_context,
          kind,
          limit,
          format,
        }),
      }],
    }), { toolName: "resolve_symbol" }),
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
          rootDir,
          targetPath: target_path,
          depthLimit: depth_limit,
          includeSymbols: include_symbols,
          maxTokens: max_tokens,
        }),
      }],
    }), { toolName: "tree" }),
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
        text: await getFileSkeleton({ rootDir, filePath: file_path }),
      }],
    }), { toolName: "skeleton" }),
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
          rootDir,
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
    }), { useEmbeddingTracker: true, toolName: "search" }),
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
        text: await getBlastRadius({ rootDir, symbolName: symbol_name, fileContext: file_context }),
      }],
    }), { toolName: "blast_radius" }),
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
        text: await runStaticAnalysis({ rootDir, targetPath: target_path }),
      }],
    }), { toolName: "lint" }),
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
          text: await proposeCommit({ rootDir, filePath: file_path, newContent: new_content }),
        }],
      };
    }, { toolName: "checkpoint" }),
  );

  server.tool(
    "checkpoints",
    "List all shadow restore points created by checkpoint. Each point captures the file state before changes. " +
    "Use this to find a restore point ID for undoing a bad change.",
    {},
    withRequestActivity(async () => {
      const points = await listRestorePoints(rootDir);
      if (points.length === 0) return { content: [{ type: "text" as const, text: "No restore points found." }] };

      const lines = points.map((p) =>
        `${p.id} | ${new Date(p.timestamp).toISOString()} | ${p.files.join(", ")} | ${p.message}`,
      );
      return { content: [{ type: "text" as const, text: `Restore Points (${points.length}):\n\n${lines.join("\n")}` }] };
    }, { toolName: "checkpoints" }),
  );

  server.tool(
    "restore",
    "Restore files to their state before a specific change. Uses the shadow restore point system. " +
    "Does NOT affect git history. Call checkpoints first to find the point ID.",
    {
      point_id: z.string().describe("The restore point ID (format: rp-timestamp-hash). Get from list_restore_points."),
    },
    withRequestActivity(async ({ point_id }) => {
      const restored = await restorePoint(rootDir, point_id);
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
    }, { toolName: "restore" }),
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
        text: await semanticNavigate({ rootDir, maxDepth: max_depth, maxClusters: max_clusters }),
      }],
    }), { toolName: "cluster" }),
  );

  server.tool(
    "hub",
    "Feature hub navigator. Hub files are .md files containing [[path/to/file]] wikilinks that act as a Map of Content. " +
    "No args = list all hubs. hub_path or feature_name = show hub with bundled skeletons. show_orphans = find unlinked files.",
    {
      hub_path: z.string().optional().describe("Path to a specific hub .md file (relative to root)."),
      feature_name: z.string().optional().describe("Feature name to search for. Finds matching hub file automatically."),
      show_orphans: z.boolean().optional().describe("If true, lists all source files not linked to any feature hub."),
      query: z.string().optional().describe("Search/filter query. When listing all hubs, ranks and marks hubs matching this term by title, path, and linked files."),
    },
    withRequestActivity(async ({ hub_path, feature_name, show_orphans, query }) => ({
      content: [{
        type: "text" as const,
        text: await getFeatureHub({
          rootDir,
          hubPath: hub_path,
          featureName: feature_name,
          showOrphans: show_orphans,
          query,
        }),
      }],
    }), { toolName: "hub" }),
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
        text: await toolUpsertMemoryNode({ rootDir, type, label, content, metadata, scope }),
      }],
    })),
  );

  server.tool(
    "memory_link",
    "Create a typed edge between two memory nodes. Supports: relates_to, depends_on, implements, references, similar_to, contains, resolved_by, contradicts. " +
    "Edges have weights (0-1) that decay over time. Duplicate edges update weight.",
    {
      source_id: z.string().describe("ID of the source memory node."),
      target_id: z.string().describe("ID of the target memory node."),
      relation: z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"]).describe("Relationship type between nodes."),
      weight: z.number().optional().describe("Edge weight 0-1. Higher = stronger relationship. Default: 1.0."),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata for the edge."),
    },
    withRequestActivity(async ({ source_id, target_id, relation, weight, metadata }) => ({
      content: [{
        type: "text" as const,
        text: await toolCreateRelation({ rootDir, sourceId: source_id, targetId: target_id, relation, weight, metadata }),
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
      edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"])).optional()
        .describe("Only traverse edges of these types. Omit for all types."),
    },
    withRequestActivity(async ({ query, max_depth, top_k, edge_filter, scope }) => ({
      content: [{
        type: "text" as const,
        text: await toolSearchMemoryGraph({ rootDir, query, maxDepth: max_depth, topK: top_k, edgeFilter: edge_filter, scope }),
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
        text: await toolAddInterlinkedContext({ rootDir, items, autoLink: auto_link, scope }),
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
      edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"])).optional()
        .describe("Only traverse edges of these types. Omit for all."),
    },
    withRequestActivity(async ({ start_node_id, max_depth, edge_filter }) => ({
      content: [{
        type: "text" as const,
        text: await toolRetrieveWithTraversal({ rootDir, startNodeId: start_node_id, maxDepth: max_depth, edgeFilter: edge_filter }),
      }],
    })),
  );

  server.tool(
    "memory_delete",
    "Delete a memory node and all its edges from the memory graph by node ID. " +
    "Use to remove stale, incorrect, or outdated nodes that are polluting search results.",
    {
      node_id: z.string().describe("ID of the memory node to delete."),
    },
    withRequestActivity(async ({ node_id }) => ({
      content: [{
        type: "text" as const,
        text: await toolDeleteMemoryNode({ rootDir, nodeId: node_id }),
      }],
    })),
  );

  server.tool(
    "memory_list",
    "List all memory nodes filtered by scope and/or kind, sorted by recency. " +
    "Use to see what's stored in memory, audit stale nodes, or find IDs before deleting.",
    {
      scope: z.enum(["session", "project", "client", "global"]).optional()
        .describe("Memory scope to filter by. Default: project."),
      kind: z.string().optional()
        .describe("Filter by node type or record_kind (e.g. 'task', 'file', 'concept', 'note')."),
      limit: z.number().optional().describe("Max nodes to return. Default: 20, max: 100."),
    },
    withRequestActivity(async ({ scope, kind, limit }) => ({
      content: [{
        type: "text" as const,
        text: await toolListMemoryNodes({ rootDir, scope, kind, limit }),
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
        text: await reindex({ rootDir, targetPath: target_path, force }),
      }],
    }), { toolName: "reindex", waitForIndexing: false }),
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
        text: await getStatus({ rootDir, format }),
      }],
    }), { toolName: "status" }),
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
        text: await getDiff({ rootDir, since, branch, file }),
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
        text: await getRelated({ rootDir, file }),
      }],
    }), { toolName: "related" }),
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
        text: await getTestMap({ rootDir, file, symbol, changed }),
      }],
    }), { toolName: "test_map" }),
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
        text: await explain({ rootDir, symbol, file, depth }),
      }],
    }), { toolName: "explain" }),
  );

  server.tool(
    "task_pack",
    "Assemble the minimum useful working set for a task: ranked files, nearby tests, recent diffs, memory, and risks.",
    {
      task: z.string().describe("Task description or engineering objective."),
      max_files: z.number().optional().describe("Maximum ranked files to include. Default: 8."),
      max_memory: z.number().optional().describe("Maximum memory hits to include. Default: 3, max: 10."),
      include_tests: z.boolean().optional().describe("Include nearby tests. Default: true."),
      include_recent_diffs: z.boolean().optional().describe("Include recent file-level diffs. Default: true."),
      include_memory: z.boolean().optional().describe("Include project memory hits. Default: true."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ task, max_files, max_memory, include_tests, include_recent_diffs, include_memory, format }) => ({
      content: [{
        type: "text" as const,
        text: await buildTaskPack({
          rootDir,
          task,
          maxFiles: max_files,
          maxMemory: max_memory,
          includeTests: include_tests,
          includeRecentDiffs: include_recent_diffs,
          includeMemory: include_memory,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "task_pack" }),
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
          rootDir,
          files,
          symbols,
          includeTests: include_tests,
          includeRecentChurn: include_recent_churn,
          format,
        }),
      }],
    }), { toolName: "change_impact" }),
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
          rootDir,
          task,
          maxFiles: max_files,
          preferSmallestScope: prefer_smallest_scope,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "edit_scope" }),
  );

  server.tool(
    "validate_scope",
    "After edit_scope, recommend the most relevant validation checks and commands for the scoped files.",
    {
      task: z.string().describe("Task description or intended change."),
      max_files: z.number().optional().describe("Maximum files to inspect when building validation guidance. Default: 5."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ task, max_files, format }) => ({
      content: [{
        type: "text" as const,
        text: await buildValidateScope({
          rootDir,
          task,
          maxFiles: max_files,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "validate_scope" }),
  );

  server.tool(
    "decision_brief",
    "Compress a subsystem or task into a short decision-oriented brief with ranked files, symbols, tests, hubs, and memory.",
    {
      query: z.string().describe("Subsystem, area, or task query."),
      include_hubs: z.boolean().optional().describe("Include matching hubs. Default: true."),
      include_memory: z.boolean().optional().describe("Include project memory. Default: true."),
      include_tests: z.boolean().optional().describe("Include nearby tests. Default: true."),
      max_memory: z.number().optional().describe("Maximum memory hits to include. Default: 3, max: 10."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ query, include_hubs, include_memory, include_tests, max_memory, format }) => ({
      content: [{
        type: "text" as const,
        text: await buildDecisionBrief({
          rootDir,
          query,
          includeHubs: include_hubs,
          includeMemory: include_memory,
          includeTests: include_tests,
          maxMemory: max_memory,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "decision_brief" }),
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
          rootDir,
          task,
          summary,
          files,
          assumptions,
          evidence,
          openRisks: open_risks,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "memory_record_task" }),
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
    }), { toolName: "workspace_context" }),
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
          rootDir,
          sourceMemoryId: source_memory_id,
          targetScope: target_scope,
          sanitize,
          summary,
          format,
        }),
      }],
    }), { toolName: "promote_pattern" }),
  );
}
