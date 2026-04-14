# Context+

Semantic Intelligence for Large-Scale Engineering.

Context+ is an MCP server designed for developers who demand 99% accuracy. By combining RAG, Tree-sitter AST, Spectral Clustering, and Obsidian-style linking, Context+ turns a massive codebase into a searchable, hierarchical feature graph.

https://github.com/user-attachments/assets/a97a451f-c9b4-468d-b036-15b65fc13e79

## Tools

### Discovery

| Tool        | Description                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`    | Startup health for the active repo, including project identity, Node ABI, native storage readiness, and database openability.                                   |
| `artifact_list` | List recent reusable context artifacts generated for this project so agents can reuse prior repo maps, searches, and task packets.                         |
| `artifact_read` | Load a previously generated context artifact by ID instead of regenerating the same context packet.                                                        |
| `repo_map`  | Compact whole-repo outline with important files and top-level symbols. Designed to give agents first-turn orientation with low token usage.                     |
| `tree`      | Structural AST tree of a project with file headers and symbol ranges (line numbers for functions/classes/methods). Dynamic pruning shrinks output automatically. |
| `skeleton`  | Function signatures, class methods, and type definitions with line ranges, without reading full bodies. Shows the API surface.                                   |
| `search`    | Search by meaning with modes: `file` (headers/symbols), `identifier` (functions/classes with call chains), or `hybrid` (both). Uses embeddings + keyword scoring and returns trust/freshness metadata in JSON mode. |
| `resolve_symbol` | Resolve an identifier to the most likely definition with ambiguity scoring and file-context-aware ranking.                                                |
| `cluster`   | Browse codebase by meaning using spectral clustering. Groups semantically related files into labeled clusters.                                                   |

### Analysis

| Tool           | Description                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `blast_radius` | Trace every file and line where a symbol is imported or used. Prevents orphaned references.                                      |
| `status`       | Project overview dashboard with repo identity, index generations, memory graph stats, git state, and recent per-tool timing stats. |
| `diff`         | Structured git diff summary with changed files, line counts, and affected symbols.                                               |
| `related`      | Show related files via imports, importers, sibling files, tests, and hubs.                                                      |
| `test_map`     | Map a source file or symbol to likely tests.                                                                                     |
| `explain`      | Extract one symbol body and its immediate call dependencies without loading an entire file.                                      |
| `task_pack`    | Assemble the minimum useful working set for a task: ranked files, tests, diffs, memory, risks, and reusable artifact ids.      |
| `change_impact`| Estimate what could break if files or symbols change, using resolver-aware evidence, related files, tests, churn, and reasons. |
| `edit_scope`   | Identify the smallest likely safe edit set for a task, with confidence and artifact ids in JSON mode.                           |
| `decision_brief` | Compress a subsystem into a short decision-oriented brief with ranked files, symbols, tests, hubs, memory, and artifact ids. |
| `lint`         | Auto-detects and runs project linters (tsc, eslint, ruff, cargo check, go vet). Plus skill score checking for code quality.      |

### Code Ops

| Tool         | Description                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `checkpoint` | Save code with validation. Checks 2-line headers, no inline comments, nesting depth, file length. Creates a shadow restore point before writing. |
| `hub`        | Feature hub navigator. Hubs are `.md` files with `[[wikilinks]]` that map features to code files. Auto-generates hubs from import graph. |

### Version Control

| Tool          | Description                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `checkpoints` | List all shadow restore points created by `checkpoint`. Each captures file state before changes.            |
| `restore`     | Restore files to their state before a specific change. Uses shadow restore points. Does not affect git.     |

### Memory & RAG

| Tool              | Description                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `memory_create`   | Create or update a memory node (concept, file, symbol, note) with auto-generated embeddings.             |
| `memory_link`     | Create typed edges between nodes (relates_to, depends_on, implements, references, similar_to, contains). |
| `memory_search`   | Semantic search with graph traversal — finds direct matches then walks neighbors.                        |
| `memory_bulk`     | Bulk-add nodes with auto-similarity linking (cosine ≥ 0.72 creates edges automatically).                 |
| `memory_explore`  | Start from a node and walk outward — returns all reachable neighbors scored by decay and depth.           |
| `memory_record_task` | Persist task outcomes with linked files, assumptions, evidence, and open risks.                       |
| `workspace_context` | List registered projects and recent sessions without merging raw code context.                          |
| `promote_pattern` | Promote project memory into client/global reusable patterns.                                             |

## Setup

### Quick Start (npx / bunx)

No installation needed. Add Context+ to your IDE MCP config.

For Claude Code, Cursor, and Windsurf, use `mcpServers`:

```json
{
  "mcpServers": {
    "contextplus": {
      "command": "bunx",
      "args": ["contextplus"],
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
    "contextplus": {
      "type": "stdio",
      "command": "bunx",
      "args": ["contextplus"],
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
- `"args": ["-y", "contextplus"]`

Or generate the MCP config file directly in your current directory:

```bash
npx -y contextplus init claude
bunx contextplus init cursor
npx -y contextplus init opencode
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
- `[path]` - Start the MCP server (stdio) for the specified path (defaults to current directory).

### From Source

```bash
npm install
npm run build
```

## Embedding Providers

Context+ supports two embedding backends controlled by `CONTEXTPLUS_EMBED_PROVIDER`:

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
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
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
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
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
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
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

**Core** (`src/core/`) - Multi-language AST parsing (tree-sitter, 43 extensions), nested gitignore-aware traversal with `.contextplusignore` support, multi-provider vector embeddings with parallel batching, SQLite + sqlite-vec storage, wikilink hub graph, in-memory property graph with decay scoring, import extraction for dependency graphs.

**Git** (`src/git/`) - Shadow restore point system for undo without touching git history.

**Tools** (`src/tools/`) - 33 MCP tools exposing startup diagnostics, structural discovery, task planning, reusable artifacts, operational memory, and change analysis.
Agent-facing JSON tools include repo identity, freshness, confidence, evidence, ambiguities, and stable artifact IDs for reuse across turns.

**Data** (`.contextplus/`) - Project-scoped directory created on startup. Contains `index.db` (SQLite with vector search), `config.json`, `artifacts/` (reusable JSON context packets), `hubs/` (auto-generated feature hubs), and `backups/` (shadow restore points). Each project gets its own isolated `.contextplus/` directory — no cross-project data sharing.

## Config

| Variable                                | Type                      | Default                                | Description                                                   |
| --------------------------------------- | ------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `CONTEXTPLUS_EMBED_PROVIDER`            | string                    | `ollama`                               | Embedding backend: `ollama` or `openai`                      |
| `OLLAMA_EMBED_MODEL`                    | string                    | `nomic-embed-text`                     | Ollama embedding model                                        |
| `OLLAMA_API_KEY`                        | string                    | -                                      | Ollama Cloud API key                                          |
| `OLLAMA_CHAT_MODEL`                     | string                    | `llama3.2`                             | Ollama chat model for cluster labeling                        |
| `CONTEXTPLUS_OPENAI_API_KEY`            | string                    | -                                      | API key for OpenAI-compatible provider (alias: `OPENAI_API_KEY`) |
| `CONTEXTPLUS_OPENAI_BASE_URL`           | string                    | `https://api.openai.com/v1`            | OpenAI-compatible endpoint URL (alias: `OPENAI_BASE_URL`)    |
| `CONTEXTPLUS_OPENAI_EMBED_MODEL`        | string                    | `text-embedding-3-small`               | OpenAI-compatible embedding model (alias: `OPENAI_EMBED_MODEL`) |
| `CONTEXTPLUS_OPENAI_CHAT_MODEL`         | string                    | `gpt-4o-mini`                          | OpenAI-compatible chat model for labeling (alias: `OPENAI_CHAT_MODEL`) |
| `CONTEXTPLUS_EMBED_BATCH_SIZE`          | string (parsed as number) | `8`                | Embedding batch size per GPU call, clamped to 5-10            |
| `CONTEXTPLUS_EMBED_CHUNK_CHARS`         | string (parsed as number) | `2000`             | Per-chunk chars before merge, clamped to 256-8000             |
| `CONTEXTPLUS_MAX_EMBED_FILE_SIZE`       | string (parsed as number) | `51200`            | Skip non-code text files larger than this many bytes          |
| `CONTEXTPLUS_EMBED_NUM_GPU`             | string (parsed as number) | -                  | Optional Ollama embed runtime `num_gpu` override              |
| `CONTEXTPLUS_EMBED_MAIN_GPU`            | string (parsed as number) | -                  | Optional Ollama embed runtime `main_gpu` override             |
| `CONTEXTPLUS_EMBED_NUM_THREAD`          | string (parsed as number) | -                  | Optional Ollama embed runtime `num_thread` override           |
| `CONTEXTPLUS_EMBED_NUM_BATCH`           | string (parsed as number) | -                  | Optional Ollama embed runtime `num_batch` override            |
| `CONTEXTPLUS_EMBED_NUM_CTX`             | string (parsed as number) | -                  | Optional Ollama embed runtime `num_ctx` override              |
| `CONTEXTPLUS_EMBED_LOW_VRAM`            | string (parsed as boolean)| -                  | Optional Ollama embed runtime `low_vram` override             |
| `CONTEXTPLUS_EMBED_TRACKER`             | string                    | `lazy`             | Embedding tracker mode: `lazy`, `eager`, or `off`             |
| `CONTEXTPLUS_EMBED_TRACKER_MAX_FILES`   | string (parsed as number) | `8`                | Max changed files processed per tracker tick, clamped to 5-10 |
| `CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS` | string (parsed as number) | `700`              | Debounce window before tracker refresh                        |

## Test

```bash
npm test
npm run test:demo
npm run test:all
```
