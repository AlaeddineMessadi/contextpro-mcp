# Context+ Agentic Code Intelligence Roadmap

## Goal

Make Context+ a standalone MCP code intelligence engine that works safely across different projects without agents reading whole repositories into context. The product should provide compact, trustworthy, project-scoped answers that reduce token use while lowering edit risk.

## Implementation Status

First hardening pass started on 2026-06-09:

- [x] Fixed sqlite-vec filtered KNN search compatibility by avoiding illegal auxiliary-column constraints during vector queries.
- [x] Restored the legacy memory graph API as a compatibility adapter over SQLite-backed memory storage.
- [x] Removed deprecated unused dependencies and updated vulnerable direct dependencies.
- [x] Added a `pretest` build step so tests run against current compiled output.
- [x] Added a Node engine range aligned with the native dependency support window.
- [x] Replaced shell-interpolated git/linter execution paths with argument-based process execution.
- [x] Preserved project-scoped memory and `mn-` compatibility IDs for public memory tools.
- [x] Centralized path containment checks and applied them to read, write, restore, hub, skeleton, reindex, diff, explain, related, and validation tools.
- [x] Added primary workflow tool names: `start_task`, `plan_edit`, `impact`, `validate`, and `remember`.
- [x] Built the first exact typed graph core for project, folder, file, test, config, document, package, and symbol nodes.
- [x] Added typed graph edges for contains, defines, imports, calls, references, tests, and configures with confidence/evidence metadata.
- [x] Added `graph_export` and `graph_query` MCP tools.
- [x] Added portable `.contextpro/graph.json` and `.contextpro/GRAPH_REPORT.md` exports.
- [x] Added SQLite FTS5/BM25 warm retrieval over indexed paths, headers, signatures, symbols, and languages.
- [x] Fused persisted FTS hits into semantic file search so indexed projects can still search when embeddings are unavailable.
- [x] Added search ranking presets (`fast`, `balanced`, `exhaustive`) while keeping raw weights available for advanced callers.
- [x] Added `impact_delta` to compare a saved graph export with the current indexed graph after edits.
- [x] Added a standalone `.contextpro/graph-dashboard.html` dashboard export.
- [x] Added heuristic route, inheritance, implementation, and recent co-change graph edges.
- [x] Added SCIP JSON import/status tools and graph merge for `SCIP_RESOLVED` definition, reference, and implementation evidence.
- [x] Added TypeScript/JavaScript language-service exact references with `LSP_RESOLVED` confidence.
- [x] Added `exact_references` fallback to imported SCIP indexes for non-TypeScript projects.

## Operating Principles

1. Trust beats breadth: fewer reliable workflows are better than many overlapping tools.
2. Project isolation is mandatory: every cache, graph, memory, and artifact is scoped to a verified root.
3. Exact facts beat semantic guesses: use embeddings for relevance, but exact indexes for definitions, references, and impact.
4. Task packets beat primitive calls: agents should start work with one compact packet, not six discovery calls.
5. Every answer needs provenance: distinguish exact, AST-extracted, LSP-resolved, semantic, heuristic, and stale evidence.
6. Standalone first: Context+ should work from a local project with no external services unless a user explicitly enables one.

## Immediate Fixes

- Fix sqlite-vec filtered KNN queries so source-specific embedding search works at runtime.
- Remove stale memory graph contracts or provide an explicit compatibility layer over SQLite-backed memory.
- Remove unused deprecated dependencies and update vulnerable direct dependencies.
- Replace shell-interpolated git commands with argument-based execution.
- Add runtime/version checks for native dependencies and supported Node versions.
- Keep tests serial with build output available, or change the test script to build first.
- Keep roadmap and implementation state outside `TODO.md`, because that file requires human approval for content edits.

## Public MCP Surface Simplification

Current tool count is high. Keep primitives available for advanced users, but make agent workflows primary:

- `start_task`: repo status, reusable artifacts, task pack, risks, and first files.
- `plan_edit`: smallest safe edit set, exact references, tests, and confidence.
- `impact`: changed files/symbols, dependents, call paths, tests, and risk.
- `validate`: project-specific commands and focused test recommendations.
- `remember`: record outcome, assumptions, evidence, and open risks.

Existing low-level tools should be grouped as advanced discovery, analysis, memory, and operations. Ranking knobs should move behind presets such as `fast`, `balanced`, and `exhaustive`.

## Precise Graph Roadmap

### Phase 1: Exact Local Graph Core

- Store typed graph nodes for project, package, folder, file, symbol, route, config, test, and document.
- Store typed edges for contains, defines, imports, calls, references, tests, configures, inherits, implements, route_handles, and co_changes_with.
- Add confidence and source columns to every edge.
- Add graph query helpers for inbound/outbound traversal, shortest path, callers, callees, and impacted tests.
- Keep SQLite as the default embedded store.

### Phase 2: SCIP/LSP Adapters

- Add optional SCIP import for languages with mature indexers. Implemented as `scip_import`, `scip_status`, graph merge, and exact-reference fallback over normalized SCIP JSON.
- Add local LSP-based reference providers where SCIP is unavailable. Implemented first for TypeScript/JavaScript with the local TypeScript language service.
- Preserve fallback AST/regex extraction for unsupported languages. Existing AST and heuristic paths remain active.
- Mark results as `LSP_RESOLVED`, `SCIP_RESOLVED`, `AST_EXTRACTED`, or `HEURISTIC`. Implemented in graph edges and exact-reference output.
- Future adapter expansion should add native LSP clients for Python, Go, Rust, Java, and C# when a project does not provide SCIP.

### Phase 3: Hybrid Retrieval

- Add SQLite FTS5/BM25 over file headers, signatures, symbol names, docs, and generated summaries.
- Fuse BM25, vector similarity, graph distance, exact symbol hits, and recent churn.
- Expose query presets instead of raw ranking weights.
- Persist warm indexes so search does not walk the repo during normal use.

### Phase 4: Incremental Standalone Indexing

- Move from query-time refresh to a durable background indexer with content hashes.
- Use cheap non-cryptographic hashes for freshness checks and SHA-256 only where content identity matters.
- Track per-file parse, graph, embedding, and summary generations.
- Support `watch`, `lazy`, and `manual` modes.
- Make all stale responses explicit and machine-readable.

### Phase 5: Agent Safety Workflows

- Require exact reference checks before delete/rename/change-impact operations when available.
- Add `impact_delta` after edits to compare planned vs actual affected graph.
- Add validation plans that use dependency/test edges, package scripts, and changed-language detection.
- Persist task outcomes as compact project-scoped memory.
- Decay or summarize old memory to avoid stale recommendations.

### Phase 6: Human Visibility

- Export `.contextpro/graph.json` for team sharing.
- Export `.contextpro/GRAPH_REPORT.md` with architecture, hubs, risks, suggested questions, and confidence notes.
- Add a local dashboard or TUI for graph, hubs, restore points, memory, and impact paths.
- Keep generated graph artifacts portable across checkouts by using relative paths.

## Security And Reliability

- No raw cross-project memory search by default.
- No cross-client memory unless explicitly promoted and sanitized.
- No network calls unless the provider is explicitly configured.
- Path containment checks before reading, writing, restoring, or exporting.
- Argument-based process execution for git and validators.
- Audit direct dependencies on every release.
- Add adversarial tests for path traversal, shell metacharacters, oversized inputs, stale root reuse, and malformed MCP payloads.

## Success Metrics

- Build passes.
- Main tests pass.
- `npm audit` has no high severity direct dependency issues.
- Warm `search` and `task_pack` avoid full repo walks.
- Exact reference tools return exhaustive results for supported languages.
- Task startup consumes fewer tokens than grep/read exploration.
- Agents can complete multi-file edits with fewer missed dependents and fewer validation retries.
