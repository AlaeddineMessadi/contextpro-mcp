# ContextPro

**Find the code. Keep the context small.**

ContextPro gives coding agents the source evidence they need: bounded code slices, symbol contracts, references and reusable task context. It runs locally over MCP, so your agent can explore a repository without repeatedly loading whole files into its conversation.

[Get started](INSTALL.md) · [Agent guide](agent-guide.md) · [Documentation](docs/README.md) · [Contribute](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/CONTRIBUTING.md) · [Security](SECURITY.md)

## Why ContextPro?

- **Read less, learn more.** Find code and retrieve relevant source together. Batch known targets in one call and expand only what the task needs.
- **Follow the binding, not just the name.** TypeScript and JavaScript references use the compiler to distinguish aliases, exports and same-named symbols. Counts, scope and truncation are explicit.
- **Keep the tool catalog small.** The lean profile starts with three tools. Discover additional tools when they become useful.
- **Stay aware of changes.** Worktree-scoped indexes check saved-file drift and reconcile in the background. Responses expose freshness and evidence limits.
- **Carry useful context forward.** Reuse task packets and record durable decisions in project memory. Notes remain evidence to review, not instructions to trust blindly.
- **Use models when they help.** Structural reads work without an embedding service. Add local or hosted embeddings for semantic retrieval.

ContextPro is built for agents that need to inspect code, explain an API, trace references and plan changes. It also leaves room for the simplest useful operation: a native read can be best when the exact small source range is already known.

## Get started

Use **Node.js 24 LTS** and npm. Install from source until a registry release is announced; the version in `package.json` is not proof of a published npm package.

```sh
git clone https://github.com/AlaeddineMessadi/contextpro-mcp.git
cd contextpro-mcp
npm ci
npm run build
node build/index.js doctor --root /absolute/path/to/your-project
node -p 'process.execPath'
```

Use the printed Node executable and your checkout path in the client configuration. For example, in Claude Code's project `.mcp.json`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/contextpro-mcp/build/index.js", "--root", "/absolute/path/to/your-project"],
      "env": { "CONTEXTPRO_TOOL_PROFILE": "lean" }
    }
  }
}
```

Replace every placeholder, add `.contextpro/` to the target project's `.gitignore`, then restart the client. [Installation instructions](INSTALL.md) cover Codex, Claude Code, OpenCode, indexing and native-module recovery. [Project instructions](INSTRUCTIONS.md) teach agents when ContextPro is useful and when to verify with native tools.

## A small interface for real coding work

| Task | Start with | What to check |
| --- | --- | --- |
| Locate unfamiliar code and read evidence | `context(query:...)` | Retrieval is a ranked selection, not an exhaustive search |
| Read several known targets | `context(targets:[...])` | Follow explicit omissions if more evidence is needed |
| Find TS/JS references | `exact_references` | Declared scope, reference kinds and truncation |
| Inspect an exported API | Discover `skeleton`, then use `exported_only:true` | Signatures do not prove behavior |
| Assess a change | Discover `blast_radius` or `validate_scope` | Text matches are candidates; recommended checks still need to run |
| Preserve a decision | Discover `memory_record_task` | Keep supporting evidence and revisit stale assumptions |
| Coordinate local agents | Discover `team_status` / `team_task` | Explicit ownership and advisory file leases; renew every five minutes |
| Inspect compiler errors or rename a binding | Discover `compiler_diagnostics` / `rename_preview` | TS/JS compiler or configured Pyright; inspect before `rename_apply` |
| Record executed checks | `validate_scope`, then discover `validation_record` | Run checks in the coding host; receipts become stale when inputs change |

Tool schemas are the argument reference. See the [agent guide](agent-guide.md) for examples, batching and context reuse.

| Profile | Initial interface |
| --- | --- |
| `lean` | `context`, `exact_references`, `discover_tools` |
| `workflow` (default) | 14 tools for discovery, reads, impact and diagnostics |
| `core` | Common workflows plus editing and graphs |
| `full` | All registered tools, including compatibility aliases |

Set `CONTEXTPRO_TOOL_PROFILE` in the server environment. `discover_tools(enable:[...])` enables tools without executing them. If the client cannot refresh its catalog, use the supported `discover_tools({root,call:{name,arguments}})` dispatcher with the returned expert schema.

Experimental connected retrieval (`CONTEXTPRO_CONNECTED_CONTEXT=true`) combines ranked source, one-hop imports/callers and relevant tests in `context` and `task_pack`. It remains opt-in while task-level performance is evaluated. Discover `feature_brief` for a cached, source-cited feature map; model-written interpretations require a separate opt-in. Query-based `context` packets accept `previous_context_id` while the agent still holds that packet; omit it after context loss. Exact target reads remain stateless. See [configuration and freshness rules](docs/configuration.md).

The optional `context.intent` hint (`lookup`, `change`, `debug`, `review`, `overview`, or `auto`) enables question-aware source and document retrieval for one query. Shared indexing/compiler work is also opt-in through `contextpro daemon start` and `CONTEXTPRO_DAEMON=true`. Evidence-backed memory, immutable handoffs and local task coordination build on the existing SQLite/artifact architecture. [Configuration](docs/configuration.md#experimental-development-context) explains setup, limits and rollback; these features do not establish a measured coding-speed improvement.

## Ask for the source you need

Pass the absolute active repository or worktree as `root` on every call. Query
budgets use `max_tokens` (512–12000, default 4000; estimated UTF-8 bytes divided by
four). Exact batches accept up to six targets.

```js
context({
  root: "/absolute/path/to/project",
  query: "apps/mobile/app/host reports publish controls and disabled state",
  max_tokens: 2500
})
context({
  root: "/absolute/path/to/project",
  targets: [{file: "src/guest/rules/page.tsx"}, {file: "src/guest/identity/page.tsx"}],
  max_tokens: 4000
})
```

Known directory prefixes and route topics help query discovery retain the requested
implementation. A named component or compound error code supplies additional local
text evidence. These are bounded ranking hints, not hard directory filters or
compiler-resolved references; connected dependencies may still come from elsewhere.
For a UI inventory, ask explicitly for an overview. For a bug, name the affected
symbol and source area. Check citations and omissions, then narrow to exact targets
when needed rather than repeating the same broad query.

## Evidence you can inspect

ContextPro distinguishes source evidence, compiler-resolved references, textual candidates and heuristic fallbacks. Parser and TypeScript workers run in bounded child processes so a worker failure can be reported and recovered from without inherently terminating the MCP server.

Freshness checks cover saved files, not unsaved editor buffers. Per-file reconciliation is not an atomic snapshot of a repository being edited concurrently. Reference precision depends on language and scope; configured Python uses Pyright LSP, while unconfigured Python heuristics and imported SCIP data retain their distinct provenance.

Local-first does not mean sandboxed. Tools run with your user permissions. Hosted embedding or chat providers receive the inputs sent to them, and chat-assisted operations are optional. Read the [security model](SECURITY.md) and [provider configuration](docs/configuration.md) before using sensitive repositories.

## Performance: measure completed work

We optimize for useful evidence per call and successful tasks, not just small responses. The [benchmark guide](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/docs/benchmarks/README.md) separates direct tool timings, synthetic retrieval tests, agent runs and estimates.

One [24-query offline reference experiment](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/docs/benchmarks/2026-09-08-reference-evidence.md) passed every query and reduced the larger text response by approximately **12.5%**. Small responses grew approximately **1.2%**, and server latency was essentially unchanged. This is a scoped serialization result, not measured agent token or billing savings.

The [September 26 coding pilot](docs/benchmarks/2026-09-26-connected-evidence.md)
did **not** meet the productivity rollout gate: the baseline passed 1/8 frozen
tasks and the candidate 0/8, with no jointly passing pairs for a valid savings
comparison. Failures, timeouts and an interrupted run limit attribution. Connected
retrieval remains opt-in. Later retrieval regressions verify specific source
coverage; they do not establish faster completed tasks or lower billed tokens.

Comparisons with native tools, Graft, Graphify or Serena should report versions, correctness, cold and warm runs, provider usage and repeated trials. See [how we compare](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/docs/comparison.md). We welcome reproducible results, including tasks where another approach wins.

## Build with us

Useful contributions include small bug reproductions, language fixtures, reference-completeness tests, realistic benchmarks, clearer setup guides and performance fixes with before/after evidence.

```sh
npm run build
npm test
npm run docs:check
npm run release:check
npm run pack:check
```

Start with [CONTRIBUTING.md](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/CONTRIBUTING.md), [open issues](https://github.com/AlaeddineMessadi/contextpro-mcp/issues) or the [roadmap](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/TODO.md). The optional `landing/` website and local [dashboard](docs/dashboard.md) have their own npm lockfiles. [Maintenance](docs/maintenance.md) explains safe cleanup and runtime-specific testing.

For questions, see [support](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/SUPPORT.md). Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Community participation follows our [code of conduct](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/CODE_OF_CONDUCT.md).

## License and origins

ContextPro is an independent evolution of [Context+](https://github.com/ForLoopCodes/contextplus), distributed under the [MIT license](LICENSE). The original ForLoop copyright notice is preserved. See [NOTICE](NOTICE) for attribution. References to other projects do not imply endorsement.
