# ContextPro MCP

Standalone code intelligence MCP for coding agents.

ContextPro helps AI coding agents work across real projects with less token waste and fewer blind edits. It combines semantic search, Tree-sitter AST indexing, exact TypeScript/JavaScript references, optional SCIP evidence, reusable task artifacts, project memory, safe restore points, and graph-based impact analysis so agents can plan, edit, and validate without reading every file.

ContextPro is a private fork and expanded evolution of [Context+](https://github.com/ForLoopCodes/contextplus), with additional agentic planning, graph intelligence, project isolation, packaging, safety, and workflow features layered on top.

https://github.com/user-attachments/assets/a97a451f-c9b4-468d-b036-15b65fc13e79

## Tools

### Primary Agent Workflows

Use these first. They wrap lower-level discovery and analysis into compact packets so agents do not need to read or search the whole repository.

| Tool         | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `start_task` | Primary entry point. Returns ranked files, tests, recent diffs, project memory, freshness, risks, and artifact IDs. |
| `plan_edit`  | Finds the smallest likely safe edit set before reading or changing files.                                        |
| `impact`     | Estimates what could break for files or symbols, including related files, tests, churn, and reasons.             |
| `validate`   | Recommends the smallest relevant validation commands for the planned or completed edit scope.                    |
| `remember`   | Records task outcomes, linked files, assumptions, evidence, and open risks for future sessions.                  |

### Discovery

| Tool             | Description                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`         | Startup health for the active repo, including project identity, Node ABI, native storage readiness, and database openability.                                    |
| `artifact_list`  | List recent reusable context artifacts generated for this project so agents can reuse prior repo maps, searches, and task packets.                               |
| `artifact_read`  | Load a previously generated context artifact by ID instead of regenerating the same context packet.                                                              |
| `repo_map`       | Compact whole-repo outline with important files and top-level symbols. Designed to give agents first-turn orientation with low token usage.                      |
| `graph_export`   | Export `.contextplus/graph.json`, `.contextplus/GRAPH_REPORT.md`, and `.contextplus/graph-dashboard.html` for portable project intelligence.                    |
| `graph_query`    | Query graph summary, file neighborhoods, symbol neighborhoods, and impact views without reading source files.                                                    |
| `tree`           | Structural AST tree of a project with file headers and symbol ranges (line numbers for functions/classes/methods). Dynamic pruning shrinks output automatically.  |
| `skeleton`       | Function signatures, class methods, and type definitions with line ranges, without reading full bodies. Shows the API surface.                                    |
| `search`         | Search by meaning with modes and presets. Uses embeddings when available plus SQLite FTS5/BM25 fallback over indexed paths, headers, signatures, and symbols.    |
| `resolve_symbol` | Resolve an identifier to the most likely definition with ambiguity scoring and file-context-aware ranking.                                                        |
| `exact_references` | Find exact references with the local TypeScript/JavaScript language service or an imported SCIP JSON index.                                                    |
| `scip_import`    | Normalize a project-provided SCIP JSON index into `.contextplus/scip-index.json` for exact cross-language graph/reference evidence.                              |
| `scip_status`    | Report whether the project has imported SCIP evidence available.                                                                                                |
| `cluster`        | Browse codebase by meaning using spectral clustering. Groups semantically related files into labeled clusters.                                                    |

### Analysis

| Tool              | Description                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `blast_radius`    | Trace every file and line where a symbol is used. Uses the SQLite call_sites index first, then import graph scoping, then full scan as fallback. |
| `status`          | Project overview dashboard with repo identity, index generations, memory graph stats, git state, and recent per-tool timing stats. |
| `diff`            | Structured git diff summary with changed files, line counts, and affected symbols.                                               |
| `related`         | Show related files via imports, importers, sibling files, tests, and hubs.                                                       |
| `test_map`        | Map a source file or symbol to likely tests via import graph and naming conventions.                                              |
| `explain`         | Extract one symbol body and its immediate call dependencies without loading an entire file.                                       |
| `reindex`         | Re-walk and re-parse project files after git pull, branch switch, or external edits. Detects changed files via content hash.     |
| `task_pack`       | Assemble the minimum useful working set for a task: ranked files, tests, diffs, memory, risks, and reusable artifact ids.        |
| `change_impact`   | Estimate what could break if files or symbols change, using resolver-aware evidence, related files, tests, churn, and reasons.   |
| `impact_delta`    | Compare a saved graph export with the current indexed graph after edits to show actual structural changes.                       |
| `edit_scope`      | Identify the smallest likely safe edit set for a task, with confidence and artifact ids in JSON mode.                            |
| `decision_brief`  | Compress a subsystem into a short decision-oriented brief with ranked files, symbols, tests, hubs, memory, and artifact ids.     |
| `validate_scope`  | Recommend the most relevant validation checks and commands for a set of scoped files.                                             |
| `lint`            | Auto-detects and runs project linters (tsc, eslint, ruff, cargo check, go vet). Plus skill score checking for code quality.      |

### Code Ops

| Tool         | Description                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `checkpoint` | Save code with validation. Checks 2-line headers, no inline comments, nesting depth, file length. Creates a shadow restore point before writing. |
| `hub`        | Feature hub navigator. Hubs are `.md` files with `[[wikilinks]]` that map features to code files. Auto-generates hubs from import graph. |

### Version Control

| Tool          | Description                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `checkpoints` | List all shadow restore points created by `checkpoint`. Each captures file state before changes.             |
| `restore`     | Restore files to their state before a specific change. Uses shadow restore points. Does not affect git.      |

### Memory & RAG

| Tool                 | Description                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `memory_create`      | Create or update a memory node (concept, file, symbol, note) with auto-generated embeddings.                          |
| `memory_link`        | Create typed edges between nodes: `relates_to`, `depends_on`, `implements`, `references`, `similar_to`, `contains`, `resolved_by`, `contradicts`. |
| `memory_search`      | Semantic search with graph traversal — finds direct matches then walks neighbors.                                     |
| `memory_bulk`        | Bulk-add nodes with auto-similarity linking (cosine ≥ 0.72 creates edges automatically).                              |
| `memory_explore`     | Start from a node and walk outward — returns all reachable neighbors scored by decay and depth.                        |
| `memory_list`        | List all memory nodes filtered by scope and kind. Use to audit the graph or find node IDs.                            |
| `memory_delete`      | Delete a specific memory node and all its edges by ID.                                                                |
| `memory_record_task` | Persist task outcomes with linked files, assumptions, evidence, and open risks.                                       |
| `workspace_context`  | List registered projects and recent sessions without merging raw code context.                                        |
| `promote_pattern`    | Promote project memory into client/global reusable patterns.                                                          |

> **Complementary server:** [pmll-memory-mcp](https://www.npmjs.com/package/pmll-memory-mcp) (`npx pmll-memory-mcp`) is a separate MCP server by [@drQedwards](https://github.com/drQedwards) that adapts Context+'s long-term memory graph and adds short-term KV context memory, Q-promise deduplication, and a solution engine on top. See [drQedwards/PPM](https://github.com/drQedwards/PPM) for details.

## Setup

### Quick Start (npx / bunx)

No installation needed. Add ContextPro to your IDE MCP config.

For Claude Code, Cursor, and Windsurf, use `mcpServers`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "bunx",
      "args": ["contextpro-mcp"],
      "env": {
        "OLLAMA_EMBED_MODEL": "nomic-embed-text",
        "OLLAMA_CHAT_MODEL": "gemma2:27b",
        "OLLAMA_API_KEY": "YOUR_OLLAMA_API_KEY"
      }
    }
  }
}
```

For VS Code (`.vscode/mcp.json`), use `servers` and `inputs`:

```json
{
  "servers": {
    "contextpro": {
      "type": "stdio",
      "command": "bunx",
      "args": ["contextpro-mcp"],
      "env": {
        "OLLAMA_EMBED_MODEL": "nomic-embed-text",
        "OLLAMA_CHAT_MODEL": "gemma2:27b",
        "OLLAMA_API_KEY": "YOUR_OLLAMA_API_KEY"
      }
    }
  },
  "inputs": []
}
```

If you prefer `npx`, use:

- `"command": "npx"`
- `"args": ["-y", "contextpro-mcp"]`

Or generate the MCP config file directly in your current directory:

```bash
npx -y contextpro-mcp init claude
bunx contextpro-mcp init cursor
npx -y contextpro-mcp init opencode
```

Supported coding agent names: `claude`, `cursor`, `vscode`, `windsurf`, `opencode`.

Config file locations:

| IDE         | Config File          |
| ----------- | -------------------- |
| Claude Code | `.mcp.json`          |
| Cursor      | `.cursor/mcp.json`   |
| VS Code     | `.vscode/mcp.json`   |
| Windsurf    | `.windsurf/mcp.json` |
| OpenCode    | `opencode.json`      |

### CLI Subcommands

- `init [target]` - Generate MCP configuration and scaffold `.contextplus/` directory with `config.json`.
- `doctor [path] [--fix]` - Print startup/storage diagnostics for a repo and optionally repair native dependencies with the active Node runtime.
- `skeleton [path]` or `tree [path]` - View the structural tree of a project with file headers and symbol definitions directly in your terminal.
- `--root <path>` or `[path]` - Start the MCP server (stdio) for the specified project root. If omitted, ContextPro falls back to `process.cwd()`.

On MCP startup, ContextPro automatically tries to repair `better-sqlite3` / `sqlite-vec` when it detects a repairable native load failure for the active Node runtime. Set `CONTEXTPLUS_NATIVE_AUTO_REPAIR=false` to disable that behavior.
If `process.cwd()` resolves to `/` or a home-level directory, ContextPro now refuses to start unless you pass `--root <project-path>` (or a positional project path) or set `CONTEXTPLUS_ALLOW_UNSAFE_ROOT=true`.

### From Source

```bash
npm install
npm run build
```

Use this when you want an MCP client to run a local checkout instead of the published `npx` / `bunx` package.

### Local MCP From Source

1. Install dependencies and build the generated server entrypoint:

```bash
cd /absolute/path/to/contextpro-mcp
npm install
npm run build
```

2. Add the built server to your MCP config. For Claude Code, Cursor, Windsurf, Antigravity, and other clients that use `mcpServers`, use an absolute path to `build/index.js`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "node",
      "args": [
        "/absolute/path/to/contextpro-mcp/build/index.js",
        "--root",
        "/absolute/path/to/your/project"
      ],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text",
        "CONTEXTPLUS_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

For VS Code (`.vscode/mcp.json`), use the same command and args inside `servers`:

```json
{
  "servers": {
    "contextpro": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/contextpro-mcp/build/index.js",
        "--root",
        "/absolute/path/to/your/project"
      ],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text",
        "CONTEXTPLUS_EMBED_TRACKER": "lazy"
      }
    }
  },
  "inputs": []
}
```

For Codex `~/.codex/config.toml`:

```toml
[mcp_servers.contextpro]
command = "node"
args = ["/absolute/path/to/contextpro-mcp/build/index.js"]

[mcp_servers.contextpro.env]
CONTEXTPLUS_EMBED_PROVIDER = "ollama"
OLLAMA_EMBED_MODEL = "nomic-embed-text"
CONTEXTPLUS_EMBED_TRACKER = "lazy"
```

`build/index.js` is generated by `npm run build` and is intentionally ignored by git. If a client reports `Cannot find module '/.../build/index.js'` or `calling "initialize": EOF`, run `npm install && npm run build` in this repository, then restart or reload the MCP client.

Verify a local source build before restarting the client:

```bash
node /absolute/path/to/contextpro-mcp/build/index.js doctor --root /absolute/path/to/your/project
```

## Embedding Providers

ContextPro supports two embedding backends controlled by `CONTEXTPLUS_EMBED_PROVIDER`:

| Provider | Value | Requires | Best For |
|----------|-------|----------|----------|
| **Ollama** (default) | `ollama` | Local Ollama server | Free, offline, private |
| **OpenAI-compatible** | `openai` | API key | Gemini (free tier), OpenAI, Groq, vLLM |

### Ollama (Default)

No extra configuration needed. Just run Ollama with an embedding model:

```bash
ollama pull nomic-embed-text
ollama serve
```

### Google Gemini (Free Tier)

Full Claude Code `.mcp.json` example:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "CONTEXTPLUS_OPENAI_API_KEY": "YOUR_GEMINI_API_KEY",
        "CONTEXTPLUS_OPENAI_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
        "CONTEXTPLUS_OPENAI_EMBED_MODEL": "text-embedding-004"
      }
    }
  }
}
```

Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).

### OpenAI

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_EMBED_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

### Other OpenAI-compatible APIs (Groq, vLLM, LiteLLM)

Any endpoint implementing the [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings) works:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "CONTEXTPLUS_OPENAI_API_KEY": "YOUR_KEY",
        "CONTEXTPLUS_OPENAI_BASE_URL": "https://your-proxy.example.com/v1",
        "CONTEXTPLUS_OPENAI_EMBED_MODEL": "your-model-name"
      }
    }
  }
}
```

> **Note:** The `cluster` tool uses a chat model for cluster labeling. When using the `openai` provider, set `CONTEXTPLUS_OPENAI_CHAT_MODEL` (default: `gpt-4o-mini`).
>
> For VS Code, Cursor, or OpenCode, use the same `env` block inside your IDE's MCP config format (see [Config file locations](#setup) table above).

## Architecture

Three layers built with TypeScript over stdio using the Model Context Protocol SDK:

**Core** (`src/core/`) - Multi-language AST parsing (tree-sitter, 43 extensions), nested gitignore-aware traversal with `.contextplusignore` support, multi-provider vector embeddings with parallel batching, SQLite + sqlite-vec storage with schema migrations, SQLite FTS5/BM25 file search, wikilink hub graph, project-scoped memory graph with decay scoring, import/call-site extraction, portable project graph export, and optional SCIP JSON normalization for exact cross-language evidence.

**Git** (`src/git/`) - Shadow restore point system for undo without touching git history.

**Tools** (`src/tools/`) - 48 MCP tools exposing startup diagnostics, structural discovery, graph export/query, exact references, task planning, reusable artifacts, operational memory, and change analysis. Agent-facing JSON tools include repo identity, freshness, confidence, evidence, ambiguities, and stable artifact IDs for reuse across turns.

**Data** (`.contextplus/`) - Project-scoped directory created on startup. Contains `index.db` (SQLite with vector search, FTS5 file search, file index, symbol index, import graph, call-site index), `config.json`, `artifacts/` (reusable JSON context packets), `hubs/` (auto-generated feature hubs), `backups/` (shadow restore points), optional `scip-index.json`, and exported graph artifacts (`graph.json`, `GRAPH_REPORT.md`, `graph-dashboard.html`). Each project gets its own isolated `.contextplus/` directory — no cross-project data sharing.

## Best Practices

### Agent Startup

Always begin implementation work with `start_task`. It wraps project status, ranked files, likely tests, memory hits, recent diffs, and reusable artifacts into one compact packet.

```
1. start_task    → ranked files, tests, memory hits, recent diffs, risks
2. artifact_list → check whether a fresh task pack, graph export, or repo map already exists
3. graph_query   → inspect neighborhoods or impact paths without reading source files
```

### Before Editing

Run `plan_edit` before changing files. It gives the smallest likely edit set, related tests, and confidence without making the agent explore the repository manually.

Run `skeleton` on any file before reading it in full. Signatures and line ranges are usually enough to make targeted edits. Only read full bodies when the logic isn't clear from the signature.

Run `exact_references` or `blast_radius` before renaming or deleting any symbol. `exact_references` uses the TypeScript/JavaScript language service when available and falls back to imported SCIP evidence for other languages.

### After Editing

Run `impact_delta` after edits when you exported a graph before editing. It compares the saved graph with the current indexed graph so agents can see what changed structurally.

Run `validate` after every edit. It recommends focused project checks. Use `lint` when you want the raw auto-detected validators (tsc, eslint, ruff, cargo check, go vet) and code quality checks.

### Keeping the Index Fresh

Run `reindex` after:
- `git pull` or branch switch
- Large external edits (file generation, scaffolding, etc.)
- Any time `status` shows stale files

For small in-session edits, the index auto-patches via `quickRefresh` on the next search call (up to `CONTEXTPLUS_QUICKREFRESH_MAX_FILES` files, default 30).

### Exact Cross-Language References

For TypeScript and JavaScript projects, `exact_references` uses the local TypeScript language service and marks results as `LSP_RESOLVED`.

For other languages, generate a SCIP JSON index with the project's preferred indexer, write it inside the project, then call the MCP tool:

```
scip_import({ "index_path": ".contextplus/index.scip.json" })
```

Imported SCIP facts are cached at `.contextplus/scip-index.json` and reused by `graph_export`, `graph_query`, and `exact_references` with `SCIP_RESOLVED` confidence.

### Memory Graph

Use `memory_record_task` at the end of significant work sessions. It persists outcomes, linked files, assumptions, and open risks — future sessions can retrieve this with `memory_search` instead of re-exploring the same code.

Use `memory_link` to express relationships between concepts and files:
- `resolved_by` — link a bug or question node to the file/symbol that resolved it
- `contradicts` — flag conflicting decisions or assumptions
- `depends_on` — track architectural dependencies not visible in imports

### Token Efficiency

- `skeleton` before `read` — saves reading bodies you won't need
- `artifact_list` + `artifact_read` before `task_pack` or `repo_map` — reuse cached context from prior turns
- `explain` instead of reading a whole file when you only need one function body
- `search` with `mode: identifier` to find call chains and definitions in one shot

## Config

| Variable                                | Type                       | Default                              | Description                                                          |
| --------------------------------------- | -------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `CONTEXTPLUS_EMBED_PROVIDER`            | string                     | `ollama`                             | Embedding backend: `ollama` or `openai`                              |
| `OLLAMA_EMBED_MODEL`                    | string                     | `nomic-embed-text`                   | Ollama embedding model                                               |
| `OLLAMA_API_KEY`                        | string                     | -                                    | Ollama Cloud API key                                                 |
| `OLLAMA_CHAT_MODEL`                     | string                     | `llama3.2`                           | Ollama chat model for cluster labeling                               |
| `CONTEXTPLUS_OPENAI_API_KEY`            | string                     | -                                    | API key for OpenAI-compatible provider (alias: `OPENAI_API_KEY`)     |
| `CONTEXTPLUS_OPENAI_BASE_URL`           | string                     | `https://api.openai.com/v1`          | OpenAI-compatible endpoint URL (alias: `OPENAI_BASE_URL`)            |
| `CONTEXTPLUS_OPENAI_EMBED_MODEL`        | string                     | `text-embedding-3-small`             | OpenAI-compatible embedding model (alias: `OPENAI_EMBED_MODEL`)      |
| `CONTEXTPLUS_OPENAI_CHAT_MODEL`         | string                     | `gpt-4o-mini`                        | OpenAI-compatible chat model for labeling (alias: `OPENAI_CHAT_MODEL`) |
| `CONTEXTPLUS_EMBED_BATCH_SIZE`          | string (parsed as number)  | `8`                                  | Embedding batch size per GPU call, clamped to 5–10                   |
| `CONTEXTPLUS_EMBED_CHUNK_CHARS`         | string (parsed as number)  | `2000`                               | Per-chunk chars before merge, clamped to 256–8000                    |
| `CONTEXTPLUS_MAX_EMBED_FILE_SIZE`       | string (parsed as number)  | `51200`                              | Skip non-code text files larger than this many bytes                 |
| `CONTEXTPLUS_EMBED_NUM_GPU`             | string (parsed as number)  | -                                    | Optional Ollama embed runtime `num_gpu` override                     |
| `CONTEXTPLUS_EMBED_MAIN_GPU`            | string (parsed as number)  | -                                    | Optional Ollama embed runtime `main_gpu` override                    |
| `CONTEXTPLUS_EMBED_NUM_THREAD`          | string (parsed as number)  | -                                    | Optional Ollama embed runtime `num_thread` override                  |
| `CONTEXTPLUS_EMBED_NUM_BATCH`           | string (parsed as number)  | -                                    | Optional Ollama embed runtime `num_batch` override                   |
| `CONTEXTPLUS_EMBED_NUM_CTX`             | string (parsed as number)  | -                                    | Optional Ollama embed runtime `num_ctx` override                     |
| `CONTEXTPLUS_EMBED_LOW_VRAM`            | string (parsed as boolean) | -                                    | Optional Ollama embed runtime `low_vram` override                    |
| `CONTEXTPLUS_EMBED_TRACKER`             | string                     | `lazy`                               | Embedding tracker mode: `lazy`, `eager`, or `off`                   |
| `CONTEXTPLUS_EMBED_TRACKER_MAX_FILES`   | string (parsed as number)  | `8`                                  | Max changed files processed per tracker tick, clamped to 5–10        |
| `CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS` | string (parsed as number)  | `700`                                | Debounce window before tracker refresh                               |
| `CONTEXTPLUS_QUICKREFRESH_MAX_FILES`    | string (parsed as number)  | `30`                                 | Max stale files auto-patched per search call before warning          |
| `CONTEXTPLUS_NATIVE_AUTO_REPAIR`        | string (parsed as boolean) | `true`                               | Auto-rebuild/install native SQLite bindings for the active Node ABI  |
| `CONTEXTPLUS_ALLOW_UNSAFE_ROOT`         | string (parsed as boolean) | `false`                              | Allow cwd fallback from `/` or home-level directories                |
| `CONTEXTPLUS_SESSION_ID`                | string                     | -                                    | Session identifier for session-scoped memory isolation               |
| `CONTEXTPLUS_SESSION_SOURCE`            | string                     | `mcp`                                | Session source tag stored in memory node metadata                    |

## Test

```bash
npm test
npm run test:demo
npm run test:all
```
