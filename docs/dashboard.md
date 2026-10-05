# Local development console

Use Node 24 or newer for the dashboard regression tests. Build the MCP first, then start the dashboard on loopback:

```sh
npm run build
cd dashboard
npm ci
npm run test
npm run build
npm run start
```

Open `http://127.0.0.1:6868`. This is a local operator app with access to local
indexes. Keep it on loopback; it is not a public authenticated service.

The workspace picker searches project names and full paths. It defaults to
projects with an existing index and remembers the last selected workspace in
browser storage. Enable **Include projects without an index** to inspect older
registry entries. Missing folders remain in the registry and cannot be indexed
from the UI. Paths distinguish separate worktrees with the same project name.

- **Overview** shows source readiness, recent calls, and search readiness.
- **Activity** filters the latest 200 recorded calls by tool and result. Tool
  timing aggregates cover all recorded history; source-output estimates are
  separate, expandable details and are not billing savings.
- **Index** shows languages, symbols, source coverage, and maintenance actions.
  **Update index** processes changed files. **Advanced** exposes a full rebuild.
  Actual indexing results report processed/skipped files and measured duration;
  total repository size is never used to estimate incremental throughput.
- **Graph** loads code and memory relationships on demand. The code view caps
  its display at 200 connected files. Search highlights nodes; the labeled node
  selector provides keyboard access to the same connection details as the graph.
- **Resources** samples matching processes across the machine, including MCP,
  Ollama, and Next.js. These are not measurements of the selected project alone.

The current view refreshes every five seconds when visible; graph and memory
refresh every 30 seconds. Each feed updates independently and shows its own
failure without blanking the other panels. The footer reports the oldest sample
used by the view, and failures retain the last successful data with its timestamp.
Changing projects cancels old reads and discards their late responses.

Pausing live updates keeps manual refresh available. Dashboard indexing jobs
continue to be polled while paused. Reloading recovers a running job from the
same dashboard process. Job tracking is in memory: after a server restart, refresh
source status before retrying. Source reads use the MCP's SQLite data access in
WAL mode. The build identity shown under **Configuration & build** describes the
dashboard reader's loaded modules, not the builds loaded by other MCP processes.

Set `CONTEXTPRO_DASHBOARD_ROOT` to include a specific indexed workspace. Set
`CONTEXTPRO_MCP_ROOT` if the dashboard must read built modules from another
ContextPro checkout. Fonts have local fallbacks when the optional web font cannot
be fetched; all index and activity data remains local.
