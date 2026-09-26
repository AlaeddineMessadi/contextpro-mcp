# Discovery repair verification — 2026-09-13

This is regression verification, not a comparative performance benchmark.

Repository: ContextPro MCP 1.3.0, branch `codex/evidence-retrieval-fixes`,
base commit `77212b86bcd5b60ef8e5e2d65bb2c4b09cd77e0c`. Changes were local when measured.
The September 9 parser, dispatch, validation, excerpt and reference fixes were
already present and were preserved. No application source was modified.

## Freshness: confirmed code-path gap

Search called `quickRefresh` directly. Above the default 30-file threshold it
returned an incomplete result without indexing the backlog. The existing
`ensureFreshIndex` gate already handled that case with a structural reindex;
search did not use it. This explains a reproducible failure mode consistent with
the earlier empty/stale-index reports, but does not prove every historical report
had the same cause.

Reproduction: create 35 supported files in a temporary root, then call
`context({root: ROOT, query: "item34", max_tokens: 512})`. Before the repair the
database retained zero indexed files. After the repair all 35 files are indexed
and the requested definition is returned. Editing all 35 files and querying a
new symbol also refreshes the index and removes the old symbol.

Search now shares the structural freshness gate, including concurrent-reader
coordination, failure warnings and the `CONTEXTPRO_AUTO_REFRESH=false` opt-out.
Structural maintenance passes `noEmbed: true` and `autoHubs: false`.
Natural-language retrieval may still request query embeddings separately.
Exact file/symbol/line targets continue to read current source without creating
an index. Successfully refreshed discovery no longer suggests it is incomplete
merely because its metadata says `refreshed` rather than `fresh`.

## CP-002: named definitions

A synthetic pipeline fixture contains a 33-line `reusableAnswers` definition,
25 short calls and competing documentation. At a 512-unit budget,
`context({root: ROOT, query: "Find implementation of reusableAnswers in pipeline.ts",
max_tokens: 512})` previously returned comments, part of the function and short
calls while omitting its return predicate. The repaired selector returns the
complete definition within the same budget.

Literal identifier hints now locate defining files independently of the initial
file-ranking cutoff. Definitions are resolved from current source and packed
before incidental windows. Oversized definitions retain an entry-point window;
remaining source selection and omission notices still apply. Additional coverage
checks quoted lowercase identifiers and dollar-prefixed names. This is structural
name matching, not binding-resolved reference tracing.

## CP-006: schema visibility

The parameter descriptions now state 1–6 targets and an integer response budget
of 512–12000 (default 4000, UTF-8 bytes/4). Raw MCP tests verify both JSON Schema
bounds and the prose descriptions retained by clients that simplify schemas.
Validation bounds remain unchanged. Actual client catalog refresh is outside
this verification; a running MCP process must restart to load the new build.

## Validation

- TypeScript build passed.
- All 679 main tests passed, including earlier repair regressions.
- All four parser demo tests passed.
- Documentation, release metadata, package contents and diff whitespace checks passed.
- A raw stdio test booted in one root and discovered a separate cold 35-file root
  through lean `context`, within the 512-unit response budget and with zero calls
  to the instrumented provider endpoint.

Tests used `/opt/homebrew/bin/node` v26.0.0, ABI 147, matching the installed native
SQLite binary and configured MCP runtime. An initial Node 24 run failed the
integration fixture that disables native repair and isolates HOME because that
runtime requires ABI 137. The matching-runtime suite passed without rebuilding
shared dependencies or changing that fixture's safeguards.

No Graft comparison, semantic-quality evaluation, matched latency benchmark,
tokenizer count or billing-savings measurement was performed.
