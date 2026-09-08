# ContextPro implementation roadmap

Updated 2026-09-08. Optimize successful coding work for correctness, latency and measured cost. A mandatory MCP call on every lookup is not the objective.

| Order | Work | Acceptance evidence |
| --- | --- | --- |
| Foundation — implemented | Project-aware references, counts/truncation, worker isolation, stronger fingerprints and watcher recovery | Alias/test/project/re-export/shadowing regressions; stale-edit and failure tests; direct repo replay |
| 1 | Reduce cold compiler setup; share freshness work within a request; dependency-aware invalidation | Separate cold/warm timing; new callers invalidate negative caches; config and branch changes update results |
| 2 | Route common intents and select supporting evidence in bounded packets | Fewer model turns and smaller payloads at equal task success on held-out repositories |
| 3 | Validate memory, preserve supersession and support lexical retrieval offline | Changed supporting files/config invalidate facts; scope stays isolated; useful notes retrieved without embeddings |
| 4 | Reference pagination and SCIP revision verification | Every result retrievable without silently dropping matches; stale imported indexes identified |
| 5 | Trial optional graph expansion and learned pruning | Controlled ablation improves total task cost without unacceptable correctness loss; small reads avoid extra inference |

The foundation's [implementation report](../benchmarks/2026-09-08-reference-foundation.md) records limits and tests. It does not establish that all later acceptance criteria are met.

## Measurement policy

Keep deterministic exact-set tests alongside matched agent trials. Hold model/settings, task, repository revision and success criteria constant; counterbalance order and repeat trials. Separate indexing, tool, recovery and model time. Record provider input, cached-input and output usage without double-counting subset fields. Unknown billing stays unknown.

Track cold and warm latency, reference precision/recall, task success, retries, memory and disk growth. Compression that drops a required reference is a correctness failure even if the output is smaller. See the [benchmark index](../benchmarks/README.md).

Historical designs remain in the [archive](../archive/README.md). They are not promises to add every proposed tool, model or transport.
