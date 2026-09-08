# ContextPro status

Updated 2026-09-08. This describes the checkout including [PR #9](https://github.com/AlaeddineMessadi/contextpro-mcp/pull/9), not a published release. Package metadata remains `1.3.0`; supported Node range is `>=20 <27`.

| Area | Current behavior | Remaining limit |
| --- | --- | --- |
| Tool catalog | Four profiles; workflow defaults to 14 tools, lean to three | Dynamic discovery depends on client support |
| Structural index | SQLite schema v7; size/mtime/ctime probes, hash verification and per-file consistent reads | No atomic whole-repo or unsaved-buffer snapshot |
| Background updates | Watcher plus periodic reconciliation; polling survives watcher failure | Large backlogs take time; inspect freshness |
| Parser | Isolated WASM worker with bounded requests and fallback | Fallback reduces precision; syntax validation can fail closed |
| TS/JS references | Reused compiler projects, aliases/project refs/indexed tests, categorized counts and per-file call totals | Indexed scope only; 500 displayed results; cold initialization cost |
| Other reference evidence | SCIP import and Python import/call candidates | SCIP revision verification and stronger Python resolution remain open |
| Retrieval | Bounded context, batched reads, keyword fallback, optional graph pointers | No guarantee every task-relevant dependency is selected |
| Embeddings | Independent optional provider; bounded query requests | Reindex needed for changed model/corpus vectors |
| Memory | Project/session scopes, durable notes and graph traversal | Source/config evidence validation and robust offline retrieval remain work |
| Source edits | Revision checks, serialized writes, restore points and preview | Multi-file publication is not transactional; rename is textual |
| Efficiency | Session estimates plus separately recorded provider-usage trials | No automatic billing access or universal savings claim |

## Verification and measurements

Reference/freshness commit `c5742ab` passed **644 main tests on Node v24.15.0 and v26.0.0**, TypeScript build and package dry-run. Node 24 used its isolated native dependency cache. See the [implementation report](docs/benchmarks/2026-09-08-reference-foundation.md).

The direct app-a reference replay returned 13 calls, three imports and a definition, with 12.743 s cold setup and 0.675–0.738 s repeated queries. These are tool timings, not agent savings. The [benchmark index](docs/benchmarks/README.md) separates provider records from estimates and incident replays.

## Next work

[TODO.md](TODO.md) and the [current roadmap](docs/roadmaps/contextpro-roadmap.md) track cold-start/freshness cost, evidence-aware routing, validated memory, pagination and held-out evaluations. Those items are not complete merely because the foundation passed its tests.

[CHANGELOG.md](CHANGELOG.md) records changes. [AUDIT.md](AUDIT.md) and [archived plans](docs/archive/README.md) preserve historical findings; their old counts and defaults are not the current configuration reference.
