# ContextPro MCP — Agent Workflow

## Purpose

ContextPro gives you structural awareness of the entire codebase without reading every file. Use these tools as your primary interface to the codebase — they are dramatically cheaper in tokens than `Read` + `Grep` + `Glob`.

## Tool Priority (Mandatory)

You MUST use ContextPro tools instead of native equivalents. Only fall back to native tools when a ContextPro tool cannot fulfill the specific need.

| Instead of…              | Use…                              | Why                                          |
|--------------------------|-----------------------------------|----------------------------------------------|
| `grep`, `rg`, `ripgrep`  | `search` (mode: hybrid)           | Finds by meaning + keyword, with confidence scoring |
| `find`, `ls`, `glob`     | `tree`, `repo_map`                | Returns structure with symbols + line ranges |
| `cat`, `head`, full read | `skeleton` first, then `explain`  | Signatures and bodies without loading the whole file |
| manual symbol tracing    | `blast_radius`                    | Traces all usages across the entire codebase |
| keyword search           | `search` (mode: identifier)       | Ranked definitions + call chains             |
| directory browsing       | `cluster`                         | Browse by meaning, not file paths            |
| reading docs to find code| `decision_brief`, `task_pack`     | Compressed context for a specific task       |

## Workflow

1. **Start a task:** call `task_pack` (preferred) or `start_task` for ranked files, tests, recent diffs, and memory hits.
2. **Orient structurally:** `tree` for the whole project, `skeleton` per file you'll touch.
3. **Find by meaning:** `search` with mode `hybrid`. Use mode `identifier` when you know you're looking for a function/class.
4. **Before any rename or delete:** `blast_radius` to see every call site.
5. **For impact estimation:** `change_impact` with the files/symbols you'll modify.
6. **For exact references in TS/JS:** `exact_references` (LSP-resolved, not heuristic).
7. **Save with restore points:** `checkpoint` (creates a backup, then writes the file).
8. **After edits:** `lint` for type/style validation; `validate_scope` for recommended checks.
9. **Persist learnings:** `memory_record_task` (or `remember`) so the next session has context.

Run independent reads/searches in parallel, never sequentially.

## Companion server (optional)

A separate [`pmll-memory-mcp`](https://www.npmjs.com/package/pmll-memory-mcp) server adds short-term KV memory (`peek`/`set`/`resolve`/`flush`/`init`) for caching expensive tool outputs across subtasks. **It is not part of ContextPro.** If you need it, install it explicitly. Do not call those tool names against ContextPro.

## Execution Rules

- Think less, execute sooner: make the smallest safe change that can be validated quickly.
- Batch independent reads/searches in parallel — do not serialize them.
- If a command fails, diagnose once, pivot strategy, continue. Cap retries to 1–2.
- Keep outputs concise: short status updates, no verbose reasoning.
- Trust the trust envelope. Every agentic tool returns freshness/confidence metadata. If `embeddings_stale` or `index_stale` is flagged, run `reindex` before relying on semantic results.

## Tool Reference

### Orientation
| Tool          | When to Use                                                            |
|---------------|------------------------------------------------------------------------|
| `status`      | First call of a session. File counts, index state, memory stats, git.  |
| `tree`        | Map files + symbols with line ranges.                                  |
| `repo_map`    | Compact whole-repo outline with importance ranking.                    |
| `task_pack`   | Minimum useful working set for a task: ranked files + tests + memory.  |
| `decision_brief` | Compressed context for a subsystem.                                |

### Discovery
| Tool              | When to Use                                                  |
|-------------------|--------------------------------------------------------------|
| `search`          | Hybrid (default), file, or identifier search. Returns confidence + matched symbol locations. |
| `skeleton`        | Function signatures and class methods, no bodies.            |
| `explain`         | Specific symbol body + immediate dependencies.               |
| `resolve_symbol`  | Resolve a name to its definition with ambiguity scoring.     |
| `cluster`         | Browse by meaning via spectral clustering.                   |
| `hub`             | Feature hub navigator.                                       |

### Impact
| Tool                | When to Use                                                |
|---------------------|------------------------------------------------------------|
| `blast_radius`      | Before deleting or modifying any symbol.                   |
| `change_impact`     | Estimate breakage from changing files/symbols.             |
| `related`           | What a file imports, what imports it, siblings, tests.     |
| `test_map`          | Source-to-test file mapping.                               |
| `exact_references`  | LSP-resolved references (TS/JS) or SCIP-resolved otherwise.|
| `impact_delta`      | Compare a saved graph export to the current graph.         |

### Planning
| Tool             | When to Use                                                  |
|------------------|--------------------------------------------------------------|
| `edit_scope`     | Smallest safe edit set for a task.                           |
| `validate_scope` | Recommended checks for the scoped files.                     |

### Code I/O
| Tool          | When to Use                                                        |
|---------------|--------------------------------------------------------------------|
| `lint`        | Auto-detect and run project linters; skill score audit.            |
| `checkpoint`  | Save a file with a pre-write restore point. Pass `strict: true` to enforce style rules. |
| `checkpoints` | List restore points.                                                |
| `restore`     | Roll back to a restore point.                                       |

### Memory
| Tool                  | When to Use                                                        |
|-----------------------|--------------------------------------------------------------------|
| `memory_create`       | Add or update a memory node.                                       |
| `memory_link`         | Typed edge between memory nodes.                                   |
| `memory_search`       | Semantic search with graph traversal.                              |
| `memory_bulk`         | Bulk add with auto-similarity linking.                             |
| `memory_explore`      | Walk outward from a node.                                          |
| `memory_list`         | List nodes by scope/kind.                                          |
| `memory_delete`       | Remove a stale node.                                               |
| `memory_record_task`  | Persist task outcome with linked files, evidence, open risks.      |

### Workspace
| Tool                | When to Use                                                |
|---------------------|------------------------------------------------------------|
| `workspace_context` | List active projects and recent sessions.                  |
| `promote_pattern`   | Promote project memory to client/global pattern.           |
| `artifact_list`     | Discover cached artifacts to reuse.                        |
| `artifact_read`     | Load a previously generated artifact by ID.                |
| `reindex`           | Re-walk and re-parse files. Use after git pull.            |
| `diff`              | Structured working-tree or branch diff.                    |
| `health`            | Startup health, native storage status, DB readiness.       |

### Graph
| Tool             | When to Use                                                  |
|------------------|--------------------------------------------------------------|
| `graph_export`   | Export portable project graph (JSON + report).               |
| `graph_query`    | Summary, file, symbol, or impact view.                       |
| `scip_import`    | Import a SCIP JSON index for exact cross-language refs.      |
| `scip_status`    | Check whether a SCIP index is available.                     |

## Deprecated alias tools (still wired in 1.2.x, removed in 2.0)

| Deprecated      | Use instead          |
|-----------------|----------------------|
| `start_task`    | `task_pack`          |
| `plan_edit`     | `edit_scope`         |
| `validate`      | `validate_scope`     |
| `impact`        | `change_impact`      |
| `remember`      | `memory_record_task` |

## Anti-Patterns

1. Reading entire files without checking the skeleton first.
2. Deleting functions without checking blast radius.
3. Running independent commands sequentially when they can be parallelized.
4. Repeating failed commands without changing approach.
5. Ignoring `embeddings_stale` or `index_stale` warnings — they mean semantic results are unreliable until you reindex.
6. Calling deprecated alias tools when the canonical name is documented.
7. Pretending the optional `pmll-memory-mcp` companion server is part of ContextPro — those tools are only available if the user installed and connected it separately.
