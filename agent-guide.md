# ContextPro MCP — Agent Workflow Guide

Use ContextPro as the first interface for understanding an unfamiliar repository. It returns
ranked, bounded context. Use native file/search tools when they are cheaper for a
known exact target or when retrieved context is incomplete.

## Lean workflow (opt-in)

Set `CONTEXTPRO_TOOL_PROFILE=lean` for three advertised tools: `context`, `exact_references` and
`discover_tools`. Call `exact_references` directly for TS/JS caller questions. Start with `context(query:"your repository question")`: search,
source reading and deduplication run together on the server. Known targets use
`context(targets:[{file:"src/api.ts",symbol:"create"},{file:"src/types.ts"}])`
without search, index waits or embeddings. Short forwarding functions can include
up to two possible same-file helpers, one level deep, within the same budget.
These are candidates from source names, not compiler-resolved call-graph claims. Optional `start`/`end` are inclusive,
one-based line numbers, mutually exclusive with `symbol`.

The response budget defaults to 4000 estimated tokens (UTF-8 bytes/4). Omissions
are explicit; request narrower targets or raise the budget if evidence is missing.
Exact identifier queries use lexical search; natural-language queries retain
hybrid ranking. Large discovered files use complete declarations and query-anchored
interior ranges, ranked across files by weighted term coverage and output cost.
Ranges preserve exact source text, but may omit surrounding control flow.
This is an extractive heuristic, not a trained
retrieval policy or a guarantee that all relevant code was found.

Use `discover_tools` to enable editing, graph, validation or diagnostics only when
needed. Do not automatically call status, reindex, report or memory on each task.

When delegating repository work, include the active root and a concrete next
read in the task prompt when known, for example:

> Work in `/absolute/project/root`. Use `context` for discovery or batch the known
> targets `[{file:"src/api.ts",symbol:"create"},{file:"src/types.ts"}]` in one call
> with that root. Inspect omissions and use a narrow native read if needed.

The batch accepts up to six targets. It can reduce separate tool calls even when
no discovery is needed. A single tiny known read may be simpler natively; tool
availability or an instruction alone does not establish that an agent used it.

## Choose the next call from the evidence

| What you need or observe | Next useful action |
| --- | --- |
| Unfamiliar implementation | Name a known source directory and observed symbol/route in `context(query:...)`; use `intent:"change"`, `"debug"` or `"review"` when supporting evidence matters |
| Known file or declaration | Use `context(targets:[{file,symbol}])` or a narrow `{file,start,end}` range; no search or embeddings are needed |
| Source displaced by documents or budget omissions | Read the discovered source target directly or split the batch; use scoped native search if the path remains unknown |
| Binding identity or cross-file TS/JS callers | Use `exact_references` with the observed declaration file; inspect totals, scope and warnings |
| Reference timeout | Continue with bounded source/native local tracing; keep compiler completeness or rename safety unverified |

Choose only the rows needed for the task. Do not invent symbol names to satisfy
an example, or repeat the same broad query after an explicit omission.
Evidence labels describe the packet: `returned` is included, `omitted` was
budget-excluded, `unclassified` was not evaluated, and `unavailable` is not proof
that a role or source is absent. Inspect citations and control flow before editing.
Lexical fallback can still supply useful source; it is not a semantic-quality test.
Structural freshness and semantic readiness are separate. A model change needs a
semantic rebuild for each affected root; see [semantic recovery](docs/maintenance.md#recover-semantic-search).

## Existing workflow

1. Start with `task_pack(max_tokens:2000, graph_hops:1)` for a task-specific context bundle, or `status` when
   diagnosing index health.
2. Use `search(mode:"file", format:"compact", include_dependencies:true)` to locate
   unfamiliar code and supporting imports. Use `grep` or `explain` directly for a known literal/name.
   The default crux excerpt often avoids a second read; verbose `json` is for diagnostics.
   `grep` is literal by default: pass `regex:true` for `A|B` alternation or escapes.
   `context_chars` controls the in-line character window (40–400); use
   `context_lines:2` for neighboring lines (0–10, default 0). Overlaps are deduplicated.
3. Use `skeleton` before reading a large file; use `explain` for one symbol body
   and its immediate dependencies. `exported_only:true` gives a TS/JS public API view.
   Skeletons normalize/truncate signatures; do not use them as exact Edit anchors.
   Read the needed source with `context(targets:[{file,start,end}])` before editing.
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

The default catalog exposes 14 workflow tools, including `exact_references`.
For other experts, call `discover_tools(query:"rename")`, then
`discover_tools(enable:["rename_preview","rename_apply"])` to expose binding-aware
rename schemas for this session.
Enabling returns the requested schemas and does not execute the tool. If the client
cannot refresh its catalog, tools marked `callable` can run through the existing tool:

```json
{"root":"/absolute/repo","call":{"name":"skeleton","arguments":{"file_path":"src/api.ts"}}}
```

Pass this to `discover_tools` after reading the enabled tool's schema. The fallback
supports source reads, references, validation planning, status/health, and reindex;
it excludes source edits and destructive maintenance. It uses the target's normal
root routing, validation, freshness and metrics. Put `root` only at the top level.
Use only `root` and `call` for execution; do not mix discovery controls such as
`query`, `enable` or `limit` into that request. Budgets are tool-specific:
`max_tokens` is accepted by `context`, not `status` or `exact_references`.
For other experts, configure `CONTEXTPRO_TOOL_PROFILE=full` before startup.
Unknown top-level arguments and unknown `context.targets` keys are rejected;
use `root` and `max_tokens`, not `projectPath` or `maxTokens`.
`context` accepts 1–6 exact targets and an integer `max_tokens` from 512 to 12000
(default 4000, estimated UTF-8 bytes/4). Split larger batches or narrow the ranges.
Explicit line targets with `end` can read text files larger than 2 MB without
parsing or indexing the bundle. They scan at most 64 MiB per file and retain only
bounded requested ranges; whole-file and symbol reads keep the 2 MB limit.
Binary, changing, oversized and scan-limited inputs have explicit omissions.
Discovery checks structural freshness and falls back to a structural reindex when
the quick-refresh threshold is exceeded, without generating embeddings or hubs.
`CONTEXTPRO_AUTO_REFRESH=false` disables that maintenance; freshness warnings remain
visible. Exact targets read current source without initializing the index.
Generated Graft wiring cards are excluded from discovery when `graft/INDEX.md`
contains the Graft repo-map header. Authored directories named `graft` remain
eligible, and explicit exact targets can still read the generated cards.
Project verification leaves unchanged configuration files untouched. Actual config
updates use a temporary file and atomic replacement so failed writes preserve the
previous settings. Initialization, indexing and other persistent operations still
need writable storage; this is not a general read-only server mode.
Literal symbol names in discovery queries prioritize their definitions; large
bodies can still be partial, so inspect the returned ranges and omissions.
Query discovery also combines named-identifier text matches with concrete path
topics, and recognizes existing repository-relative directory prefixes such as
`apps/mobile/app/host`. Up to eight additional candidates compete through bounded
interior source windows in both selectors. These hints do not require chat calls
and are disabled for semantic-only evaluation and exact target reads. Directory
hints are preferences, not hard filters; linked evidence can come from elsewhere.
Use `exact_references` to establish TS/JS binding identity. Unknown directory
prefixes and identifiers do not invent paths or prove absence. For an omitted
route, guard or implementation, follow up with exact targets or native scope search.
Literal UI phrases, including Unicode text, use full-source local text search;
matching lines get priority in the returned source windows. Quotes can delimit
the phrase. Existing summary-only indexes rebuild automatically on refresh.
Repository orientation queries also include structural entry points, import hubs,
their dependencies and a root README when available. File mentions within an
overview supplement that orientation instead of narrowing it to the named files.
Outside an overview, explicit `Read path/to/file`
queries prioritize up to six known indexed or discovered document paths, returning whole files when the
budget permits; use `targets` for deterministic reads without discovery.
Project-status, readiness, handoff and documentation queries also search visible
Markdown/text filenames and bounded heading/intro previews, even when those files
are outside the structural index. This respects repository ignore rules and skips
symlinks. At most 64 document prefixes (16 KiB each) are inspected and six documents
selected; omissions remain explicit. These excerpts do not prove the newest or
complete project status. Use exact reads for the selected report's remaining sections.
General discovery downweights dependency lockfiles. When source alternatives
exist, `context` excludes lockfiles unless the query names one or asks about
dependencies or resolution; lockfile-only evidence remains available.

Do not repeat the entire workflow for a one-line lookup. Check supporting import
pointers before trusting a top result as the complete edit scope. If a packet says
`context.unchanged:true`, retain the previous packet; after losing context, omit the
previous ID to recover a full response. `search(profile:true, format:"compact")` exposes
phase timings for performance diagnosis.

## Routing and freshness

Every tool accepts `root`. Subagents must pass their own absolute worktree root
on every call, including discovery and reindex. A shell `cd` does not retarget a
shared MCP server. When the effective Git repository has linked worktrees, an
omitted root is rejected with a request to specify it explicitly. A single client
root can still describe the parent agent, so it does not bypass this guard.
Linked checkouts require root even when attached to a bare Git store.
For a single main checkout, the server uses client roots then its boot root. Separate
clones cannot be detected through shared Git metadata; still pass root explicitly.
Each worktree has an isolated index. If source appears stale, verify the selected
root against a native read before rebuilding or changing provider settings.

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

Use `rename_preview` / `rename_apply` for compiler-backed TS/JS or configured
Python renames. The separate `rename_symbol` compatibility tool is textual;
inspect the resulting diff. `find_symbol` JSON exposes a
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
Both `health` and `status` include the version and build timestamp captured when
the process loaded, plus its PID. Rebuilding on disk does not update that running
identity; restart the server to load the new build. `health` checks runtime and
storage readiness. Use `status` for index freshness and vector availability.
An empty vector index uses lexical discovery; searches do not generate corpus
embeddings. Configure a provider and reindex without `no_embed` when semantic
retrieval is required.

## Reference counts and compiler availability

`exact_references` uses TS/JS project configuration, inherited aliases and referenced
source projects. With a TS/JS `file` and no `line`, it infers a named declaration
from current source, including interface and object properties. Several candidates
produce an ambiguity warning; pass `file` and `line` to select the intended binding.
If no declaration exists, the response requests an explicit occurrence rather than
assuming line one. Indexed tests remain in scope even when excluded from production
compilation. Retained compiler services observe source/config changes and run in a
separate worker with a 30-second active deadline and idle disposal. Cold initialization
can still be slow. `limit` bounds displayed occurrences, not the compiler workspace;
lowering it does not narrow analysis. Do not repeatedly retry an unchanged timeout.
Read the target and trace local uses natively when that answers the task; disclose
the limited scope. A binding-sensitive rename still needs resolved references or
an appropriate compiler/language-server check.

Check `total`, `returned`, `truncated`, `counts`, `scope` and `warnings` in JSON output.
Text output labels each occurrence as definition, import, call or reference, and
shows identical snippets once per file while retaining every returned location. `callsByFile`
reports call totals before the result limit; at most 50 call-file summaries are shown,
with `callFileCount` and `callFilesTruncated` exposing omissions. These summaries
exist only for compiler-classified evidence. A direct-call count differs from all
identifier occurrences or matching lines.
The current maximum display is 500; verify omitted results separately. Dynamic and
unindexed references are outside this declared scope. Python uses Pyright LSP when
`CONTEXTPRO_PYRIGHT_COMMAND` is configured; otherwise candidates remain heuristic.
Imported SCIP evidence still needs source-revision verification.

Normal source checks use size/mtime/ctime, then hashes for suspicious files. Background
reconciliation continues after watcher failure. These checks do not include unsaved
editor buffers or promise an atomic repository snapshot. An incomplete response is a
reason to expand or verify evidence, not to label a rename safe.

## Optional teamwork and verification

Use `context(query:...,intent:"change")` for supporting implementation, caller,
contract, configuration and test evidence. `debug`, `review`, `overview`, `lookup`
and `auto` are also supported. The hint opts that query into adaptive retrieval;
distinguish unclassified, unavailable and budget-omitted roles. Ordinary exact reads
avoid discovery and compiler initialization.

Discover `team_status` / `team_task` only when coordinating local work. Claim a
task with an explicit owner and individual files, then renew five-minute leases.
Same-worktree file conflicts reject; other-worktree overlap warns. These are
advisory claims, not an agent launcher or a lock on outside editors.

After editing, obtain a `validate_scope` snapshot before running checks in the
host. Submit actual exit status, runtime identity and bounded output through
`validation_record`. Source changes invalidate applicability. Record durable
conclusions with `memory_record_task(source_evidence:[...],validation_refs:[...])`,
and `supersedes` when replacing an earlier conclusion. Inspect the returned
handoff through `artifact_read`; do not treat historical validation as current.

For TS/JS and configured Python use `rename_preview`, inspect its edits, then
`rename_apply` with the preview ID. Stale source/configuration or unsupported
operations reject; there is no textual fallback. The separate `rename_symbol`
compatibility tool remains textual. Run appropriate checks after applying.
Enable specialists in batches of at most six; writes are excluded from the
read-compatible discovery dispatcher. See [configuration](docs/configuration.md)
for Python setup, shared compute, resource limits and rollback.
