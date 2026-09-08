# Direct reference evidence and benchmark instrumentation — 2026-09-08

The reference workflow now exposes `exact_references` as an initial tool in lean and workflow profiles, labels individual definitions/imports/calls/references, and reports per-file call totals before result truncation. Identical snippets appear once per file; every returned location remains present. This targets discovery and manual classification work, not cold compiler initialization.

## Verified behavior and cost tradeoff

A real stdio test calls exact references first in a lean session, without any discovery/enable calls, and checks the resulting call count and per-file evidence. Other regressions cover aliases, same-named unrelated bindings, cross-project deduplication, truncated results and a bounded 50-file call summary. This proves the one-call path exists, not that every agent will choose it.

| Initial catalog | Before | After | Added bytes |
| --- | ---: | ---: | ---: |
| Lean | 2 tools / 2,068 bytes | 3 tools / 3,139 bytes | 1,071 |
| Workflow | 13 tools / 18,520 bytes | 14 tools / 19,591 bytes | 1,071 |

These are serialized catalog bytes, not tokenizer counts. An agent that previously discovered, enabled and then called exact references can now call it directly. Sessions that never need references still pay the larger catalog cost; only matched agent usage can establish the net effect. The reference tool description was shortened to limit this overhead.

## Offline replay

Baseline: merged commit `3461e1c`. Candidate runtime: `3020a94`. Both used Node v26.0.0 and the same installed dependencies. Three alternating repetitions per fixture/version used fresh processes and independently prepared structural indexes, followed by immediate warm compiler queries. The recorded run started after the website build completed, with no concurrent builds or test suites launched by this task. OS/background application caches and load were not controlled.

All **24 timed queries passed** their checks: the small fixture returns exactly 13 call locations split 4+9, including barrel aliases and excluding unrelated same-named bindings; the large fixture counts 2,009 calls despite the 100-result display limit. Candidate per-file totals match those expected counts.

| Fixture | Compiler state | Baseline median | Candidate median |
| --- | --- | ---: | ---: |
| 13 calls | Cold | 489.0 ms | 486.7 ms |
| 13 calls | Warm | 3.91 ms | 3.86 ms |
| 2,009 calls | Cold | 786.2 ms | 779.6 ms |
| 2,009 calls | Warm | 264.1 ms | 268.2 ms |

Compiler latency is essentially unchanged in this small replay; it is not evidence of a meaningful speedup. Indexing, module import, MCP transport, tool discovery and model reasoning are excluded from these timings. The generated fixtures are not the external app-a repository.

Default text output grew from 1,150 to 1,164 bytes (+1.2%) on the small fixture while adding labels and per-file counts. On the large fixture it shrank from 3,457 to 3,026 bytes (12.5% smaller) through snippet deduplication, with all 100 displayed occurrences retained. JSON keeps per-occurrence source context and grows with the new summary fields. Output bytes do not establish total agent-token savings.

[Raw measurements, ranges and build fingerprints](2026-09-08-reference-evidence.json). Absolute local build paths are redacted; numeric measurements and build hashes are unchanged. No paid agent trials or actual billing measurements were performed in this implementation pass.

## Benchmark evidence now available

The [benchmark procedure](methodology.md) covers repeated alternating native/new or old/new Codex trials, separate empty/structurally-seeded index states, tool names/arguments, observed client spans, provider input/cache/output usage and opt-in server phase traces. Each agent gets a fresh MCP process; these index states must not be mislabeled warm compiler sessions. Missing usage or trace fields remain unavailable. Costs stay null without verified rates or billing.

Server traces stay local and off by default, add no MCP result prose, redact common sensitive keys and bound argument/file sizes. Unioned server spans avoid double-counting overlapping calls. Older builds lacking trace support remain explicitly unmeasured on server duration.

The runner was exercised with a fake Codex executable to verify launch planning, alternating order, provider accounting, output collision refusal and temporary-directory cleanup without spending account quota. This validates the harness, not model task performance.

## Validation

All **654 main tests pass on Node v26.0.0**. TypeScript build, website production build, documentation synchronization/link checks and diff whitespace checks pass. Scope validation recommended the build and relevant regression tests, which passed; its optional embedding request timed out and used keyword fallback. That embedding path is outside the offline compiler replay and remains relevant to end-to-end latency measurements.
