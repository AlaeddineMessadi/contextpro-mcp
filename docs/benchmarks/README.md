# Benchmarks

Results have different baselines and must not be combined into one savings claim. Commit hashes cited in these reports refer to the pre-publication development history and private benchmark repositories; reports measured only on private repositories are not published.

| Record | What it measures | Main limitation |
| --- | --- | --- |
| [Development and local teamwork](2026-10-05-development-teamwork.md) | Deterministic phase tests, small retrieval and shared-runtime measurements, a 12-attempt coding smoke | Small fixtures and one smoke repetition; the coding campaign is incomplete and promotion criteria are not met |
| [October 7 issue-log repairs](2026-10-07-log-repairs.md) | Discovery ordering and compiler-reference checks on a frozen corpus | Bounded regression checks; mixed latency samples; no agent productivity or billing measurement |
| [Discovery repair verification](2026-09-13-discovery-repairs.md) | Regression verification of freshness, discovery and reference fixes | Regression checks, not a comparative performance benchmark |
| [Connected evidence and coding pilot](2026-09-26-connected-evidence.md) | Frozen retrieval controls and eight paired coding tasks | Experimental retrieval; single-run pairs, local dependency copies |
| [Workflow follow-up audit](2026-09-08-workflow-rebenchmark.md) | Reported second implementation trial and inspected raw tool incidents | Single run; timings/correctness reported by the workflow; no new billing measurement |
| [Worktree implementation audit](2026-09-08-worktree-routing-audit.md) | Actual transcript routing, timings and per-category usage | Unequal inherited contexts/caches; both implementations need fixes; not a controlled savings trial |
| [Initial retrieval/agent report](2026-09-07.md) | Synthetic retrieval and recorded agent trials | Small task sets; read each experiment's method |
| [Workflow improvements](2026-09-07-improvements.md) | Follow-up retrieval/workflow measurements | Not a universal benchmark win |
| [Token overhead audit](2026-09-07-token-overhead.md) | Provider input, caching and tool overhead in matched Codex trials | Settings and task shape affect costs; negative savings remain meaningful |
| [Direct reference evidence](2026-09-08-reference-evidence.md) | One-call protocol checks, cold/warm compiler replay, output/catalog bytes | No measured agent token or billing savings |
| [Reference/freshness foundation](2026-09-08-reference-foundation.md) | Correct reference counts and cold/warm direct tool timings | No paired agent/native trial or billing measurement |

See the [repeatable benchmark procedure](methodology.md) for alternating agent trials, tool phase traces and offline cold/warm compiler replays.

Adjacent JSON files retain raw results for public or synthetic corpora; raw data from private repositories is withheld. Provider-usage trials and character/token estimates are labeled in their reports. Do not overwrite old results after moving a file; rerun into a new dated record and capture the source revision and method.

For future comparisons, keep model/settings, task, repo revision and success checks matched, repeat and counterbalance trials, isolate resource contention, and measure cold/warm paths separately. Include all provider input/cache/output fields without double counting. Optional retrieval-provider costs are separate. Subscription quota reduction is not automatically an invoice saving.
