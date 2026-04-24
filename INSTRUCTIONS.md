# Context+ MCP - Agent Instructions

## Purpose

You are equipped with the Context+ MCP server. It gives you structural awareness of the entire codebase without reading every file. Follow this workflow strictly to conserve context and maximize accuracy.

## Architecture

The MCP server is built with TypeScript and communicates over stdio using the Model Context Protocol SDK. It has three layers:

**Core Layer** (`src/core/`):

- `parser.ts` - Multi-language symbol extraction via tree-sitter AST with regex fallback. Supports 14+ languages.
- `tree-sitter.ts` - WASM grammar loader for 43 file extensions using web-tree-sitter 0.20.8.
- `walker.ts` - Gitignore-aware recursive directory traversal with depth and target path control.
- `embeddings.ts` - Ollama vector embedding engine with disk cache, cosine similarity search, and API key support.
- `db.ts` - SQLite + sqlite-vec persistent index: files, symbols, embeddings, memory graph, artifact cache.
- `project-config.ts` - Project identity (projectId, clientId, repoFingerprint, workspaceRoot) for multi-repo isolation.
- `artifacts.ts` - Stable content-addressed artifact cache for low-token reuse of task packs, repo maps, search results.
- `context-metadata.ts` - Trust and freshness metadata emitted by every agentic tool for confidence signaling.
- `hub.ts` - Wikilink parser for `[[path]]` links, cross-link tags, hub discovery, orphan detection.
- `chat-model.ts` - Optional LLM integration for cluster labeling and hub name derivation.

**Tools Layer** (`src/tools/`):

- `context-tree.ts` - Token-aware structural tree with symbol line ranges and Level 0/1/2 pruning.
- `file-skeleton.ts` - Function signatures with line ranges, without reading full bodies.
- `semantic-search.ts` - Ollama-powered semantic file search with symbol definition lines and 60s cache TTL.
- `semantic-identifiers.ts` - Identifier-level semantic search returning ranked definitions + call chains with line numbers.
- `search.ts` - Unified entry point for file/identifier/hybrid search with confidence banner and quality scoring.
- `semantic-navigate.ts` - Browse-by-meaning navigator using spectral clustering and Ollama labeling.
- `blast-radius.ts` - Symbol usage tracer across the entire codebase.
- `static-analysis.ts` - Native linter runner (tsc, eslint, py_compile, cargo check, go vet).
- `propose-commit.ts` - Code gatekeeper validating headers, FEATURE tag, no inline comments, nesting, file length.
- `feature-hub.ts` - Obsidian-style feature hub navigator with bundled skeleton views and query scoring.
- `memory-tools.ts` - Memory graph MCP wrappers: upsert, relate, search, prune, interlink, traverse, delete, list.
- `agentic-context.ts` - High-level context assembly: task_pack, repo_map, decision_brief, change_impact, edit_scope, workspace_context.
- `reindex.ts` - Full or incremental reindex with SQLite persistence and stale-file detection.
- `status.ts` - Instant project overview dashboard: file counts, index state, memory stats, git info.
- `diff.ts` - Structured git diff with affected symbols and changed file summary.
- `related.ts` - Import graph traversal: what a file imports, what imports it, sibling files, test file.
- `test-map.ts` - Source-to-test file mapping via import graph and naming conventions.
- `explain.ts` - Extract specific function/class body with dependencies without reading the entire file.
- `resolve-symbol.ts` - Resolve an identifier to the most likely definition with ambiguity scoring.
- `planning-helpers.ts` - Task pack assembly: ranked files, tests, memory hits, recent diffs.
- `retrieval-helpers.ts` - Shared retrieval utilities: memory hits, freshness, context hydration.
- `register-tools.ts` - MCP tool registration: wires all 36 tools with Zod schemas and `withRequestActivity` wrapper.

The memory graph is a **Retrieval-Augmented Generation (RAG)** system backed by SQLite + sqlite-vec. Agents MUST use `memory_search` at the start of every task to retrieve prior context, and persist learnings with `memory_create` and `memory_link` after completing work. This prevents redundant exploration and builds cumulative knowledge across sessions.

**Entry Point**: `src/index.ts` initializes the SQLite database, registers 36 MCP tools, and starts the stdio transport. Accepts an optional CLI argument for the target project root directory (defaults to `process.cwd()`).

## Environment Variables

| Variable                                | Default              | Description                                                      |
| --------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| `OLLAMA_EMBED_MODEL`                    | `nomic-embed-text`   | Embedding model name                                             |
| `OLLAMA_API_KEY`                        | (empty)              | Cloud auth (auto-detected by SDK)                                |
| `OLLAMA_CHAT_MODEL`                     | `llama3.2`           | Chat model for cluster labeling and hub name derivation          |
| `CONTEXTPLUS_EMBED_PROVIDER`            | `ollama`             | Embedding provider: `ollama` or `openai`                         |
| `CONTEXTPLUS_EMBED_BATCH_SIZE`          | `8`                  | Embedding batch per GPU call (hard-capped to 5-10)               |
| `CONTEXTPLUS_EMBED_TRACKER`             | `true`               | Enable realtime embedding updates for changed files/functions    |
| `CONTEXTPLUS_EMBED_TRACKER_MAX_FILES`   | `8`                  | Max changed files per tracker tick (hard-capped to 5-10)         |
| `CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS` | `700`                | Debounce before applying tracker refresh                         |
| `CONTEXTPLUS_SESSION_ID`                | (empty)              | Session identifier for session-scoped memory isolation           |
| `CONTEXTPLUS_SESSION_SOURCE`            | `mcp`                | Session source tag stored in memory node metadata                |
| `CONTEXTPLUS_QUICKREFRESH_MAX_FILES`    | `30`                 | Max stale files auto-patched per search call before warning      |
| `CONTEXTPLUS_NATIVE_AUTO_REPAIR`        | `true`               | Auto-repair native SQLite bindings for the current Node runtime  |

Runtime cache: `.contextplus/` is created at MCP startup and stores reusable embedding vectors for files, identifiers, call sites, and artifact payloads. A realtime tracker watches file updates and refreshes changed function/file embeddings incrementally.

## Fast Execute Mode (Mandatory)

Default to execution-first behavior. Use minimal tokens, minimal narration, and maximum tool leverage.

1. Start every session with `status` for instant project overview and `task_pack` for ranked files + memory hits.
2. Run independent discovery operations in parallel whenever possible.
3. Prefer structural tools (`skeleton`, `tree`, `explain`) over full-file reads to conserve context.
4. Before modifying or deleting symbols, run `blast_radius`.
5. Run `lint` after edits for type and style validation.
6. Use `artifact_list` to reuse cached task packs and repo maps from prior turns.

### Execution Rules

1. Think less, execute sooner: make the smallest safe change that can be validated quickly.
2. Do not serialize independent commands; batch parallelizable reads/searches.
3. If a command fails, avoid blind retry loops. Diagnose once, pivot strategy, continue.
4. Cap retry attempts for the same failing operation to 1-2 unless new evidence appears.
5. Keep outputs concise: short status updates, no verbose reasoning dumps.

### Token-Efficiency Rules

1. Treat 100 effective tokens as better than 1000 vague tokens.
2. Use high-signal tool calls first (`skeleton`, `tree`, `blast_radius`, `task_pack`).
3. Read full file bodies only when signatures/structure are insufficient.
4. Avoid repeated scans of unchanged areas.
5. Prefer direct edits + deterministic validation over extended speculative analysis.
6. Check `artifact_list` before calling `task_pack` or `repo_map` — reuse if fresh.

## Strict Formatting Rules

### File Header (Mandatory)

Every file MUST start with exactly 2 comment lines (10 words each) explaining the file:

```
// Regex-based symbol extraction engine for multi-language AST parsing
// FEATURE: Core parsing layer for structural code analysis
```

Line 1: What the file does.
Line 2: `FEATURE: <name>` - the primary feature it belongs to. Links to hub.

### Zero Comments

No comments anywhere in the file except the 2-line header. No inline comments, no block comments, no TODO markers.

### Code Ordering

Strict order within every file:

1. Imports
2. Enums
3. Interfaces / Types
4. Constants
5. Functions / Classes

### Abstraction Thresholds

- **Under 20 lines, used once**: INLINE it. Do not extract into a function.
- **Under 20 lines, used multiple times**: Extract into a reusable function.
- **Over 30 lines**: Extract into its own function or file.
- **Max nesting**: 3-4 levels. Flatten deep nesting.
- **Max file length**: 500-1000 lines. Split larger files.
- **Max files per directory**: 10. Use subdirectories for organization.

### Variable Discipline

- No redundant intermediate variables. Chain calls: `c = g(f(a))` instead of `b = f(a); c = g(b)`.
- Exception: Keep intermediate variables that represent distinct, meaningful states.
- Remove all unused variables, imports, and files before finishing.

## Tool Reference

| Tool                  | When to Use                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `status`              | Start of every session. Project overview, index state, git info, memory stats.      |
| `tree`                | Map files + symbols with line ranges. Use after status for structural orientation.  |
| `skeleton`            | MUST run before full reads. Get signatures + line ranges first.                     |
| `search`              | Find files/identifiers by meaning. Modes: file, identifier, hybrid (default).       |
| `cluster`             | Browse codebase by meaning, not directory structure.                                 |
| `blast_radius`        | Before deleting or modifying any symbol. Uses call_sites index → import graph → full scan. |
| `lint`                | After writing code. Auto-detects linters + skill score checking.                    |
| `checkpoint`          | Save files with validation. Creates restore point before writing.                   |
| `checkpoints`         | See undo history.                                                                    |
| `restore`             | Revert a bad change without touching git.                                            |
| `hub`                 | Browse feature graph hubs. Find orphaned files.                                     |
| `reindex`             | Re-walk and re-parse project files after git pull or branch switch.                 |
| `diff`                | Structured git diff showing changed files, lines added/removed, affected symbols.   |
| `related`             | Show what a file imports, what imports it, siblings, and its test file.             |
| `test_map`            | Map source files to their test files via import graph and naming conventions.       |
| `explain`             | Extract a function/class body with its dependencies. Cheaper than reading the file. |
| `resolve_symbol`      | Resolve an identifier to its most likely definition with ambiguity scoring.         |
| `task_pack`           | Assemble minimum working set: ranked files, tests, memory, recent diffs.           |
| `decision_brief`      | Compressed context for a subsystem: ranked files, hubs, memory, risks.             |
| `change_impact`       | Estimate what could break if specific files or symbols change.                      |
| `edit_scope`          | Identify the smallest safe edit set for a task.                                     |
| `validate_scope`      | Recommend validation checks and commands for scoped files.                          |
| `repo_map`            | Compact repository map with important files and top-level symbols.                  |
| `workspace_context`   | List active projects and recent sessions without loading per-project code context.  |
| `artifact_list`       | List reusable context artifacts (task packs, repo maps, search results).            |
| `artifact_read`       | Load a previously generated artifact to reuse without regenerating.                 |
| `memory_create`       | Create/update memory nodes (concept, file, symbol, note) with auto-embedding.      |
| `memory_link`         | Create typed edges between memory nodes: depends_on, implements, references, similar_to, contains, **resolved_by**, **contradicts**. |
| `memory_search`       | Semantic search + graph traversal across neighbors.                                  |
| `memory_bulk`         | Bulk-add nodes with auto-similarity linking (cosine ≥ 0.72).                        |
| `memory_explore`      | Start from a node, walk outward, return scored neighbors.                           |
| `memory_list`         | List all memory nodes filtered by scope/kind. Use to audit or find IDs.            |
| `memory_delete`       | Delete a specific memory node by ID.                                                |
| `memory_record_task`  | Persist task outcomes with linked files, assumptions, evidence, and open risks.     |

## Anti-Patterns to Avoid

1. Reading entire files without checking the skeleton first.
2. Deleting functions without checking blast radius.
3. Creating small helper functions that are only used once.
4. Writing inline comments anywhere in the code.
5. Wrapping simple logic in 10 layers of abstraction or nesting.
6. Leaving unused imports or variables after a refactor.
7. Creating more than 10 files in a single directory.
8. Writing files longer than 1000 lines.
9. Running independent commands sequentially when they can be parallelized.
10. Repeating failed terminal commands without changing inputs or approach.
11. Calling `task_pack` or `repo_map` when a fresh artifact already exists — use `artifact_list` + `artifact_read`.
12. Ignoring trust/confidence metadata returned by agentic tools — low confidence signals stale index.

## Priority Reminder

Execute ASAP with the least tokens possible.
Use structural/context tools strategically, then patch and validate.
Avoid over-planning unless the task is ambiguous or high-risk.
