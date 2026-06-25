# ContextPro MCP

> **Code intelligence for coding agents.** Less guessing. Fewer wasted tokens. Safer edits.

[![npm version](https://img.shields.io/npm/v/contextpro-mcp.svg)](https://www.npmjs.com/package/contextpro-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20%20%3C27-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.x-blue.svg)](https://modelcontextprotocol.io)

ContextPro is a Model Context Protocol server that gives Claude Code, Codex, Antigravity, OpenCode, Cursor, and any other MCP-aware agent a compact, structural map of a real codebase — without reading every file. It combines semantic search, AST-based symbol indexing, exact TypeScript/JavaScript references, impact analysis, validation guidance, project memory, safe restore points with preview + undo, and artifact caching behind one stdio server.

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
| Restore blindly and lose the fix | `restore --preview` shows what changes before touching anything; every restore auto-saves an undo point |
| "feeds" ranking buried under "fee" matches | Exact lemmatized term matching — substring collisions eliminated |
| Recompute heavy context on every call | `task_pack` read-through cache — identical tasks served instantly from artifacts |

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
        "CONTEXTPRO_PROVIDER": "ollama",
        "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest",
        "CONTEXTPRO_CHAT_MODEL": "gemma4:12b"
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
CONTEXTPRO_PROVIDER = "ollama"
CONTEXTPRO_EMBED_MODEL = "nomic-embed-text:latest"
CONTEXTPRO_CHAT_MODEL = "gemma4:12b"
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
        "CONTEXTPRO_PROVIDER": "ollama",
        "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest",
        "CONTEXTPRO_CHAT_MODEL": "gemma4:12b"
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

ContextPro needs an embedding model for semantic `search`. The default is local [Ollama](https://ollama.com):

```bash
ollama serve
ollama pull nomic-embed-text       # 137M params, 768-dim, fast
```

Prefer a hosted API (OpenAI, OpenRouter, Groq, …) or a different local runtime? See **[LLM providers](#llm-providers)** below — any OpenAI-compatible endpoint works with one base-URL setting.

> **No provider configured?** ContextPro still works — `search` falls back to FTS5/BM25 keyword ranking and `status` reports the degraded mode. Structural tools (`tree`, `skeleton`, `blast_radius`, `find_symbol`, `change_impact`, …) never need a provider.

---

## LLM providers

ContextPro uses an LLM for two things only: **embeddings** (semantic `search`) and an optional **chat model** (cluster labels, hub names, planning rerank). Everything else is pure AST/graph work with no model.

You configure all of it with **five short keys** — same names for every provider:

| Key | Default | What it does |
| --- | --- | --- |
| `CONTEXTPRO_PROVIDER` | `ollama` | `ollama` (local) or `openai` (any OpenAI-compatible API) |
| `CONTEXTPRO_API_KEY` | (none) | API key — only for the hosted/`openai` path |
| `CONTEXTPRO_BASE_URL` | OpenAI's | Endpoint URL — point at any compatible provider |
| `CONTEXTPRO_EMBED_MODEL` | provider default | Embedding model |
| `CONTEXTPRO_CHAT_MODEL` | provider default | Chat model (optional — cluster/hub labels, rerank) |

There are exactly two backends. `ollama` runs locally with no key. `openai` speaks the standard `/embeddings` + `/chat/completions` API, so **any provider that implements it works** — set `CONTEXTPRO_PROVIDER=openai` and point `CONTEXTPRO_BASE_URL` at the endpoint. You may also name the provider directly (`openrouter`, `groq`, `together`, `vllm`, `lmstudio`, `litellm`, …) — these are readable aliases that select the same `openai` path.

**Examples** (drop into the `env` block of your MCP config):

```jsonc
// OpenAI
{ "CONTEXTPRO_PROVIDER": "openai",
  "CONTEXTPRO_API_KEY": "sk-...",
  "CONTEXTPRO_EMBED_MODEL": "text-embedding-3-small",
  "CONTEXTPRO_CHAT_MODEL": "gpt-4o-mini" }

// OpenRouter — embed locally with Ollama, route chat to Claude
{ "CONTEXTPRO_PROVIDER": "ollama",
  "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest",
  "CONTEXTPRO_CHAT_PROVIDER": "openrouter",
  "CONTEXTPRO_BASE_URL": "https://openrouter.ai/api/v1",
  "CONTEXTPRO_API_KEY": "sk-or-...",
  "CONTEXTPRO_CHAT_MODEL": "anthropic/claude-3.5-haiku" }

// Local OpenAI-compatible server (LM Studio / vLLM / llama.cpp)
{ "CONTEXTPRO_PROVIDER": "openai",
  "CONTEXTPRO_BASE_URL": "http://localhost:1234/v1",
  "CONTEXTPRO_API_KEY": "not-needed",
  "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text" }
```

Notes:
- **Embeddings and chat are independent.** You can embed locally with Ollama and rerank/label with a hosted chat model (or skip chat entirely — it's optional). Set `CONTEXTPRO_CHAT_PROVIDER` to override the chat backend separately from `CONTEXTPRO_PROVIDER`.
- **Anthropic / Claude:** Claude has no native embeddings endpoint, so run embeddings on Ollama or OpenAI and route *chat* to Claude through an OpenAI-compatible proxy (OpenRouter, LiteLLM) via `CONTEXTPRO_BASE_URL`.
- **Switching embedding models changes the vector dimension.** ContextPro detects the drift, clears the stale cache, and `status` flags it — just run `reindex` once after switching.
- **Verify what's active:** `status` shows `Provider: <name> | Model: <model>`.
- **Backward-compatible:** the older long names (`CONTEXTPRO_EMBED_PROVIDER`, `CONTEXTPRO_OPENAI_API_KEY`, `OLLAMA_EMBED_MODEL`, plain `OPENAI_API_KEY`, …) still work — the short keys above just take precedence.

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

ContextPro exposes **49 MCP tools** organized into seven categories.

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
| `grep` | Fast literal or regex string search (log lines, config keys, error messages) |
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
| `checkpoints` | List restore points — tombstone files that didn't exist at snapshot time are clearly flagged |
| `restore` | Roll back to a restore point. `preview: true` shows the plan before touching anything; every live restore auto-saves a safety undo point |
| `gc` | Garbage-collect orphaned artifacts and stale restore points, frees disk space |

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
| `artifact_list` / `artifact_read` | Reuse cached task packs, repo maps, search results — lists include file sizes |
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
│  │  49 tools  ·  registered via Zod schemas                │    │
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

## Multiple projects (standalone, never mixed)

**One server process = one project.** Each project is fully isolated:

- All state lives in **that project's own `.contextpro/` directory** — its SQLite index (`index.db`), embeddings, memory graph, artifacts, restore points, and config. Nothing is shared or global.
- A server pins to a single root via `--root` and refuses to drift; queries can only ever see the project it was started for.
- Run one ContextPro server **per project** — give each its own entry in your agent config. They never see each other's data.

```jsonc
// .mcp.json — two projects, two isolated servers
{
  "mcpServers": {
    "contextpro-web":  { "command": "npx", "args": ["-y", "contextpro-mcp", "--root", "/abs/path/web"] },
    "contextpro-api":  { "command": "npx", "args": ["-y", "contextpro-mcp", "--root", "/abs/path/api"] }
  }
}
```

Each project's index is keyed by its absolute root, so even identically-named files in different projects never collide.

**Guardrails.** ContextPro refuses to start when `--root` is `/`, your home directory, or a top-level home folder (it would scatter `.contextpro/` databases somewhere harmful) — override only if you mean it with `CONTEXTPRO_ALLOW_UNSAFE_ROOT=true`. It also self-heals native-binding ABI drift (see below).

**Optional cross-project layer.** If you *want* to relate projects (e.g. a consulting client with several repos), `workspace_context` lists registered projects and `promote_pattern` shares a reusable memory note up to a `client`/`global` scope. This is opt-in — by default nothing crosses the project boundary. Set `CONTEXTPRO_CLIENT_ID` to group projects under one client.

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

**Providers** — the five generic keys (see [LLM providers](#llm-providers)):

| Variable | Default | Description |
| --- | --- | --- |
| `CONTEXTPRO_PROVIDER` | `ollama` | `ollama`, `openai`, or an OpenAI-compatible alias (`openrouter`, `groq`, `vllm`, …) |
| `CONTEXTPRO_API_KEY` | (none) | API key for the hosted/`openai` path |
| `CONTEXTPRO_BASE_URL` | `https://api.openai.com/v1` | Endpoint base URL — point at any compatible provider |
| `CONTEXTPRO_EMBED_MODEL` | provider default | Embedding model (`nomic-embed-text:latest` / `text-embedding-3-small`) |
| `CONTEXTPRO_CHAT_MODEL` | provider default | Chat model — cluster/hub labels, rerank (`gemma4:12b` / `gpt-4o-mini`) |
| `CONTEXTPRO_CHAT_PROVIDER` | (= provider) | Override the chat backend independently of embeddings |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Non-default Ollama endpoint |

> **Legacy names still work** (the generic keys above take precedence): `CONTEXTPRO_EMBED_PROVIDER`, `CONTEXTPRO_OPENAI_API_KEY`, `CONTEXTPRO_OPENAI_BASE_URL`, `CONTEXTPRO_OPENAI_EMBED_MODEL`, `CONTEXTPRO_OPENAI_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_CHAT_MODEL`, and provider-native `OPENAI_API_KEY` / `OPENAI_BASE_URL`.

**Indexing & runtime:**

| Variable | Default | Description |
| --- | --- | --- |
| `CONTEXTPRO_EMBED_BATCH_SIZE` | `8` | Embedding batch per call (clamped to 5–10) |
| `CONTEXTPRO_EMBED_TRACKER` | `lazy` | `off`, `lazy`, or `eager` realtime updates |
| `CONTEXTPRO_REINDEX_NO_EMBED` | `false` | Skip eager embedding population during reindex |
| `CONTEXTPRO_MAX_FILE_SIZE` | `5242880` | Skip source files larger than this (bytes) |
| `CONTEXTPRO_QUICKREFRESH_MAX_FILES` | `30` | Max stale files auto-patched per search |
| `CONTEXTPRO_NATIVE_AUTO_REPAIR` | `true` | Auto-rebuild native bindings on ABI drift |
| `CONTEXTPRO_ALLOW_UNSAFE_ROOT` | `false` | Allow `/` or home-level project roots |
| `CONTEXTPRO_PROJECT_ID` | (auto) | Override project identity |
| `CONTEXTPRO_CLIENT_ID` | (none) | Group projects under one client for cross-project memory |

---

## Project trajectory

Three docs work together so the project's history stays auditable:

- **[STATUS.md](./STATUS.md)** — live state of every subsystem
- **[CHANGELOG.md](./CHANGELOG.md)** — per-version history
- **[AUDIT.md](./AUDIT.md)** — every audit finding ever reported, with verification status

### Recent releases

- **1.3.1** — Round-4 audit fixes: cluster labels no longer emit import-vocab leakage or raw path globs; feature directories recovered via directory anchor; `restore` takes a pre-restore safety snapshot with optional `preview` dry-run; `gc` tool cleans orphaned artifacts and stale restore points; `task_pack` read-through artifact cache; `artifact_list` includes file sizes; fee/feeds ranking collision fixed; generic 5-key provider config scheme.
- **1.3.0** — Production hardening: atomic writes for artifacts/graph/SCIP; JSON.parse guards; manifest-mutex leak fix; bounded LRU caches; numeric schema-version compare; `health` reports version + build stamp.
- **1.2.2** — `grep` tool for literal/regex search; closes 8 dev-lifecycle audit findings (input validation, output disambiguation, `cluster` heuristic fallback).
- **1.2.1** — Eager embedding population in reindex; disambiguated `status` warning; Node ABI documentation.
- **1.2.0** — Comprehensive 25-issue audit; tracking docs added; legacy env-var aliases.
- **1.1.0** — Agentic workflow aliases, project graph export/query, `impact_delta`, exact references, SCIP import, FTS5/BM25 fallback.

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

---

## Contributing

```bash
npm install
npm run build       # tsc
npm test            # 366 tests across core, tools, and integration
npm run test:demo   # 33 demo tests
npm run dev         # tsc --watch
```

Run `npm rebuild better-sqlite3 sqlite-vec` whenever you change Node major versions.

---

## License

MIT — see [LICENSE](./LICENSE).

ContextPro stands on the shoulders of [Context+](https://github.com/ForLoopCodes/contextplus) by ForLoopCodes; this fork preserves the original's spirit while adding multi-project safety, agentic workflow tools, persistent storage, and a documented audit trail.
