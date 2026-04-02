# Context+ MCP - Agent Workflow

## Purpose

Context+ gives you structural awareness of the entire codebase without reading every file. These tools replace your default search and read operations — use them as your primary interface to the codebase.

## Tool Priority (Mandatory)

You MUST use Context+ tools instead of native equivalents. Only fall back to native tools when a Context+ tool cannot fulfill the specific need.

| Instead of…             | MUST use…                      | Why                                         |
|--------------------------|--------------------------------|---------------------------------------------|
| `grep`, `rg`, `ripgrep` | `semantic_code_search`         | Finds by meaning, not just string match     |
| `find`, `ls`, `glob`    | `get_context_tree`             | Returns structure with symbols + line ranges|
| `cat`, `head`, read file | `get_file_skeleton` first      | Signatures without wasting context on bodies|
| manual symbol tracing    | `get_blast_radius`             | Traces all usages across the entire codebase|
| keyword search           | `semantic_identifier_search`   | Ranked definitions + call chains            |
| directory browsing       | `semantic_navigate`            | Browse by meaning, not file paths           |

## Workflow

1. Start every task with `get_context_tree` or `get_file_skeleton` for structural overview
2. Use `semantic_code_search` or `semantic_identifier_search` to find code by meaning
3. Run `get_blast_radius` BEFORE modifying or deleting any symbol
4. Prefer structural tools over full-file reads — only read full files when signatures are insufficient
5. Run `run_static_analysis` after writing code
6. Use `search_memory_graph` at task start for prior context, `upsert_memory_node` after completing work

## Execution Rules

- Think less, execute sooner: make the smallest safe change that can be validated quickly
- Batch independent reads/searches in parallel — do not serialize them
- If a command fails, diagnose once, pivot strategy, continue — cap retries to 1-2
- Keep outputs concise: short status updates, no verbose reasoning

## Tool Reference

| Tool | When to Use |
|------|-------------|
| `get_context_tree` | Start of every task. Map files + symbols with line ranges. |
| `get_file_skeleton` | Before full reads. Get signatures + line ranges first. |
| `semantic_code_search` | Find relevant files by concept. |
| `semantic_identifier_search` | Find functions/classes/variables and their call chains. |
| `semantic_navigate` | Browse codebase by meaning, not directory structure. |
| `get_blast_radius` | Before deleting or modifying any symbol. |
| `get_feature_hub` | Browse feature graph hubs. Find orphaned files. |
| `run_static_analysis` | After writing code. Catch errors deterministically. |
| `propose_commit` | Validate and save file changes. |
| `list_restore_points` | See undo history. |
| `undo_change` | Revert a change without touching git. |
| `upsert_memory_node` | Create/update memory nodes (concept, file, symbol, note). |
| `create_relation` | Create typed edges between memory nodes. |
| `search_memory_graph` | Semantic search + graph traversal across neighbors. |
| `prune_stale_links` | Remove decayed edges and orphan nodes. |
| `add_interlinked_context` | Bulk-add nodes with auto-similarity linking. |
| `retrieve_with_traversal` | Walk outward from a node, return scored neighbors. |

## Anti-Patterns

1. Reading entire files without checking the skeleton first
2. Deleting functions without checking blast radius
3. Running independent commands sequentially when they can be parallelized
4. Repeating failed commands without changing approach
