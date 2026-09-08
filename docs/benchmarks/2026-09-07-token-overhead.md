# Token overhead investigation and lean retrieval

ContextPro's compact responses were smaller than scripted native retrieval, but its
previous agent workflow was expensive. Retrieval payload size is only one component
of end-to-end usage. This investigation uses existing traces, primary-source
research, code changes and fresh Codex comprehension trials.

## Why input increased

The previous batched comparison used 368,131 input tokens with ContextPro versus
160,964 with native tools: +207,167 (+128.7%). Of that increase, 199,424 was cached
input. Uncached input increased by 7,743 (+13.7%). Cached input is a subset of input,
not an additional quantity to add on top; it is not necessarily free.

Provider usage was captured from Codex `turn.completed.usage`. It aggregates the
agent's run, including repeated requests with growing history. The available
traces do not provide a per-request rendered prompt, so we cannot attribute each
of those 207,167 tokens exactly to individual schemas or messages.

Concrete evidence from the old traces:

- Ten MCP calls across two tasks, including two failures: seven symbols in a
  six-target batch, and `efficiency_report(history_limit:0)` rejecting zero.
  The latter schema/backend issue was fixed before this investigation.
- `explain(depth:0)` still returned signatures repeated in code, caller summaries,
  sibling names and related tests. Four successful explanation responses contained
  6,258 reference tokens. Keeping their same code blocks and source locations
  requires 3,904: 2,354 presentation/context tokens removable for body-only reads.
  Some of that context is useful for impact analysis, so full mode remains available.
- Instructions required an extra `efficiency_report` model turn, even though
  telemetry is already automatic. This requirement has been removed.
- Compact search defaulted to both file and identifier surfaces when the agent
  omitted mode. The new context operation deliberately searches files only.
- Routine JSON/protocol envelopes alone do not explain the large usage increase.
  Internal root, freshness and source-mutation wrappers preserve correctness;
  removing those would not solve the conversation-history cost.

Reference token counts use `o200k_base`, not a claim about GPT-6's billing tokenizer.
See [the raw presentation audit](2026-09-07-input-audit.json).

## Implemented changes

- Opt-in `CONTEXTPRO_TOOL_PROFILE=lean`: only `context` and `discover_tools` are
  advertised. Current reference catalog size is 486 tokens, versus 4,140 for
  workflow and 16,186 for full. That's 88.3% less than workflow, measured on JSON
  MCP catalogs; client-specific wrappers and server instructions are additional.
- `context(query:...)` composes discovery, bounded import expansion, disk reads
  and range deduplication on the server, returning only source evidence and
  necessary warnings/omissions. It avoids serial search/explain model turns.
- `context(targets:[{file,symbol?,start?,end?},...])` batches exact reads without
  retrieval, an embedding-provider call or an indexing wait. Each file is read
  once per request; parsing uses that same snapshot. Two MB per-file limit.
- Exact identifier queries use lexical retrieval. Natural language retains hybrid
  retrieval; a guessed confidence threshold does not suppress semantic recall.
- Large discovered files use whole top-level declaration spans selected by
  marginal query-term coverage per square root of byte cost. This deterministic
  heuristic reuses token sets, penalizes repeated coverage and preserves source
  text. It is not a trained selective-retrieval model or a formal optimal selector.
- Optional `explain(format:"source")` skips caller/test/sibling computation and
  duplicated signatures for single or batched symbol reads.
- Short forwarding functions can include up to two possible same-file helper
  functions, one hop deep. Candidates respect the same response budget and are
  labeled as candidates, not compiler-resolved call edges. Basic parameter/local
  shadowing is excluded. The locks and wrappers in application source stay intact.
- Agent rules now stop when evidence suffices, allow native tools when cheaper,
  and request an efficiency report only when the user asks for one.

Budgets are UTF-8 bytes/4, including returned notices; omissions are explicit and
source bodies are not clipped to meet the budget. Known line-range requests return
exact inclusive ranges. Source can change after a read; normal mutation guards
remain necessary when editing.

## Fresh paired agent results

Same frozen repository as the previous benchmark, same configured GPT-6 Astra
model with high reasoning effort, fresh isolated sessions, equal read-only tasks
and acceptance checks. Native tools remain available to the ContextPro variant.
The first task ran native then ContextPro; the second ran ContextPro then native.
No full test suite or heavy retrieval workload overlapped these timed runs.
Snapshot preparation is outside the clock; server startup and tool execution are
inside. Prompt cache availability is observed, not controlled or cleared.

| Two-task totals | Native | Lean ContextPro | Change |
|---|---:|---:|---:|
| Total input | 160,629 | 198,821 | +23.8% |
| Cached input, included above | 104,064 | 149,248 | +43.4% |
| Uncached input | 56,565 | 49,573 | -12.4% |
| Output | 1,254 | 1,308 | +4.3% |
| Wall time | 82.3 s | 98.0 s | +19.2% |
| Correct answers | 2/2 | 2/2 | Equal |
| MCP calls | 0 | 4 | No MCP errors |

Compared with the older ContextPro workflow's 368,131 input tokens and 190.6 s,
lean used 46.0% fewer total input tokens and 48.6% less time. Those are successive
rounds, not a controlled ablation isolating one code change. Both new tasks were
correct. In the native-repair task, lean needed one MCP call, used 6.7% more total
input, 34.5% less uncached input, and took 40.8 s versus native's 33.8 s.

The safety task initially needed three MCP calls because the agent followed
forwarding functions to their implementations. The helper expansion was added
*after* this first paired round. Follow-up results are recorded separately below,
not silently substituted for a less favorable run.

Machine-readable usage: [lean agent runs](codex-pairs-lean-2026-09-07.json).
Raw prompts, answers, events and stderr remain in ignored
`.contextpro/codex-pairs-lean-2026-09-07/`. Output contains provider-reported counts;
no actual dollar charge was returned. Subscription quota is not a dollar invoice.
Pricing claims must account for cached input, uncached input, output, cache writes
(all zero here), and any embedding/operating costs. This benchmark does not establish
patch-writing productivity or generalize from two questions to all coding tasks.

## Targeted follow-up after helper expansion

A fresh safety-task pair used the same model, task and variant guidance. ContextPro
finished correctly in 38.4 s versus native's 44.6 s (13.9% faster), but its total
input was 139,079 versus 110,918 (+25.4%), and uncached input was 37,703 versus
29,382 (+28.3%). Output was 410 versus 757; both succeeded without MCP errors.

The ContextPro agent chose three search queries instead of forwarding-function
target reads. This run therefore does **not** demonstrate an end-to-end benefit
from helper expansion. Direct source-fixture checks verify that the wrapper and
its local implementation now arrive together, but observed agent policy variation
still matters. Do not turn this single faster run into a general performance claim.

[Follow-up usage records](codex-pairs-lean-forwarding-2026-09-07.json). Raw events,
prompts and answers: `.contextpro/codex-pairs-lean-forwarding-2026-09-07/`.

All six fresh benchmark sessions in this investigation consumed 609,447 provider-
reported input tokens, of which 436,224 were cached and 173,223 uncached; output
was 3,729 tokens. These totals are the benchmark's own consumption, excluding the
parent development conversation. No actual dollar charge was available.

Codex, Claude Code and OpenCode's existing local ContextPro entries now select
`lean`; configuration backups were saved alongside each file. They require an
MCP restart. The package default remains `workflow` for compatibility. Dynamic
expert discovery is protocol-tested; clients that cannot reload enabled schemas
should use `full`.

## Research and how it applies

1. [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
   describes overhead from tool definitions and intermediate results. We adopted
   server-side composition and bounded output, using a deterministic read operation
   rather than adding arbitrary JavaScript execution.
2. [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode-mcp/) exposes a large
   API through two operations. This informed the small initial tool surface. Its
   published savings describe Cloudflare's API catalog, not ContextPro's savings.
3. [Repoformer](https://arxiv.org/abs/2403.10059) studies learned selective retrieval
   for code completion. The applicable principle is avoiding retrieval when it
   cannot help. ContextPro's direct-target bypass is deterministic; it does not
   implement Repoformer's trained model, and its reported speedups do not transfer.
4. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
   documents reuse of matching prefixes, including tool definitions and history,
   and recommends stable tool definitions and deferred loading. MCP controls its
   catalog; the host client controls rendering, cache policy and billing. ContextPro
   cannot force cache hits or eliminate all client-generated overhead.
5. [From Tool Orchestration to Code Execution](https://arxiv.org/abs/2602.15945)
   evaluates executable MCP workflows and their additional execution risks. There
   is no need to introduce an arbitrary-code sandbox for this bounded retrieval path.

## Verification

TypeScript build passed. The full suite passed all 619 tests after updating the
instruction contract, including direct reads without an index, exact source/range
preservation, overlapping target deduplication, budget omissions, stale-source
refresh, traversal/symlink escape rejection, ambiguous symbols, forwarding helper
selection and parameter shadowing. Additional protocol assertions cover enabling
an expert from the two-tool profile. Claude Code's configured server connected
successfully using Node 26 and the lean profile.

## Remaining work with the strongest evidence

Measure more repository sizes, languages and actual edit/test tasks with repeats.
Evaluate graph/caller coverage and retrieval precision before reducing the source
budget further. The first context response still returned unrelated code and tests;
more precise evidence selection could lower fresh input further. Evaluate an optional
compiler-resolved forwarding path for languages where exact binding is available.
Keep usage reporting outside the model loop through client hooks where supported.

Favor ContextPro when a combined indexed operation replaces several native steps.
Use native tools for a known narrow read or literal lookup when they are cheaper.
Forced usage can raise cost and latency; universal superiority is not supported by
these results.
