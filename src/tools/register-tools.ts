// MCP tool registration — wires all server.tool() calls to their handlers
// FEATURE: Tool registration layer extracted from index.ts for readability

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getContextTree } from "./context-tree.js";
import { getFileSkeleton } from "./file-skeleton.js";
import { unifiedSearch, invalidateSearchCache, invalidateIdentifierSearchCache } from "./search.js";
import { getBlastRadius } from "./blast-radius.js";
import { runStaticAnalysis } from "./static-analysis.js";
import { proposeCommit } from "./propose-commit.js";
import { listRestorePoints, restorePoint, currentSessionId, garbageCollectRestorePoints } from "../git/shadow.js";
import { semanticNavigate } from "./semantic-navigate.js";
import { getFeatureHub } from "./feature-hub.js";
import { toolUpsertMemoryNode, toolCreateRelation, toolSearchMemoryGraph, toolAddInterlinkedContext, toolRetrieveWithTraversal, toolDeleteMemoryNode, toolListMemoryNodes } from "./memory-tools.js";
import { reindex } from "./reindex.js";
import { getStatus } from "./status.js";
import { getDiff } from "./diff.js";
import { getSemanticDiff } from "./semantic-diff.js";
import { getSqlSchema } from "./sql-schema.js";
import { getTestImpact } from "./test-impact.js";
import { getChangedSince } from "./changed-since.js";
import { getRelated } from "./related.js";
import { getTestMap } from "./test-map.js";
import { explain } from "./explain.js";
import { getRepoMap } from "./repo-map.js";
import { resolveSymbol } from "./resolve-symbol.js";
import { grepProject } from "./grep.js";
import { exportProjectGraphTool, queryProjectGraphTool } from "./project-graph.js";
import { impactDeltaTool } from "./impact-delta.js";
import { exactReferencesTool } from "./exact-references.js";
import { scipImportTool, scipStatusTool } from "./scip-index.js";
import { buildTaskPack, buildChangeImpact, buildEditScope, buildDecisionBrief, buildValidateScope, recordTaskMemory, getWorkspaceContext, promotePattern } from "./agentic-context.js";
import { findSymbol, replaceSymbolBody, insertAroundSymbol, renameSymbol } from "./symbolic-edit.js";
import { listArtifacts, readArtifact, garbageCollectArtifacts } from "../core/artifacts.js";
import { formatStartupHealthReport, runStartupHealthCheck } from "../core/startup-health.js";
import { recordToolTiming } from "../core/tool-metrics.js";
import { currentRoot } from "../core/request-context.js";
import { annotationsForTool, isToolEnabled, resolveToolProfile } from "../core/tool-profile.js";
import { garbageCollectDeadWorktrees } from "../core/worktree-gc.js";
import { getEfficiencyReport } from "./efficiency-report.js";

type ActivityWrapper = <TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean; toolName?: string; waitForIndexing?: boolean; ensureFreshIndex?: boolean },
) => (args: TArgs) => Promise<TResult>;

/** Optional per-request root override, injected into every tool schema. */
const rootArg = z
  .string()
  .optional()
  .describe(
    "Absolute path of the git worktree to target. Omit to use the server's project root. " +
    "Set this to route a request to a specific worktree when one MCP server serves several.",
  );

export function registerTools(
  serverInput: McpServer,
  bootRoot: string,
  withRequestActivity: ActivityWrapper,
  noteServerActivity: () => void,
): void {
  // Per-request effective root, evaluated at handler execution time.
  // withRequestActivity establishes the resolved worktree root via
  // AsyncLocalStorage for the duration of each handler; outside a request
  // (CLI/direct callers) this falls back to the server's boot root.
  const rootDir = (): string => currentRoot(bootRoot);

  // Wrap server.tool so every registered tool automatically accepts the optional
  // `root` argument without repeating it across 50+ schemas. The wrapper merges
  // `root: rootArg` into each tool's Zod shape; withRequestActivity reads and
  // strips it before the handler runs.
  const toolProfile = resolveToolProfile(process.env.CONTEXTPRO_TOOL_PROFILE ?? process.env.CONTEXTPLUS_TOOL_PROFILE);
  const sessionStartedAt = Date.now();
  const server = {
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: unknown) => {
      if (!isToolEnabled(name, toolProfile)) return undefined;
      return (serverInput.tool as unknown as (...a: unknown[]) => unknown)(
        name,
        description,
        { ...shape, root: rootArg },
        annotationsForTool(name),
        handler,
      );
    },
  } as unknown as McpServer;
  const registerStructuredTool = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    outputSchema: unknown,
    handler: unknown,
  ): unknown => {
    if (!isToolEnabled(name, toolProfile)) return undefined;
    return (serverInput.registerTool as unknown as (...args: unknown[]) => unknown)(
      name,
      {
        description,
        inputSchema: { ...inputSchema, root: rootArg },
        outputSchema,
        annotations: annotationsForTool(name),
      },
      handler,
    );
  };

  // Deprecated tool names (start_task, impact, plan_edit, validate, remember) delegate to
  // their replacement's exact schema + implementation instead of re-declaring both, so the
  // two can never silently drift apart (as `impact` had from `change_impact`, missing
  // include_recent_churn). The alias still gets its own tool-metrics attribution so usage of
  // deprecated names stays visible ahead of removing them in 2.0.
  const registerDeprecatedAlias = <TArgs>(
    aliasName: string,
    canonicalName: string,
    summary: string,
    shape: Record<string, unknown>,
    run: (args: TArgs) => Promise<string>,
    options: { useEmbeddingTracker?: boolean; ensureFreshIndex?: boolean } = {},
  ): void => {
    // The handler's arg type is genuinely tied to `shape` at each call site, but `shape`'s
    // static type here is an erased `Record<string, unknown>` (matching how `server` itself
    // is already loosely cast above) — TS can't correlate a free `TArgs` with that, so this
    // one call needs the same pragmatic cast the outer server wrapper already uses.
    (server.tool as unknown as (name: string, description: string, shape: Record<string, unknown>, handler: unknown) => void)(
      aliasName,
      `[deprecated, prefer ${canonicalName}] ${summary}`,
      shape,
      withRequestActivity<TArgs, { content: Array<{ type: "text"; text: string }> }>(async (args) => ({
        content: [{ type: "text" as const, text: await run(args) }],
      }), { ...options, toolName: aliasName }),
    );
  };

  server.tool(
    "health",
    "Report ContextPro startup health, including active root, project identity, Node ABI, native storage status, and database readiness.",
    {
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    async ({ format }) => {
      const started = Date.now();
      noteServerActivity();
      try {
        const report = await runStartupHealthCheck(rootDir());
        recordToolTiming(rootDir(), "health", Date.now() - started, "ok");
        return {
          content: [{
            type: "text" as const,
            text: format === "json" ? JSON.stringify(report, null, 2) : formatStartupHealthReport(report),
          }],
        };
      } catch (error) {
        recordToolTiming(rootDir(), "health", Date.now() - started, "error");
        throw error;
      }
    },
  );

  server.tool(
    "artifact_read",
    "Load a previously generated context artifact by ID so agents can reuse earlier task packets, repo maps, and decisions without regenerating them.",
    {
      artifact_id: z.string().min(1).describe("Artifact ID returned by repo_map, search, task_pack, change_impact, edit_scope, or decision_brief."),
    },
    withRequestActivity(async ({ artifact_id }) => {
      const artifact = await readArtifact(rootDir(), artifact_id);
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
    "List recent reusable context artifacts generated for this project. Use it to discover cached repo maps, task packs, and impact summaries. Each entry reports its on-disk size (sizeBytes).",
    {
      kind: z.string().optional().describe("Optional artifact kind filter, e.g. repo_map, search, task_pack."),
      limit: z.number().optional().describe("Maximum artifacts to return. Default: 20."),
    },
    withRequestActivity(async ({ kind, limit }) => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await listArtifacts(rootDir(), kind, limit), null, 2),
      }],
    }), { toolName: "artifact_list", waitForIndexing: false }),
  );

  server.tool(
    "gc",
    "Garbage-collect orphaned on-disk data: artifact .json payloads and restore-point backup folders " +
    "that have been evicted from their manifests (by the LRU caps) but never deleted from disk, plus " +
    "indexes of git worktrees that no longer exist. Safe — only removes files no longer referenced by " +
    "any manifest or live worktree. Reports files removed and bytes reclaimed.",
    {},
    withRequestActivity(async () => {
      const [artifacts, restorePoints, deadWorktrees] = await Promise.all([
        garbageCollectArtifacts(rootDir()),
        garbageCollectRestorePoints(rootDir()),
        garbageCollectDeadWorktrees(rootDir()),
      ]);
      const freed = artifacts.freedBytes + restorePoints.freedBytes;
      const kb = (freed / 1024).toFixed(1);
      return {
        content: [{
          type: "text" as const,
          text: `Garbage collection complete.\n`
            + `  Artifacts: removed ${artifacts.deletedFiles} orphaned file(s), freed ${(artifacts.freedBytes / 1024).toFixed(1)} KB\n`
            + `  Restore points: removed ${restorePoints.deletedPoints} orphaned backup(s), freed ${(restorePoints.freedBytes / 1024).toFixed(1)} KB\n`
            + `  Dead worktrees: removed ${deadWorktrees.removedWorkspaces} stale index(es)\n`
            + `  Total reclaimed: ${kb} KB`,
        }],
      };
    }, { toolName: "gc", waitForIndexing: false }),
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
      focus_files: z.array(z.string()).optional().describe("Files to bias importance ranking toward for this call (e.g. files already found relevant to the current task) — reseeds PageRank per call instead of one static global ranking, Aider-repomap-style."),
      focus_identifiers: z.array(z.string()).optional().describe("Identifiers mentioned in the current task/query — files that define one get an importance boost on top of any focus_files boost."),
    },
    withRequestActivity(async ({ target_path, include_signatures, max_files, max_symbols_per_file, max_tokens, format, focus_files, focus_identifiers }) => ({
      content: [{
        type: "text" as const,
        text: await getRepoMap({
          rootDir: rootDir(),
          targetPath: target_path,
          includeSignatures: include_signatures,
          maxFiles: max_files,
          maxSymbolsPerFile: max_symbols_per_file,
          maxTokens: max_tokens,
          format,
          focusFiles: focus_files,
          focusIdentifiers: focus_identifiers,
        }),
      }],
    }), { toolName: "repo_map", ensureFreshIndex: true }),
  );

  server.tool(
    "graph_export",
    "Export the indexed project graph to portable artifacts: .contextpro/graph.json and .contextpro/GRAPH_REPORT.md. " +
    "Use after reindex to share exact file, symbol, import, call, test, and confidence metadata across agents.",
    {
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ format }) => ({
      content: [{
        type: "text" as const,
        text: await exportProjectGraphTool({ rootDir: rootDir(), format }),
      }],
    }), { toolName: "graph_export", ensureFreshIndex: true }),
  );

  registerStructuredTool(
    "graph_query",
    "Query the indexed project graph without reading source files. Supports scoped neighborhoods, transitive impact, confidence-weighted shortest paths, PageRank hotspots, and structural communities.",
    {
      kind: z.enum(["summary", "file", "symbol", "impact", "path", "hotspots", "communities"]).optional().describe("Graph view to return. Default: summary."),
      file: z.string().optional().describe("File path for file or impact views."),
      symbol: z.string().optional().describe("Exact symbol name for symbol views."),
      source: z.string().optional().describe("Starting node for path view: exact node id, project-relative path, or unambiguous symbol label."),
      target: z.string().optional().describe("Destination node for path view: exact node id, project-relative path, or unambiguous symbol label."),
      max_hops: z.number().optional().describe("Maximum path length for path view. Default: 8, max: 20."),
      limit: z.number().optional().describe("Maximum nodes/edges to return. Default: 50, max: 200."),
      max_tokens: z.number().optional().describe("Approximate response budget. Default: 2500, range: 256-12000."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    z.object({
      graph: z.record(z.unknown()).optional(),
      nodes: z.array(z.record(z.unknown())).optional(),
      edges: z.array(z.record(z.unknown())).optional(),
      analysis: z.record(z.unknown()).optional(),
      fuzzyNote: z.string().nullable().optional(),
      truncation: z.record(z.unknown()).optional(),
      error: z.string().optional(),
    }),
    withRequestActivity(async (args: any) => {
      const { kind, file, symbol, source, target, max_hops, limit, max_tokens, format } = args;
      const options = { rootDir: rootDir(), kind, file, symbol, source, target, maxHops: max_hops, limit, maxTokens: max_tokens };
      const jsonText = await queryProjectGraphTool({ ...options, format: "json" });
      let structuredContent: Record<string, unknown>;
      try {
        structuredContent = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        structuredContent = { error: jsonText };
      }
      const text = format === "json" ? jsonText : await queryProjectGraphTool({ ...options, format: "text" });
      return {
        content: [{ type: "text" as const, text }],
        structuredContent,
      };
    }, { toolName: "graph_query", ensureFreshIndex: true }),
  );

  server.tool(
    "resolve_symbol",
    "Resolve an identifier to the most likely definition with ambiguity scoring. Use this before explain/refactor work when a symbol name appears in multiple files. " +
    "This is a best-guess ranking (call-graph proximity + locality), not a compiler resolution — if an LSP-backed tool (e.g. Serena) is available for this language, prefer it when the ambiguity flag here is set.",
    {
      symbol_name: z.string().min(1).describe("The symbol or identifier name to resolve."),
      file_context: z.string().optional().describe("Optional current file path to bias resolution using import context and locality."),
      kind: z.string().optional().describe("Optional expected kind, e.g. function, method, class, interface."),
      limit: z.number().optional().describe("Maximum candidates to return. Default: 8."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ symbol_name, file_context, kind, limit, format }) => ({
      content: [{
        type: "text" as const,
        text: await resolveSymbol({
          rootDir: rootDir(),
          symbolName: symbol_name,
          fileContext: file_context,
          kind,
          limit,
          format,
        }),
      }],
    }), { toolName: "resolve_symbol", ensureFreshIndex: true }),
  );

  server.tool(
    "exact_references",
    "Find exact references using the local TypeScript/JavaScript language service, Python import/call index evidence, or an imported SCIP JSON index. Use before rename/delete/refactor operations when available. " +
    "TS/JS resolution here is compiler-API-backed and trustworthy; other languages fall back to SCIP import or a heuristic index — for those, an LSP-backed tool (e.g. Serena) will generally be more precise if one is available.",
    {
      symbol_name: z.string().min(1).describe("Symbol name to resolve references for."),
      file: z.string().optional().describe("Optional file containing the symbol. If omitted, the indexed symbol table is used."),
      line: z.number().optional().describe("Optional 1-based line for the symbol inside file."),
      limit: z.number().optional().describe("Maximum references to return. Default: 100, max: 500."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ symbol_name, file, line, limit, format }) => ({
      content: [{
        type: "text" as const,
        text: await exactReferencesTool({ rootDir: rootDir(), symbolName: symbol_name, file, line, limit, format }),
      }],
    }), { toolName: "exact_references", ensureFreshIndex: true }),
  );

  server.tool(
    "scip_import",
    "Import and normalize a project-provided SCIP JSON index into .contextpro/scip-index.json so graph_export, graph_query, and exact_references can use SCIP_RESOLVED evidence.",
    {
      index_path: z.string().min(1).describe("Project-relative path to a SCIP JSON index, for example .contextpro/index.scip.json."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ index_path, format }) => ({
      content: [{
        type: "text" as const,
        text: await scipImportTool({ rootDir: rootDir(), indexPath: index_path, format }),
      }],
    }), { toolName: "scip_import", waitForIndexing: false }),
  );

  server.tool(
    "scip_status",
    "Report whether this project has an imported SCIP JSON index available for exact cross-language reference evidence.",
    {
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ format }) => ({
      content: [{
        type: "text" as const,
        text: await scipStatusTool({ rootDir: rootDir(), format }),
      }],
    }), { toolName: "scip_status", waitForIndexing: false }),
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
          rootDir: rootDir(),
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
      file_path: z.string().min(1).describe("Path to the file to inspect (relative to project root)."),
    },
    withRequestActivity(async ({ file_path }) => ({
      content: [{
        type: "text" as const,
        text: await getFileSkeleton({ rootDir: rootDir(), filePath: file_path }),
      }],
    }), { toolName: "skeleton", ensureFreshIndex: true }),
  );

  server.tool(
    "search",
    "Search the codebase by MEANING. Modes: 'file' searches file headers/symbols, 'identifier' searches function/class definitions with call chains, " +
    "'hybrid' (default) runs both and returns combined results. Uses embeddings for semantic matching plus keyword overlap scoring. " +
    "For an exact known symbol name in a language with a real language server available (e.g. via an LSP-backed MCP like Serena), prefer that for go-to-definition — this tool is best for meaning-based / fuzzy discovery across the whole repo.",
    {
      query: z.string().min(1).max(8000).describe("Natural language description of what you're looking for."),
      mode: z.enum(["file", "identifier", "hybrid"]).optional().describe("Search mode: 'file' for files, 'identifier' for functions/classes, 'hybrid' for both. Default: hybrid."),
      preset: z.enum(["fast", "balanced", "exhaustive", "semantic_only", "keyword_only"]).optional().describe("Ranking preset. fast favors cheap lexical recall, balanced is default, exhaustive returns a wider set, semantic_only ignores keyword overlap (pure embedding similarity), keyword_only ignores embedding similarity (pure lexical match)."),
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
      fusion: z.enum(["weighted", "rrf"]).optional().describe(
        "How to combine semantic + keyword scores in file mode. 'rrf' (default) fuses rank positions and is robust when signal scales differ. 'weighted' is an opt-out that blends by semantic_weight/keyword_weight.",
      ),
      inline_code: z.enum(["off", "crux", "full"]).optional().describe(
        "Inline source with file matches. 'crux' (default) returns an ~8-line relevant span, 'full' returns the matched definition body, and 'off' returns pointers only.",
      ),
    },
    withRequestActivity(async (args) => ({
      content: [{
        type: "text" as const,
        text: await unifiedSearch({
          rootDir: rootDir(),
          query: args.query,
          mode: args.mode,
          preset: args.preset,
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
          fusion: args.fusion,
          inlineCode: args.inline_code,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "search" }),
  );

  server.tool(
    "grep",
    "Fast literal or regex string search across the project's indexed file set. Use this for log-message lookups, config-key searches, error-message tracing, or any time you know the exact characters you want to find. Use 'search' instead for semantic intent queries. Skips binary files; respects .gitignore via the indexed walker.",
    {
      pattern: z.string().min(1).describe("Literal string to search for (or regex when regex=true)."),
      regex: z.boolean().optional().describe("Treat pattern as a regular expression. Default: false (literal match)."),
      case_sensitive: z.boolean().optional().describe("Match case-sensitively. Default: false."),
      target_path: z.string().optional().describe("Optional subdirectory to scope the search."),
      glob: z.string().optional().describe("Optional file glob filter, e.g. \"src/**/*.ts\" or \"*.md\". Comma-separated for multiple."),
      max_matches_per_file: z.number().optional().describe("Max matches per file. Default: 10."),
      max_total_matches: z.number().optional().describe("Max total matches across all files. Default: 200."),
      max_file_bytes: z.number().optional().describe("Skip files larger than this (bytes). Default: 1000000."),
      context_chars: z.number().optional().describe("Characters of surrounding context per match. Default: 160."),
    },
    withRequestActivity(async (args) => ({
      content: [{
        type: "text" as const,
        text: await grepProject({
          rootDir: rootDir(),
          pattern: args.pattern,
          regex: args.regex,
          caseSensitive: args.case_sensitive,
          targetPath: args.target_path,
          glob: args.glob,
          maxMatchesPerFile: args.max_matches_per_file,
          maxTotalMatches: args.max_total_matches,
          maxFileBytes: args.max_file_bytes,
          contextChars: args.context_chars,
        }),
      }],
    }), { toolName: "grep", waitForIndexing: false }),
  );

  server.tool(
    "blast_radius",
    "Before deleting or modifying code, check the BLAST RADIUS. Traces every file and line where a specific symbol " +
    "(function, class, variable) is imported or used. Prevents orphaned code. Also warns if usage count is low (candidate for inlining).",
    {
      symbol_name: z.string().min(1).describe("The function, class, or variable name to trace across the codebase."),
      file_context: z.string().optional().describe("The file where the symbol is defined. Excludes the definition line from results."),
      mode: z.enum(["summary", "detailed"]).optional().describe("Summary groups usages by containing symbol (default); detailed returns every matching line."),
    },
    withRequestActivity(async ({ symbol_name, file_context, mode }) => ({
      content: [{
        type: "text" as const,
        text: await getBlastRadius({ rootDir: rootDir(), symbolName: symbol_name, fileContext: file_context, mode }),
      }],
    }), { toolName: "blast_radius", ensureFreshIndex: true }),
  );

  server.tool(
    "lint",
    "Auto-detects and runs project linters (tsc, eslint, ruff, cargo check, go vet). " +
    "Also checks code skill score: 2-line headers, no inline comments, nesting depth, file length. " +
    "By default returns the top 10 worst-scoring files; pass verbose: true to see all.",
    {
      target_path: z.string().optional().describe("Specific file or folder to lint (relative to root). Omit for full project."),
      verbose: z.boolean().optional().describe("Return all files with issues. Default: false (top 10 by lowest score)."),
    },
    withRequestActivity(async ({ target_path, verbose }) => ({
      content: [{
        type: "text" as const,
        text: await runStaticAnalysis({ rootDir: rootDir(), targetPath: target_path, verbose }),
      }],
    }), { toolName: "lint" }),
  );

  server.tool(
    "checkpoint",
    "Save code with optional validation. Creates a shadow restore point before writing. " +
    "Use during long work sessions for safe mid-work saves. Pass strict: true to enforce style rules (header, no inline comments, nesting, length); otherwise issues are advisory warnings only.",
    {
      file_path: z.string().min(1).describe("Where to save the file (relative to project root)."),
      new_content: z.string().min(1).describe("The complete file content to save."),
      strict: z.boolean().optional().describe("If true, reject on any style violation. Default: false (warnings only)."),
    },
    withRequestActivity(async ({ file_path, new_content, strict }) => {
      invalidateSearchCache();
      invalidateIdentifierSearchCache();
      return {
        content: [{
          type: "text" as const,
          text: await proposeCommit({ rootDir: rootDir(), filePath: file_path, newContent: new_content, strict }),
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
      const points = await listRestorePoints(rootDir());
      if (points.length === 0) return { content: [{ type: "text" as const, text: "No restore points found." }] };

      const session = currentSessionId();
      const lines = points.map((p) => {
        const foreign = p.session && p.session !== session ? " [OTHER SESSION]" : "";
        // Loud, unambiguous: restoring a point whose file was new at checkpoint time DELETES that file.
        const tomb = p.tombstoneFiles && p.tombstoneFiles.length > 0
          ? ` [⚠ RESTORE DELETES: ${p.tombstoneFiles.join(", ")} — file(s) did not exist at checkpoint]`
          : "";
        return `${p.id} | ${new Date(p.timestamp).toISOString()} | ${p.files.join(", ")} | ${p.message}${foreign}${tomb}`;
      });
      const ownCount = points.filter((p) => !p.session || p.session === session).length;
      const header = `Restore Points (${points.length} total, ${ownCount} from this session):`;
      return { content: [{ type: "text" as const, text: `${header}\n\n${lines.join("\n")}` }] };
    }, { toolName: "checkpoints" }),
  );

  server.tool(
    "restore",
    "Restore files to their state at a checkpoint. Uses the shadow restore point system (does NOT affect git history). " +
    "Call checkpoints first to find the point ID. SAFE BY DEFAULT: a pre-restore safety snapshot is taken before any " +
    "file is overwritten or deleted, so a wrong restore is reversible. Pass preview:true to see exactly what would " +
    "change (including any file the restore would DELETE) without writing anything.",
    {
      point_id: z.string().min(1).describe("The restore point ID (format: rp-timestamp-hash). Get it from checkpoints."),
      preview: z.boolean().optional().describe("Dry run: show what would change (overwrite/create/delete) without writing. Recommended before a real restore."),
    },
    withRequestActivity(async ({ point_id, preview }) => {
      const result = await restorePoint(rootDir(), point_id, { preview: preview === true });

      const renderPlan = (): string => {
        const icon = { overwrite: "✏ overwrite", create: "+ create", delete: "⚠ DELETE", "missing-backup": "? skip (backup missing)" };
        return result.plan.plans.map((p) => `  ${icon[p.action]}  ${p.file}${p.destructive ? "  (destroys current content)" : ""}`).join("\n");
      };
      const destructiveCount = result.plan.plans.filter((p) => p.destructive).length;

      if (result.preview) {
        const willDelete = result.plan.plans.filter((p) => p.action === "delete").length;
        const note = willDelete > 0
          ? `\n\n⚠ ${willDelete} file(s) would be DELETED (they did not exist at checkpoint time). `
            + `Restoring the earliest point of a newly-created file removes that file.`
          : "";
        return {
          content: [{
            type: "text" as const,
            text: `PREVIEW — restoring ${point_id} ("${result.plan.message}") would affect ${result.plan.plans.length} file(s); `
              + `${destructiveCount} destructive:\n${renderPlan()}${note}\n\nRe-call restore without preview to apply. `
              + `A safety snapshot will be taken first so you can undo.`,
          }],
        };
      }

      invalidateSearchCache();
      invalidateIdentifierSearchCache();
      const undo = result.safetyPointId
        ? `\n\nUndo this restore with: restore point_id="${result.safetyPointId}"`
        : "";
      return {
        content: [{
          type: "text" as const,
          text: result.restoredFiles.length > 0
            ? `Restored ${result.restoredFiles.length} file(s):\n${result.restoredFiles.join("\n")}${undo}`
            : `No files were restored. The backup may be empty or its files were not found.${undo}`,
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
        text: await semanticNavigate({ rootDir: rootDir(), maxDepth: max_depth, maxClusters: max_clusters }),
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
          rootDir: rootDir(),
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
      label: z.string().min(1).max(500).describe("Short identifier for the node. Used for deduplication with type."),
      content: z.string().min(1).max(16000).describe("Detailed content for the node. Used for embedding generation."),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata pairs."),
      scope: z.enum(["session", "project", "client", "global"]).optional().describe("Memory scope. Defaults to project."),
    },
    withRequestActivity(async ({ type, label, content, metadata, scope }) => ({
      content: [{
        type: "text" as const,
        text: await toolUpsertMemoryNode({ rootDir: rootDir(), type, label, content, metadata, scope }),
      }],
    })),
  );

  server.tool(
    "memory_link",
    "Create a typed edge between two memory nodes. Supports: relates_to, depends_on, implements, references, similar_to, contains, resolved_by, contradicts. " +
    "Edges have weights (0-1) that decay over time. Duplicate edges update weight.",
    {
      source_id: z.string().min(1).describe("ID of the source memory node."),
      target_id: z.string().min(1).describe("ID of the target memory node."),
      relation: z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"]).describe("Relationship type between nodes."),
      weight: z.number().optional().describe("Edge weight 0-1. Higher = stronger relationship. Default: 1.0."),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata for the edge."),
    },
    withRequestActivity(async ({ source_id, target_id, relation, weight, metadata }) => ({
      content: [{
        type: "text" as const,
        text: await toolCreateRelation({ rootDir: rootDir(), sourceId: source_id, targetId: target_id, relation, weight, metadata }),
      }],
    })),
  );

  server.tool(
    "memory_search",
    "Search the memory graph by meaning with graph traversal. Finds direct matches via embedding similarity, " +
    "then traverses neighbors to discover linked context. Returns hits and graph-connected neighbors with relevance scores.",
    {
      query: z.string().min(1).max(8000).describe("Natural language query to search the memory graph."),
      max_depth: z.number().optional().describe("How many hops to traverse from direct matches. Default: 1."),
      top_k: z.number().optional().describe("Number of direct matches to return. Default: 5."),
      scope: z.enum(["session", "project", "client", "global"]).optional().describe("Retrieval scope. Defaults to project."),
      edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"])).optional()
        .describe("Only traverse edges of these types. Omit for all types."),
    },
    withRequestActivity(async ({ query, max_depth, top_k, edge_filter, scope }) => ({
      content: [{
        type: "text" as const,
        text: await toolSearchMemoryGraph({ rootDir: rootDir(), query, maxDepth: max_depth, topK: top_k, edgeFilter: edge_filter, scope }),
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
        text: await toolAddInterlinkedContext({ rootDir: rootDir(), items, autoLink: auto_link, scope }),
      }],
    })),
  );

  server.tool(
    "memory_explore",
    "Start from a memory node and traverse outward. Returns the starting node plus all reachable neighbors " +
    "within the depth limit, scored by edge weight decay and depth penalty. Use after memory_search to explore a node's neighborhood.",
    {
      start_node_id: z.string().min(1).describe("ID of the memory node to start traversal from."),
      max_depth: z.number().optional().describe("Maximum traversal depth from start node. Default: 2."),
      edge_filter: z.array(z.enum(["relates_to", "depends_on", "implements", "references", "similar_to", "contains", "resolved_by", "contradicts"])).optional()
        .describe("Only traverse edges of these types. Omit for all."),
    },
    withRequestActivity(async ({ start_node_id, max_depth, edge_filter }) => ({
      content: [{
        type: "text" as const,
        text: await toolRetrieveWithTraversal({ rootDir: rootDir(), startNodeId: start_node_id, maxDepth: max_depth, edgeFilter: edge_filter }),
      }],
    })),
  );

  server.tool(
    "memory_delete",
    "Delete a memory node and all its edges from the memory graph by node ID. " +
    "Use to remove stale, incorrect, or outdated nodes that are polluting search results.",
    {
      node_id: z.string().min(1).describe("ID of the memory node to delete."),
    },
    withRequestActivity(async ({ node_id }) => ({
      content: [{
        type: "text" as const,
        text: await toolDeleteMemoryNode({ rootDir: rootDir(), nodeId: node_id }),
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
        text: await toolListMemoryNodes({ rootDir: rootDir(), scope, kind, limit }),
      }],
    })),
  );

  server.tool(
    "reindex",
    "Re-walk, re-parse, and re-index project files into the database. Detects changed files via content hash and only re-processes what changed. " +
    "Eagerly populates file and identifier embeddings unless no_embed=true or CONTEXTPRO_REINDEX_NO_EMBED is set. " +
    "Use after git pull, branch switch, or external edits. Builds the import graph for related/test_map tools.",
    {
      target_path: z.string().optional().describe("Scope reindex to a specific directory (relative to root)."),
      force: z.boolean().optional().describe("Force re-process all files, ignoring cache. Default: false."),
      no_embed: z.boolean().optional().describe("Skip eager embedding population. Search/identifier semantic ranking will populate lazily on first call. Default: false."),
      auto_hubs: z.boolean().optional().describe("Generate feature-hub labels (one chat-model call per hub). Off by default to keep reindex fast and free. Or set CONTEXTPRO_AUTO_HUBS=1."),
    },
    withRequestActivity(async ({ target_path, force, no_embed, auto_hubs }) => ({
      content: [{
        type: "text" as const,
        text: await reindex({ rootDir: rootDir(), targetPath: target_path, force, noEmbed: no_embed, autoHubs: auto_hubs }),
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
        text: await getStatus({ rootDir: rootDir(), format }),
      }],
    }), { toolName: "status" }),
  );

  server.tool(
    "efficiency_report",
    "Report ContextPro's persistent, auditable context-compression estimates by tool. History stores numeric metrics only—never prompts, source code, response bodies, or file paths. Token savings are estimates, not billing data.",
    {
      scope: z.enum(["session", "24h", "7d", "all"]).optional().describe("History window. Default: 24h."),
      input_cost_per_million: z.number().nonnegative().optional().describe("Optional model input price in USD per million tokens. When provided, returns a clearly-labelled hypothetical cost estimate."),
      history_limit: z.number().int().min(1).max(100).optional().describe("Maximum recent saving events to include. Default: 10."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or JSON. Default: text."),
    },
    withRequestActivity(async ({ scope, input_cost_per_million, history_limit, format }) => ({
      content: [{
        type: "text" as const,
        text: await getEfficiencyReport({
          rootDir: rootDir(),
          scope,
          sessionStartedAt,
          inputCostPerMillion: input_cost_per_million,
          historyLimit: history_limit,
          format,
        }),
      }],
    }), { toolName: "efficiency_report", waitForIndexing: false }),
  );

  server.tool(
    "diff",
    "Structured git diff showing changed files, lines added/removed, and affected symbols. " +
    "Supports: working tree (default), since a commit, vs a branch, a specific file, or staged/both scopes.",
    {
      since: z.string().optional().describe("Show changes since this commit (e.g. HEAD~3, abc123)."),
      branch: z.string().optional().describe("Compare current branch against this branch (e.g. main)."),
      file: z.string().optional().describe("Show diff for a specific file (includes raw diff output)."),
      scope: z.enum(["unstaged", "staged", "both"]).optional().describe("Working-tree scope. 'unstaged' (default) shows the worktree vs index. 'staged' shows index vs HEAD. 'both' shows worktree vs HEAD."),
    },
    withRequestActivity(async ({ since, branch, file, scope }) => ({
      content: [{
        type: "text" as const,
        text: await getDiff({ rootDir: rootDir(), since, branch, file, scope }),
      }],
    })),
  );

  server.tool(
    "semantic_diff",
    "AST-level change summary: which SYMBOLS were added/removed/modified/moved since a git ref " +
    "(default HEAD; pass a branch like 'main'). Ignores pure reformatting and includes brand-new untracked files. " +
    "Token-lean; pair with change_impact/blast_radius for the per-PR review loop ('what changed since main').",
    {
      since: z.string().optional().describe("Git ref to compare the working tree against (e.g. main, HEAD~3). Default: HEAD."),
      format: z.enum(["text", "json"]).optional().describe("Output format. Default: text."),
    },
    withRequestActivity(async ({ since, format }) => ({
      content: [{
        type: "text" as const,
        text: await getSemanticDiff({ rootDir: rootDir(), since, format }),
      }],
    })),
  );

  server.tool(
    "sql_schema",
    "Postgres/Supabase schema + RLS navigator from migration .sql files. Answers schema/RLS questions " +
    "without psql: table columns + types + CHECK constraints, whether RLS is enabled, RLS policies " +
    "(command/roles/USING predicate), and SECURITY DEFINER function bodies. Filter by table/policy/function name.",
    {
      name: z.string().optional().describe("Filter to a single table, policy, or function name (case-insensitive)."),
      targetPath: z.string().optional().describe("Restrict the .sql scan to a subtree (e.g. supabase/migrations)."),
      format: z.enum(["text", "json"]).optional().describe("Output format. Default: text."),
    },
    withRequestActivity(async ({ name, targetPath, format }) => ({
      content: [{
        type: "text" as const,
        text: await getSqlSchema({ rootDir: rootDir(), name, targetPath, format }),
      }],
    })),
  );

  server.tool(
    "related",
    "Show files related to a given file: what it imports, what imports it, same-directory siblings, test file, and hub membership. " +
    "Requires reindex to have been run for import graph data.",
    {
      file: z.string().min(1).describe("File path to find related files for (relative to root)."),
    },
    withRequestActivity(async ({ file }) => ({
      content: [{
        type: "text" as const,
        text: await getRelated({ rootDir: rootDir(), file }),
      }],
    }), { toolName: "related", ensureFreshIndex: true }),
  );

  server.tool(
    "test_map",
    "Map source files to their test files using import graph and naming conventions. " +
    "Modes: specific file, specific symbol, or changed files (dirty worktree, untracked files, or last commit when clean).",
    {
      file: z.string().optional().describe("Source file to find tests for."),
      symbol: z.string().optional().describe("Symbol name — finds which file defines it, then its tests."),
      changed: z.boolean().optional().describe("Find tests for dirty/untracked files, or for the last commit when the worktree is clean."),
    },
    withRequestActivity(async ({ file, symbol, changed }) => ({
      content: [{
        type: "text" as const,
        text: await getTestMap({ rootDir: rootDir(), file, symbol, changed }),
      }],
    }), { toolName: "test_map", ensureFreshIndex: true }),
  );

  server.tool(
    "test_impact",
    "Select only the tests affected by changes since a git ref (default HEAD; pass a branch like 'main'). " +
    "Walks reverse import dependencies from changed source files to the tests that exercise them, plus any " +
    "directly-changed test files. Forces a run-all fallback when build config / lockfiles change. " +
    "The 'which tests must I run' half of the per-PR loop — O(diff), not O(repo).",
    {
      since: z.string().optional().describe("Git ref to compare the working tree against (e.g. main, HEAD~3). Default: HEAD."),
      format: z.enum(["text", "json"]).optional().describe("Output format. Default: text."),
    },
    withRequestActivity(async ({ since, format }) => ({
      content: [{
        type: "text" as const,
        text: await getTestImpact({ rootDir: rootDir(), since, format }),
      }],
    }), { toolName: "test_impact", ensureFreshIndex: true }),
  );

  server.tool(
    "changed_since",
    "Per-PR review pack in one call: what SYMBOLS changed (semantic_diff) + which TESTS to run " +
    "(test_impact) + which files DEPEND ON the changed ones (file-level blast radius), since a git ref " +
    "(default HEAD; pass a branch like 'main'). The 'what changed since main' review loop, token-lean.",
    {
      since: z.string().optional().describe("Git ref to compare against (e.g. main, HEAD~3). Default: HEAD."),
      format: z.enum(["text", "json"]).optional().describe("Output format. Default: text."),
    },
    withRequestActivity(async ({ since, format }) => ({
      content: [{
        type: "text" as const,
        text: await getChangedSince({ rootDir: rootDir(), since, format }),
      }],
    }), { toolName: "changed_since", ensureFreshIndex: true }),
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
        text: await explain({ rootDir: rootDir(), symbol, file, depth }),
      }],
    }), { toolName: "explain", ensureFreshIndex: true }),
  );

  const TASK_PACK_SHAPE = {
    task: z.string().min(1).describe("Task description or engineering objective."),
    max_files: z.number().optional().describe("Maximum ranked files to include. Default: 8."),
    max_memory: z.number().optional().describe("Maximum memory hits to include. Default: 3, max: 10."),
    max_tokens: z.number().optional().describe("Approximate output budget with utility-aware pruning. Default: 3000, range: 512-12000."),
    include_tests: z.boolean().optional().describe("Include nearby tests. Default: true."),
    include_recent_diffs: z.boolean().optional().describe("Include recent file-level diffs. Default: true."),
    include_memory: z.boolean().optional().describe("Include project memory hits. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  };
  type TaskPackArgs = {
    task: string; max_files?: number; max_memory?: number; max_tokens?: number; include_tests?: boolean;
    include_recent_diffs?: boolean; include_memory?: boolean; format?: "text" | "json";
  };
  const runTaskPack = ({ task, max_files, max_memory, max_tokens, include_tests, include_recent_diffs, include_memory, format }: TaskPackArgs) =>
    buildTaskPack({
      rootDir: rootDir(),
      task,
      maxFiles: max_files,
      maxMemory: max_memory,
      maxTokens: max_tokens,
      includeTests: include_tests,
      includeRecentDiffs: include_recent_diffs,
      includeMemory: include_memory,
      format,
    });

  server.tool(
    "task_pack",
    "Assemble the minimum useful working set for a task: ranked files, nearby tests, recent diffs, memory, and risks.",
    TASK_PACK_SHAPE,
    withRequestActivity(async (args: TaskPackArgs) => ({
      content: [{ type: "text" as const, text: await runTaskPack(args) }],
    }), { useEmbeddingTracker: true, toolName: "task_pack", ensureFreshIndex: true }),
  );

  registerDeprecatedAlias(
    "start_task",
    "task_pack",
    "Primary workflow entry point. Returns a compact task packet with ranked files, tests, recent diffs, project memory, freshness, and risks.",
    TASK_PACK_SHAPE,
    runTaskPack,
    { useEmbeddingTracker: true, ensureFreshIndex: true },
  );

  const CHANGE_IMPACT_SHAPE = {
    files: z.array(z.string()).optional().describe("Files to analyze for impact."),
    symbols: z.array(z.string()).optional().describe("Symbols to analyze for impact."),
    include_tests: z.boolean().optional().describe("Include likely impacted tests. Default: true."),
    include_recent_churn: z.boolean().optional().describe("Include recent churn in risk scoring. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  };
  type ChangeImpactArgs = {
    files?: string[]; symbols?: string[]; include_tests?: boolean; include_recent_churn?: boolean; format?: "text" | "json";
  };
  const runChangeImpact = ({ files, symbols, include_tests, include_recent_churn, format }: ChangeImpactArgs) =>
    buildChangeImpact({
      rootDir: rootDir(),
      files,
      symbols,
      includeTests: include_tests,
      includeRecentChurn: include_recent_churn,
      format,
    });

  server.tool(
    "change_impact",
    "Estimate what could break if specific files or symbols change, including related files, tests, churn, and reasons.",
    CHANGE_IMPACT_SHAPE,
    withRequestActivity(async (args: ChangeImpactArgs) => ({
      content: [{ type: "text" as const, text: await runChangeImpact(args) }],
    }), { toolName: "change_impact", ensureFreshIndex: true }),
  );

  registerDeprecatedAlias(
    "impact",
    "change_impact",
    "Primary impact workflow. Estimates what could break for changed files or symbols, including related files, tests, churn, and reasons.",
    CHANGE_IMPACT_SHAPE,
    runChangeImpact,
    { ensureFreshIndex: true },
  );

  server.tool(
    "impact_delta",
    "Compare a saved graph export with the current indexed graph after edits. Use graph_export before editing, then reindex and call this to see actual structural changes.",
    {
      baseline_path: z.string().optional().describe("Baseline graph path relative to root. Default: .contextpro/graph.json."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ baseline_path, format }) => ({
      content: [{
        type: "text" as const,
        text: await impactDeltaTool({ rootDir: rootDir(), baselinePath: baseline_path, format }),
      }],
    }), { toolName: "impact_delta", ensureFreshIndex: true }),
  );

  const EDIT_SCOPE_SHAPE = {
    task: z.string().min(1).describe("Task description or intended change."),
    max_files: z.number().optional().describe("Maximum files to recommend. Default: 5."),
    prefer_smallest_scope: z.boolean().optional().describe("Bias toward the smallest safe scope. Default: true."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  };
  type EditScopeArgs = { task: string; max_files?: number; prefer_smallest_scope?: boolean; format?: "text" | "json" };
  const runEditScope = ({ task, max_files, prefer_smallest_scope, format }: EditScopeArgs) =>
    buildEditScope({
      rootDir: rootDir(),
      task,
      maxFiles: max_files,
      preferSmallestScope: prefer_smallest_scope,
      format,
    });

  server.tool(
    "edit_scope",
    "Identify the smallest likely safe edit set for a task, including likely source files and nearby tests.",
    EDIT_SCOPE_SHAPE,
    withRequestActivity(async (args: EditScopeArgs) => ({
      content: [{ type: "text" as const, text: await runEditScope(args) }],
    }), { useEmbeddingTracker: true, toolName: "edit_scope", ensureFreshIndex: true }),
  );

  registerDeprecatedAlias(
    "plan_edit",
    "edit_scope",
    "Primary edit planning workflow. Finds the smallest likely safe edit set for a task before reading or changing files.",
    EDIT_SCOPE_SHAPE,
    runEditScope,
    { useEmbeddingTracker: true, ensureFreshIndex: true },
  );

  const VALIDATE_SCOPE_SHAPE = {
    task: z.string().min(1).describe("Task description or intended change."),
    max_files: z.number().optional().describe("Maximum files to inspect when building validation guidance. Default: 5."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  };
  type ValidateScopeArgs = { task: string; max_files?: number; format?: "text" | "json" };
  const runValidateScope = ({ task, max_files, format }: ValidateScopeArgs) =>
    buildValidateScope({ rootDir: rootDir(), task, maxFiles: max_files, format });

  server.tool(
    "validate_scope",
    "After edit_scope, recommend the most relevant validation checks and commands for the scoped files.",
    VALIDATE_SCOPE_SHAPE,
    withRequestActivity(async (args: ValidateScopeArgs) => ({
      content: [{ type: "text" as const, text: await runValidateScope(args) }],
    }), { useEmbeddingTracker: true, toolName: "validate_scope", ensureFreshIndex: true }),
  );

  registerDeprecatedAlias(
    "validate",
    "validate_scope",
    "Primary validation workflow. Recommends the smallest relevant checks and commands for a task's likely edit scope.",
    VALIDATE_SCOPE_SHAPE,
    runValidateScope,
    { useEmbeddingTracker: true, ensureFreshIndex: true },
  );

  server.tool(
    "decision_brief",
    "Compress a subsystem or task into a short decision-oriented brief with ranked files, symbols, tests, hubs, and memory.",
    {
      query: z.string().min(1).max(8000).describe("Subsystem, area, or task query."),
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
          rootDir: rootDir(),
          query,
          includeHubs: include_hubs,
          includeMemory: include_memory,
          includeTests: include_tests,
          maxMemory: max_memory,
          format,
        }),
      }],
    }), { useEmbeddingTracker: true, toolName: "decision_brief", ensureFreshIndex: true }),
  );

  const MEMORY_RECORD_TASK_SHAPE = {
    task: z.string().min(1).describe("Task or issue name."),
    summary: z.string().min(1).describe("What changed or was learned."),
    files: z.array(z.string()).optional().describe("Files touched or relevant to the task."),
    assumptions: z.array(z.string()).optional().describe("Assumptions made during the task."),
    evidence: z.array(z.string()).optional().describe("Evidence supporting the outcome."),
    open_risks: z.array(z.string()).optional().describe("Risks that remain unresolved."),
    format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
  };
  type MemoryRecordTaskArgs = {
    task: string; summary: string; files?: string[]; assumptions?: string[];
    evidence?: string[]; open_risks?: string[]; format?: "text" | "json";
  };
  const runMemoryRecordTask = ({ task, summary, files, assumptions, evidence, open_risks, format }: MemoryRecordTaskArgs) =>
    recordTaskMemory({
      rootDir: rootDir(),
      task,
      summary,
      files,
      assumptions,
      evidence,
      openRisks: open_risks,
      format,
    });

  server.tool(
    "memory_record_task",
    "Persist useful task outcomes with linked files, assumptions, evidence, and open risks for future sessions.",
    MEMORY_RECORD_TASK_SHAPE,
    withRequestActivity(async (args: MemoryRecordTaskArgs) => ({
      content: [{ type: "text" as const, text: await runMemoryRecordTask(args) }],
    }), { useEmbeddingTracker: true, toolName: "memory_record_task" }),
  );

  registerDeprecatedAlias(
    "remember",
    "memory_record_task",
    "Primary memory workflow. Records a task outcome with linked files, assumptions, evidence, and open risks for future sessions.",
    MEMORY_RECORD_TASK_SHAPE,
    runMemoryRecordTask,
    { useEmbeddingTracker: true },
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
      source_memory_id: z.string().min(1).describe("Memory node ID to promote."),
      target_scope: z.enum(["client", "global"]).describe("Where to promote the pattern."),
      sanitize: z.boolean().optional().describe("Mark the promoted pattern as sanitized. Default: true."),
      summary: z.string().min(1).describe("Reusable pattern summary."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ source_memory_id, target_scope, sanitize, summary, format }) => ({
      content: [{
        type: "text" as const,
        text: await promotePattern({
          rootDir: rootDir(),
          sourceMemoryId: source_memory_id,
          targetScope: target_scope,
          sanitize,
          summary,
          format,
        }),
      }],
    }), { toolName: "promote_pattern" }),
  );

  server.tool(
    "find_symbol",
    "Find symbols (functions, classes, methods, types) by name path pattern. " +
    "A name path is a Serena-style path through the symbol tree within a file, e.g., \"ClassName/methodName\" or \"/AbsoluteRoot/Nested\". " +
    "Returns location, signature, and optionally body and children. Use this before symbolic edits or to navigate a file's API surface. " +
    "Symbol extraction here is tree-sitter/regex-based, not a real language server — if an LSP-backed tool (e.g. Serena) is available for this language, prefer it when you need compiler-exact symbol resolution.",
    {
      name_path_pattern: z.string().min(1).describe("Name path pattern. Use \"name\" to match anywhere, \"Class/method\" for relative, \"/Class/method\" for absolute."),
      relative_path: z.string().optional().describe("Restrict search to a specific file. Omit to scan the whole project."),
      include_body: z.boolean().optional().describe("Include the symbol's source body in results. Use judiciously."),
      depth: z.number().optional().describe("Depth of descendants to retrieve (e.g., 1 returns class methods). Default: 0."),
      max_matches: z.number().optional().describe("Maximum matches to return. Default: 50."),
      substring_matching: z.boolean().optional().describe("If true, the last path element matches by substring."),
      include_kinds: z.array(z.string()).optional().describe("Only return symbols of these kinds (function, class, method, etc.)."),
      exclude_kinds: z.array(z.string()).optional().describe("Exclude symbols of these kinds."),
      format: z.enum(["text", "json"]).optional().describe("Return plain text or structured JSON. Default: text."),
    },
    withRequestActivity(async ({ name_path_pattern, relative_path, include_body, depth, max_matches, substring_matching, include_kinds, exclude_kinds, format }) => ({
      content: [{
        type: "text" as const,
        text: await findSymbol({
          rootDir: rootDir(),
          namePathPattern: name_path_pattern,
          relativePath: relative_path,
          includeBody: include_body,
          depth,
          maxMatches: max_matches,
          substringMatching: substring_matching,
          includeKinds: include_kinds,
          excludeKinds: exclude_kinds,
          format,
        }),
      }],
    }), { toolName: "find_symbol", ensureFreshIndex: true }),
  );

  server.tool(
    "replace_symbol_body",
    "Replace the entire body (definition through closing brace/dedent) of a symbol identified by its name path. " +
    "Creates a shadow restore point before writing. Use this for surgical refactors instead of file-level edits. " +
    "Only call after find_symbol/skeleton/explain confirms the target.",
    {
      relative_path: z.string().min(1).describe("File containing the symbol (relative to project root)."),
      name_path: z.string().min(1).describe("Name path of the symbol to replace (e.g., \"ClassName/methodName\")."),
      body: z.string().min(1).describe("Full replacement text for the symbol definition, including signature line."),
      message: z.string().optional().describe("Optional restore-point message for traceability."),
    },
    withRequestActivity(async ({ relative_path, name_path, body, message }) => ({
      content: [{
        type: "text" as const,
        text: await replaceSymbolBody({ rootDir: rootDir(), relativePath: relative_path, namePath: name_path, body, message }),
      }],
    }), { toolName: "replace_symbol_body" }),
  );

  server.tool(
    "insert_after_symbol",
    "Insert new code immediately after the closing line of an existing symbol. " +
    "Useful for adding sibling functions, methods, or class members without re-reading the file. Creates a shadow restore point.",
    {
      relative_path: z.string().min(1).describe("File to modify (relative to project root)."),
      name_path: z.string().min(1).describe("Name path of the anchor symbol (insertion happens after its end)."),
      body: z.string().min(1).describe("Code to insert after the symbol."),
      message: z.string().optional().describe("Optional restore-point message."),
    },
    withRequestActivity(async ({ relative_path, name_path, body, message }) => ({
      content: [{
        type: "text" as const,
        text: await insertAroundSymbol({ rootDir: rootDir(), relativePath: relative_path, namePath: name_path, body, position: "after", message }),
      }],
    }), { toolName: "insert_after_symbol" }),
  );

  server.tool(
    "insert_before_symbol",
    "Insert new code immediately before the first line of an existing symbol. " +
    "Useful for prepending imports, helpers, or decorators. Creates a shadow restore point.",
    {
      relative_path: z.string().min(1).describe("File to modify (relative to project root)."),
      name_path: z.string().min(1).describe("Name path of the anchor symbol (insertion happens before its start)."),
      body: z.string().min(1).describe("Code to insert before the symbol."),
      message: z.string().optional().describe("Optional restore-point message."),
    },
    withRequestActivity(async ({ relative_path, name_path, body, message }) => ({
      content: [{
        type: "text" as const,
        text: await insertAroundSymbol({ rootDir: rootDir(), relativePath: relative_path, namePath: name_path, body, position: "before", message }),
      }],
    }), { toolName: "insert_before_symbol" }),
  );

  server.tool(
    "rename_symbol",
    "Rename a symbol in its defining file and propagate the rename to callers and importers based on the indexed graph. " +
    "Creates shadow restore points for the defining file and each updated cross-file site. " +
    "Best-effort textual rename — does not understand scopes (though it does skip string literals and comments); always inspect blast_radius first to confirm safety. " +
    "If an LSP-backed rename tool (e.g. Serena) is available for this language, prefer it for scope-exact renames.",
    {
      relative_path: z.string().min(1).describe("File where the symbol is defined."),
      name_path: z.string().min(1).describe("Name path of the symbol to rename."),
      new_name: z.string().min(1).describe("The new identifier name."),
      message: z.string().optional().describe("Optional restore-point message."),
    },
    withRequestActivity(async ({ relative_path, name_path, new_name, message }) => ({
      content: [{
        type: "text" as const,
        text: await renameSymbol({ rootDir: rootDir(), relativePath: relative_path, namePath: name_path, newName: new_name, message }),
      }],
    }), { toolName: "rename_symbol" }),
  );
}
