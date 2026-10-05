# ContextPro status

Updated 2026-10-05. This describes the current source checkout, including the development/teamwork phases, not a published release. Package metadata remains `1.3.0`; supported Node range is `>=20 <27`.

| Area | Current behavior | Remaining limit |
| --- | --- | --- |
| Tool catalog | Four profiles; workflow defaults to 14 tools, lean to three; supported expert dispatcher | Live catalog refresh still depends on the client |
| Structural index | SQLite schema v7; size/mtime/ctime probes, hash verification and per-file consistent reads | No atomic whole-repo or unsaved-buffer snapshot |
| Background updates | Watcher plus periodic reconciliation; polling survives watcher failure | Large backlogs take time; inspect freshness |
| Parser | Isolated WASM worker with bounded requests and fallback | Fallback reduces precision; syntax validation can fail closed |
| TS/JS references | Reused compiler projects, aliases/project refs/indexed tests, categorized counts and per-file call totals | Indexed scope only; 500 displayed results; cold initialization cost |
| Other reference evidence | Configured Pyright LSP; explicit Python heuristic fallback when unconfigured; SCIP import | Optional language server must be installed; SCIP revision verification remains open |
| Retrieval | Bounded exact reads, path/identifier-guided source, UI/document orientation; opt-in connected graph retrieval | Broad lexical recall remains incomplete; hints are not hard filters |
| Embeddings | Independent optional provider; bounded query requests | Reindex needed for changed model/corpus vectors |
| Context reuse | Source-hash-bound query deltas and cached cited feature briefs; model summaries opt-in | Omit previous context IDs after context loss; caches are regenerable |
| Memory | Source/config hash evidence, explicit supersession, lexical fallback and immutable handoffs | Legacy records are unverified; ignored inputs and unsaved buffers are outside scope |
| Source edits | Compiler rename previews for TS/JS and configured Python; revision/hash checks and restore points | Multi-file publication is not transactional; legacy rename_symbol remains textual |
| Teamwork | Shared local task/dependency ledger, atomic claims and five-minute file leases | Explicit and advisory; ContextPro does not launch agents or messages |
| Validation | Pre-check snapshots and host-reported command receipts | Recommendations are not executed checks; changed inputs invalidate applicability |
| Shared compute | Optional private per-user service for indexing and TS/Python compiler work | Defaults off; resource/latency evidence remains limited |
| Efficiency | Session estimates plus separately recorded provider-usage trials | No automatic billing access or universal savings claim |

## Verification and measurements

The October 5 development/teamwork phases pass **821 main tests** on Node 26, plus the previously run 33 parser demos. All 42 focused workflows also pass on Node 20.20.2 with a stable native cache. Build, documentation, package-content and release-metadata checks pass locally; the package audit reports zero vulnerabilities. Fresh stdio verifies the unchanged three-tool lean catalog and the complete claim/check/record/handoff/rename flow. The [implementation and measurement report](docs/benchmarks/2026-10-05-development-teamwork.md) separates these results from the frozen coding campaign (12-attempt smoke complete, 60-attempt expansion running), opt-in runtime measurements and release states. PR #42 is open; hosted CI is billing-blocked, and merge/publication and desktop reload remain pending.

The September 29 repair reproduces the three app-b source-location reports
on frozen revision `private-rev` and adds scoped directory/named-usage candidates to
both source selectors. The [replay report](docs/benchmarks/2026-09-29-scoped-discovery.md)
records 12/12 candidate coverage checks in 24 matched calls, 782 passing main tests,
33 parser demos, fresh stdio verification and build identity. README,
agent policy, managed project instructions and website instructions describe the
same current behavior. Restart a running MCP process after rebuilding; files on
disk do not prove which build another agent has loaded.

The [September 26 coding pilot](docs/benchmarks/2026-09-26-connected-evidence.md)
accounts for all 16 planned attempts. Baseline acceptance was 1/8 and candidate
acceptance 0/8, with no jointly passing pairs. The productivity gate was not met;
connected retrieval remains opt-in. Later source-retrieval fixes are development
regressions, not a rerun or improvement claim for that frozen pilot.

PR #28 merged at `c43ddc6` with 759 main tests, 33 parser demos and 24 orientation
replay calls passing locally. Its GitHub jobs did not run because of account
billing/spending limits. Local checks do not certify the remote OS/Node matrix.

### Earlier dated measurements


The September 8 open-source preparation added contributor/security guides, gated release workflows, package-content checks and a source-install website path. **656 main tests pass on Node v26.0.0**; both optional apps build with Next.js 16.3.4 / React 19.2.8, and all three production dependency audits report zero known vulnerabilities at this check. Workflow syntax and documentation/package checks pass locally. Public visibility, npm publication and GitHub security settings remain explicit [launch gates](docs/launch/checklist.md).

The reference-evidence follow-up passes **654 main tests on Node v26.0.0**. All 24 offline reference replay queries pass; compiler latency is essentially unchanged. The larger text fixture is 12.5% smaller, while the initial lean/workflow catalog grows by 1,071 bytes. These are output/schema measurements, not agent token savings. See the [evidence report](docs/benchmarks/2026-09-08-reference-evidence.md).

Reference/freshness commit `c5742ab` passed **644 main tests on Node v24.15.0 and v26.0.0**, TypeScript build and package dry-run. Node 24 used its isolated native dependency cache. See the [implementation report](docs/benchmarks/2026-09-08-reference-foundation.md).

The direct app-a reference replay returned 13 calls, three imports and a definition, with 12.743 s cold setup and 0.675–0.738 s repeated queries. These are tool timings, not agent savings. The [benchmark index](docs/benchmarks/README.md) separates provider records from estimates and incident replays.

## Next work

[TODO.md](TODO.md) and the [current roadmap](docs/roadmaps/contextpro-roadmap.md) track cold-start/freshness cost, evidence-aware routing, validated memory, pagination and held-out evaluations. Those items are not complete merely because the foundation passed its tests.

[CHANGELOG.md](CHANGELOG.md) records changes. [AUDIT.md](AUDIT.md) and [archived plans](docs/archive/README.md) preserve historical findings; their old counts and defaults are not the current configuration reference.
