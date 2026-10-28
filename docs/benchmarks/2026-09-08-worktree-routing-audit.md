# Audit of an implementation benchmark in isolated Git worktrees

Date: 2026-09-08. Evidence: read-only inspection of the two supplied uncommitted worktrees and their local Claude Code JSONL records. This report intentionally omits private project identifiers, application symbols, full transcripts, and user paths. Neither application worktree was edited, committed, or re-tested during this audit.

## Main finding

The ContextPro agent edited its isolated worktree, but all 57 ContextPro tool calls omitted `root`. Every supplied file, file_path, and target_path argument was relative. Its initial `status` response explicitly identified the parent checkout, the parent's branch, and zero uncommitted changes, while the transcript's agent working directory was the child worktree.

The reported stale-read incident is therefore explained by querying and reindexing a different checkout from the one being edited. These records do not demonstrate a cache returning stale contents for the correct requested worktree. This is still an important integration/usability failure: the mismatch went unnoticed and caused repeated verification and recovery attempts. A server cannot safely infer a subagent's changed working directory from an inherited stdio connection unless the client communicates it.

## Verified chronology

All times below are UTC on the audit date.

- 07:49:36: `status({})` returned the parent checkout root and branch. The agent's JSONL working directory identified the child worktree.
- 07:49:56: `reindex({})` ran against the same implicit scope. It completed after approximately 25.6 seconds and skipped all 530 files.
- The agent subsequently edited files using absolute child-worktree paths.
- 08:00:01: `explain` of the relative application file returned the parent version, without the new feature patch.
- 08:00:10: `grep` against that relative file found no new patch.
- 08:00:26: targeted `reindex` without `root` returned zero indexed and one skipped file.
- 08:00:31: forced targeted `reindex`, also without `root`, returned one indexed file and 274 extracted symbols.
- 08:00:36: `grep`, still without `root`, again found no patch.
- 08:00:43: `search`, also without `root`, returned existing parent-checkout symbols.
- 08:00:52: a native `Read` using the absolute child-worktree path showed the new patch. The tool calls had been inspecting different files on disk.

## Timings and tool counts

| Metric | Native | ContextPro | Interpretation |
| --- | ---: | ---: | --- |
| Self-reported measured interval | 609 s | 742 s | ContextPro +21.8%; these do not cover all work |
| First JSONL task record to final assistant record | 767.740 s | 846.163 s | ContextPro +10.2%; includes report generation |
| Verified tool calls | 84 | 110 | ContextPro +31.0% |
| ContextPro tool calls | 0 | 57 | Every call omitted root |
| Distinct model-response IDs with usage | 85 | 91 | ContextPro +7.1% |

The native agent took its end timestamp before running additional tools, including another Jest batch. The ContextPro agent also took its end timestamp before its efficiency report and final response. The two self-timed intervals are not complete end-to-end measurements. JSONL timestamps exclude any setup before the initial task record.

The 57 ContextPro call-to-result intervals summed to approximately 69.1 seconds. Three calls dominated that sum: initial reindex 25.6 seconds, task_pack 10.4 seconds, and exact_references 10.3 seconds. Summed intervals may overlap when calls run concurrently and do not isolate server compute from client overhead. They do not establish that the entire end-to-end difference was caused by the workspace mismatch.

## Recorded provider usage, with streaming duplicates removed

Method: select assistant records with a message ID and a usage object; group records by message ID; take the maximum observed value of each top-level usage field within that group; sum each field across groups. This avoids double counting the multiple streaming/partial assistant records for one API response. Nested cache-creation subtotals and thinking-token details are not added again, since they are already contained in the top-level fields. Counts below are values recorded by the client, not independently verified billing records.

| Recorded usage field | Native | ContextPro |
| --- | ---: | ---: |
| input_tokens | 23,884 | 24,138 |
| cache_creation_input_tokens | 453,409 | 173,824 |
| cache_read_input_tokens | 33,063,321 | 36,327,641 |
| output_tokens | 51,641 | 51,132 |
| Arithmetic sum of these four categories | 33,592,255 | 36,576,735 |

The arithmetic sum is approximately 8.9% higher for ContextPro, but it is not a dollar-cost comparison. Cached input, uncached input, cache creation, and output can have different prices. These are repeated tokens processed across requests, not unique source tokens or a single context-window size. The benchmark's roughly 456k/462k headline is not the cumulative provider usage represented in the transcripts.

The starting cache conditions were unequal:

- Native's first response recorded 11,264 input tokens, 291,300 cache-creation tokens, and zero cache-read tokens.
- ContextPro's first response recorded 11,264 input tokens, 11,076 cache-creation tokens, and 280,674 cache-read tokens.
- Both started with approximately 300k input-context tokens before substantial task discovery. Worktree isolation did not mean a minimal/fresh conversation context.
- Excluding the first response, cache creation was 162,109 tokens for Native and 162,748 for ContextPro. Most of the apparent cache-creation difference came from initial cache warmth, rather than the discovery strategy.

No measured dollar savings can be established without the applicable provider/account pricing and billing semantics. ContextPro's own reported full-file-read savings are an estimate against a hypothetical baseline, not a measurement against the native arm.

## Correctness and retrieval findings

- Both diffs use the flag-filtered item pool, satisfying the explicitly identified trap.
- The ContextPro implementation checks the persisted toggle but omits the live subscription entitlement check at one usage site. Its initial and later `explain` responses both included all three nearby existing entitlement guards. The relevant evidence was supplied; the agent did not apply it. This is an implementation/review failure, not evidence that retrieval hid the existing guards.
- The native implementation includes the live entitlement guard but hardcodes the new settings label and description in English.
- The ContextPro implementation uses translation keys but only adds their English values. The three other inspected locales lack these new keys. It better preserves the translation mechanism, but it should not be described as fully translated.
- The initial task_pack ranked unrelated UI components at a reported 97% despite the query naming existing entitlement, storage, and settings integration points. This is useful evidence of retrieval-ranking weakness; ranking percentages should not be treated as verified probabilities of relevance.
- Passing different selected test sets does not establish that one implementation is more correct. Both returned code requiring review. No claim is made here that the reported test pass counts were independently reproduced.

## Requirements for a fair follow-up

Use the same fixed base commit, equivalent starting prompts and model settings, correctly scoped worktree roots, a predeclared shared validation suite, and external timing through final completion. Separate cold-index/cold-cache trials from warm trials. Record the provider usage categories above and tool traces, alternate run order across repeats, and score correctness independently of each agent's self-report. Include an MCP-preferred hybrid arm that may use direct native reads when that is the cheapest sufficient operation; forcing every lookup through an MCP measures a different policy from the recommended workflow.


## Safeguard implemented after the audit

Tool requests without `root` now reject ambiguous linked-worktree routing before tool execution. Explicit roots bypass registry inspection. The check reads a bounded Git worktree registry without spawning Git on each request, and observes added/removed worktrees immediately. Separate unrelated clones remain outside this detection: subagents must still supply their absolute root on every call. The repository-independent instructions resource remains available without a root. Opt-in traces record the effective root without adding it to every agent response.

A real stdio regression reproduces a shared parent-client connection with an edited child worktree, five successive edits, normal and forced reindex, explain/grep/search, and parallel reads across parent and child. This proves routing and read-path behavior on the fixture. It is not a new end-to-end agent benchmark and establishes no speed, correctness-of-generated-code or billing win.

Validation: all 665 main tests pass on Node 26, including the stdio replay, separate Git directory routing, cached workspace routing and rejection before index seeding. TypeScript build, documentation checks and package checks pass.
