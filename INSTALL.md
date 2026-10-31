# Install ContextPro

ContextPro is published on npm as `contextpro-mcp`, and every client below starts it with `npx`. To run unreleased code from a checkout, see [Run from source](#run-from-source).

## Prerequisites

- Node.js 20–26 (24 LTS recommended) and npm. No API key or Ollama needed.
- For TypeScript/JavaScript compiler references, install the target project's dependencies (`npm install`). Without them, `tsconfig` `extends` and type packages don't resolve, and files can't be checked.

The examples use the unpinned package so they don't go stale. Teams that want reproducible setups can pin a release with `contextpro-mcp@<version>`.

## Connect your client

The "project root" is the repository ContextPro indexes. Without `--root`, the root is the directory the client starts the server in. ContextPro refuses to start in `/` or in your home folder itself. A project folder directly inside your home folder (for example `~/myapp`) is accepted when it is a Git repository (has `.git`); a non-repository folder there (for example `~/Downloads`) is refused unless `CONTEXTPRO_ALLOW_UNSAFE_ROOT=true`. Global configs and GUI apps often start servers from your home folder, so they should pass `--root`.

### Claude Code

Just for you, in one project:

```sh
cd your-project
claude mcp add contextpro -e CONTEXTPRO_TOOL_PROFILE=lean -- npx -y contextpro-mcp --root "$PWD"
claude mcp list   # contextpro: ... ✔ Connected
```

Put the server name before `-e`. The `-e` flag takes several values, so a name after it is read as an environment variable and the command fails with `Invalid environment variable format`.

For a team, commit the config and the agent instructions:

```sh
cd your-project
npx -y contextpro-mcp init claude   # writes .mcp.json, AGENTS.md and CLAUDE.md
claude
```

Claude Code asks once to approve servers from a project `.mcp.json`. Until you start `claude` in the project and accept, `claude mcp list` shows "Pending approval". The generated config has no `--root`, so the root is the directory where you start `claude`: start it in the repository root. Started in a subdirectory, ContextPro silently indexes only that subdirectory. The same applies to any config without `--root`, such as OpenCode's `opencode.json`.

### Codex

```sh
codex mcp add contextpro --env CONTEXTPRO_TOOL_PROFILE=lean -- npx -y contextpro-mcp
```

Codex reads `~/.codex/config.toml` by default (`$CODEX_HOME/config.toml` if set). That config is shared by every project, so don't add `--root` to it: every Codex session would then use that one repository. Codex starts the server in the folder where you start `codex`, so start it in your repository root. Started from your home folder, ContextPro refuses to start rather than index it. The command writes:

```toml
[mcp_servers.contextpro]
command = "npx"
args = ["-y", "contextpro-mcp"]

[mcp_servers.contextpro.env]
CONTEXTPRO_TOOL_PROFILE = "lean"
```

`codex mcp list` only prints the config; it does not start the server. Use the [smoke test](#verify) to check it starts. `Auth: Unsupported` is normal for a local (stdio) server.

### Cursor and other `mcpServers` JSON clients

For Cursor, run `npx -y contextpro-mcp init cursor` in your project. It writes `.cursor/mcp.json` with `--root ${workspaceFolder}`, which Cursor expands to the project folder (documented by Cursor; not yet verified inside Cursor by us). GUI apps may start servers from your home folder, so the explicit workspace root matters there.

For other clients, put this in the project's own config file:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "npx",
      "args": ["-y", "contextpro-mcp"],
      "env": { "CONTEXTPRO_TOOL_PROFILE": "lean" }
    }
  }
}
```

Add `--root` only if the client starts servers outside the project, and then prefer the client's workspace variable (such as `${workspaceFolder}`) over a fixed path. Never put a fixed `--root` in a global or user-level config: every project would then use that one repository. If a client passes an unexpanded `${...}` variable as `--root`, ContextPro ignores it and uses the launch directory.

### OpenCode

```sh
cd your-project
npx -y contextpro-mcp init opencode   # writes opencode.json and AGENTS.md
opencode mcp list
```

### VS Code

```sh
cd your-project
npx -y contextpro-mcp init vscode   # writes .vscode/mcp.json
```

The generated file uses VS Code's format (`servers`, `type: "stdio"`, `--root ${workspaceFolder}`). This setup has not yet been verified inside VS Code.

### What `init` does

`npx -y contextpro-mcp init <claude|cursor|vscode|windsurf|opencode>` writes the client's project config with the `lean` profile and adds a managed ContextPro section to `AGENTS.md` (and `CLAUDE.md` for Claude). The VS Code and Cursor targets write `--root ${workspaceFolder}`; the Claude and OpenCode targets write no `--root`. The Windsurf target writes `.windsurf/mcp.json` and has not been verified inside Windsurf.

- It merges JSON without replacing other servers or an existing customized ContextPro entry.
- It also creates `.contextpro/config.json` (provider defaults and project identity), which the auto-written `.contextpro/.gitignore` covers.
- `AGENTS.md` gets a managed block at the top and existing content is preserved. `CLAUDE.md` gets the same block, so Claude Code may read it twice.
- Running it again is idempotent and preserves your own rules outside the managed markers.
- `--no-agent-instructions` skips `AGENTS.md`/`CLAUDE.md`; `--runner bunx` uses Bun instead of npx; `--root <dir>` targets another directory.

The agent instructions matter: the MCP config exposes the tools, while `AGENTS.md`/`CLAUDE.md` tells the agent when to use them. The full workflow is served on demand as `contextpro://instructions`. To add the instructions by hand, copy [INSTRUCTIONS.md](INSTRUCTIONS.md). A separate skill is optional; it does not enable tools or repair retrieval.

ContextPro keeps its local state in `.contextpro/` and writes a `.contextpro/.gitignore` itself, so you don't need to change your `.gitignore`. Older versions: add `.contextpro/` to your .gitignore.

## Verify

Smoke test for any client. Run it in your project; it starts the server, lists its tools and exits:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | CONTEXTPRO_TOOL_PROFILE=lean npx -y contextpro-mcp --root "$PWD" 2>/dev/null | grep -o '"name":"[a-z_]*"'
# expect four lines: "name":"contextpro" (the server info), then "name":"context", "name":"discover_tools", "name":"exact_references"
```

Check storage with `doctor`:

```sh
npx -y contextpro-mcp doctor --root /absolute/path/to/project
```

Expect `Before: ok | storage=true | dbOpen=true` and `After: ok | …`. "Fix Applied: no" only means you didn't pass `--fix`.

`npx -y contextpro-mcp --help` lists the commands, and `--version` prints the installed version.

In the client, a first read looks like this. Use a line range: a whole file larger than `max_tokens` is omitted rather than cut.

```js
context({ root: "/absolute/path/to/project", targets: [{ file: "src/index.ts", start: 1, end: 40 }], max_tokens: 1500 })
```

Replace `src/index.ts` with a file in your project. For callers of a symbol:

```js
exact_references({ root: "/absolute/path/to/project", file: "src/lib/foo.ts", symbol_name: "foo" })
```

Without Ollama, `context()` results include a "Discovery used lexical fallback" notice. That is expected and doesn't affect `exact_references`.

To inspect the index, enable `status` with `discover_tools(enable:["status"])`. If the tool doesn't appear (some clients don't refresh their tool list), call it through `discover_tools({ root, call: { name: "status", arguments: {} } })`. For first-time indexing, or drift that needs a rebuild, enable and call `reindex`; `no_embed:true` builds structural data without embeddings. This is installation diagnosis, not something to run on every task.

## Optional setup

### Workflow profile

`CONTEXTPRO_TOOL_PROFILE` picks the starting tool list. `lean` (3 tools) is recommended. `workflow` (14 tools for discovery, reads, impact and validation) is the server default when no profile is set; `core` has 39 and `full` all 68. See [profiles](docs/configuration.md#profiles).

### Semantic search with Ollama

Embeddings are optional. ContextPro tries a local Ollama at `OLLAMA_HOST` (default `http://127.0.0.1:11434`) automatically and falls back to keyword search when it's unavailable. Compiler references and structural search work either way. To enable semantic search, install Ollama and run `ollama pull nomic-embed-text`.

The defaults are already provider `ollama` and model `nomic-embed-text:latest`; set them explicitly only to pin or change them:

```json
"env": {
  "CONTEXTPRO_TOOL_PROFILE": "lean",
  "CONTEXTPRO_PROVIDER": "ollama",
  "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest"
}
```

The `CONTEXTPRO_PROVIDER` and `CONTEXTPRO_EMBED_MODEL` lines above are the defaults. ContextPro needs its own embedding endpoint; it does not reuse a Claude or Codex session. Reindex after changing the model. For structural-only indexing with no embeddings, set `CONTEXTPRO_REINDEX_NO_EMBED=true` or pass `no_embed:true` to `reindex`.

Chat-assisted operations are optional. Leave `CONTEXTPRO_CHAT_RERANK` and `CONTEXTPRO_AUTO_HUBS` off unless needed. Hosted credentials can make a default chat model available even without an explicit chat-model setting, so omitting that setting is not a network-off switch. See [provider settings](docs/configuration.md#providers).

## Run from source

```sh
git clone https://github.com/AlaeddineMessadi/contextpro-mcp.git
cd contextpro-mcp
npm ci
npm run build
node build/index.js doctor --root /absolute/path/to/your-project
node -p 'process.execPath'
```

Use the printed Node executable and your checkout path in the client config. Using the same executable in every client avoids differences between your shell's Node and a desktop client's PATH. For example, in a Claude Code `.mcp.json`:

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

Restart the client after changes. A reconnect can reuse a cached launch command; `health` (enable it through `discover_tools`) shows the running executable and parser backend. The server repairs incompatible SQLite bindings in an isolated cache for the launching Node ABI; the first repair needs npm and network access.

## Native-module recovery

On a `NODE_MODULE_VERSION` or ABI mismatch, inspect the executable named by the error and run doctor with that same executable:

```sh
/absolute/path/to/node /absolute/path/to/contextpro-mcp/build/index.js doctor --fix --root /absolute/path/to/target-project
```

Automatic isolated repair is enabled by default. `CONTEXTPRO_NATIVE_AUTO_REPAIR=false` disables it; `doctor --fix` provides the explicit repair path. The cache defaults to `~/.cache/contextpro/native` and separates ABI, platform, architecture, libc and dependency versions. `CONTEXTPRO_NATIVE_CACHE_DIR` can give multiple clients using the same runtime a stable location.

Do not rebuild shared `node_modules` merely to satisfy one client: clients using another Node ABI can then break. After repair, restart the failing client. If offline and no compatible binding is installed or cached, restore access to the matching runtime/cache before expecting storage operations to work.

## Worktrees and common problems

- **`npm warn deprecated prebuild-install@7.1.3` from npx:** expected; it comes from a native dependency and does not affect ContextPro.
- **`Unsafe project root` at startup:** the server was started in `/`, in your home folder, or in a non-Git folder directly inside it, usually without `--root`. Start the client in your project folder, or add `--root` to that project's own config (never to a global one). If your project sits directly in your home folder and is not a Git repository, move it one level deeper, run `git init`, or set `CONTEXTPRO_ALLOW_UNSAFE_ROOT=true`.
- **`exact_references` finds nothing and warns that files could not be checked:** install the target project's dependencies (`npm install`) and retry.
- **Tools absent after a startup failure:** run the configured command directly to read stderr. From source, `ERR_MODULE_NOT_FOUND` with a missing `node_modules` means the checkout is incomplete: run `npm ci` and `npm run build` with the configured Node, then restart the client. Keep the checkout's dependencies and build while clients use it.
- **Wrong repository or worktree:** subagents must pass their absolute worktree `root` on every call. A shell `cd` does not retarget a shared MCP server. Linked worktrees require explicit roots, including for `reindex`. Client-advertised roots may describe the parent agent.
- **Local state:** `.contextpro/` in the project holds the index, memory and restore points. It is not entirely disposable; follow [maintenance](docs/maintenance.md) before deleting it. `~/.contextpro` holds the workspace registry and `~/.cache/contextpro` the native-binding cache.
- **Stale embeddings:** check provider and model settings, then reindex. Interactive search does not rebuild the whole vector corpus.
- **Slow or failed calls:** inspect `health` and `status`; use bounded results and keyword-only discovery when the provider is unavailable. Do not loop on connection errors.
- **Agent ignores ContextPro:** install the project rules with `init` or from [INSTRUCTIONS.md](INSTRUCTIONS.md).
