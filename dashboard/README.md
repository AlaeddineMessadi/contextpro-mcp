# ContextPro Dashboard

A live operational dashboard for the ContextPro MCP server. It reads each project's
`.contextpro/index.db` (SQLite, WAL mode — safe to read while the MCP writes) and
shows what's happening inside the index.

## Panels

- **Index & Health** — index state (fresh/stale/indexing), indexed vs missing/removed
  files, generation, embeddings provider/model/dimension/count, memory node/edge
  counts, git branch + uncommitted, and any freshness warnings.
- **Tool Activity & History** — which MCP tools were called, how often, latency
  (avg/max), error rate, and a recent-calls timeline. *(Persisted by the MCP server
  to a `tool_calls` table, so it survives restarts.)*
- **Code Graph** — interactive import structure; node size = how many files import
  it (a PageRank-style importance proxy). Most-depended-on files listed alongside.
- **Memory Graph** — the agent memory graph (nodes + typed edges), sized by access
  count, with relation-type distribution.

A **project switcher** enumerates every workspace from `~/.contextpro/workspace-registry.json`,
and the page **auto-refreshes** status + tool activity every few seconds.

## Run

```bash
cd dashboard
bun install        # or npm install
bun run dev        # → http://localhost:6868
```

The dashboard imports the MCP's built modules from `../build`, so build the MCP first
(`npm run build` in the repo root) if you haven't.

### Configuration (env)

- `CONTEXTPRO_MCP_ROOT` — path to the contextpro-mcp repo (defaults to the parent of
  the dashboard's cwd; only needed if you run the dashboard from elsewhere).
- `CONTEXTPRO_DASHBOARD_ROOT` — pin the default project root shown when no `?root=`
  is supplied (otherwise the first indexed project from the registry is used).

## Notes

- **Tool history requires the MCP server running this build.** Tool-call persistence
  was added alongside this dashboard; restart your MCP server on this branch so it
  begins logging calls to `tool_calls`. Until then the Tool Activity panel shows 0.
- It's a **local operator tool**, not a deployed site — it reads local SQLite files.
