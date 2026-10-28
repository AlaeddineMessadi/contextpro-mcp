# ContextPro

**Compiler-exact references and bounded source context for coding agents, in a three-tool lean profile.**

ContextPro is a local MCP server for TypeScript and JavaScript repositories. When an agent asks "who calls this?", it answers with the TypeScript compiler instead of a name search: aliases, re-exports and same-named symbols are told apart, and every result states its scope and whether it was truncated. When an agent needs source, it returns budgeted slices instead of whole files.

[Get started](INSTALL.md) · [Agent guide](agent-guide.md) · [Benchmarks](docs/benchmarks/README.md) · [Documentation](docs/README.md) · [Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

## What it is good at

- **Renames and refactors in TS/JS codebases.** `exact_references` resolves bindings with the compiler and reports per-file call totals, reference kinds and truncation, so an agent knows what it has not seen.
- **Parallel agents on one repository.** Indexes are scoped per Git worktree, check saved-file drift and reconcile in the background.
- **A small tool catalog.** The lean profile exposes three of the 68 tools; the rest are discovered only when needed.
- **Inspectable evidence.** Responses separate compiler-resolved references, textual candidates and heuristic fallbacks, and report freshness.

Python references work through a configured Pyright; other languages fall back to structural and textual evidence.

## Honest results

ContextPro has not been shown to make agents finish tasks faster. Our own trials, published in [docs/benchmarks](docs/benchmarks/README.md), include the losses:

| Measured | Result |
| --- | --- |
| Compiler reference checks on two fixtures (barrel aliases, same-named bindings) | 24 of 24 timed queries passed |
| Response size on six retrieval tasks vs a scripted `rg`/`git` baseline | about 41% fewer response tokens, but about 6.8× slower per call |
| Matched agent trials (2 read-only tasks), lean profile vs native tools | **23.8% more** total input, **19.2% more** wall time |
| Matched agent trials (2 read-only tasks), workflow profile vs native tools | **128.7% more** total input |
| Eight paired coding tasks, previous ContextPro build vs connected-retrieval candidate | previous build 1/8, candidate 0/8 (six on private repositories; see connected-evidence report) |

Plain `grep` and file reads are often the cheapest choice when an agent already knows where to look. ContextPro is most useful when binding identity matters or the exact location is unknown. We welcome reproducible comparisons, including ones where another tool wins; see [how we compare](docs/comparison.md).

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

Install the project instructions as well as the server: connecting MCP exposes tools,
while `AGENTS.md` / `CLAUDE.md` teaches the agent when to use them. The detailed
workflow is available on demand through `contextpro://instructions`. A separate
skill is optional; it does not enable tools or repair retrieval.

## A small interface for real coding work

| Task | Start with | What to check |
| --- | --- | --- |
| Locate unfamiliar code and read evidence | `context(query:...)` | Retrieval is a ranked selection, not an exhaustive search |
| Read several known targets | `context(targets:[...])` | Follow explicit omissions if more evidence is needed |
| Find TS/JS references | `exact_references` | Declared scope, reference kinds and truncation |
| Inspect an exported API | Discover `skeleton`, then use `exported_only:true` | Signatures do not prove behavior |
| Assess a change | Discover `blast_radius` or `validate_scope` | Text matches are candidates; recommended checks still need to run |
| Preserve a decision | Discover `memory_record_task` | Keep supporting evidence and revisit stale assumptions |
| Inspect compiler errors or rename a binding | Discover `compiler_diagnostics` / `rename_preview` | TS/JS compiler or configured Pyright; inspect before `rename_apply` |
| Record executed checks | `validate_scope`, then discover `validation_record` | Run checks in the coding host; receipts become stale when inputs change |

Tool schemas are the argument reference. See the [agent guide](agent-guide.md) for examples, batching and context reuse.

| Profile | Initial interface |
| --- | --- |
| `lean` | `context`, `exact_references`, `discover_tools` |
| `workflow` (default) | 14 tools for discovery, reads, impact and validation |
| `core` | 39 tools: common workflows plus editing and graphs |
| `full` | All 68 registered tools, including 5 deprecated aliases |

Set `CONTEXTPRO_TOOL_PROFILE` in the server environment. `discover_tools(enable:[...])` enables tools without executing them. If the client cannot refresh its catalog, use the supported `discover_tools({root,call:{name,arguments}})` dispatcher with the returned expert schema.

Experimental connected retrieval (`CONTEXTPRO_CONNECTED_CONTEXT=true`) combines ranked source, one-hop imports/callers and relevant tests in `context` and `task_pack`. It remains opt-in while task-level performance is evaluated. Discover `feature_brief` for a cached, source-cited feature map; model-written interpretations require a separate opt-in. Query-based `context` packets accept `previous_context_id` while the agent still holds that packet; omit it after context loss. Exact target reads remain stateless. See [configuration and freshness rules](docs/configuration.md).

The optional `context.intent` hint (`lookup`, `change`, `debug`, `review`, `overview`, or `auto`) enables question-aware source and document retrieval for one query. Shared indexing/compiler work is also opt-in through `contextpro daemon start` and `CONTEXTPRO_DAEMON=true`. Evidence-backed memory and handoffs build on the existing SQLite/artifact architecture; experimental features such as local task coordination are documented in configuration. [Configuration](docs/configuration.md#experimental-development-context) explains setup, limits and rollback; these features do not establish a measured coding-speed improvement.

## Ask for the source you need

Pass the absolute active repository or worktree as `root` on every call. Query
budgets use `max_tokens` (512–12000, default 4000; estimated UTF-8 bytes divided by
four). Exact batches accept up to six targets.

This example uses ContextPro's own repository. In another project, use paths and
declaration names observed in its source rather than guessed symbols.

```js
context({
  root: "/absolute/path/to/contextpro-mcp",
  query: "src/core/agent-setup.ts mergeAgentInstructions preserve existing project rules",
  intent: "change",
  max_tokens: 2500
})
context({
  root: "/absolute/path/to/contextpro-mcp",
  targets: [{file: "src/core/agent-setup.ts", symbol: "mergeAgentInstructions"}],
  max_tokens: 1500
})
// Use compiler references when binding identity or cross-file callers matter.
exact_references({
  root: "/absolute/path/to/contextpro-mcp",
  file: "src/core/agent-setup.ts",
  symbol_name: "mergeAgentInstructions",
  limit: 20
})
```

These are task-dependent choices, not a checklist: stop when enough evidence is
available. If a broad query favors documentation, read the discovered source
symbol or a narrow line range directly. If references time out, continue with
bounded source/native tracing and disclose its limits; lowering `limit` changes
the display window, not compiler workspace scope. Read each tool's schema:
`max_tokens` is a `context` budget, not an argument for `status` or `exact_references`.

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

## Build with us

Useful contributions include small bug reproductions, language fixtures, reference-completeness tests, realistic benchmarks, clearer setup guides and performance fixes with before/after evidence.

```sh
npm run build
npm test
npm run docs:check
npm run release:check
npm run pack:check
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md), [open issues](https://github.com/AlaeddineMessadi/contextpro-mcp/issues) or the [roadmap](docs/roadmaps/contextpro-roadmap.md). [Maintenance](docs/maintenance.md) explains safe cleanup and runtime-specific testing.

For questions, see [support](SUPPORT.md). Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Community participation follows our [code of conduct](CODE_OF_CONDUCT.md).

## License and origins

ContextPro began as a fork of [Context+](https://github.com/ForLoopCodes/contextplus) by ForLoop and has since been largely rewritten around compiler-backed references, worktree-scoped indexes and bounded retrieval. Upstream has been quiet since July 2026, so development continues here. It is distributed under the [MIT license](LICENSE). The original ForLoop copyright notice is preserved. See [NOTICE](NOTICE) for attribution. References to other projects do not imply endorsement.
