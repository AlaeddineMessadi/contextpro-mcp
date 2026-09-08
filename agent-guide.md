# ContextPro MCP — Agent Workflow Guide

Use ContextPro as the first interface for understanding an unfamiliar repository. It returns
ranked, bounded context. Use native file/search tools when they are cheaper for a
known exact target or when retrieved context is incomplete.

## Lean workflow (opt-in)

Set `CONTEXTPRO_TOOL_PROFILE=lean` for two advertised tools: `context` and
`discover_tools`. Start with `context(query:"your repository question")`: search,
source reading and deduplication run together on the server. Known targets use
`context(targets:[{file:"src/api.ts",symbol:"create"},{file:"src/types.ts"}])`
without search, index waits or embeddings. Short forwarding functions can include
up to two possible same-file helpers, one level deep, within the same budget.
These are candidates from source names, not compiler-resolved call-graph claims. Optional `start`/`end` are inclusive,
one-based line numbers, mutually exclusive with `symbol`.

The response budget defaults to 4000 estimated tokens (UTF-8 bytes/4). Omissions
are explicit; request narrower targets or raise the budget if evidence is missing.
Exact identifier queries use lexical search; natural-language queries retain
hybrid ranking. Large discovered files use bounded whole declarations selected
by query-term coverage per byte. This is an extractive heuristic, not a trained
retrieval policy or a guarantee that all relevant code was found.

Use `discover_tools` to enable editing, graph, validation or diagnostics only when
needed. Do not automatically call status, reindex, report or memory on each task.

## Existing workflow

1. Start with `task_pack(max_tokens:2000, graph_hops:1)` for a task-specific context bundle, or `status` when
   diagnosing index health.
2. Use `search(mode:"file", format:"compact", include_dependencies:true)` to locate
   unfamiliar code and supporting imports. Use `grep` or `explain` directly for a known literal/name.
   The default crux excerpt often avoids a second read; verbose `json` is for diagnostics.
3. Use `skeleton` before reading a large file; use `explain` for one symbol body
   and its immediate dependencies. `exported_only:true` gives a TS/JS public API view.
4. Before changing a symbol, use `blast_radius` for textual scope; `kind:"call"`
   filters call-containing lines and explicit kind counts avoid manual recounts.
   Use `exact_references` for compiler-resolved TS/JS rename checks and `change_impact`
   or `test_impact` to plan validation.
5. After edits, use `validate_scope` or `lint`, then record durable findings with
   `memory_record_task` when they will help a later session.

Run independent ContextPro reads in parallel. Prefer bounded outputs (`top_k`,
`max_tokens`, summary modes) and expand only when needed.
For several known symbols, prefer one `explain(symbols:[{symbol,file},...], depth:0)`
call. It accepts up to six targets and reports any whole bodies omitted by its
response budget. Batch requests reduce model turns and repeated input history.

The default catalog exposes 13 workflow tools. Call `discover_tools(query:"exact references")`
to find an expert tool, then `discover_tools(enable:["exact_references"])` to expose its
schema for this session. Enabling does not execute the tool. Clients without dynamic
catalog support can configure `CONTEXTPRO_TOOL_PROFILE=full` before startup.

Do not repeat the entire workflow for a one-line lookup. Check supporting import
pointers before trusting a top result as the complete edit scope. If a packet says
`context.unchanged:true`, retain the previous packet; after losing context, omit the
previous ID to recover a full response. `search(profile:true, format:"compact")` exposes
phase timings for performance diagnosis.

## Routing and freshness

Every tool accepts `root`. Pass the absolute worktree root when the client has
multiple roots, cannot advertise roots, or is controlling another worktree.
Otherwise the server resolves the client workspace, then falls back to its boot
root. Each worktree has an isolated index; a wrong or missing root is the usual
cause of seeing code from another checkout.

Structural tools probe freshness and refresh small changes automatically. Do not
run full `reindex` routinely. Use it when the freshness gate cannot finish a large change or when `status`
reports stale embeddings. See [maintenance](docs/maintenance.md) before deleting
project state or invoking cleanup tools.

## Important distinctions

- `checkpoint` creates a recoverable file write; `restore` rolls it back.
- `artifact_list`/`artifact_read` reuse prior generated context.
- Memory tools persist decisions and evidence; keep secrets and transient chatter
  out of memory.
- Savings footers and `efficiency_report` are estimates of source context avoided,
  not billing facts. Do not present them as measured provider-token savings.

Tool-specific descriptions contain the complete arguments and behavior for each
tool. Prefer canonical names; deprecated aliases remain only for compatibility.

## End-of-task reporting

Metrics are recorded automatically. Only when asked for a usage report, call
`efficiency_report(scope:"session", format:"json")` and label its `finalSummary`
as an estimate. Do not add a model turn solely to produce an estimated footer. This report isolates the MCP
process session from concurrent agents using the same project database. It is
cumulative for that server session, not necessarily a single chat task: label it
as session usage when a client keeps the server alive across tasks.

Token figures use UTF-8 bytes divided by four. The session full-source baseline
credits each file revision once, then subtracts tool requests, responses and one
advertised tool catalog. It does not measure the other agent's hypothetical
behavior, tokenizer usage, repeated conversation history or prompt caching.
If the estimated overhead exceeds that baseline, no savings are claimed.

Pass `input_cost_per_million` only when you know the model's input-token price.
The dollar number is a hypothetical uncached-input scenario. Optionally supply
`contextpro_cost_usd` for known embedding/operating costs in the same window; the
report will then subtract them. Otherwise net savings and actual billing savings
remain unknown. Never describe this as revenue, money earned, or verified savings.
The report covers completed calls before the report request itself.

Per-call footers are off by default to avoid repeating the same explanation.
`CONTEXTPRO_EFFICIENCY_FOOTER=true` enables legacy per-call estimates; use the
net session report when requested, not a sum of positive footers.

## Incremental packets and optional graph context

`task_pack` always returns full context by default. Keep its `context.id` and pass
`previous_context_id` only while you still have the earlier response. The next
packet contains explicit added, changed and removed entries. After compaction,
context loss or handing work to another agent, omit the ID and request a full
packet. `artifact_read` with that ID recovers the immutable snapshot. Missing,
unrelated or truncated baselines cause an explicitly labeled full fallback.

Use `preset: "keyword_only"` for discovery without embedding-provider calls.
The token budget applies to the final text/JSON tool payload, estimated as UTF-8
bytes/4; it is not a promise about every model's tokenizer.

`graph_hops: 1` or `2` adds bounded related import pointers with evidence labels;
`graph_max_files` caps additional files (default 4, maximum 10). It stays off by
default: test whether the extra context helps your task before enabling it routinely.

## Safe editing (core/full or enabled expert tools)

Prefer exact language-server rename when available. ContextPro rename remains a
textual operation; inspect the resulting diff. `find_symbol` JSON exposes a
`contentHash`; pass it as `expected_content_hash` to reject an outdated edit.
Writes serialize within the project, preserve file modes, and reject symlinked
targets or parents. Source replacements use exact spans or reject ambiguity.
Multi-file edits are not a filesystem transaction: partial failures identify
completed/pending files and recovery points. Handle a conflict by reading current
context and retrying deliberately.


## Parser availability

WASM parsing runs in a reusable child process with baseline compilation, bounded
queue/source sizes, a 15-second request deadline and a short recovery cooldown.
A parser child exit does not inherently terminate the MCP parent. Structural reads fall back
to regex parsing when unavailable; this is reduced precision, not exact semantic
analysis. Supported-language syntax validation fails closed on parser failure.
`health` reports the executable path and parser backend so a client using an old
cached launch command is visible. Restart the client to reload changed MCP config.

## Reference counts and compiler availability

`exact_references` uses TS/JS project configuration, inherited aliases and referenced
source projects. Indexed tests remain in scope even when excluded from production
compilation. Retained compiler services observe source/config changes and run in a
separate worker with a 30-second active deadline and idle disposal. Cold initialization
can still be slow; retry or use native/compiler tools when analysis cannot complete.

Check `total`, `returned`, `truncated`, `counts`, `scope` and `warnings` in JSON output.
A direct-call count is different from all identifier occurrences or matching lines.
The current maximum display is 500; verify omitted results separately. Dynamic and
unindexed references are outside this declared scope. Python candidates are heuristic;
imported SCIP evidence still needs source-revision verification.

Normal source checks use size/mtime/ctime, then hashes for suspicious files. Background
reconciliation continues after watcher failure. These checks do not include unsaved
editor buffers or promise an atomic repository snapshot. An incomplete response is a
reason to expand or verify evidence, not to label a rename safe.
