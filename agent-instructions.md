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

## Git Worktrees (multi-root routing)

One ContextPro server can serve several git worktrees at once. Each worktree has
its **own index** keyed off its own root — so a tool call must target the worktree
the files actually live in, or you will get results from the wrong checkout.

**Resolution order for every tool call:** explicit `root` argument → the workspace
roots your MCP client advertises (auto-detected) → the server's boot root. So if
your client exposes the worktree as its workspace root, routing is automatic and
you do not need to pass `root`. Pass it explicitly when auto-detection can't apply.

- **When to pass `root` explicitly:** the client advertises several roots and the
  request can't be attributed to one, the client doesn't support the `roots`
  capability, or you're driving a worktree other than your own workspace. Then pass
  the worktree's absolute path as `root` on each call (every tool accepts it).
  Omitting it with no usable client roots falls back to the boot root — usually the
  main checkout, which is **not** your worktree.
- **How to know your root:** run `git rev-parse --show-toplevel`. If that differs
  from the server's boot root (see `health`/`status` `repo.root`), you are in a
  worktree and must pass `root`.
- **First touch is cheap:** a fresh worktree clones the base checkout's index, so
  only files that differ from the base are processed — not the whole tree. The
  background reconcile sweep picks up those differences automatically once the
  worktree is routed; you rarely need an explicit `reindex` after creating one.
- **Parallel subagents:** when several agents run in different worktrees against
  the same server, each must pass its own `root`. Requests are isolated; a missing
  `root` is the usual cause of an agent "seeing the wrong code."
- **Cleanup:** `gc` removes indexes for worktrees git no longer lists. Run it
  (with the base root) after tearing down worktrees.

## Companion server (optional)

A separate [`pmll-memory-mcp`](https://www.npmjs.com/package/pmll-memory-mcp) server adds short-term KV memory (`peek`/`set`/`resolve`/`flush`/`init`) for caching expensive tool outputs across subtasks. **It is not part of ContextPro.** If you need it, install it explicitly. Do not call those tool names against ContextPro.

## Execution Rules

- Think less, execute sooner: make the smallest safe change that can be validated quickly.
- Batch independent reads/searches in parallel — do not serialize them.
- If a command fails, diagnose once, pivot strategy, continue. Cap retries to 1–2.
- Keep outputs concise: short status updates, no verbose reasoning.
- Trust the trust envelope. Structural graph tools run a cheap freshness probe before reading, refresh changed/added/deleted files, and coordinate concurrent agents through a shared SQLite lock. A background tracker still heals idle-time drift. You normally do **not** need a manual `reindex`; use it after a large branch switch or when `status` reports an embedding problem.
- Treat savings footers as transparent estimates, not billing facts. Use `efficiency_report` for the calculation method, numeric-only history, and an optional model-price scenario.
- When a substantive task used ContextPro, include the largest "this MCP session" estimate from its footers in the final summary. Do not call it billed-token savings, and do not add footer values manually.

## Tool Reference

### Orientation
| Tool          | When to Use                                                            |
|---------------|------------------------------------------------------------------------|
| `status`      | First call of a session. File counts, index state, memory stats, git.  |
| `efficiency_report` | Auditable estimated token savings for this session, 24h, 7d, or all history. |
| `tree`        | Map files + symbols with line ranges.                                  |
| `repo_map`    | Compact whole-repo outline with importance ranking.                    |
| `task_pack`   | Ranked files + tests + memory; use `max_tokens` to bound context without losing the two strongest files. |
| `decision_brief` | Compressed context for a subsystem.                                |

### Discovery
| Tool              | When to Use                                                  |
|-------------------|--------------------------------------------------------------|
| `search`          | Hybrid RRF search with confidence, symbol locations, and an inline crux by default. |
| `skeleton`        | Function signatures and class methods, no bodies.            |
| `explain`         | Specific symbol body + immediate dependencies.               |
| `resolve_symbol`  | Resolve a name to its definition with ambiguity scoring.     |
| `cluster`         | Browse by meaning via spectral clustering.                   |
| `hub`             | Feature hub navigator.                                       |

### Impact
| Tool                | When to Use                                                |
|---------------------|------------------------------------------------------------|
| `blast_radius`      | Before deleting or modifying any symbol; summary groups usage kinds by enclosing caller. |
| `change_impact`     | Estimate breakage from changing files/symbols.             |
| `related`           | What a file imports, what imports it, siblings, tests.     |
| `test_map`          | Source-to-test file mapping.                               |
| `test_impact`       | Tests affected by changes since a ref (run-all fallback on config changes). |
| `semantic_diff`     | What SYMBOLS changed since a ref (added/removed/modified/moved), ignores reformatting. |
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
| `reindex`           | Force a full re-walk. Rarely needed — the index self-heals within ~30s. Use only after a large git pull when you need fresh results now. |
| `diff`              | Structured working-tree or branch diff.                    |
| `health`            | Startup health, native storage status, DB readiness.       |

### Graph
| Tool             | When to Use                                                  |
|------------------|--------------------------------------------------------------|
| `graph_export`   | Export portable project graph (JSON + report).               |
| `graph_query`    | Summary, file/symbol/impact, weighted path, hotspots, or structural communities. Use `max_tokens` to bound context. |
| `scip_import`    | Import a SCIP JSON index for exact cross-language refs.      |
| `scip_status`    | Check whether a SCIP index is available.                     |

### SQL / Database (Postgres / Supabase)
| Tool          | When to Use                                                     |
|---------------|----------------------------------------------------------------|
| `sql_schema`  | Table columns/types/CHECK, RLS enabled state, RLS policies (command/roles/predicate), and SECURITY DEFINER function bodies — from migration `.sql` files, without psql. Filter by table/policy/function name. Use this instead of shelling out to psql / `pg_get_functiondef` for schema & RLS questions. |

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
5. Reflexively running a full `reindex` after adding a few files — structural reads now refresh small changes on demand and concurrent agents share the same refresh.
6. Calling deprecated alias tools when the canonical name is documented.
7. Pretending the optional `pmll-memory-mcp` companion server is part of ContextPro — those tools are only available if the user installed and connected it separately.
8. Working inside a git worktree without passing `root` — your calls hit the main checkout's index instead of the worktree's, so you see the wrong code. Check `git rev-parse --show-toplevel` and pass it as `root`.
