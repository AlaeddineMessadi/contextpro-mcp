# Maintenance and cleanup

## Build and validate

The MCP root, `landing/` and `dashboard/` use npm lockfiles. The apps remain optional. Use Node to launch MCP and the same executable across clients where possible. The full test suite also needs Git and ripgrep (`rg`) for its offline native-search baseline; see [contributor setup](https://github.com/AlaeddineMessadi/contextpro-mcp/blob/main/CONTRIBUTING.md#development-setup).

```sh
npm ci
npm run build
npm test
npm run docs:check
npm pack --dry-run
```

If tests use temporary HOME directories and Node differs from the shared native installation, pin the existing isolated cache explicitly:

```sh
CONTEXTPRO_NATIVE_CACHE_DIR="$HOME/.cache/contextpro/native" npm test
```

Repair a missing compatible cache with the failing runtime's `doctor --fix`; do not rebuild shared native modules for one client. `test:demo` and `test:all` include optional demo/provider scenarios; inspect their requirements before running them. The maintained `test/main/` suite replaces the removed one-off `scripts/autonomous-verify.mjs` audit probe.

Direct imports of built tool modules inherit the shell environment, not the MCP client's configuration. When validating a real project, use the client's provider/model settings as well as its Node runtime: a different model identity can clear regenerable vectors. Prefer temporary fixtures for isolated probes.

## Recover semantic search

A fresh structural index means files, symbols and imports are current. Automatic
query refreshes intentionally skip corpus embeddings. They do not populate a
missing semantic index. A semantic rebuild under a different provider/model
invalidates incompatible vectors, including when the models share a dimension.
Structural-only refreshes preserve the existing vector-space identity; workers
with a different model use lexical evidence instead of comparing incompatible vectors.

Use the same intended embedding provider/model in each client. Inspect
`status({root:"/absolute/project/root",format:"json"})`: check `embeddings`,
including the stored model, stale reason, counts, skipped flag and last error.
With that provider available, run
`reindex({root:"/absolute/project/root",no_embed:false,auto_hubs:false})`.
Also unset `CONTEXTPRO_REINDEX_NO_EMBED`, which overrides the argument.
In the lean catalog, discover the current schema with
`discover_tools({root:"/absolute/project/root",enable:["status","reindex"]})`;
if the client does not refresh its catalog, execute through
`discover_tools({root:"/absolute/project/root",call:{name:"reindex",arguments:{no_embed:false,auto_hubs:false}}})`.

Rebuild each affected project/worktree once. Large local corpora can take several
minutes. If a client times out, check status for an ongoing rebuild before starting
another one. After completion, verify nonzero file/identifier vectors, no stale
flag or embedding error, and replay a representative query. A weak semantic match
with healthy vectors alone is not a reason to rebuild. Existing MCP processes need
reconnecting to load new server code or changed client model settings.

## Documentation source of truth

- `README.md`: concise entry point; link to detailed guides instead of repeating every environment setting.
- `INSTALL.md` and `docs/configuration.md`: launch/setup and current defaults.
- `agent-instructions.md`: tiny manifest hint; keep it under the existing regression-test limit.
- `agent-guide.md`: detailed MCP instructions resource.
- `INSTRUCTIONS.md`: project policy, also used by the website copy panel and `/api/instructions`.
- `STATUS.md` / `TODO.md`: current state and pending work. Historical results belong in dated reports.

After changing `INSTRUCTIONS.md`, run `npm run docs:sync`. This generates `landing/src/generated/agent-instructions.json`; do not hand-edit it. Landing npm lifecycle hooks also synchronize it before `dev`, `build`, `cf:build`, `cf:preview`, and `cf:deploy`. Invoke these npm scripts rather than the underlying Next.js/OpenNext CLIs to run the hooks. JSON imports keep the route usable in deployments that cannot read the repository filesystem at request time. `npm run docs:check` verifies synchronization and local links in current documentation.

Keep `AGENTS.md` and `CLAUDE.md` aligned with the managed template in `src/core/agent-setup.ts` if changing the installer policy. Never expand the manifest into the full guide merely for convenience.

## What can be removed

| Path/data | Cleanup rule |
| --- | --- |
| `.DS_Store`, temporary logs, `*.tsbuildinfo` | Regenerable metadata; remove when not needed for diagnosis |
| `landing/.next/`, `dashboard/.next/`, build-tool caches | Stop the corresponding development server before removal |
| `build/` | Rebuildable, but live MCP workers load files here; stop clients before deleting |
| `graft/` | Regenerable structural index; keep it while active agents use it |
| `node_modules/` | Reinstallable, but active clients/apps depend on it; do not purge during this review |
| `.contextpro/` | **Mixed durable state and caches. Do not delete wholesale.** Inspect artifacts, memory, configuration and restore points separately |
| `~/.cache/contextpro/native` | Shared per-runtime native bindings; removing live runtimes' entries can break clients or force repairs |
| Dated benchmark JSON and incident reports | Retain evidence; old paths in raw records are historical observations |

Use the `gc` tool's own current schema and inspect its result when reclaiming supported artifacts/restore points. Do not infer that every old file is safe to delete. The dashboard and landing source remain useful independent applications and are not unused MCP dependencies.

## This cleanup

Removed an obsolete root Bun lockfile naming `better-agent-mcp`, the duplicate landing Bun lockfile, five unused Next starter SVGs, an empty tracked Claude settings file, and the one-off audit probe superseded by regression tests. Removed local Finder metadata only; active builds, indexes, dependencies, native caches, memory and backups were retained.

Moved April designs, the early Context+ roadmap, September PR #8 plans and the legacy TODO into `docs/archive/`, with historical labels. Raw benchmark evidence remains intact. Website instruction copies now derive from a single file; installation examples no longer recommend rebuilding shared native dependencies or force extra MCP calls.
