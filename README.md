# ContextPro

[![npm version](https://img.shields.io/npm/v/contextpro-mcp)](https://www.npmjs.com/package/contextpro-mcp)
[![CI](https://github.com/AlaeddineMessadi/contextpro-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AlaeddineMessadi/contextpro-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/contextpro-mcp)](LICENSE)

**Exact find-all-references for your coding agent on TypeScript/JavaScript repos — answered by the TypeScript compiler, not grep.**

ContextPro is a local [MCP](https://modelcontextprotocol.io) server for agents such as Claude Code, Codex, Cursor and OpenCode. Its compiler-backed "find all references" means a rename or refactor is far less likely to miss callers that import the function under another name or through a re-export (within the files the compiler can check). It also serves source reads with a size limit, so the agent gets the lines it needs instead of whole files. It runs on your machine and needs no API key.

## Quick start

Requirements: Node.js 20–26 (24 LTS recommended). No API key or Ollama needed. For compiler references, install the target project's dependencies first (`npm install`); otherwise files can't be checked.

**Fastest try (Claude Code):**

```sh
cd your-project
claude mcp add contextpro -e CONTEXTPRO_TOOL_PROFILE=lean -- npx -y contextpro-mcp --root "$PWD"
claude mcp list   # contextpro: ... ✔ Connected
```

Keep the server name before `-e`, which would otherwise swallow it.

**Claude Code, whole team** (commits `.mcp.json` plus agent instructions in `AGENTS.md` and `CLAUDE.md`):

```sh
npx -y contextpro-mcp init claude
claude   # start it in the repository root and approve "contextpro" once
```

**Codex:**

```sh
codex mcp add contextpro --env CONTEXTPRO_TOOL_PROFILE=lean -- npx -y contextpro-mcp --root /absolute/path/to/project
```

**Cursor and other clients that read `mcpServers` JSON** (`.cursor/mcp.json` or the client's config file):

```json
{ "mcpServers": { "contextpro": {
    "command": "npx",
    "args": ["-y", "contextpro-mcp", "--root", "/absolute/path/to/project"],
    "env": { "CONTEXTPRO_TOOL_PROFILE": "lean" } } } }
```

**OpenCode:** run `npx -y contextpro-mcp init opencode`, then `opencode mcp list`.

**Try it.** Ask your agent:

- "Use contextpro to find every caller of `<function>` in `<file>`."
- "Use contextpro to show me how `<feature>` works."

[INSTALL.md](INSTALL.md) covers VS Code, team approval, a smoke test that works without any client, running from source and troubleshooting.

## What it is good at

- **Safe renames and refactors.** The compiler tells apart aliased imports, re-exports and different functions that share a name, and the answer says how many results exist and whether any were cut off.
- **Reading just enough source.** The agent asks for a file, a symbol or a line range under a size budget and is told what was left out.
- **Several agents on one repository.** Each Git worktree gets its own index, kept up to date as files change.
- **A small tool list.** The recommended `lean` setup shows the agent three tools (`context`, `exact_references` and `discover_tools`); the other 65 stay hidden until the agent asks for them.

Python references work through a configured Pyright; other languages fall back to structural and text search.

## Honest results

ContextPro has not been shown to make agents finish tasks faster. Our own trials, published in [docs/benchmarks](docs/benchmarks/README.md), include the losses.

It is worth trying for renames and refactors where aliased or re-exported callers matter, or when you don't know where the code lives.

| Measured | Result |
| --- | --- |
| Compiler reference checks on two fixtures (barrel aliases, same-named bindings) | 24 of 24 timed queries passed |
| Response size on six retrieval tasks vs a scripted `rg`/`git` baseline | about 41% fewer response tokens, but about 6.8× slower per call |
| Matched agent trials (2 read-only tasks), lean profile vs native tools | **23.8% more** total input, **19.2% more** wall time |
| Matched agent trials (2 read-only tasks), workflow profile vs native tools | **128.7% more** total input |

For simple lookups, plain grep is cheaper. We welcome reproducible comparisons, including ones where another tool wins; see [how we compare](docs/comparison.md).

## Learn more

- [Install and troubleshoot](INSTALL.md)
- [Agent guide](agent-guide.md): how agents should call the tools, with examples
- [Configuration](docs/configuration.md): tool profiles, providers and environment variables
- [Security model](SECURITY.md): what runs locally and what a hosted provider would see
- [All documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md)

## License and origins

ContextPro began as a fork of [Context+](https://github.com/ForLoopCodes/contextplus) by ForLoop and has since been largely rewritten. It is distributed under the [MIT license](LICENSE); the original ForLoop copyright notice is preserved, see [NOTICE](NOTICE).
