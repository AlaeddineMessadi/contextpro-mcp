# Reference and freshness foundation — 2026-09-08

This is the first implementation batch from the September research roadmap. It strengthens correctness, failure handling and repeated reference queries. It does not implement the later routing, memory or learned-pruning proposals, or establish an end-to-end benchmark win.

## Implemented

### Reference evidence and compiler reuse

TypeScript/JavaScript references use the nearest `tsconfig.json` or `jsconfig.json`, including inherited options, aliases and source redirects for referenced projects. Indexed tests excluded from production compilation are checked with their nearest configuration. Malformed configurations and unresolved static workspace imports produce coverage warnings instead of silent guessed settings. Scope remains the indexed TS/JS inventory plus an explicitly supplied target; dynamic references, unindexed files and other repositories are outside that scope.

Each occurrence is classified as a definition, import/re-export, direct call or other reference. Multiple calls on one line remain distinct. Shadowed names, callback values and identifiers inside computed keys or nested factory calls are not counted as direct calls. Responses expose `total`, `returned`, `truncated`, category counts, scope and warnings. Display limits never change the total. The maximum displayed set is still 500; pagination is future work, and the response explicitly directs verification of omitted matches. Python import/call heuristics are labeled as such. Imported SCIP source-revision validation remains future work.

A compiler worker retains at most three language-service projects and updates versioned source snapshots. Configuration changes and added source files are observed; regression coverage includes a consumer whose referenced project's configuration changes. Idle services/workers are disposed after 60 seconds. The worker has a 512 MB V8 heap limit, a 30-second active-request deadline, a bounded queue and a 20,000-file input limit. A timeout or child crash rejects pending requests; the next query can start a new worker. These are process-level bounds, not a guarantee against whole-machine memory exhaustion.

### Freshness and watcher recovery

Schema v7 adds change-time metadata alongside size and full-precision modification time. This detects ordinary same-size edits whose modification time was restored. Older fingerprints are refreshed lazily. Metadata is a fast detector, not cryptographic proof; explicit hash refresh remains available.

Reindex, quick refresh and targeted structural refresh hash and parse one source read, with matching metadata checked before/after that read. A concurrent change during the read fails that file instead of publishing a mixed fingerprint and parse. This provides per-file consistency, not an atomic snapshot of every file in a continuously edited repository.

Status now checks changed indexed content as well as inventory changes. Failed or capped refreshes remain stale; successfully repairing a large batch no longer requests a redundant reindex merely because many files changed. If watching fails at initialization or later, periodic reconciliation continues polling.

## Direct app-a replay

Target: `canEditItem` at `src/billing/featureLimits.ts:391` in the local app-a checkout used in the earlier incident investigation. A structural-only reindex preceded this replay: approximately 9.2 seconds, 534 discovered files, 331 processed and 203 skipped. The typed-reference scope contained 246 TS/JS files.

Four sequential direct calls to `exactReferencesTool` ran in one Node v24.15.0 process, retaining the compiler worker. The first call had no compiler-service cache. All four returned the same category counts with no coverage warnings: **13 calls, three imports and one definition**. The 13-call count matches the earlier independently enumerated call locations. No source bodies or private conversation records are committed.

| Compiler state | Direct tool duration | Calls | All occurrences |
| --- | ---: | ---: | ---: |
| Cold service | 12,743 ms | 13 | 17 |
| Warm service | 738 ms | 13 | 17 |
| Warm service | 683 ms | 13 | 17 |
| Warm service | 675 ms | 13 | 17 |

[Raw measurements](2026-09-08-reference-replay.json). These measurements were recorded before the final nested-callee classification hardening; the final regression suite checks that hardening separately. They exclude MCP transport, discovery, pre-query freshness, model reasoning and initial indexing. OS caches were not cleared, and no paired native/Graft trial or provider-usage capture was performed. They demonstrate repeat-query reuse on this checkout, not a controlled speedup versus the old implementation, a p95 guarantee, or token/money savings. Cold startup remains a concrete optimization target.

## Validation

- All **644 main tests pass on both Node v26.0.0 and v24.15.0**. Node 26 matches the repository's installed native modules; Node 24 uses `CONTEXTPRO_NATIVE_CACHE_DIR` pointing to its existing isolated cache. The initial default Node 24 run exposed fixture-specific failures: temporary HOME directories hid the stable cache, and a protocol test disabled automatic repair. Shared native modules were not rebuilt.
- New regressions cover inherited aliases, indexed tests, separate referenced projects, config changes, re-exports, same-line calls, shadowing, nested/computed callees, more than 500 results, modified/new source files, restored modification times, partial refreshes, watcher failure, compiler timeout and child termination.
- `buildValidateScope` recommended the relevant test suite and build, both run. Its optional query-embedding request timed out and fell back to keyword ranking without disconnecting.
- TypeScript build succeeds. Package dry-run includes the compiler worker, process manager, reference service and fingerprint helper.

Reproduce the full suite with the Node runtime matching the installed bindings, or provide the stable native cache when using another supported runtime:

```sh
npm run build
CONTEXTPRO_NATIVE_CACHE_DIR=/absolute/path/to/contextpro/native \
  node --test --test-concurrency=4 test/main/*.test.mjs
npm pack --dry-run
```

## Next batches

### PR review follow-up

The compiler worker now applies the requested display limit before IPC, retaining at most 500 context-bearing entries while counting and deduplicating all occurrences. Source snippets use line offsets instead of splitting an entire file for each result. Empty TypeScript results again fall back to imported SCIP evidence, preserving compiler warnings and explicitly marking SCIP freshness as unverified. The live retrieval benchmark's parser task now expects `tree-sitter-runtime.ts`, where grammar loading lives; historical measurements above remain unchanged.

After these fixes, all **646 main tests pass on Node v26.0.0**. Added coverage exercises a real worker returning three of 2,002 occurrences, upper/lower/default limits, project deduplication under truncation, and malformed-config fallback to SCIP in text and JSON. The TypeScript build, scope validation's recommended tests and diff whitespace check pass.

### Planned work

1. Share freshness work within a request, add dependency-aware invalidation and reduce cold compiler setup. Keep negative results dependent on source inventory.
2. Route common intents through the existing small catalog; select evidence and supporting types/tests within one bounded context packet.
3. Validate memory against source/config revisions, preserve supersession and support scoped lexical retrieval offline.
4. Evaluate optional pruning and graph expansion on held-out tasks. Ship them only after matched agent trials show lower measured cost with preserved task success.

The operating goal is reliable, cheaper successful work. Tiny known-file reads can still favor native tools; no universal winner or universal correctness claim is made.
