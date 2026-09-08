# Repeatable agent and reference benchmarks

Measure successful task completion, full provider usage and elapsed task time separately. Tool-result bytes, avoided full-file reads and subscription quota are not bills. Keep failures in the results. Compare the same model/effort, prompts, source commit and acceptance checks, alternating version order across repetitions. Report medians and ranges with sample counts; three runs do not establish a reliable tail-latency or significance claim.

## Agent trials

`scripts/benchmark-codex-pairs.mjs` uses fresh Codex sessions with the configured model and account. Without `--run` it only prints a plan. Defaults are two source-comprehension tasks, three repeats and a structurally seeded index: **12 agent sessions**. This corpus does not reproduce the external app-a tasks; retain their actual prompts, acceptance checks and call traces for that comparison.

```sh
CONTEXTPRO_BENCH_REPEATS=3 CONTEXTPRO_BENCH_INDEX_STATES=empty,seeded \
  node scripts/benchmark-codex-pairs.mjs /path/to/source /path/to/new-results
# Review the plan; adding --run spends normal account quota.
```

The default comparison is native tools versus the configured ContextPro server. To compare old/new ContextPro, set `CONTEXTPRO_BENCH_BASELINE_SERVER` to a private launcher JSON file containing `command`, `args` and optional string `env` values. `CONTEXTPRO_BENCH_CANDIDATE_SERVER` optionally overrides the configured current server. Build each version in a separate checkout and keep both builds fixed during trials. Local JavaScript builds are fingerprinted before and after each run; a changed build invalidates the trial. Package-runner launchers without a local entry file have no automatic fingerprint. Both versions receive identical guidance; each advertises its own tool schema. Do not put credentials in committed launcher files.

`CONTEXTPRO_BENCH_TASK` selects `native-cache-contract` or `source-mutation-contract`. `CONTEXTPRO_BENCH_PROFILE` selects `workflow` or `lean`. Repetitions are bounded from 1 to 20. Output directories cannot reuse an existing `runs.json`. Temporary source/index directories are removed after each trial, including on failure.

- The source commit is frozen at launch and archived for each run. Uncommitted source edits are excluded. MCP code comes from the supplied built launcher, which may be a different revision.
- `empty` has no prepared index. `seeded` runs structural reindex using that variant's server in a separate preparation process; semantic vectors are not prewarmed. Index preparation time is recorded separately.
- Every agent session starts a new MCP process. Compiler state is **fresh**, including seeded-index trials; these are not warm-compiler agent runs. OS and provider prompt caches remain uncontrolled.
- `events.jsonl` preserves provider events; `timed-events.jsonl` adds arrival timestamps. `runs.json` records command/MCP tool names and arguments, status, observed client duration, final answer, acceptance result and usage. Buffered event delivery can distort individual client durations.
- `server.jsonl` uses the optional trace supported by the new build. Server preparation includes root verification, freshness and waits; handler and postprocessing are separate. Coverage is checked against observed MCP calls. Older servers may not emit traces; their server duration is unavailable. Overlapping server spans are unioned; their sum is also retained and is not elapsed task time.
- Provider input includes cached input; do not add cached input again. Missing fields stay unknown. A missing turn's usage prevents a measured summary. Costs remain null without verified rates/billing. Optional ContextPro embedding/chat provider usage is separate from the Codex account usage and is not included in these totals. Time outside server spans includes model work, scheduling and transport; do not label the entire remainder model reasoning.

Raw outputs can contain project code, paths and arguments. Keep them local and publish only reviewed aggregate evidence. Trace redaction is limited, and is not a guarantee that prompts contain no secrets. The benchmark's read-only instructions are a task constraint, not a security boundary against an untrusted agent.

## Offline cold/warm reference replay

Build the baseline and candidate separately, then run:

```sh
node scripts/benchmark-references.mjs \
  --baseline-build /path/to/old/build --candidate-build /path/to/new/build \
  --repeats 3 --output /path/to/new-reference-results.json
```

This runs no agent or model. It alternates versions on identical generated fixtures: 13 calls split 4+9 with barrel aliases and unrelated same-named bindings, and a 2,009-call case exceeding the display limit. Each version/repeat gets a fresh process and structural index. The first query has a cold compiler, followed immediately by a warm query. Module load and index preparation are excluded; OS caches are uncontrolled. Counts, exact call locations for the small case, and exclusion of unrelated bindings must pass or the replay fails. Both successes and their byte sizes are recorded; these are not provider tokens or money saved.

The bounded real-worker regression additionally checks that only the requested entries cross IPC while full counts remain accurate. Agent protocol tests verify that exact references work as the first lean call without discovery or enable calls. These test specific contracts; they do not prove every agent will choose the shortest workflow.


## Shared clients and implementation tasks

A Git worktree isolates source files, not necessarily the agent conversation, provider cache or MCP connection. In shared-client/subagent trials, include the absolute target `root` on every ContextPro call. A shell `cd` does not change an inherited stdio server. New opt-in server traces include `resolvedRoot` and `rootSelection` (`explicit` or `automatic`); verify those fields against the edited worktree. Older traces leave this information unavailable.

Start arms from equivalent minimal prompts, not a long parent conversation. Record the initial input and cache state; fresh subagents can inherit hundreds of thousands of tokens. Time externally until final completion, including post-edit tests, retries and report generation. Self-reported stop times can exclude subsequent work. Use one shared, independent validation suite rather than comparing different self-selected test totals.

For Claude JSONL evidence, group streaming records by response/message ID before summing usage. Report input, cache creation, cache reads and output separately; do not add nested cache or reasoning subtotals twice. Check streaming semantics and missing fields before aggregation. A sum across requests includes repeated cached context and is not a single context window or dollar cost. See the [worktree incident audit](2026-09-08-worktree-routing-audit.md).

Include an MCP-preferred hybrid policy that allows cheap native reads. A forced MCP-only policy is a different product configuration and must be labeled separately. Accept a performance win only alongside the same correctness criteria, including adverse states such as revoked access and changed feature flags where relevant.
