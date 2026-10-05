# Configuration reference

Defaults below describe this checkout's MCP launch path. Set environment variables in the client that launches the server, then restart it. `src/core/provider-config.ts`, `src/core/tool-profile.ts` and `src/index.ts` are the implementation sources; legacy aliases remain accepted where implemented, but new configurations should use `CONTEXTPRO_*`.

## Profiles

`CONTEXTPRO_TOOL_PROFILE` defaults to `workflow` (14 initial tools). `lean` advertises `context`, `exact_references` and `discover_tools`; `core` includes common editing/graph operations; `full` advertises everything. Existing custom profiles survive `init`. Discovering or enabling tools does not execute them. Enabling returns schemas; hosts without catalog updates can use `discover_tools({root,call:{name,arguments}})` for tools marked `callable` (reads and indexing, never source edits). The target schema and normal request routing still apply. Use `full` for other experts on those hosts.

## Providers

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_PROVIDER` | `ollama` | Local Ollama or the OpenAI-compatible backend |
| `CONTEXTPRO_BASE_URL` | `https://api.openai.com/v1` | Compatible endpoint base; ensure it supports the operation requested |
| `CONTEXTPRO_API_KEY` | unset | Compatible endpoint credential; inject without committing |
| `CONTEXTPRO_EMBED_MODEL` | `nomic-embed-text:latest` locally; `text-embedding-3-small` for compatible backend | Embedding identity; reindex after changing it |
| `CONTEXTPRO_CHAT_PROVIDER` | embedding provider | Separate chat backend selection; key/base URL remain shared |
| `CONTEXTPRO_CHAT_MODEL` | provider fallback when chat is invoked | Optional explicit selection; fallback names are `gemma4:12b` and `gpt-4o-mini`, not a promise of endpoint availability |
| `CONTEXTPRO_CHAT_RERANK` | off | Opt in to reranking the top eight planning/connected candidates with current bounded source snippets; model call deadline 1.5 seconds, deterministic fallback |
| `CONTEXTPRO_FEATURE_SUMMARIES` | off | Allow explicit `feature_brief` preparation to generate citation-checked model interpretations; 30-second deadline. Ordinary context discovery only reuses valid cached briefs |
| `CONTEXTPRO_AUTO_HUBS` | off | Opt in to chat-assisted hub generation during reindex |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local Ollama endpoint |

Compatible-provider aliases select the same API implementation; an alias does not guarantee that a vendor supports embeddings or a particular model. Check your endpoint's capabilities. Explicit chat operations can use configured credentials and fallback models; an omitted chat-model variable is not a universal disable switch.

Hosted requests can contain source/context material. The coding agent's model usage and ContextPro's optional provider usage are independent. Normal direct source/structural reads do not require chat inference.

For provider-free discovery use `search(preset:"keyword_only")` or direct `context(targets:[...])`. Set `CONTEXTPRO_REINDEX_NO_EMBED=true` or pass `reindex(no_embed:true)` to skip corpus embedding generation; that setting alone does not prohibit query embeddings on a later hybrid search. Memory embedding/search operations have their own provider requirements.

## Indexing and retrieval

| Variable | Launch default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_CONNECTED_CONTEXT` | off | Experimental shared `context`/`task_pack` retrieval: reciprocal-rank fusion, one-hop connected evidence, at most 32 candidate files. Explicit task-pack graph settings override its defaults |
| `CONTEXTPRO_EMBED_TRACKER` | `lazy` | Start tracking when needed; `eager` starts at boot; `off` disables the background tracker |
| `CONTEXTPRO_EMBED_TRACKER_DEBOUNCE_MS` | `700` | Debounce changes; tracker helper enforces a 500 ms minimum |
| `CONTEXTPRO_EMBED_TRACKER_MAX_FILES` | `8` | Per-tick changes, clamped to 5–10 |
| `CONTEXTPRO_RECONCILE_INTERVAL_MS` | `30000` | Background reconciliation interval, at least 5000 ms; idle scheduling may skip ticks while watching works |
| `CONTEXTPRO_RECONCILE_MAX_FILES` | `40` | Repair budget per sweep |
| `CONTEXTPRO_AUTO_REFRESH` | enabled | Pre-query structural freshness gate, including search/context discovery; false leaves warnings and skips automatic maintenance |
| `CONTEXTPRO_REFRESH` | metadata fast path | Set `hash` to hash every source during quick refresh |
| `CONTEXTPRO_QUICKREFRESH_MAX_FILES` | `30` | Quick-refresh threshold; the structural gate can fall back to a full structural refresh |
| `CONTEXTPRO_REINDEX_NO_EMBED` | off | Skip eager corpus embeddings |
| `CONTEXTPRO_QUERY_EMBED_TIMEOUT_MS` | `1500` | Query-embedding budget, clamped to 100–10000 ms |
| `CONTEXTPRO_EMBED_BATCH_SIZE` | `32` local / `8` compatible | Inputs per embedding request, clamped to 1–128 |
| `CONTEXTPRO_EMBED_CHUNK_CHARS` | `2000` | Embedding chunk size, clamped to 256–8000 characters |
| `CONTEXTPRO_MAX_FILE_SIZE` | `5242880` | Full-reindex source size cap in bytes |
| `CONTEXTPRO_MAX_EMBED_FILE_SIZE` | `51200` | File embedding size cap in bytes |

Normal refresh compares size, full mtime and ctime, then hashes suspicious files. Hashing and parsing share a verified read. Freshness warnings describe remaining drift or failure, not merely the number of files already repaired. Watcher failure keeps periodic reconciliation alive when the tracker is enabled.

Interactive retrieval reuses existing vectors rather than generating a corpus on demand. A failed query embedding can fall back to keyword ranking; explicit semantic-only requests still need semantic evidence.

Query-based `context` responses include a `source_context` ID. Pass it as
`previous_context_id` only while holding the complete prior packet. Compatible
requests return added, changed and removed source ranges. Different roots,
queries, settings or budgets, missing artifacts and incomplete deliveries recover
with a full response. Omit the ID after compaction. Exact `targets` remain
stateless, index-independent reads and reject `previous_context_id`.

The discoverable `feature_brief` expert accepts `query`, optional `refresh`, and
`max_tokens` (512–12000, default 2000; UTF-8 bytes/4). Its deterministic facts cite
source ranges. Optional model interpretations are labeled separately; citation
validation does not verify the claims themselves. Cached briefs validate source
hashes, dependency membership, generator/model identity and retrieval settings
(adaptive mode, reranking and embedding identity) before reuse. Neither
briefs nor deltas imply exhaustive repository coverage. Use `artifact_read` for
full stored packets. Both experts support compatibility dispatch through
`discover_tools`; the lean catalog remains three tools.

Local full-text search stores full source for indexed files, so text beyond the
embedding summary is searchable. This increases the regenerable database size;
embedding inputs and response budgets remain bounded separately. The extraction
stamp automatically rebuilds older summary-only indexes on the next structural
freshness check. Unicode query tokens and phrase matching use that local index.
Default natural-language `context` discovery considers twelve ranked files before
packing bounded source ranges; exact identifiers consider four. These candidate
counts are independent of `max_tokens` and do not imply complete scope coverage.

## Runtime and reporting

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_NATIVE_AUTO_REPAIR` | `true` | Isolated per-runtime binding repair; npm/network needed for a cache miss |
| `CONTEXTPRO_NATIVE_CACHE_DIR` | `~/.cache/contextpro/native` | Stable ABI/platform/architecture/libc/dependency cache |
| `CONTEXTPRO_EFFICIENCY_FOOTER` | `false` | Legacy per-call estimated footer; prefer reporting only when requested |
| `CONTEXTPRO_PROJECT_ID` | derived | Project identity override |
| `CONTEXTPRO_CLIENT_ID` | unset | Optional client grouping |
| `CONTEXTPRO_SESSION_ID` | unset | Session metadata for scoped memory |
| `CONTEXTPRO_SESSION_SOURCE` | `mcp` | Session source label |
| `CONTEXTPRO_INSTRUCTIONS_REMOTE` | `false` | Optional trusted remote instructions; bundled guide is the normal path |
| `CONTEXTPRO_INSTRUCTIONS_REMOTE_URL` | `https://contextpro.dev/api/instructions` | Remote source when enabled |
| `CONTEXTPRO_ALLOW_UNSAFE_ROOT` | `false` | Override root/home-level root checks; ordinary project roots need no override |
| `CONTEXTPRO_REFERENCE_HEAP_MB` | `1024` | Reference-worker JavaScript heap ceiling (not preallocated); integer 256–4096, invalid values use 1024; restart the host after changing |

The TypeScript reference worker retains at most one project and releases completed
compiler graphs between configurations in a monorepo. Single-project queries
reuse their compiler. Other limits are 60-second idle disposal, a 30-second active
request deadline and 20,000 input files. Heap exhaustion returns a specific error
with the configured limit. Parser requests have a 15-second deadline and separate
queue/source limits. These are not whole-machine resource guarantees.

Query-based `context` in both default and connected modes adds at most eight
source candidates corroborated by a named identifier and path topics, or an
existing relative directory prefix plus a topic. Each of up to eight identifier
hints examines at most 64 local text hits. The shared source collector selects
bounded interior windows; connected packets remain capped at 32 candidate files.
These are lexical hints, not binding-resolved references or hard scope filters.
No additional chat/embedding calls are introduced. Exact target reads remain
stateless, and semantic-only evaluation bypasses these lexical candidates.

Lexical discovery retains quoted phrases and compound keys, and treats tests and
translation catalogs as secondary evidence unless requested. SQL files participate
in source-text search and freshness checks; SQL binding references and structural
symbol extraction are not provided by this text fallback. Source budgets still
allow omissions, especially for broad questions spanning many modules.

Discovery includes source under `.github/` and `.maestro/`, including nested app
directories. Project and nested `.gitignore`/`.contextproignore` rules still
apply. Other hidden entries, dependency/build directories and symlinks remain
excluded from discovery; use exact targets for a known source outside that scope.

See [installation](../INSTALL.md) for launch examples and [maintenance](maintenance.md) for test/runtime and disk-cleanup guidance.

## Optional benchmark tracing

`CONTEXTPRO_PROVIDER_TRACE_PATH` optionally records local JSONL events containing
provider/model identity, call duration, status and provider-reported input/output
counts. It records no prompts, source or credentials. Missing counts stay null;
local embeddings commonly report input counts without output counts. These
events are separate from the coding agent's usage and are not billing estimates.

Set `CONTEXTPRO_TOOL_TRACE_PATH` to an absolute local JSONL path before starting the server. Tracing is off by default and adds no MCP response text. Each event records tool arguments, status, a session/request ID, total server duration, preparation (root verification/freshness/waits), handler execution and postprocessing. Spans can overlap; their sum is not elapsed agent time.

The trace caps each argument payload at 8 KiB and the file at 64 MiB, redacts common credential/content keys and requires a private regular destination file (created with mode 0600). Query strings and paths can still contain private information; keep raw traces local. Write failures are best-effort and produce a stderr warning. A missing or partial trace is unavailable evidence, not zero execution time. See the [benchmark procedure](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/docs/benchmarks/methodology.md).
## Experimental development context

`contextpro daemon start|status|stop` manages an optional private local compute service. Set `CONTEXTPRO_DAEMON=true` in each MCP process to share freshness/indexing, TypeScript compiler work and configured Python analysis. Build, Node ABI and provider/runtime configuration must match. Incompatibility, crashes and unavailable services fall back to local computation. The service expires after five idle minutes; Windows currently uses local compute because a private Unix socket is required. `CONTEXTPRO_RUNTIME_DIR` overrides the default `~/.contextpro/runtime` directory for isolated installations. Stop a running service using its original build/configuration before upgrading it.

`context` accepts a query-only `intent` hint: `auto`, `lookup`, `change`, `debug`, `review`, or `overview`. Supplying it enables adaptive retrieval for that call. `CONTEXTPRO_ADAPTIVE_CONTEXT=true` enables inferred intent for query calls. Omit both to retain the existing selector. Exact targets remain stateless and reject an intent hint.

Change/debug/review requests reuse the connected evidence retriever for implementations, callers, dependencies and tests. Configuration and contract candidates are labelled by path; these are structural/textual hints, not compiler proof. Missing evidence and output omissions do not establish absence. Response budgets and source delta IDs retain their existing contracts.

These intents also inspect at most twelve matching task-risk candidates lexically and return up to two current records within the existing output budget. Notes cite their memory IDs and remain textual claims. Stale, unverified and superseded risk notes are excluded; unavailable and omitted risk evidence are explicit. Changed notes invalidate context reuse. Ordinary lookup requests do not perform this memory search.

## Verifiable memory and host checks

`memory_record_task` accepts `source_evidence: [{file, hash?, start?, end?}]`, `supersedes: [memory_id]` and `validation_refs: [artifact_id]`. Source references capture whole-file SHA-256 hashes, the canonical worktree root and Git revision, plus configuration and dependency-manifest evidence. Existing `files` also bind source evidence; deleted legacy file references remain recordable as explicitly unverified. Explicit structured references reject unavailable files and invalid line ranges. Each task record is immutable history: recording the same task again creates another record. Explicit supersession preserves the old record and its evidence.

Retrieval labels records `current`, `stale`, `unverified` or `superseded`. Stale and superseded conclusions do not enter automatic task recommendations. Manual memory search/listing retains them, with lexical fallback when embeddings are unavailable. Legacy records migrate logically as `unverified`; no destructive migration is required. A returned `handoff` artifact contains completed work, remaining risks, assumptions, source references and validation state. Read it through `artifact_read`; current source/supersession and validation applicability are rechecked alongside the historical payload.

Referenced validation receipts also affect task-memory applicability: a stale receipt makes its conclusion stale, and an unavailable receipt makes it unverified. A current source hash alone does not renew an old validation conclusion.

Call `validate_scope` after edits and before running checks. Its snapshot covers ignore-aware workspace files, configuration and manifests; ignored dependencies, build outputs and unsaved buffers are outside that snapshot. Run checks in the coding host, then call `validation_record({root, snapshot_id, command, exit_code, runtime, evidence?})`. Results are explicitly host-reported. Source/configuration/membership/revision changes invalidate applicability; recommended commands never count as executed checks. Snapshots cap at 20,000 files and fail rather than silently truncate evidence.

Rollback: previous builds ignore the additive metadata/artifacts. Retain records for inspection; do not infer that an older build validates them. Writes require an enabled specialist tool or the full profile; the discovery dispatcher does not execute memory/validation writes.

## Local teamwork

Discover `team_status` and `team_task` when coordination is needed. The three-tool lean catalog is unchanged. `team_status` shows dependencies, ready task IDs, ownership, expiry and recent history. `team_task` supports `create`, `update`, `claim`, `renew`, `release`, `block`, `complete` and `handoff`. Claims require an explicit `owner`; individual-file leases expire after five minutes and must be renewed while working. Dependency cycles and incomplete prerequisites reject claims. A same-worktree file conflict fails atomically; overlap in another worktree returns a warning. Leases are advisory and do not prevent external editors from writing.

The SQLite ledger lives under `~/.contextpro/teams`, keyed by canonical Git common directory (canonical root outside Git). `CONTEXTPRO_TEAM_DIR` permits isolated test installations. Expired ownership is reclaimable, with tasks, events and handoff links retained. `handoff_id` links an existing handoff artifact from that worktree. ContextPro never spawns agents or sends messages. To roll back, stop invoking the tools and retain the independent ledger; existing source indexes are unchanged.

Each event retains its task/lease/handoff snapshot in `details`, so a later handoff does not erase earlier references. Inspect a task with `team_status({task_id})`; paginate with `before_event_id: olderEventsBefore` and optional `event_limit` (1–50, default 20). Existing ledgers receive an additive `details` column; old events have empty details and remain readable by previous builds.

## Compiler diagnostics and rename

Discover `compiler_diagnostics({root,files})` for TypeScript/JavaScript or configured Python diagnostics. TypeScript reuses the bounded compiler worker. For Python, set `CONTEXTPRO_PYRIGHT_COMMAND` to an installed `pyright-langserver` executable; ContextPro invokes it with `--stdio`, without shell execution or runtime downloads. Integration tests pin MIT-licensed Pyright `1.1.414`. `CONTEXTPRO_PYTHON_PATH` optionally specifies an interpreter; normal `pyrightconfig.json` / `pyproject.toml` settings, including virtual environments, apply. Python sessions cap at two canonical roots, serialize a bounded queue, use a 1 GiB JavaScript heap limit and expire after 60 idle seconds. Unconfigured Python exact references retain explicitly labelled heuristic/SCIP evidence; configured LSP errors do not silently turn into heuristic success.

For compiler-backed edits, request `rename_preview({root,file,line,column,new_name,max_tokens?})` using one-based positions. Inspect its immutable artifact and then invoke `rename_apply({root,preview_id})`. TS/JS uses compiler rename locations (including alias prefix/suffix edits); Python uses Pyright's prepare/rename operations. Unsupported operations reject. Apply verifies workspace membership, revision and every affected file hash, creates a restore point, and publishes only the previewed edits. Limits are 100 files, 5,000 edits and an 8 MiB artifact. A concurrent outside writer can still cause partial publication; the error identifies completed files and the restore point. Run diagnostics/tests after application: a compiler-generated rename is not proof of behavioral correctness.

The older `rename_symbol` remains an explicitly textual compatibility tool. It is never a silent fallback for `rename_apply`. Rollback: unset Python configuration and stop using the added specialist tools; source restoration uses the returned restore point. Stop the shared service before rebuilding, then restart it with matching build, parser/compiler dependencies, Node ABI and environment. Shared compute remains opt-in.

Python cache identity includes the configured executable, npm Pyright package/server content and version, interpreter setting, relevant configuration and dependency manifests. Installation or manifest changes restart the session. Shared-service compatibility also includes the configured Python installation identity.
