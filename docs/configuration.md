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
hashes, dependency membership and generator/model identity before reuse. Neither
briefs nor deltas imply exhaustive repository coverage. Use `artifact_read` for
full stored packets. Both experts support compatibility dispatch through
`discover_tools`; the lean catalog remains three tools.

Local full-text search stores full source for indexed files, so text beyond the
embedding summary is searchable. This increases the regenerable database size;
embedding inputs and response budgets remain bounded separately. The extraction
stamp automatically rebuilds older summary-only indexes on the next structural
freshness check. Unicode query tokens and phrase matching use that local index.

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

Lexical discovery retains quoted phrases and compound keys, and treats tests and
translation catalogs as secondary evidence unless requested. SQL files participate
in source-text search and freshness checks; SQL binding references and structural
symbol extraction are not provided by this text fallback. Source budgets still
allow omissions, especially for broad questions spanning many modules.

See [installation](../INSTALL.md) for launch examples and [maintenance](maintenance.md) for test/runtime and disk-cleanup guidance.

## Optional benchmark tracing

`CONTEXTPRO_PROVIDER_TRACE_PATH` optionally records local JSONL events containing
provider/model identity, call duration, status and provider-reported input/output
counts. It records no prompts, source or credentials. Missing counts stay null;
local embeddings commonly report input counts without output counts. These
events are separate from the coding agent's usage and are not billing estimates.

Set `CONTEXTPRO_TOOL_TRACE_PATH` to an absolute local JSONL path before starting the server. Tracing is off by default and adds no MCP response text. Each event records tool arguments, status, a session/request ID, total server duration, preparation (root verification/freshness/waits), handler execution and postprocessing. Spans can overlap; their sum is not elapsed agent time.

The trace caps each argument payload at 8 KiB and the file at 64 MiB, redacts common credential/content keys and requires a private regular destination file (created with mode 0600). Query strings and paths can still contain private information; keep raw traces local. Write failures are best-effort and produce a stderr warning. A missing or partial trace is unavailable evidence, not zero execution time. See the [benchmark procedure](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/docs/benchmarks/methodology.md).
