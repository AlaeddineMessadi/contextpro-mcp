# Runtime architecture

ContextPro runs an MCP stdio server from `src/index.ts`. Each request resolves a verified project/worktree root. `src/tools/register-tools.ts` owns schemas and handlers; `src/core/tool-profile.ts` controls the initial catalog and discovery enables experts for the session.

## Retrieval path

1. Direct `context` targets read bounded current source without search or embeddings. Discovery queries use the index and ranking paths.
2. Graph-backed tools pass through freshness checks. The walker respects exclusions; fingerprints identify suspicious files, hashes verify content, and coordinated writers repair structural rows.
3. Retrieval combines lexical evidence with optional existing vectors. Task packets and source slices select bounded evidence and expose omissions rather than pretending selection is exhaustive.
4. Artifacts and prior packet IDs support reuse. A client must still possess a baseline before requesting a delta.

## Process boundaries

- The MCP parent handles transport, root routing, request bookkeeping and tool dispatch.
- `parser-process.ts` and `parser-worker.ts` isolate Tree-sitter WASM; regex fallback is lower precision and syntax validation can reject when parsing is unavailable.
- `typescript-reference-process.ts` and its worker isolate TypeScript language services. Versioned snapshots and project configurations support reuse. References distinguish direct calls, imports, definitions and other occurrences.
- Embedding and optional chat requests use independent provider configuration. Retrieval deadlines and lexical fallback limit some provider failures; they do not prove every possible native failure is recoverable.

## Storage and freshness

Each project's `.contextpro/index.db` uses SQLite WAL and sqlite-vec. Schema v7 adds ctime to file fingerprints. Source rows, symbols, imports and calls are updated transactionally per file from the same source read. Index generations invalidate derived context. Background watching is backed by periodic reconciliation, which continues after watcher failure.

The directory also holds configuration, memory-related state, artifacts and restore points. It must not be treated as one disposable cache. Native libraries live separately in an ABI-specific user cache. The workspace registry records known projects for routing and the dashboard.

No single operation atomically snapshots every file of an arbitrarily changing worktree. Explicit scope, stale/incomplete warnings and post-edit compiler/tests are part of the evidence contract.

## Evidence and edits

Compiler-resolved TS/JS references, imported SCIP evidence, AST-derived structure and textual/heuristic candidates are distinct. Reflection, unindexed/generated files, runtime injection and other repositories can be outside the returned scope. Imported SCIP revision validation remains planned.

Source mutations check expected revisions, reject disallowed paths/symlinks, serialize project writes and preserve restore points. Multi-file publication can partially succeed and reports recovery details. ContextPro's rename is textual; compiler-backed reference lookup does not turn it into a semantic rename engine.

## Documentation surfaces

`agent-instructions.md` is deliberately tiny because clients can repeat it in tool context. `agent-guide.md` is the on-demand MCP resource. `INSTRUCTIONS.md` is the concise project policy; both website surfaces consume one generated JSON representation of it. Historical plans and raw benchmarks are outside the runtime's normal instruction path.
