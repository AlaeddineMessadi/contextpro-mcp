# Install ContextPro

These instructions target the current checkout. Use the local build to get changes under review; do not assume an npm package with the same version contains them. Use Node.js 24 LTS and npm; the package engine range is 20–26. Install from source until a registry release is announced.

## Local build

```sh
git clone https://github.com/AlaeddineMessadi/contextpro-mcp.git
cd contextpro-mcp
npm ci
npm run build
node build/index.js doctor --root /absolute/path/to/target-project
```

Keep the actual Node executable path printed by `node -p 'process.execPath'`. Using it in all clients avoids differences between an interactive shell's Node and a desktop client's PATH. The server repairs incompatible SQLite dependencies in an isolated cache for the launching Node ABI. First repair requires npm and network access; see [native-module recovery](#native-module-recovery).

The target root is the repository being indexed, which can differ from the ContextPro checkout. Add `.contextpro/` to that project's `.gitignore`. The directory also contains memory and restore points; it is not entirely disposable.

## Client configuration

Replace all placeholder paths. These examples launch the same local build and use the default workflow profile. Set the profile to `lean` for three initially advertised tools. Existing custom credentials and settings should be preserved.

### Codex

Merge this entry into the applicable Codex configuration, such as `~/.codex/config.toml`:

```toml
[mcp_servers.contextpro]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/contextpro-mcp/build/index.js", "--root", "/absolute/path/to/target-project"]

[mcp_servers.contextpro.env]
CONTEXTPRO_TOOL_PROFILE = "workflow"
CONTEXTPRO_PROVIDER = "ollama"
CONTEXTPRO_EMBED_MODEL = "nomic-embed-text:latest"
```

### Claude Code

Merge into the target project's `.mcp.json`:

```json
{
  "mcpServers": {
    "contextpro": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/contextpro-mcp/build/index.js", "--root", "/absolute/path/to/target-project"],
      "env": {
        "CONTEXTPRO_TOOL_PROFILE": "workflow",
        "CONTEXTPRO_PROVIDER": "ollama",
        "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest"
      }
    }
  }
}
```

### OpenCode

Merge into `opencode.json`:

```json
{
  "mcp": {
    "contextpro": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/contextpro-mcp/build/index.js", "--root", "/absolute/path/to/target-project"],
      "enabled": true,
      "environment": {
        "CONTEXTPRO_TOOL_PROFILE": "workflow",
        "CONTEXTPRO_PROVIDER": "ollama",
        "CONTEXTPRO_EMBED_MODEL": "nomic-embed-text:latest"
      }
    }
  }
}
```

Restart the client after changes. A reconnect can reuse a cached launch command; `health` identifies the running executable and parser backend. Enable `health` through `discover_tools` if it is absent from the selected catalog.

### Generated starters and packaged installs

The CLI can generate starter configurations and managed project instructions:

```sh
node /absolute/path/to/contextpro-mcp/build/index.js init claude --root /absolute/path/to/target-project --runner npx
node /absolute/path/to/contextpro-mcp/build/index.js init opencode --root /absolute/path/to/target-project --runner npx
```

Starters use a package runner, even when generated from a local checkout. Replace the generated launch command with the local examples above to run unreleased code. For a registry install, first verify access to the intended published package and pin its version deliberately.

`init` merges JSON without replacing other servers or an existing customized ContextPro entry. It installs a managed `AGENTS.md` section and, for Claude, a `CLAUDE.md` section. `--no-agent-instructions` skips those sections. Repeated init preserves custom rules outside the markers. Codex configuration is manual; do not assume every client is supported by the generator.

## Verify once

1. Restart the client and confirm the expected server is connected.
2. Call `status` to inspect the root and index. In lean mode, enable it with `discover_tools(enable:["status"])`.
3. Read a known small source target with `context` in lean mode, or `explain` in workflow mode.
4. For first-time indexing or reported drift requiring a rebuild, enable/call `reindex`. `no_embed:true` builds structural evidence without eager corpus embeddings.

This is installation diagnosis, not a checklist for every coding task. Missing embeddings do not disable structural tools. For retrieval with no query embedding attempt, use `search(preset:"keyword_only")` or direct `context(targets:[...])`.

## Optional model setup

For local semantic retrieval, install and start Ollama, then pull the configured embedding model, for example `nomic-embed-text`. ContextPro needs its own embedding endpoint; it does not reuse a Claude or Codex session.

Chat-assisted operations are optional. Leave `CONTEXTPRO_CHAT_RERANK` and `CONTEXTPRO_AUTO_HUBS` off unless needed. Hosted credentials can make a default chat model available even without an explicit chat-model setting, so omitting that setting is not a universal network-off switch. See [provider settings](docs/configuration.md#providers).

## Native-module recovery

On a `NODE_MODULE_VERSION` or ABI mismatch, inspect the executable named by the error and run doctor with that same executable:

```sh
/absolute/path/to/node /absolute/path/to/contextpro-mcp/build/index.js doctor --fix --root /absolute/path/to/target-project
```

Automatic isolated repair is enabled by default. `CONTEXTPRO_NATIVE_AUTO_REPAIR=false` disables it; `doctor --fix` provides the explicit repair path. The cache defaults to `~/.cache/contextpro/native` and separates ABI, platform, architecture, libc and dependency versions. `CONTEXTPRO_NATIVE_CACHE_DIR` can give multiple clients using the same runtime a stable location.

Do not rebuild shared `node_modules` merely to satisfy one client: clients using another Node ABI can then break. After repair, restart the failing client. If offline and no compatible binding is installed or cached, restore access to the matching runtime/cache before expecting storage operations to work.

## Worktrees and common problems

- **Wrong repository/worktree:** subagents must pass their absolute worktree `root` on every call. Shell `cd` does not retarget a shared MCP server. Linked worktrees require explicit roots, including reindex calls; verify the chosen checkout before attempting recovery. Client-advertised roots may describe the parent agent.
- **Stale embeddings:** check provider/model settings, then reindex. Interactive search does not rebuild the whole vector corpus.
- **Slow or failed calls:** inspect `health` and `status`; use bounded results and keyword-only discovery when the provider is unavailable. Do not loop blindly on connection errors.
- **Agent ignores MCP:** install concise project rules from [INSTRUCTIONS.md](INSTRUCTIONS.md). Prefer MCP when it adds useful context; allow native reads for tiny known targets and incomplete evidence.
- **Disk growth:** follow [maintenance](docs/maintenance.md). Preserve memory and restore points while cleaning regenerable artifacts.
