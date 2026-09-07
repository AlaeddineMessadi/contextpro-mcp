# Install ContextPro for Coding Agents

ContextPro is a project-scoped MCP server: one running server builds and maintains a compact index for one codebase (or worktree). It is designed to make an agent discover code through symbols, relationships, and ranked task context before it spends tokens on raw files.

This guide covers a practical default installation, optional model features, verification, and the small instruction policy that helps agents use the server consistently.

## Choose the operating mode

| Mode | What works | Requirements | Recommended when |
| --- | --- | --- | --- |
| Structural only | `tree`, `skeleton`, `blast_radius`, `task_pack`, impact tools, exact references, memory, and safe edits | Node only | You do not want another model endpoint or are offline |
| Semantic search | Everything above plus embedding-ranked `search` | An embedding provider; local Ollama is the default | Most projects |
| Chat-assisted refinement | Everything above plus optional hub labels and ambiguous planning reranks | A separately configured chat model | You have chosen the latency/cost/privacy trade-off |

The structural index is always useful; a missing embedding provider degrades `search` to keyword ranking rather than disabling the server.

## Prerequisites

- Node.js 20 through 26. ContextPro automatically repairs incompatible SQLite bindings in a separate cache for each runtime ABI, without changing the shared installation. `doctor --fix` retries explicitly; first-time repair requires npm and network access.
- A project root, never `/` or a home directory. ContextPro creates its local index in `.contextpro/`, which is already appropriate to add to `.gitignore`.
- For semantic search, an embedding model. The no-cost local default is Ollama:

```bash
ollama serve
ollama pull nomic-embed-text
```

You do not need a chat model for the recommended setup.

## Recommended configuration

Use a pinned package version for reproducible team behavior. Upgrade it intentionally in the same way as any other developer tool. Replace `/absolute/path/to/project` with the repository or worktree that this server should index.

### Codex

Add this to `~/.codex/config.toml` (or the applicable project-level Codex configuration):

```toml
[mcp_servers.contextpro]
command = "npx"
args = ["-y", "contextpro-mcp@1.3.0", "--root", "/absolute/path/to/project"]

[mcp_servers.contextpro.env]
CONTEXTPRO_PROVIDER = "ollama"
CONTEXTPRO_EMBED_MODEL = "nomic-embed-text:latest"
CONTEXTPRO_EMBED_TRACKER = "lazy"
CONTEXTPRO_TOOL_PROFILE = "workflow"
```

Restart Codex after saving the configuration. `workflow` exposes 12 everyday tools. Select `core` for editing and advanced graphs or `full` for all operations.

### Claude Code and other `.mcp.json` clients

Add this to the repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp@1.3.0", "--root", "/absolute/path/to/project"],
      "env": {
        "CONTEXTPRO_PROVIDER": "ollama",
        "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest",
        "CONTEXTPRO_EMBED_TRACKER": "lazy",
        "CONTEXTPRO_TOOL_PROFILE": "workflow"
      }
    }
  }
}
```

### Generated starter configuration

From the target repository, ContextPro can generate a starter file for several clients:

```bash
npx -y contextpro-mcp@1.3.0 init claude
npx -y contextpro-mcp@1.3.0 init opencode
npx -y contextpro-mcp@1.3.0 init cursor
```

`init` writes that client's config file, so inspect or commit any existing configuration first. It initializes embeddings only; add a chat model only when you want that feature.

## Verify the installation

1. Restart the coding agent so it reconnects to MCP servers.
2. Ask the agent to call `status`. It should report the expected project root and index state.
3. Ask it to call `task_pack` for a real small task, then `skeleton` on one returned file. This confirms the low-token workflow before relying on it for larger work.
4. With Ollama installed, call `search` with a behavior question. `status` should show the active embedding provider and model. If the embedding provider is unavailable, structural tools still work and `search` reports keyword-only behavior.

For local diagnosis outside an agent:

```bash
npx -y contextpro-mcp@1.3.0 doctor --root /absolute/path/to/project
```

If `status` reports stale embeddings after changing providers or embedding models, run `reindex` once from the MCP client. Switching embedding models changes vector dimensions, so ContextPro intentionally discards incompatible vectors.

## Why ContextPro has model settings

The coding agent and ContextPro are separate processes. ContextPro cannot reuse the host agent's private model session, context window, or provider credentials. Its model settings therefore describe an independent provider connection:

- `CONTEXTPRO_EMBED_MODEL` creates vectors for semantic retrieval. It receives the indexed search material needed by the configured provider; local Ollama keeps that processing on the machine.
- `CONTEXTPRO_CHAT_MODEL` is optional. It is used only for hub naming and selected ambiguous planning reranks. It is not used to write code, conduct normal graph analysis, or replace the coding agent.
- No chat model is configured by the recommended setup. This avoids surprise requests, latency, and cost.
- A hosted embedding or chat provider receives the request content necessary for that operation. Use a local provider or structural-only mode when source-data egress is not acceptable.

For an intentional hosted setup, use an OpenAI-compatible endpoint and store the API key in the MCP client's secret/environment mechanism rather than committing it:

```toml
[mcp_servers.contextpro.env]
CONTEXTPRO_PROVIDER = "openai"
CONTEXTPRO_BASE_URL = "https://api.openai.com/v1"
CONTEXTPRO_API_KEY = "set-this-in-your-secret-manager"
CONTEXTPRO_EMBED_MODEL = "text-embedding-3-small"
# Optional; omit to keep chat-assisted features disabled.
CONTEXTPRO_CHAT_MODEL = "gpt-4o-mini"
```

`openrouter`, `groq`, `vllm`, `lmstudio`, and LiteLLM are readable provider aliases for the same OpenAI-compatible API path. Set the corresponding base URL. A chat provider may be selected independently with `CONTEXTPRO_CHAT_PROVIDER`, but it currently shares the configured API key and base URL.

## Make agents use ContextPro first

The server publishes a compact manifest hint plus a full [agent workflow guide](agent-guide.md) at `contextpro://instructions`. The compact hint is intentional: some MCP clients repeat server instructions in every tool description, creating a large context cost. For reliable behavior, add the following short policy to the repository's own agent-instruction file—`AGENTS.md` for Codex, `CLAUDE.md` for Claude Code, or the equivalent used by your client. Append it; do not replace project-specific guidance.

```md
## ContextPro workflow

ContextPro is available for this repository. Use it before broad filesystem discovery:

1. Start implementation tasks with `task_pack` (and `status` once per session).
2. Use `skeleton`, `explain`, `tree`, `repo_map`, or `search` before reading whole files or running broad grep/glob scans.
3. Run `blast_radius` before renaming, deleting, or materially changing a symbol; use `change_impact` when a change spans files.
4. Run independent ContextPro reads in parallel. Reuse fresh artifacts with `artifact_list` / `artifact_read` instead of rebuilding the same context.
5. After a substantive task, record durable outcomes with `memory_record_task`; do not store secrets or transient speculation.

Fall back to native tools only when ContextPro cannot answer the specific question, when validating an edit, or when direct file contents are necessary.
```

This is deliberately a preference hierarchy, not an instruction to ignore compiler output, tests, repository rules, or security controls. It saves tokens by replacing broad discovery with precise structural calls while preserving normal editing and validation tools.

### Multiple agents and worktrees

Give each worktree its own absolute `root`. A client that advertises the active workspace root is routed automatically; otherwise pass `root` on individual ContextPro calls. Each worktree gets an isolated index, while a new worktree can seed from its base repository's index to avoid reprocessing unchanged files. Do not let agents targeting different worktrees omit their roots: the usual symptom is an agent seeing results from the main checkout.

## Environment reference

Canonical names use `CONTEXTPRO_*`. Legacy `CONTEXTPLUS_*` aliases remain supported through 2.0 unless noted below; canonical names take precedence.

### Provider and model settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_PROVIDER` | `ollama` | `ollama` or any OpenAI-compatible alias |
| `CONTEXTPRO_API_KEY` | none | API key for the OpenAI-compatible path |
| `CONTEXTPRO_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint base URL |
| `CONTEXTPRO_EMBED_MODEL` | provider-specific | Embedding model for semantic retrieval |
| `CONTEXTPRO_CHAT_PROVIDER` | embedding provider | Optional chat-provider override |
| `CONTEXTPRO_CHAT_MODEL` | unset in recommended config | Optional chat model for hub labels and ambiguous planning reranks |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |

### Indexing and retrieval

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_EMBED_BATCH_SIZE` | `32` with Ollama, `8` remotely; clamped to 1–128 | Embedding inputs per request; reduce it on memory-constrained hardware |
| `CONTEXTPRO_EMBED_CHUNK_CHARS` | `2000`, clamped to 256–8000 | Max source chunk size for embedding |
| `CONTEXTPRO_EMBED_TRACKER` | `lazy` | Realtime update mode: `off`, `lazy`, or `eager` |
| `CONTEXTPRO_EMBED_TRACKER_DEBOUNCE_MS` | `700` | Delay before processing changed files |
| `CONTEXTPRO_EMBED_TRACKER_MAX_FILES` | `8` | Changed files processed per tracker tick |
| `CONTEXTPRO_RECONCILE_INTERVAL_MS` | `30000` | Background drift-repair interval |
| `CONTEXTPRO_RECONCILE_MAX_FILES` | `40` | Maximum repairs per reconciliation sweep |
| `CONTEXTPRO_AUTO_REFRESH` | `true` | Refresh changed files before structural graph reads |
| `CONTEXTPRO_REFRESH` | `stat` | `stat` fast path or `hash` for maximum freshness verification |
| `CONTEXTPRO_QUICKREFRESH_MAX_FILES` | `30` | Maximum stale files patched synchronously per request |
| `CONTEXTPRO_REINDEX_NO_EMBED` | `false` | Skip eager embeddings during reindex; semantic search becomes lazy/keyword-first |
| `CONTEXTPRO_AUTO_HUBS` | `false` | Generate chat-labeled feature hubs during reindex; opt in because it can call the chat model |
| `CONTEXTPRO_MAX_FILE_SIZE` | `5242880` | Skip indexing source files larger than this byte count |
| `CONTEXTPRO_MAX_EMBED_FILE_SIZE` | `51200` | Skip oversized text files during semantic-search embedding |

### Optional Ollama hardware tuning

These options apply only to Ollama embedding requests. Leave them unset unless you have measured a need.

| Variable | Purpose |
| --- | --- |
| `CONTEXTPRO_EMBED_NUM_GPU` | GPU layers/device count |
| `CONTEXTPRO_EMBED_MAIN_GPU` | Primary GPU index |
| `CONTEXTPRO_EMBED_NUM_THREAD` | CPU thread count |
| `CONTEXTPRO_EMBED_NUM_BATCH` | Ollama runtime batch size |
| `CONTEXTPRO_EMBED_NUM_CTX` | Ollama runtime context size |
| `CONTEXTPRO_EMBED_LOW_VRAM` | Enable low-VRAM mode (`true`/`false`) |

### Agent behavior, identity, and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTPRO_TOOL_PROFILE` | `full` | `workflow` has 12 daily tools; `core` adds editing/graphs; `full` includes all tools |
| `CONTEXTPRO_EFFICIENCY_FOOTER` | `false` | Show conservative, estimated response-token savings footers |
| `CONTEXTPRO_PROJECT_ID` | derived | Explicit project identity override |
| `CONTEXTPRO_CLIENT_ID` | none | Opt-in client grouping for cross-project memory |
| `CONTEXTPRO_SESSION_ID` | none | Session identity used to isolate session-scoped memory |
| `CONTEXTPRO_SESSION_SOURCE` | `mcp` | Session source stored with project and memory metadata |
| `CONTEXTPRO_NATIVE_AUTO_REPAIR` | `true` | Repair missing/incompatible bindings in an isolated ABI/version cache |
| `CONTEXTPRO_NATIVE_CACHE_DIR` | `~/.cache/contextpro/native` | Location of per-runtime native dependencies; shared installation stays unchanged |
| `CONTEXTPRO_IDLE_TIMEOUT_MS` | implementation default | Shut down an idle server after this duration |
| `CONTEXTPRO_PARENT_POLL_MS` | implementation default | Parent-process liveness polling interval |
| `CONTEXTPRO_ALLOW_UNSAFE_ROOT` | `false` | Permit dangerous root/home-level project roots |
| `CONTEXTPRO_INSTRUCTIONS_REMOTE` | `false` | Fetch agent instructions from a remote URL; enable only for a trusted endpoint |
| `CONTEXTPRO_INSTRUCTIONS_REMOTE_URL` | `https://contextpro.dev/api/instructions` | Remote instruction URL when the preceding flag is enabled |

Provider-specific historical names (`CONTEXTPRO_EMBED_PROVIDER`, `CONTEXTPRO_OPENAI_*`, `OLLAMA_EMBED_MODEL`, `OLLAMA_CHAT_MODEL`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL`) remain compatible. Prefer the canonical variables above in new configurations.

## Common problems

- **`NODE_MODULE_VERSION` mismatch:** run the server with the Node major that installed it, or run `npm rebuild better-sqlite3 sqlite-vec` in a local checkout. Automatic repair is off by default; `doctor --fix` is the explicit repair path.
- **Ollama cannot be reached:** start `ollama serve`, pull `nomic-embed-text`, then restart the MCP server. Structural tools remain available while it is down.
- **Search is not semantic:** inspect `status`; reindex after a provider/model change and confirm that the embedding model is installed or that the hosted endpoint accepts `/embeddings`.
- **Wrong repository results in a worktree:** set the absolute worktree root in MCP configuration or pass `root` explicitly to the tools.
- **A configuration includes a key:** remove it from committed config, rotate the key if exposed, and inject it through the client or OS secret mechanism.

## Make agents use ContextPro first

`contextpro init <agent>` now merges the ContextPro server into existing JSON
configuration without replacing other servers or an already customized ContextPro
entry. It installs a small managed section in `AGENTS.md`; Claude setup also
installs it in `CLAUDE.md`. Existing rules outside the marked section remain intact,
and rerunning init updates that section without duplicating it. `--root` targets a
specific project; `--no-agent-instructions` skips the instruction installation.
Malformed JSON or malformed managed markers produce an error instead of discarding
user configuration. Existing customized server profiles are preserved; change
`CONTEXTPRO_TOOL_PROFILE` to `workflow` manually to adopt the smaller menu.

The section tells agents to use ContextPro first for repository discovery, inspect
impact before shared-code changes, validate afterward, and quote the session
`efficiency_report` once in their final answer. Agents must still fall back when
the server is unavailable or its evidence is incomplete. MCP instructions guide
host behavior; the server cannot force every client to follow them. Clients that
do not read AGENTS.md should receive the same section in their native project rules.

Session savings are estimates against a full-file baseline. Supply the actual
model input rate to calculate a hypothetical dollar amount. Without that rate,
the report says cost is unavailable. ContextPro does not infer revenue or claim
access to the coding agent's billing account. See [the agent guide](agent-guide.md)
for exact assumptions, context-delta recovery, and mutation guarantees.
