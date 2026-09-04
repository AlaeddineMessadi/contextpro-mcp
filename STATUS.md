# ContextPro MCP — Status

> Live state of the project: what's working, what's known-broken, what's in flight.
> Update on every release and after any audit. Pair with `CHANGELOG.md` (what changed, when) and `AUDIT.md` (deep findings).

**Last updated:** 2026-06-18
**Current version:** 1.2.2
**Branch:** `main`
**Node target:** `>=20 <27`

---

## At a glance

| Area | State | Notes |
|---|---|---|
| Core indexing (SQLite + sqlite-vec) | ✅ Stable | 768-dim vectors, FTS5 fallback, schema v4 |
| Walker / parser (tree-sitter + regex) | ✅ Stable | 36 langs via WASM grammars, regex fallback |
| Tool surface (48 tools) | 🟡 Working, slimming | 5 alias tools deprecated in 1.2.0 (still wired); new `grep` tool added in 1.2.2 |
| Memory graph | ✅ Stable | Auto-prune on access, decay-weighted edges |
| Embeddings (Ollama / OpenAI-compatible) | ✅ Stable | Lazy tracker, dim-drift now surfaced to clients |
| Restore points (`checkpoint` / `restore`) | ✅ Stable | JSON manifest under `.contextpro/backups/` |
| Project graph + SCIP import | ✅ Stable | Confidence tags: SCIP/LSP/AST/HEURISTIC/AMBIGUOUS |
| Exact references (TS/JS LSP) | ✅ Stable | LSP_RESOLVED evidence |
| Multi-project / multi-client | ✅ Stable | Workspace registry, scope-aware memory |
| Agent instructions resource | ✅ Stable | Now bundled locally; remote fetch optional |
| CLI subcommands (`init`, `doctor`, `tree`, `skeleton`) | ✅ Stable | Explicit exit codes after writes |
| Test suite | ✅ Green | Run `npm test` after `npm rebuild better-sqlite3` |

---

## Recent trajectory

- **1.2.2 — Dev-lifecycle audit fixes + literal grep.** Closes 8 issues from the 47-tool audit: empty-input validation across 25+ params, `change_impact` truncation explicit, `graph_query` not-found messaging, `reindex` non-existent target warning, `cluster` heuristic label fallback, `memory_delete` belt-and-suspenders edge cleanup. Adds the `grep` tool for fast literal/regex search.
- **1.2.1 — Verification follow-up.** All three findings from the 1.2.0 verification pass resolved: reindex eagerly populates embeddings, `status` warning disambiguated, dual-Node ABI quirk documented.
- **1.2.0 — Audit pass.** Comprehensive audit identified 25 issues across 5 severities. All Critical and High items resolved. New tracking docs (`STATUS.md`, `AUDIT.md`, expanded `CHANGELOG.md`) added so trajectory stays auditable.
- **1.1.0 — Agent workflow + graph intelligence.** Added `start_task`, `plan_edit`, `impact`, `validate`, `remember`. Portable graph export, `impact_delta`, exact references, SCIP import, FTS5 fallback.
- **1.0.x rebrand line.** Forked from Context+, renamed package and storage dir to `contextpro` with one-way migration from `.contextplus/` and `.mcp_data/`.

See `CHANGELOG.md` for the full entry-by-entry history.

---

## Known issues — open

None blocking. Two deferred items remain for 2.0:

- **`register-tools.ts` 1010 lines.** Co-locating Zod schemas with each tool will land in 2.0. (`AUDIT.md` 2026-06-18 #21.)
- **Project's own files violating its own lint rules.** Scope reduced to `src/tools/*`; full cleanup tracked in `TODO.md` v2. (`AUDIT.md` 2026-06-18 #18.)

---

## What's working well

- **Token efficiency.** `repo_map` + `skeleton` + `explain` reduce orientation-and-discovery context; `efficiency_report` now exposes the conservative estimate, per-tool history, and optional price scenario instead of presenting an unauditable headline alone.
- **Project safety.** All file-facing tools route through `resolveProjectPath` and reject path traversal. The `--root` flag is now also subject to unsafe-root checks (1.2.0).
- **Confidence signaling.** Every agentic tool emits a freshness/trust envelope (index generation, last-indexed time, evidence kind).
- **Reusable artifacts.** Tool outputs are content-addressed and retrievable by `artifact_list` / `artifact_read` so agents don't regenerate the same task pack twice.
- **Memory decay.** Edges decay with weight × `exp(-0.05 × days)`; stale edges and orphan nodes are pruned automatically before reads.

## What to watch

- **Embedding model drift.** Switching providers/models drops cached vectors. As of 1.2.0, callers see a one-cycle `embeddings stale` warning instead of silent degradation.
- **Reindex on huge repos.** Structural writes are single-writer and multi-process coordinated; normal reads use size/mtime probes and targeted refreshes, but a cold 5k+ file parse can still take minutes.
- **Skill-score lint.** Default output lists every issue. For large repos consider running `lint` with a `target_path` to keep output focused. Consolidating to top-N is a v2 item.
- **Lint targets running ContextPro itself.** Several `src/core/` files violate `max nesting 4`. The rule is advisory for now — an in-flight refactor is tracked as a v2 candidate.

## Known limitations (by design)

- **Single project per process.** Each MCP process pins to one `--root`. Multi-project orchestration uses the workspace registry and `workspace_context`, not a single shared index.
- **TS/JS LSP only for `exact_references`.** Other languages need a SCIP index imported via `scip_import`.
- **Symbol-level call graph is approximate** outside of TS/JS or SCIP-imported indexes — call-site rows are heuristic regex matches and tagged `HEURISTIC` in confidence metadata.

---

## Active work / v2 roadmap

Tracked in `TODO.md` (do not edit without human approval — agents only check off completed tasks).

- Cleaner alias tool surface (deprecated set in 1.2.0; full removal in 2.0).
- Optional `cli/` package using Charm Bubbletea.
- Smarter embedding watcher (promote `lazy` tracker to default, reduce reliance on `reindex`).
- ACP integration to import sessions/memories from peer agents.
- Better tree-sitter coverage and dedicated tooling.

---

## How to read this file

Three docs work together:

- **`STATUS.md` (this file)** — *current* shape of the project. What works, what's flagged, what's in flight. Update on every release and audit.
- **`CHANGELOG.md`** — *historical* per-version changes. Append on every release.
- **`AUDIT.md`** — *deep findings* from audits with evidence and verification status.
