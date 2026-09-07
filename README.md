# ContextPro MCP

> **Code intelligence for coding agents.** Less guessing. Fewer wasted tokens. Safer edits.

[![npm version](https://img.shields.io/npm/v/contextpro-mcp.svg)](https://www.npmjs.com/package/contextpro-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20%20%3C27-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.x-blue.svg)](https://modelcontextprotocol.io)

ContextPro is a Model Context Protocol server that gives Claude Code, Codex, Antigravity, OpenCode, Cursor, and any other MCP-aware agent a compact, structural map of a real codebase — without reading every file. It combines semantic search, AST-based symbol indexing, exact TypeScript/JavaScript references, impact analysis, validation guidance, project memory, safe restore points with preview + undo, and artifact caching behind one stdio server.

A private fork and evolution of [Context+](https://github.com/ForLoopCodes/contextplus), hardened with multi-project trust boundaries, agentic workflow tools, persistent SQLite + sqlite-vec storage, and a 25-issue audit pass landing in 1.2.x.

New to MCP configuration or setting up an agent team? Start with the dedicated **[installation and agent-use guide](INSTALL.md)**. It explains the optional model settings, verification, worktrees, and a small project-instruction snippet that makes agents reach for ContextPro first.

---

## Why ContextPro

Coding agents waste most of their context window reading whole files when they only need *signatures* and *relationships*. ContextPro changes the agent's default reach:

| Without ContextPro | With ContextPro |
| --- | --- |
| `Read whole file` to find a function | `skeleton` returns signatures only — 5–10× cheaper |
| `Grep` to find related code | `search` uses RRF-ranked semantic + keyword retrieval and inlines the relevant crux |
| Hope the rename didn't break a caller | `blast_radius` attributes calls/imports/mocks to their enclosing symbols |
| Read three files to plan an edit | `task_pack` returns ranked files + tests + memory in one call |
| Hope the edit doesn't break tests | `change_impact` lists affected importers and known-relevant tests |
| Save and pray | `checkpoint` writes with a pre-write restore point — `restore` rolls back |
| Restore blindly and lose the fix | `restore --preview` shows what changes before touching anything; every restore auto-saves an undo point |
| "feeds" ranking buried under "fee" matches | Exact lemmatized term matching — substring collisions eliminated |
| Recompute heavy context on every call | `task_pack` read-through cache — identical tasks served instantly from artifacts |
| Guess whether token claims are real | `efficiency_report` shows the estimate, method, history, and optional price scenario |

Savings depend on the task and the comparison. ContextPro can replace repeated broad reads with bounded context, while ordinary literal search can be cheaper for tiny exact-name lookups. Run `npm run bench:retrieval` for reproducible retrieval measurements; `efficiency_report` provides a clearly labeled full-file comparison estimate, not measured agent or billing savings.

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
        "CONTEXTPRO_TOOL_PROFILE": "workflow"
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
CONTEXTPRO_TOOL_PROFILE = "workflow"
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
        "CONTEXTPRO_TOOL_PROFILE": "workflow"
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

## Model providers (separate from your coding agent)

ContextPro does **not** use, proxy, or consume the coding agent's own model context. It has an independent, optional model connection for two narrow jobs: **embeddings** power semantic `search`, while a **chat model** can improve cluster labels, hub names, and ambiguous planning reranks. Everything else is pure AST/graph work with no model.

The recommended first install configures embeddings only. Leave `CONTEXTPRO_CHAT_MODEL` unset unless you explicitly want those optional chat-assisted refinements; setting it can make network calls or use local compute. See [why a separate model exists](INSTALL.md#why-contextpro-has-model-settings) for the precise behavior and privacy/cost implications.

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

Run independent reads in parallel. Structural tools refresh changed files before reading the graph and coordinate through SQLite so concurrent agents share one refresh. If `status` says `embeddings_stale`, run `reindex` before relying on semantic ranking.

---

## Tool surface

ContextPro defaults to **workflow (13 tools)** for everyday discovery and validation. `discover_tools` finds and enables expert tools for the current session without running them. Opt-in **lean** exposes only `context` and `discover_tools`: one-call source retrieval plus expert discovery. Explicit **core** and **full** profiles remain available; an unset profile now selects workflow. Clients that require every tool up front can set `CONTEXTPRO_TOOL_PROFILE=full`.

Use `search(format:"compact")` for concise JSON with code locations and freshness warnings; `json` retains the verbose diagnostic format. `include_dependencies:true` adds at most three import pointers from the two strongest file matches. `profile:true` reports freshness, retrieval/ranking and artifact timings in JSON/compact responses. `skeleton(exported_only:true)` limits TypeScript/JavaScript output to public declarations and preserves multiline signatures and interface contracts. Unchanged task-packet deltas return a small acknowledgement with recovery IDs instead of repeating the packet metadata.

### Orientation
| Tool | What it does |
| --- | --- |
| `status` | File counts, index state, memory stats, embedding provider, git, recent timings, and 24h efficiency estimate |
| `context` (lean/full) | Find and read bounded, deduplicated source in one call; exact targets bypass search and embeddings |
| `efficiency_report` | Persistent estimated token savings by tool; optional model-price scenario, with no prompt/code retention |
| `tree` | Structural tree with file headers + symbols + line ranges |
| `repo_map` | Compact whole-repo outline ranked by importance |
| `task_pack` | Minimum useful working set for a task; `max_tokens` utility-prunes low-value context while preserving the two strongest files |
| `decision_brief` | Compressed context for a subsystem |

### Discovery
| Tool | What it does |
| --- | --- |
| `search` | Hybrid (default), file, or identifier search; RRF fusion + ~8-line crux excerpts by default (`inline_code`) |
| `grep` | Fast literal or regex string search (log lines, config keys, error messages) |
| `skeleton` | Function/class signatures and line ranges, no bodies |
| `explain` | Specific symbol body with immediate dependencies |
| `resolve_symbol` | Resolve a name to its definition with ambiguity scoring |
| `cluster` | Browse by meaning via spectral clustering |
| `hub` | Feature-hub navigator (Obsidian-style `[[wikilinks]]`) |

### Impact
| Tool | What it does |
| --- | --- |
| `blast_radius` | Usage kinds + enclosing callers; compact `summary` by default, exhaustive `detailed` mode on demand |
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
| `graph_export` / `graph_query` | Portable project graph with provenance, weighted shortest paths, PageRank hotspots, structural communities, and token budgets |
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
│  │  50+ tools · Zod schemas · MCP safety annotations       │    │
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

**Guardrails.** ContextPro refuses to start when `--root` is `/`, your home directory, or a top-level home folder (it would scatter `.contextpro/` databases somewhere harmful) — override only if you mean it with `CONTEXTPRO_ALLOW_UNSAFE_ROOT=true`. It detects native-binding ABI drift and supports explicit repair (see below).

**Optional cross-project layer.** If you *want* to relate projects (e.g. a consulting client with several repos), `workspace_context` lists registered projects and `promote_pattern` shares a reusable memory note up to a `client`/`global` scope. This is opt-in — by default nothing crosses the project boundary. Set `CONTEXTPRO_CLIENT_ID` to group projects under one client.

---

## Node version

ContextPro requires **Node 20–26** (declared in `package.json:engines`). The native `better-sqlite3` binary is built against the Node major version present at install time. If you upgrade Node (or have multiple Nodes via NVM/Homebrew/asdf), the ABI may not match the running Node and you'll see:

```
Error: NODE_MODULE_VERSION X (compiled) vs Y (runtime)
```

ContextPro automatically repairs missing or incompatible native dependencies in a **separate cache for each Node ABI, operating system, architecture, libc, and dependency version**. It never rebuilds the shared installation. Multiple MCP hosts can therefore use different Node versions without replacing each other's SQLite binary.

The default cache is `~/.cache/contextpro/native`; override it with `CONTEXTPRO_NATIVE_CACHE_DIR`. The first repair needs npm and network access (and compiler tools if a prebuilt binary is unavailable). Later launches reuse the verified cache offline. Set `CONTEXTPRO_NATIVE_AUTO_REPAIR=false` to disable automatic installation. Explicit repair uses the same isolated cache:

```bash
node build/index.js doctor --fix
```

Run that command using the Node executable named in the failing host's diagnostic. Restart already-running MCP hosts after updating ContextPro. Repair validates both SQLite and its vector extension before publishing the cache; failures remain actionable diagnostics rather than successful health reports.

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
| `CONTEXTPRO_EMBED_BATCH_SIZE` | `32` with Ollama, `8` remotely | Embedding inputs per request (clamped to 1–128; adaptive splitting handles context limits) |
| `CONTEXTPRO_EMBED_TRACKER` | `lazy` | `off`, `lazy`, or `eager` realtime updates |
| `CONTEXTPRO_RECONCILE_INTERVAL_MS` | `30000` | Self-healing sweep interval; heals drift the file-watch misses (clamped ≥5000) |
| `CONTEXTPRO_RECONCILE_MAX_FILES` | `40` | Max drifted files reconciled per sweep; large backlogs drain over sweeps (clamped ≥5) |
| `CONTEXTPRO_REINDEX_NO_EMBED` | `false` | Skip eager embedding population during reindex |
| `CONTEXTPRO_MAX_FILE_SIZE` | `5242880` | Skip source files larger than this (bytes) |
| `CONTEXTPRO_QUICKREFRESH_MAX_FILES` | `30` | Max stale files auto-patched per search |
| `CONTEXTPRO_AUTO_REFRESH` | `true` | Refresh changed files before structural graph reads; set `false` only for controlled benchmarks |
| `CONTEXTPRO_REFRESH` | `stat` | `stat` uses size/mtime fast paths and hashes suspicious files; `hash` verifies every indexed source for maximum integrity |
| `CONTEXTPRO_EFFICIENCY_FOOTER` | `false` | Append a compact estimated-savings footer when a response avoids at least 100 source tokens |
| `CONTEXTPRO_NATIVE_AUTO_REPAIR` | `true` | Repair native bindings in an isolated ABI/version cache |
| `CONTEXTPRO_NATIVE_CACHE_DIR` | `~/.cache/contextpro/native` | Shared cache of separate native runtimes |
| `CONTEXTPRO_ALLOW_UNSAFE_ROOT` | `false` | Allow `/` or home-level project roots |
| `CONTEXTPRO_TOOL_PROFILE` | `workflow` | `lean`: 2 tools; `workflow`: 13; `core`: editing/graphs; `full`: all tools |
| `CONTEXTPRO_PROJECT_ID` | (auto) | Override project identity |
| `CONTEXTPRO_CLIENT_ID` | (none) | Group projects under one client for cross-project memory |

For the complete, implementation-checked list—including tracker tuning, embedding hardware settings, session metadata, and remote-instruction controls—see [Environment variables in the installation guide](INSTALL.md#environment-reference).

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
npm test            # core, tools, regression, and MCP integration tests
npm run typecheck   # TypeScript without writing build output
npm run bench:retrieval # offline fixed-corpus measurements against rg/read
npm run test:demo   # 33 demo tests
npm run dev         # tsc --watch
```

Run `npm rebuild better-sqlite3 sqlite-vec` whenever you change Node major versions.

---

## License

MIT — see [LICENSE](./LICENSE).

ContextPro stands on the shoulders of [Context+](https://github.com/ForLoopCodes/contextplus) by ForLoopCodes; this fork preserves the original's spirit while adding multi-project safety, agentic workflow tools, persistent storage, and a documented audit trail.
