# ContextPro MCP

> **Code intelligence for coding agents.** Less guessing. Fewer wasted tokens. Safer edits.

[![npm version](https://img.shields.io/npm/v/contextpro-mcp.svg)](https://www.npmjs.com/package/contextpro-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20%20%3C27-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.x-blue.svg)](https://modelcontextprotocol.io)

ContextPro is a Model Context Protocol server that gives Claude Code, Codex, Antigravity, OpenCode, Cursor, and any other MCP-aware agent a compact, structural map of a real codebase — without reading every file. It combines semantic search, AST-based symbol indexing, exact TypeScript/JavaScript references, impact analysis, validation guidance, project memory, and safe restore points behind one stdio server.

A private fork and evolution of [Context+](https://github.com/ForLoopCodes/contextplus), hardened with multi-project trust boundaries, agentic workflow tools, persistent SQLite + sqlite-vec storage, and a 25-issue audit pass landing in 1.2.x.

---

## Why ContextPro

Coding agents waste most of their context window reading whole files when they only need *signatures* and *relationships*. ContextPro changes the agent's default reach:

| Without ContextPro | With ContextPro |
| --- | --- |
| `Read whole file` to find a function | `skeleton` returns signatures only — 5–10× cheaper |
| `Grep` to find related code | `search` ranks by semantics + keywords with confidence scoring |
| Hope the rename didn't break a caller | `blast_radius` enumerates every usage with file:line |
| Read three files to plan an edit | `task_pack` returns ranked files + tests + memory in one call |
| Hope the edit doesn't break tests | `change_impact` lists affected importers and known-relevant tests |
| Save and pray | `checkpoint` writes with a pre-write restore point — `restore` rolls back |

For orientation-and-discovery work — the half of agent tasks where most tokens go — ContextPro typically reduces context usage by **~75%**.

---

## Quick Start

### Install

```bash
# Global usage via npx
npx -y contextpro-mcp

# Or with Bun
bunx contextpro-mcp
```

For a local checkout:

```bash
git clone https://github.com/AlaeddineMessadi/contextpro-mcp.git
cd contextpro-mcp
npm install
npm run build
node build/index.js doctor --root /absolute/path/to/your/project
```

### Configure your agent

#### Claude Code & Antigravity

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"],
      "env": {
        "CONTEXTPRO_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text:latest",
        "OLLAMA_CHAT_MODEL": "nemotron-3-ultra:cloud",
        "CONTEXTPRO_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

#### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.contextpro]
command = "npx"
args = ["-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"]

[mcp_servers.contextpro.env]
CONTEXTPRO_EMBED_PROVIDER = "ollama"
OLLAMA_EMBED_MODEL = "nomic-embed-text:latest"
OLLAMA_CHAT_MODEL = "nemotron-3-ultra:cloud"
CONTEXTPRO_EMBED_TRACKER = "lazy"
```

#### OpenCode

Add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "contextpro": {
      "type": "local",
      "command": ["npx", "-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"],
      "enabled": true,
      "environment": {
        "CONTEXTPRO_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text:latest",
        "OLLAMA_CHAT_MODEL": "nemotron-3-ultra:cloud",
        "CONTEXTPRO_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

Or generate a starter config:

```bash
npx -y contextpro-mcp init claude     # writes .mcp.json
npx -y contextpro-mcp init opencode   # writes opencode.json
npx -y contextpro-mcp init cursor     # writes .cursor/mcp.json
```

### First-time setup

ContextPro needs an embedding model. The recommended local stack is [Ollama](https://ollama.com):

```bash
brew install --cask ollama         # or your platform equivalent
ollama serve
ollama pull nomic-embed-text       # 137M params, 768-dim, fast
```

Or use any OpenAI-compatible API (OpenAI, Gemini, vLLM, LiteLLM):

```json
{
  "CONTEXTPRO_EMBED_PROVIDER": "openai",
  "CONTEXTPRO_OPENAI_API_KEY": "YOUR_KEY",
  "CONTEXTPRO_OPENAI_BASE_URL": "https://api.openai.com/v1",
  "CONTEXTPRO_OPENAI_EMBED_MODEL": "text-embedding-3-small"
}
```

> **No embedding provider?** ContextPro still works — `search` falls back to FTS5/BM25 keyword ranking and emits a `Provider unreachable` warning in `status`.

---

## How agents use it

The intended loop:

```
1. task_pack       →  ranked files + tests + memory + recent diffs
2. skeleton        →  function signatures (no bodies) for each file
3. search          →  semantic + keyword discovery with confidence
4. blast_radius    →  every usage of a symbol before renaming/deleting
5. (edit code)
6. checkpoint      →  write with a pre-write restore point
7. lint            →  type and style validation
8. validate_scope  →  recommended checks for the changed files
9. memory_record_task →  persist what was learned for next session
```

Run independent reads in parallel. Trust the confidence/freshness envelope every agentic tool returns — if it says `embeddings_stale`, run `reindex` before relying on semantic results.

---

## Tool surface

ContextPro exposes **47 MCP tools** organized into seven categories.

### Orientation
| Tool | What it does |
| --- | --- |
| `status` | File counts, index state, memory stats, embedding provider, git, recent timings |
| `tree` | Structural tree with file headers + symbols + line ranges |
| `repo_map` | Compact whole-repo outline ranked by importance |
| `task_pack` | Minimum useful working set for a task |
| `decision_brief` | Compressed context for a subsystem |

### Discovery
| Tool | What it does |
| --- | --- |
| `search` | Hybrid (default), file, or identifier search with confidence scoring |
| `skeleton` | Function/class signatures and line ranges, no bodies |
| `explain` | Specific symbol body with immediate dependencies |
| `resolve_symbol` | Resolve a name to its definition with ambiguity scoring |
| `cluster` | Browse by meaning via spectral clustering |
| `hub` | Feature-hub navigator (Obsidian-style `[[wikilinks]]`) |

### Impact
| Tool | What it does |
| --- | --- |
| `blast_radius` | Every usage of a symbol across the codebase |
| `change_impact` | What may break if files or symbols change |
| `related` | Imports, importers, siblings, and tests of a file |
| `test_map` | Source-to-test mapping via import graph and naming |
| `exact_references` | LSP-resolved (TS/JS) or SCIP-resolved references |
| `impact_delta` | Compare a saved graph export to the current graph |

### Planning
| Tool | What it does |
| --- | --- |
| `edit_scope` | Smallest safe edit set for a task |
| `validate_scope` | Recommended checks for the scoped files |

### Code I/O
| Tool | What it does |
| --- | --- |
| `lint` | Auto-detected linters (tsc, eslint, ruff, cargo check, go vet) + skill-score |
| `checkpoint` | Save with a pre-write restore point. `strict: true` enforces style rules |
| `checkpoints` | List restore points |
| `restore` | Roll back to a restore point |

### Memory
| Tool | What it does |
| --- | --- |
| `memory_create` / `memory_link` | Add nodes and typed edges (depends_on, implements, contradicts, …) |
| `memory_search` | Semantic search with graph traversal across neighbors |
| `memory_bulk` | Bulk import with auto-similarity linking |
| `memory_explore` | Walk outward from a node with decay-weighted scoring |
| `memory_record_task` | Persist task outcomes with files, evidence, and risks |
| `memory_list` / `memory_delete` | Audit and remove stale nodes |

### Workspace & Graph
| Tool | What it does |
| --- | --- |
| `workspace_context` | Active projects and recent sessions across clients |
| `promote_pattern` | Promote project memory to client/global pattern |
| `artifact_list` / `artifact_read` | Reuse cached task packs, repo maps, search results |
| `reindex` | Re-walk and re-parse files. Eagerly populates embeddings (1.2.1+) |
| `diff` | Structured working-tree, branch, or per-file diff |
| `health`, `doctor` | Startup health, native binding repair |
| `graph_export` / `graph_query` | Portable project graph with confidence tags |
| `scip_import` / `scip_status` | Import SCIP indexes for cross-language exactness |

> **Deprecated aliases (1.2.x → removed in 2.0):** `start_task` → `task_pack`, `plan_edit` → `edit_scope`, `validate` → `validate_scope`, `impact` → `change_impact`, `remember` → `memory_record_task`. The aliases still work; their tool descriptions are tagged `[deprecated, prefer …]`.

---

## Reindexing and embeddings

`reindex` does two things in one pass:

1. **Structural index** — files, symbols, imports, call sites, FTS5 keyword index. Always populated.
2. **Vector embeddings** — file-search and identifier embeddings via your provider. **Eagerly populated by default in 1.2.1+** so the first `search` call doesn't pay the cold cost.

Pass `no_embed: true` (or set `CONTEXTPRO_REINDEX_NO_EMBED=true`) to skip step 2 — useful when the embedding provider is unreachable or you want to defer the cost. Search will fall back to keyword ranking until you reindex without the flag. If embedding fails mid-reindex, the structural index still completes and `status` surfaces the actual error.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Coding agent (Claude / Codex / …)              │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ MCP stdio
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                       ContextPro MCP server                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  47 tools  ·  registered via Zod schemas                │    │
│  └──────┬──────────────────────────────────────────────────┘    │
│         │                                                       │
│  ┌──────▼─────────┐  ┌──────────────┐  ┌──────────────────┐     │
│  │  Tools layer   │  │  Core layer  │  │  Storage layer   │     │
│  │  search · tree │  │  parser      │  │  better-sqlite3  │     │
│  │  blast_radius  │  │  walker      │  │  + sqlite-vec    │     │
│  │  task_pack     │  │  embeddings  │  │  + FTS5/BM25     │     │
│  │  …             │  │  memory-graph│  │  + JSON manifests│     │
│  └────────────────┘  └──────────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      .contextpro/ (per project)                 │
│   index.db   ·   artifacts/   ·   hubs/   ·   backups/          │
│   config.json   ·   graph.json   ·   scip-index.json (optional) │
└─────────────────────────────────────────────────────────────────┘
```

- **Storage** is per-project under `.contextpro/`. Existing `.contextplus/` and `.mcp_data/` directories migrate automatically on first startup.
- **Languages**: 36+ via Tree-sitter WASM grammars, with regex fallback for unsupported files.
- **Embeddings**: 768-dim by default (Ollama `nomic-embed-text`); auto-detects dimension drift and re-cleans the cache.
- **Confidence tags** on every graph edge: `SCIP_RESOLVED`, `LSP_RESOLVED`, `AST_EXTRACTED`, `HEURISTIC`, `AMBIGUOUS`.

---

## Multi-project safety

A single MCP process pins to one `--root`. ContextPro refuses to start when:

- `--root` is `/`, the user's home directory, or a top-level home subdirectory (it would create `.contextpro/` and SQLite databases there).
- The project root drifts mid-session (multi-project trust check).
- Native bindings hit an ABI mismatch and auto-repair fails.

Override the unsafe-root check explicitly with `CONTEXTPRO_ALLOW_UNSAFE_ROOT=true`.

For multi-project workflows, use `workspace_context` to list registered projects and `promote_pattern` to share memory across them.

---

## Node version

ContextPro requires **Node 20–26** (declared in `package.json:engines`). The native `better-sqlite3` binary is built against the Node major version present at install time. If you upgrade Node (or have multiple Nodes via NVM/Homebrew/asdf), the ABI may not match the running Node and you'll see:

```
Error: NODE_MODULE_VERSION X (compiled) vs Y (runtime)
```

ContextPro auto-repairs this on startup (rebuilds against the active Node) — controlled by `CONTEXTPRO_NATIVE_AUTO_REPAIR` (default `true`). To repair manually:

```bash
npm rebuild better-sqlite3 sqlite-vec
```

If you have both NVM and Homebrew Node, ensure the same one is used at install and runtime:

```bash
which node && node --version
```

---

## Environment variables

Canonical prefix is `CONTEXTPRO_*` (since 1.2.0). Legacy `CONTEXTPLUS_*` names work as aliases through 2.0.

| Variable | Default | Description |
| --- | --- | --- |
| `CONTEXTPRO_EMBED_PROVIDER` | `ollama` | `ollama` or `openai` |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text:latest` | Embedding model name |
| `OLLAMA_CHAT_MODEL` | `nemotron-3-ultra:cloud` | Chat model for cluster labels and hub names |
| `CONTEXTPRO_EMBED_BATCH_SIZE` | `8` | Embedding batch per call (clamped to 5–10) |
| `CONTEXTPRO_EMBED_TRACKER` | `lazy` | `off`, `lazy`, or `eager` realtime updates |
| `CONTEXTPRO_REINDEX_NO_EMBED` | `false` | Skip eager embedding population during reindex |
| `CONTEXTPRO_QUICKREFRESH_MAX_FILES` | `30` | Max stale files auto-patched per search |
| `CONTEXTPRO_NATIVE_AUTO_REPAIR` | `true` | Auto-rebuild native bindings on ABI drift |
| `CONTEXTPRO_ALLOW_UNSAFE_ROOT` | `false` | Allow `/` or home-level project roots |
| `CONTEXTPRO_INSTRUCTIONS_REMOTE` | `false` | Fetch agent instructions from URL instead of bundle |
| `CONTEXTPRO_PROJECT_ID` | (auto) | Override project identity |
| `CONTEXTPRO_CLIENT_ID` | (none) | Group projects under a client |
| `CONTEXTPRO_SESSION_SOURCE` | `mcp` | Session source tag |

Plus standard `OLLAMA_HOST` for non-default Ollama endpoints.

---

## Project trajectory

Three docs work together so the project's history stays auditable:

- **[STATUS.md](./STATUS.md)** — live state of every subsystem
- **[CHANGELOG.md](./CHANGELOG.md)** — per-version history
- **[AUDIT.md](./AUDIT.md)** — every audit finding ever reported, with verification status

### Recent releases

- **1.2.1** — Eager embedding population in reindex; disambiguated `status` warning; Node ABI documentation.
- **1.2.0** — Comprehensive 25-issue audit; tracking docs added; legacy env-var aliases.
- **1.1.0** — Agentic workflow aliases, project graph export/query, `impact_delta`, exact references, SCIP import, FTS5/BM25 fallback.

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

---

## Contributing

```bash
npm install
npm run build       # tsc
npm test            # 295 tests across core, tools, and integration
npm run test:demo   # 33 demo tests
npm run dev         # tsc --watch
```

Run `npm rebuild better-sqlite3 sqlite-vec` whenever you change Node major versions.

---

## License

MIT — see [LICENSE](./LICENSE).

ContextPro stands on the shoulders of [Context+](https://github.com/ForLoopCodes/contextplus) by ForLoopCodes; this fork preserves the original's spirit while adding multi-project safety, agentic workflow tools, persistent storage, and a documented audit trail.
