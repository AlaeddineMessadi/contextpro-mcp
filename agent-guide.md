# ContextPro MCP — Agent Workflow Guide

Use ContextPro as the first interface for understanding a repository. It returns
ranked, bounded context; fall back to native file/search tools only when a
ContextPro tool cannot provide the exact detail you need.

## Fast workflow

1. Start with `task_pack` for a task-specific context bundle, or `status` when
   diagnosing index health.
2. Use `search` (`hybrid` for behavior, `identifier` for a known name) to locate
   code. Its default crux excerpt often avoids a second read.
3. Use `skeleton` before reading a large file; use `explain` for one symbol body
   and its immediate dependencies.
4. Before changing or deleting a symbol, call `blast_radius`. Use
   `exact_references` for compiler-resolved TS/JS references and `change_impact`
   or `test_impact` to plan validation.
5. After edits, use `validate_scope` or `lint`, then record durable findings with
   `memory_record_task` when they will help a later session.

Run independent ContextPro reads in parallel. Prefer bounded outputs (`top_k`,
`max_tokens`, summary modes) and expand only when needed.

## Routing and freshness

Every tool accepts `root`. Pass the absolute worktree root when the client has
multiple roots, cannot advertise roots, or is controlling another worktree.
Otherwise the server resolves the client workspace, then falls back to its boot
root. Each worktree has an isolated index; a wrong or missing root is the usual
cause of seeing code from another checkout.

Structural tools probe freshness and refresh small changes automatically. Do not
run full `reindex` routinely. Use it after a large branch change or when `status`
reports stale embeddings. `gc` removes indexes for deleted worktrees.

## Important distinctions

- `checkpoint` creates a recoverable file write; `restore` rolls it back.
- `artifact_list`/`artifact_read` reuse prior generated context.
- Memory tools persist decisions and evidence; keep secrets and transient chatter
  out of memory.
- Savings footers and `efficiency_report` are estimates of source context avoided,
  not billing facts. Do not present them as measured provider-token savings.
- `pmll-memory-mcp` is an optional separate server, not part of ContextPro.

Tool-specific descriptions contain the complete arguments and behavior for each
tool. Prefer canonical names; deprecated aliases remain only for compatibility.

## End-of-task reporting

Before your final answer, call `efficiency_report` with `scope: "session"` and
`format: "json"`. Include its `finalSummary` once. This report isolates the MCP
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
net session report for the final answer, not a sum of positive footers.

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

## Safe editing (core/full profiles)

Prefer exact language-server rename when available. ContextPro rename remains a
textual operation; inspect the resulting diff. `find_symbol` JSON exposes a
`contentHash`; pass it as `expected_content_hash` to reject an outdated edit.
Writes serialize within the project, preserve file modes, and reject symlinked
targets or parents. Source replacements use exact spans or reject ambiguity.
Multi-file edits are not a filesystem transaction: partial failures identify
completed/pending files and recovery points. Handle a conflict by reading current
context and retrying deliberately.
