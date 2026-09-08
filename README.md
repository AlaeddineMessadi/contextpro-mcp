# ContextPro MCP

ContextPro gives coding agents bounded repository context: source slices, symbol contracts, references, likely affected files and reusable task packets. It runs locally over MCP stdio, stores each worktree's index in SQLite, and supports optional embeddings for semantic retrieval.

This is a private evolution of [Context+](https://github.com/ForLoopCodes/contextplus). The checkout includes unreleased improvements from [PR #9](https://github.com/AlaeddineMessadi/contextpro-mcp/pull/9). The `1.3.0` package version is metadata; it does not establish that this checkout has been published to a registry.

## Start here

- [Install and connect clients](INSTALL.md): local build, Codex, Claude Code, OpenCode, native-module repair.
- [Agent guide](agent-guide.md): choose the smallest useful call, verify evidence and avoid repeated context.
- [Configuration](docs/configuration.md): profiles, providers, indexing and runtime settings.
- [Current status](STATUS.md) and [next work](TODO.md).
- [Documentation index](docs/README.md): architecture, maintenance, benchmarks and historical records.

## Build and run

Use Node.js 20–26 and npm. Keep the same Node executable for installation and launching when possible.

```sh
git clone https://github.com/AlaeddineMessadi/contextpro-mcp.git
cd contextpro-mcp
npm ci
npm run build
node build/index.js doctor --root /absolute/path/to/target-project
```

Configure the client with an absolute Node executable, this checkout's `build/index.js`, and the target project's root. See [client examples](INSTALL.md#client-configuration). An already running MCP process needs a restart to load a new build. Checking out or merging a branch does not update an existing process.

An embedding endpoint is optional for structural reads and keyword retrieval. For local semantic search, start Ollama and install the model selected in your configuration. Source sent to a hosted embedding or chat endpoint leaves the machine. The MCP's provider settings are separate from the coding agent's account.

## Choose a tool profile

| Profile | Initial catalog | Use |
| --- | --- | --- |
| `workflow` (default) | 14 tools | Discovery, source reads, impact, validation and diagnostics |
| `lean` | `context`, `exact_references`, `discover_tools` | Minimal advertised catalog and batched source retrieval |
| `core` | Common workflows plus editing/graphs | More operations available immediately |
| `full` | All registered tools and compatibility aliases | Clients that cannot refresh discovered tools |

Set `CONTEXTPRO_TOOL_PROFILE` in the MCP process environment. `discover_tools` can enable expert tools during a session; enabling a tool does not run it.

## Useful operations

| Need | Operation | Evidence limits |
| --- | --- | --- |
| Find unfamiliar code and read it together | `context(query:...)` in lean/full, or `task_pack` / `search` | Ranked selection can omit relevant files |
| Read known targets together | `context(targets:[...])` or batched `explain` | Omissions are explicit; expand if needed |
| Inspect the public API | `skeleton(exported_only:true)` for TS/JS | Signatures are not behavioral proof |
| Find references before a change | `exact_references` | Compiler-backed TS/JS within declared scope; imported SCIP and Python heuristics have different provenance |
| Find textual usage candidates | `blast_radius` | Matching lines and names, not binding-resolved calls |
| Plan checks | `validate_scope`, `change_impact`, `test_impact` | Recommendations; run actual tests/compiler checks |
| Reuse task context | `task_pack(previous_context_id:...)`, `artifact_read` | Reuse a baseline only while the client still holds it |
| Keep durable decisions | `memory_record_task` and memory tools | Retrieved notes require evidence review; automatic evidence validation is future work |
| Inspect efficiency | `efficiency_report` when requested | Full-file comparison estimates, not measured billing |

For a tiny known source range, a native read may be fastest. Do not force a fixed sequence of MCP calls for every task. Tool schemas and the [agent guide](agent-guide.md) document arguments; use discovery rather than loading a large catalog into each prompt.

## Freshness and failure handling

Graph-backed reads check source drift and repair changes. Background reconciliation continues if file watching fails. Schema v7 uses size, modification time and change time as fast fingerprints; explicit hash refresh is also available. Hashing and parsing share a verified source read. This is per-file consistency, not an atomic snapshot of a continuously edited repository or unsaved editor buffers.

Parser and TypeScript compiler work run in bounded child processes. Worker failures reject the affected request and allow recovery without inherently terminating MCP. Structural fallbacks have reduced precision. Syntax-checked edits fail closed if the required parser is unavailable. Cold compilation and whole-machine resource pressure remain limitations.

Interactive search reuses existing corpus vectors. A missing or timed-out embedding request can fall back to keyword ranking; use `preset:"keyword_only"` when no query-provider call is wanted. Reindex after an embedding-model change. See [configuration and recovery](docs/configuration.md).

## Measurements

All **644 main tests passed on Node 24 and Node 26** for the reference/freshness implementation. A direct app-a replay found **13 call expressions**, three imports and one definition. Cold compiler setup took **12.743 seconds**; repeated calls took **0.675–0.738 seconds**.

Those are direct tool measurements, not end-to-end agent savings or a universal performance guarantee. [Benchmark records](docs/benchmarks/README.md) distinguish synthetic retrieval, provider-usage trials, manual estimates and incident replays. Savings depend on the task, model, cache behavior and successful completion; small outputs alone do not prove cheaper agent work.

## Development and maintenance

```sh
npm run build
npm test
npm run docs:check
npm pack --dry-run
```

See [maintenance](docs/maintenance.md) for runtime-specific test caches, optional demo/provider tests, cleanup boundaries and documentation generation. `landing/` is an optional website; `dashboard/` is a local operator app. Neither is required to run MCP.

## License

[MIT](LICENSE). Preserve upstream attribution when redistributing derivatives.
