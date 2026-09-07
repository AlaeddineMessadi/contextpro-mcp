# Implemented improvements and measured limits

The implementation adds a small default catalog with expert tools available on demand, compact structured retrieval, bounded import pointers, complete explicit TypeScript contracts, batched symbol reads, smaller unchanged deltas, concurrent grammar-load deduplication, generation-keyed lexical/semantic indexes, and performance diagnostics. Agent instructions now recommend bounded discovery and batching, with native fallbacks when useful. Codex, Claude Code and OpenCode configurations select `workflow` and were backed up before editing.

## Retrieval after the changes

The same frozen source corpus and six task definitions were reused. There were 108 successful retrieval calls: six variants × six tasks × three counterbalanced repeats. The new server build was measured after the test suite and initial agent trials finished. Absolute latency is machine-specific; repeated warm runs are not cold-start tests.

| Strategy | One-pass response tokens (`o200k_base`) | Median call | Expected-file coverage |
| --- | ---: | ---: | ---: |
| Compact Git/rg | 10,003 | 29 ms | 80.6% |
| Improved balanced text | 6,172 | 166 ms | 86.1% |
| Improved compact JSON | 5,460 | 166 ms | 86.1% |
| Compact JSON plus import pointers and profiling | 6,187 | 167 ms | 100% |

The last row includes up to three additional import pointers, not just the top-five search hits. Its 100% is coverage of the hand-labelled required files in the delivered working set; it is not top-five recall or proof of sufficient source excerpts. It uses **38.1% fewer response tokens** than the baseline while recovering both `path-guard.ts` and `runtime-session.ts`. Without pointers, compact JSON uses **45.4% fewer response tokens**. Raw ranked-file recall did not improve on this sample, despite some better ordering; keyword-only recall remains 72.2% and needs further work on held-out tasks.

The previous balanced text median was 220 ms; improved compact output measured 166 ms, about 24.6% lower in these runs. It is still slower than ripgrep. New profiling measured median phases of 17.7 ms for freshness, 117.7 ms for retrieval/ranking, and approximately zero for artifact writing in the non-persisting compact variant. Other request overhead accounts for the remainder; this is not a complete CPU profile.

- Current catalogs: **4,102 reference tokens / 13 workflow tools**, **15,874 / 60 full tools**. Expert schemas are enabled by `discover_tools`; the schema-cost allowance updates when they are enabled. Dynamic tool-list updates are exercised over the MCP protocol.
- Unchanged packet: **163 tokens**, versus 722 in the earlier measurement. Full recovery remains available through context IDs.
- Skeletons now include the previously missing return object and interface members. Their combined output increased from 1,345 to **1,461 tokens**, still below 5,181 for whole-file reads. Extra tokens preserve useful contracts; they are not a regression to hide.
- Batch `explain` accepts up to six targets, defaults to depth zero for batches, and reports omitted whole bodies explicitly instead of clipping source code.

See `2026-09-07-improved-results.json` for the recorded per-task measurements. Raw responses, catalogs, profiling data and logs are in `.contextpro/benchmark-improved-2026-09-07/` and intentionally remain untracked.

## Actual Codex agent trials

The user selected the configured Codex model: **gpt-6-astra, high reasoning effort**. The runner launched fresh ephemeral sessions in separate frozen checkouts, with other user-configured MCPs and project instructions removed equally. ContextPro runs used the workflow profile; baseline runs used ordinary shell/read tools. The two tasks tested native-cache contracts and source-mutation safety. Order was baseline→ContextPro for one task and reversed for the other. All raw outputs and Codex JSONL events were retained.

Two rounds were collected. The first diagnosed repeated MCP reads; the second used the batching feature and updated guidance. The final round ran without overlapping test-suite or retrieval-benchmark workloads. The initial round overlapped development/test activity, so its timing is diagnostic only. Both rounds use read-only repository comprehension tasks with typed facts and required implementation evidence; **they are not patch-writing or code-generation productivity evaluations**.

Both strategies answered both tasks correctly in both rounds after review against source. The initial mechanical scorer rejected valid `file:line` references and, in one answer, `field:description` values allowed by its schema. Those formatting normalizations were applied equally; original scores and raw answers remain recorded. This is a small, source-informed evaluation rather than blind independent adjudication.

Final round totals across the two tasks:

| Observed metric | Without ContextPro | With ContextPro |
| --- | ---: | ---: |
| Total input tokens reported by Codex | 160,964 | 368,131 |
| Cached input tokens (subset of input) | 104,320 | 303,744 |
| Input minus cached input | 56,644 | 64,387 |
| Output tokens reported by Codex | 1,317 | 2,209 |
| Elapsed agent time | 74.8 s | 190.6 s |
| Correct task answers | 2/2 | 2/2 |

**No end-to-end token or time saving was demonstrated.** ContextPro consumed 207,167 additional total input tokens, of which 199,424 were additional cached-input tokens. Uncached input increased by 7,743 tokens; output increased by 892. Elapsed time increased by about 115.7 seconds. Do not add the cached column to total input again. Codex also reported reasoning-output fields, preserved in the raw usage records; no unverified assumptions about their billing treatment are used here.

Batching reduced the ContextPro tool calls across both tasks from 17 to 10, and the native task from eight to four. Total ContextPro input fell from 402,833 to 368,131 between rounds, but the rounds also differ in runtime and prompt behavior, so that is not an isolated causal estimate. The ordinary baseline remained better on these two small tasks. Mandatory discovery and final efficiency-report calls have costs; shorter individual tool output does not guarantee lower cumulative model input.

The final native trial also exposed a report-validation error: Codex requested `efficiency_report(history_limit:0)`, which the schema rejected. The final build now accepts zero for totals-only output and tests it over MCP. The measured run is retained with that error; its answer correctness does not imply error-free tool execution.

Dollar savings are **unknown**, not zero and not a guessed conversion. These runs used account quota; no verified per-model billing rate or billing receipt was supplied. The importer accepts provider usage with explicitly unavailable cost and preserves negative token/time differences. Small samples, prompt-history caching, client schema injection and tool-roundtrip count make broad claims unjustified.

Structured agent evidence: `codex-pairs-2026-09-07.json` and `codex-pairs-batched-2026-09-07.json`. Raw session records and schema-compatible `agent-runs.json` files are under the corresponding `.contextpro/` directories. The reusable runner is `scripts/benchmark-codex-pairs.mjs`; it uses the configured model and should only be invoked with authorization to spend agent quota.

## Validation and remaining work

The build and 614-test suite passed after the main implementation. Tests cover actual MCP tool discovery/enabling, unknown-tool rejection, complete multiline declarations, exported-only filtering, compact-vs-verbose content equivalence, bounded import expansion, one grammar load across 20 concurrent first-use parses, complete-body batch omissions, offline retrieval regressions, and unavailable-cost/negative-difference accounting.

The next performance target is fewer agent turns and less repeated client context, not another unsupported savings percentage. Larger held-out coding tasks with patch acceptance tests are needed to establish when ContextPro actually outperforms a competent shell workflow. Until then, agent guidance makes it the default for unfamiliar discovery while retaining direct exact lookups and fallbacks. Universal “always cheaper/faster” claims would contradict the measured agent runs.
