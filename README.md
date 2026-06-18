# ContextPro MCP

Code intelligence for coding agents.

ContextPro gives Codex, Claude Code, Antigravity, OpenCode, and other MCP clients a compact map of a real codebase: semantic search, AST structure, exact TypeScript/JavaScript references, impact analysis, validation guidance, project memory, and safe restore points. The goal is simple: help agents change code with less guessing and fewer wasted tokens.

ContextPro is a private fork and expanded evolution of [Context+](https://github.com/ForLoopCodes/contextplus), with additional planning, graph intelligence, project isolation, packaging, safety, and workflow features.

## Why It Helps

- **Start faster**: `start_task`, `repo_map`, and `tree` give an agent the useful shape of a repo without reading every file.
- **Edit with context**: `plan_edit`, `skeleton`, `search`, `resolve_symbol`, and `blast_radius` narrow changes to the right files and symbols.
- **Validate the right thing**: `validate`, `lint`, `test_map`, and `related` recommend focused checks instead of blindly running everything.
- **Keep memory**: `remember`, `memory_search`, and artifacts preserve useful project context across sessions.
- **Recover safely**: `checkpoint`, `checkpoints`, and `restore` create shadow restore points without touching git history.

## Install

Use the published package:

```bash
npx -y contextpro-mcp
```

Or with Bun:

```bash
bunx contextpro-mcp
```

For a local checkout:

```bash
npm install
npm run build
node build/index.js doctor --root /absolute/path/to/project
```

## Recommended Local Ollama Setup

Ollama settings belong in the MCP `env` block, not in `args`. `args` should only start ContextPro and optionally pass ContextPro flags like `--root`.

This local setup has these useful models available:

- Embeddings: `mxbai-embed-large:latest`, `nomic-embed-text:latest`
- Local chat labeling: `gemma4:12b`
- Cloud chat options also present: `minimax-m3:cloud`, `nemotron-3-ultra:cloud`, `kimi-k2.6:cloud`, `glm-5.1:cloud`

Recommended local config:

```json
{
  "CONTEXTPLUS_EMBED_PROVIDER": "ollama",
  "OLLAMA_EMBED_MODEL": "nomic-embed-text:latest",
  "OLLAMA_CHAT_MODEL": "nemotron-3-ultra:cloud",
  "CONTEXTPLUS_EMBED_TRACKER": "lazy"
}
```

Local Ollama does not need an API key. Ollama Cloud models such as `nemotron-3-ultra:cloud` require Ollama Cloud access; if you want fully local chat, set `OLLAMA_CHAT_MODEL=gemma4:12b` or any chat model from `ollama list`.

If users do not have Ollama, install it first:

```bash
brew install --cask ollama
```

Then install the recommended models and start Ollama:

```bash
ollama pull nomic-embed-text:latest
ollama pull nemotron-3-ultra:cloud
ollama serve
```

If a model is missing, ContextPro tells the user which `ollama pull ...` command to run. Users can use any Ollama models they prefer by changing `OLLAMA_EMBED_MODEL` and `OLLAMA_CHAT_MODEL` to names from `ollama list`.

## MCP Configs

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.contextpro]
command = "npx"
args = ["-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"]

[mcp_servers.contextpro.env]
CONTEXTPLUS_EMBED_PROVIDER = "ollama"
OLLAMA_EMBED_MODEL = "nomic-embed-text:latest"
OLLAMA_CHAT_MODEL = "nemotron-3-ultra:cloud"
CONTEXTPLUS_EMBED_TRACKER = "lazy"
```

For a local checkout, replace the command with:

```toml
command = "node"
args = ["/absolute/path/to/contextpro-mcp/build/index.js", "--root", "/absolute/path/to/your/project"]
```

### Claude Code and Antigravity

Use the standard `mcpServers` format:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text:latest",
        "OLLAMA_CHAT_MODEL": "nemotron-3-ultra:cloud",
        "CONTEXTPLUS_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

Common config files:

- Claude Code: `.mcp.json`
- Antigravity: project or user MCP config using `mcpServers`

### OpenCode

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "contextpro": {
      "type": "local",
      "command": ["npx", "-y", "contextpro-mcp", "--root", "/absolute/path/to/your/project"],
      "enabled": true,
      "environment": {
        "CONTEXTPLUS_EMBED_PROVIDER": "ollama",
        "OLLAMA_EMBED_MODEL": "nomic-embed-text:latest",
        "OLLAMA_CHAT_MODEL": "nemotron-3-ultra:cloud",
        "CONTEXTPLUS_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

You can also generate starter config files:

```bash
npx -y contextpro-mcp init claude
npx -y contextpro-mcp init opencode
```

## Core Workflow

For coding agents, the intended loop is:

1. `start_task` or `plan_edit` to scope the work.
2. `skeleton`, `search`, `resolve_symbol`, or `blast_radius` to inspect only what matters.
3. Edit the code.
4. `validate` or `lint` to run focused checks.
5. `remember` to store what was learned.

## Tool Highlights

| Tool | Use it for |
| --- | --- |
| `start_task` | First packet for a task: ranked files, tests, memory, risks, artifacts. |
| `plan_edit` | Smallest likely safe edit set. |
| `search` | Semantic and keyword code search. |
| `skeleton` | Function/type signatures without reading full files. |
| `blast_radius` | Where a symbol is used before renaming or deleting it. |
| `impact` | What may break if files or symbols change. |
| `validate` | Focused validation commands for the change. |
| `remember` | Persist task outcomes and project knowledge. |

## Data and Compatibility

Project data is stored under `.contextpro/`. Existing `.contextplus/` or `.mcp_data/` data is moved into `.contextpro/` automatically on first startup. Environment variables keep the `CONTEXTPLUS_*` prefix for compatibility. The MCP package and server name are `contextpro-mcp` / `contextpro`.

## Other Embedding Providers

Set `CONTEXTPLUS_EMBED_PROVIDER=openai` to use OpenAI-compatible embeddings instead of Ollama:

```json
{
  "CONTEXTPLUS_EMBED_PROVIDER": "openai",
  "CONTEXTPLUS_OPENAI_API_KEY": "YOUR_KEY",
  "CONTEXTPLUS_OPENAI_BASE_URL": "https://api.openai.com/v1",
  "CONTEXTPLUS_OPENAI_EMBED_MODEL": "text-embedding-3-small"
}
```

Gemini, OpenAI, vLLM, and LiteLLM-style endpoints work as long as they expose the OpenAI embeddings API.
