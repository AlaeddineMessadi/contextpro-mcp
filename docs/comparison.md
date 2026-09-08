# Comparing ContextPro fairly

ContextPro aims to give coding agents useful evidence with fewer unnecessary reads and calls. No retrieval tool wins every task, and no benchmark establishes that its answers are always correct.

## Should we name alternatives?

Yes, when a comparison is specific, reproducible and respectful. Graft, Graphify, Serena and native agent tools are reasonable comparison candidates. Naming a project is not evidence about its current behavior. Avoid a feature checklist or ranking assembled from memory, and do not imply endorsement.

Lead the README and launch announcement with ContextPro's capabilities. Keep head-to-head results in dated reports with versions and limitations. Say “on these tasks, under these conditions” rather than “the best MCP.” Publish losses and errors alongside wins. Invite maintainers to correct setup mistakes and rerun a comparison after material fixes.

## Minimum evidence for a published comparison

| Dimension | Record |
| --- | --- |
| Inputs | Public or licensed fixture, repository commit, exact task prompts and expected results |
| Versions | MCP commits, model/client version, Node/OS, hardware and configuration |
| Fairness | Same task, model and budget; fresh independent sessions; randomized or alternating order |
| Index state | Index preparation time/size; separate cold process, warm process and cache states |
| Correctness | Predeclared checks, missing and false-positive locations, scope, truncation and human review |
| Reliability | Every failed attempt, timeout, disconnect and retry; include recovery time |
| Speed | End-to-end wall time and direct server time separately; repeated trials, median and spread |
| Tokens | Provider-recorded input, cached input and output; expose missing fields and accounting definitions |
| Cost | Verified model rates and date or actual billing; otherwise leave money unavailable |
| Reproduction | Runner, sanitized raw records and enough setup detail for another person to rerun |

Start with at least five paired trials per task and report the spread; this is a practical starting point, not statistical proof. A known-file read, reference enumeration, API skeleton and multi-file feature trace exercise different costs. Add mutation/freshness tasks and larger repositories before generalizing. Do not silently drop failures or compare an inaccurate answer as though it completed the task.

## What the existing evidence supports

The [reference evidence report](benchmarks/2026-09-08-reference-evidence.md) measures compiler queries and serialized output on generated fixtures. It supports the stated correctness checks and response-size changes. It does not measure paid agent work or prove a general speedup.

Historical external-repository runs include user-reported results and changing conditions. They are useful leads for debugging, not a controlled public leaderboard. A pass on 13 references and 18 exports establishes those checks only, not complete correctness across a repository.

Response bytes are not tokens. Summing tool-output sizes does not count repeated conversation input, tool schemas, cached input or reasoning/output tokens. `efficiency_report` estimates savings relative to full-file reads, not what a native agent would actually have done. Never turn those estimates into billing claims.

## Run and contribute

See the [benchmark procedure](benchmarks/methodology.md) and the runners in `scripts/`. Agent trials spend the selected provider's normal account quota; review the plan before opting into execution. Offline fixtures can exercise retrieval without a paid account.

Submit a benchmark issue with a sanitized report and exact commands. Keep private repository names, source, home-directory paths, account data and transcripts out of public artifacts. Link primary documentation for any competitor behavior that is not directly demonstrated by the recorded trial.
