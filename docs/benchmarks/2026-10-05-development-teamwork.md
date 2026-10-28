# Development and local teamwork: implementation evidence

The six capability phases are implemented on the `2448966` status/indexing baseline. Adaptive retrieval and shared compute remain opt-in. Coding-performance promotion is not established by the deterministic tests or the small retrieval measurements below.

## Source and validation

| Phase | Source commit | Local evidence |
| --- | --- | --- |
| Intent-aware context and bounded documents | `4ef200f`, `2ccb186` | Paraphrases, unknown identifiers, no-answer cases, scoped queries and bounded packets; current billing note returned at the original 1,400-token budget |
| Request freshness and optional shared compute | `26d7477`, `136cdaa` | Concurrent startup/recovery, root isolation and crash fallback; later follow-up routes configured Python through the same service |
| Evidence-backed memory, handoffs and validation | `b6c1bdf` | Stale source/configuration, immutable repeated task history, supersession, lexical fallback, actual host check receipt and stale applicability |
| Local task ledger | `c6b9902` | Independent-process claims, worktree overlap warnings, dependency cycles, expiry/reclaim and retained handoffs |
| TS/JS and Python compiler workflow | `136cdaa` | Diagnostics, aliases, shadowing, cross-file rename, stale preview rejection, Python virtual environments and explicit missing-server behavior |

The core suite passes 824 tests on Node 26. The three local review repairs additionally pass 30 focused daemon/compiler/evidence/walker checks on Node 20.20.2: pending freshness keeps admission slots and roots until settlement, Pyright detects imported `.py`/`.pyi` edits and membership changes, and authored hidden configuration invalidates receipts and task memory. Earlier gates include 33 parser demos, 42 focused Node 20 workflow tests, 25 reference/compiler regressions and a five-test Node 20 compiler run. The initial Node 20 run is retained as an environment failure: native headers timed out and HOME-changing fixtures removed a temporary cache before the stable-cache rerun. Fresh stdio starts with exactly `context`, `exact_references` and `discover_tools`; enabled specialists complete a claim/check/record/handoff/rename/completion flow. Build, documentation, package-content and release-metadata checks pass locally. These results do not certify the hosted OS/Node matrix or desktop MCP activation.

The desktop health check at 18:51 UTC reports 1.3.0/build 2026-10-05T15:49:45.508Z/PID28501, predating the three local review repairs. The frozen coding candidate is `2ccb186`, independently built at 2026-10-05T13:53:29.381Z. Follow-up commits `983884b`, `c946717`, `91f2519` and `e8d9904` add memory/risk/history and runtime hardening; they are separately tested and are not substituted into the frozen coding arm. Further fixes canonicalize leased file aliases (`f060469`), reject ambiguous Python targets and respect Unicode identifier boundaries (`8df7b91`), and keep large rename previews within their requested budget while retaining every edit in the immutable artifact (`ed7a4e8`). The package audit is clean after compatible transitive fixes in `2676b49`. Restart/reload is a separate activation step.

## Existing issue replays

On a private repository (revision not published), the loaded baseline still omits `humanpending.md` for the original CI-billing query. A fresh frozen candidate with `intent:"auto"` returns the decisive lines 31/39 in 4,906 UTF-8 bytes with `max_tokens:1400`. A narrow regression covers long operational paragraphs as well as a small document. This is a verified opt-in retrieval repair, not a speed claim: the fresh call took 14.54 s including preparation.

The frozen candidate still misses the endpoint for the broad thumbnail-batch query. Follow-up `61c21dd` adds an opt-in endpoint path-topic prior: at the same 1,600-token budget, the current build returns route lines 22–46 in 5,441 bytes. This locates the route but still omits the decisive retry logic; at 6,000 tokens it also returns lines 100–124. Fresh build 2026-10-05T15:49:45.508Z verifies generation 4087, 1,459 sources, no missing/removed sources and a fresh structural index. The issue remains partially addressed, with exact reads as the workaround for complete evidence at small budgets. This follow-up and retrieval-configuration-aware brief invalidation pass 62 focused tests on Node 26 and Node 20; neither is substituted into the frozen coding arm. A raw-module probe accidentally used a different embedding model and cleared regenerable vectors; this was environment misuse, not evidence of a retrieval defect. The fresh replay used the configured embedding identity and disclosed lexical limitations.

## Bounded external retrieval comparison

The same four-file TS/Python/document fixture is used for two symbol lookups, an operational-document lookup and a no-answer query. Each is repeated twice in a persistent MCP session. No corpus embeddings are created. First/second requests are not OS-cache-cold measurements. The host also runs other work; this is a small diagnostic comparison, not a universal ranking.

| Tool and version | First-request median | Second-request median | Median response bytes | Evidence returned |
| --- | ---: | ---: | ---: | --- |
| ContextPro candidate |55.8 ms |99.3 ms |660 | Both symbol bodies and the billing paragraph |
| Codebase Memory MCP 0.11.0 |171.8 ms |143.6 ms |1,164 | Both symbol bodies and the billing paragraph |
| Codanna 0.16.0 |0.8 ms |0.5 ms |217 | Symbol locations/signatures; document collection unavailable in this provider-free setup |

Different tools intentionally return different evidence. Codanna's location-oriented symbol call does less source extraction. Its document search needs a separately embedded collection, so that case is **unavailable**, not a general document-quality failure. Server-only RSS is recorded but not compared across these different process architectures. No provider-token or billing inference is made from response bytes.

The initial comparison exposed ContextPro's unknown-single-word document miss. It is retained in [initial evidence](2026-10-05-teamwork-retrieval-initial.json); [candidate evidence](2026-10-05-teamwork-retrieval.json) records the follow-up. Reproduce with `scripts/benchmark-teamwork-retrieval.mjs` and installed executable paths in `CONTEXTPRO_CODANNA` / `CONTEXTPRO_CODEBASE_MEMORY`.

Official design references and licenses: [Codebase Memory MCP, MIT](https://github.com/DeusData/codebase-memory-mcp), [Codanna, Apache-2.0](https://github.com/bartolli/codanna), and [Pyright, MIT](https://github.com/microsoft/pyright). No competitor implementation code was copied. Downloaded macOS ARM64 archive SHA-256 values were verified: Codanna `3e6c92cff05a69cdce4c242aea734a0d32935de45dff95e88d06e591d7f73595`; Codebase Memory `4dee7f38b63740e6751d7a7ed7eb10291c1f2a3ea2415f599dc68370ca0a2d18`. Python integration tests pin Pyright 1.1.414; runtime installation is explicit.

## Shared-runtime measurements

Two MCP sessions query the same TS fixture, with two counterbalanced process repetitions. Each repetition includes a compiler-cold round and three warm rounds. RSS sums observed MCP/service/worker descendants after calls; it is sampled resident memory, not measured peak usage. All 32 reference calls found the expected caller and reported no shared-service fallback.

| Repetition | Process mode: highest sampled RSS | Shared mode: highest sampled RSS | Process warm median | Shared warm median |
| --- | ---: | ---: | ---: | ---: |
|0 |776.9 MiB |670.6 MiB |43.4 ms |49.1 ms |
|1 |658.2 MiB |603.3 MiB |74.4 ms |80.5 ms |

Sampled memory falls about 8–14%, while paired warm latency increases about 8–13%. The fixture is too small for default promotion, and it does not quantify shared Python performance. Keep shared compute opt-in. [Raw measurements](2026-10-05-teamwork-runtime.json) and `scripts/benchmark-shared-runtime.mjs` retain the exact conditions.

## Frozen coding campaign

The original private campaign froze eight existing tasks plus two Python tasks (ten in all). All ten validators rejected the before fixture and accepted the known fix; the plan had native/baseline/candidate arms and two counterbalanced repetitions: 60 attempts. The published `scripts/fixtures/development-teamwork.json` keeps only the four tasks that do not depend on private repositories (two contextpro, two Python), whose plan is 24 attempts, and the qualification evidence is not published. The first 12 attempts of the original plan interleave both Python tasks with two existing tasks.

The old CLI 0.154.0 rejected configured `gpt-6.1-sol` before coding. Six recorded infrastructure failures and an interrupted residual fixture remain in `.contextpro/development-teamwork-campaign`; they are not silently retried or counted as model outcomes. Bundled CLI 0.160.0 passed an availability probe with the same account/model. Its separate campaign, `.contextpro/development-teamwork-cli160`, uses the same frozen corpus/builds and `xhigh` reasoning.

The [12-attempt smoke](2026-10-05-teamwork-smoke.json) is complete: native, baseline and candidate each pass 2/4 tasks. Both Python tasks pass in all arms; worktree routing and grep context fail held-out validation in all arms. Native and candidate worktree attempts also reach the 600-second agent limit; incomplete provider usage stays null. On the two jointly successful task pairs, the median candidate/baseline ratio is **1.211 for completion time** and **1.291 for measured input tokens**. That is worse on this subset, not a productivity improvement. The two ratios describe one repetition of two tasks and carry substantial uncertainty.

The unchanged original campaign was interrupted after 22 recorded attempts, with a baseline trial left as a residual. Its runner is no longer active; the residual is retained under the existing resume policy, and no outcome has been silently retried or discarded. The 60-attempt original campaign remains incomplete. Patches, failed validations, provider usage and traces remain retained locally. A separate read-only `benchmark-process-sampler.mjs` observer sampled Codex process-tree RSS every two seconds from partway through attempt 13; the first twelve attempts have no coding-memory samples. These are observed RSS samples, not peak or unique physical memory, and are separate from the completed runtime fixture measurements above. The observer records no command arguments.

Default promotion requires no deterministic regressions, no lower candidate success count, and either 10% lower median completion time or 20% lower measured input tokens on jointly successful matched trials. The smoke does not satisfy promotion criteria; defaults remain unchanged; the original campaign is incomplete.

## Migration and rollback

The existing [configuration reference](../configuration.md) documents additive fields, optional Python setup, specialist schemas, retained history and rollback. Omitting `intent` and unsetting `CONTEXTPRO_ADAPTIVE_CONTEXT` preserves prior retrieval. Stop a shared daemon using its original build/configuration before upgrading; unset `CONTEXTPRO_DAEMON` for process-local computation. Legacy memories remain inspectable as unverified. Source changes can be restored through existing restore points. Publication, hosted CI, merge and desktop reload are separate release states.

## Review and release state

Hosted CI for this phase was blocked by account billing; local checks passed. Required checks are not bypassed. The existing desktop MCP session is not reloaded.
