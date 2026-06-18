# Changelog

All notable changes to this project are recorded here. The project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/) conventions. Pair with `STATUS.md` (live state) and `AUDIT.md` (deep findings with evidence).

## [Unreleased]

## [1.2.1] - 2026-06-18

Verification follow-up to 1.2.0. Three findings surfaced during the post-release audit are resolved.

### Fixed

- **Reindex eagerly populates embeddings.** `reindex` now fills `file_search_cache` and `identifier_cache` vector tables in the same pass that builds the structural index, instead of deferring to first `search` call. Cold first-search latency drops from ~120s to <1s on a 126-file repo. Pass `no_embed: true` to opt out, or set `CONTEXTPRO_REINDEX_NO_EMBED=true`. If embedding fails (Ollama unreachable), the structural index still completes and `status` surfaces the actual error. (`AUDIT.md` 2026-06-18 verification finding A, `src/tools/reindex.ts`)
- **`status` warning is disambiguated.** Instead of one generic "embeddings empty / Ollama unreachable" string, `status` now reports the actual cause from new `last_embed_skipped` / `last_embed_error` / `embeddings_stale` metadata: skipped via flag, last reindex error, never indexed, lazy-populating, or stale-flagged. The text output also shows the embedding provider/model and a `STALE` marker when applicable. (`AUDIT.md` 2026-06-18 verification finding B, `src/tools/status.ts`)
- **Node version requirement documented.** README now has a "Node version" subsection explaining the dual-Node ABI mismatch quirk, the auto-repair behavior, and how to manually repair (`npm rebuild better-sqlite3 sqlite-vec`). (`AUDIT.md` 2026-06-18 verification finding C, `README.md`)

### Added

- `no_embed` parameter on the `reindex` tool.
- `CONTEXTPRO_REINDEX_NO_EMBED` env var.
- Embedding provider/model and stale flag in `status` output.
- Per-reindex meta keys: `last_embed_files_populated`, `last_embed_identifiers_populated`, `last_embed_skipped`, `last_embed_error`.

## [1.2.0] - 2026-06-18

Comprehensive audit pass. All Critical and High findings from `AUDIT.md` 2026-06-18 are fixed. The release also adds tracking docs so the project's trajectory stays auditable.

### Fixed — Critical (mislead agents or break tools today)

- **`blast_radius` no longer skips the entire definition file.** Internal callers within the file containing the definition were invisible. Now only the definition *line* is excluded (via `isDefinitionLine`), as originally intended. (AUDIT 2026-06-18 #1, `src/tools/blast-radius.ts`)
- **`walkDirectory` works for single-file targets.** Previously returned `[]` when `targetPath` was a file because `walkRecursive` only emits children. Now branches on `stats.isFile()` and emits a single entry. (AUDIT 2026-06-18 #2, `src/core/walker.ts`)
- **`--root` flag now subject to unsafe-root protection.** Previously `npx contextpro-mcp --root /` or `--root $HOME` bypassed every safety check. `isUnsafeRoot` now applies to all sources, with `realpath` resolution so symlink-to-root is caught. (AUDIT 2026-06-18 #3, `src/core/root-guard.ts`)
- **`checkpoint` no longer rejects normal files.** `validateHeader` previously rejected any file lacking a literal `FEATURE:` substring on line 2 — including most real-world projects. The `FEATURE:` rule is now an advisory warning. The 2-line header rule itself is also advisory by default; pass `strict: true` to opt in. (AUDIT 2026-06-18 #4, `src/tools/propose-commit.ts`)
- **Native auto-repair recovers from stale lock files.** A crashed process used to leave `.contextpro/native-repair.lock` in place forever. Lock now has a 60s TTL and stale-lock detection. (AUDIT 2026-06-18 #5, `src/core/native-repair.ts`)
- **`agent-instructions.md` no longer references unregistered tools.** The `PMLL short-term KV memory` section instructed agents to call `init`/`peek`/`set`/`resolve`/`flush` which are not part of this MCP. Section reframed as an optional companion server reference (`pmll-memory-mcp`) with clear opt-in language. (AUDIT 2026-06-18 #6, `agent-instructions.md`)

### Fixed — High (wrong defaults, silent failures)

- **Agent instructions resource serves bundled file by default.** `INSTRUCTIONS_SOURCE_URL` (`https://contextplus.vercel.app/api/instructions`) was a stale pre-rebrand URL with no error handling. Now reads `agent-instructions.md` from the package by default; remote fetch only attempted if explicitly enabled via `CONTEXTPRO_INSTRUCTIONS_REMOTE=true`. (AUDIT 2026-06-18 #7, `src/index.ts`)
- **Server version matches package.json.** Previously hardcoded to `1.0.0` while `package.json` had moved to `1.1.0`. Now read from `package.json` at startup. (AUDIT 2026-06-18 #8, `src/index.ts`)
- **`shadowCommit` removed.** 83 lines of dead code that pulled in `simple-git` for no caller. (AUDIT 2026-06-18 #9, `src/git/shadow.ts`, `package.json`)
- **Silent `catch` blocks now log degradation.** ~40 sites previously swallowed errors silently (Ollama unreachable, parser crash, restore failure, etc.). Each now writes a single tagged line to stderr (`[contextpro/<subsystem>] degraded: <reason>`) so MCP clients with stderr capture see the cause. The behavioral fallback is unchanged. (AUDIT 2026-06-18 #10, various)
- **Legacy data migration is atomic.** `migrateLegacyProjectData` previously used `cp` config that silently skipped conflicting files, producing half-migrated state. Now uses `{ recursive: true, force: true }` and surfaces actual errors. (AUDIT 2026-06-18 #11, `src/core/data-dir.ts`)
- **Embedding dimension drift surfaces to clients.** Switching embedding providers/models drops cached vectors and previously degraded `search` silently for one cycle. The DB now records `embed_provider`, `embed_model`, and `embed_dim` in `meta`; on mismatch, agentic tools emit a `embeddings_stale` warning in their trust envelope until the next reindex. (AUDIT 2026-06-18 #12, `src/core/db.ts`)

### Fixed — Medium (correctness under realistic conditions)

- **BOM and CRLF stripped at file-read boundaries.** UTF-8 BOM and `\r\n` line endings previously corrupted brace-counting and indent detection. (AUDIT 2026-06-18 #13, `src/core/parser.ts`, `src/tools/propose-commit.ts`)
- **`validateAbstraction` brace counting ignores strings, regex, comments, and template literals.** Previously `const r = /\{[^}]*\}/` incremented nesting depth. (AUDIT 2026-06-18 #14, `src/tools/propose-commit.ts`)
- **Concurrent reindex calls are serialized.** Status writes now run inside a single SQLite transaction. A second concurrent caller observes `INDEXING` and waits via the existing `waitForIndexingCompletion` path. (AUDIT 2026-06-18 #15, `src/tools/reindex.ts`)
- **`project-config.ts` has a `configVersion` field.** Idempotent migration runs on `loadProjectConfig` so future schema changes don't surface as deep `TypeError`s. (AUDIT 2026-06-18 #16, `src/core/project-config.ts`)
- **`python3` linter only runs when Python files are in scope.** Eliminated the spurious `py_compile.py: error: the following arguments are required` output. (AUDIT 2026-06-18 #17, `src/tools/static-analysis.ts`)

### Changed — DX

- **Five alias tools deprecated.** `start_task` → `task_pack`, `plan_edit` → `edit_scope`, `validate` → `validate_scope`, `impact` → `change_impact`, `remember` → `memory_record_task`. Aliases still work in 1.2.x; tool descriptions now mark them `[deprecated, prefer …]`. Removal scheduled for 2.0. (AUDIT 2026-06-18 #20)
- **`CONTEXTPRO_*` env-var aliases added.** Every `CONTEXTPLUS_*` env var has an equivalent `CONTEXTPRO_*` form. `CONTEXTPLUS_*` continues to work through 2.0. (AUDIT 2026-06-18 #19)
- **`lint` default output is top-10.** Pass `verbose: true` to see all files with issues. (AUDIT 2026-06-18 #25)
- **CLI subcommands close DB explicitly.** `tree`, `skeleton`, `doctor`, `init` all `closeDB()` and `process.exit(0)` after their writes. (AUDIT 2026-06-18 #23)
- **`.serena/` added to `.gitignore`.** (AUDIT 2026-06-18 #24)
- **Removed dead `lang === 'tsx'` branch in `extractImports`.** `LANG_MAP` returns `typescript`/`javascript`, never `tsx`/`jsx`. (AUDIT 2026-06-18 rejected items)

### Added

- **`STATUS.md`** — live project state, updated on every release and audit.
- **`AUDIT.md`** — permanent log of audits with finding numbers, evidence, and resolution status.
- **Embed metadata persistence** — DB tracks the embedding provider/model/dim that produced cached vectors.
- **`CONTEXTPRO_INSTRUCTIONS_REMOTE`** env var for opting into remote instruction fetch.

### Deferred

- **`register-tools.ts` refactor** (1006 lines) — co-locating Zod schemas with each tool will be a 2.0 task. (AUDIT 2026-06-18 #21)
- **Project's own files violating its lint rules** — scope of advisory rule reduced to `src/tools/*` for 1.2.0; full cleanup tracked in `TODO.md` v2. (AUDIT 2026-06-18 #18)

## [1.1.0] - 2026-06-10

- Added primary agent workflow aliases: `start_task`, `plan_edit`, `impact`, `validate`, and `remember`.
- Added portable project graph export/query tools with confidence-tagged nodes and edges.
- Added `impact_delta` for comparing graph exports before and after edits.
- Added TypeScript/JavaScript exact references via the local TypeScript language service.
- Added optional SCIP JSON import/status support for exact cross-language reference evidence.
- Added SQLite FTS5/BM25 retrieval fallback and search presets.
- Hardened project path containment and shell command execution.
- Restored legacy memory graph compatibility over SQLite-backed memory storage.
- Fixed sqlite-vec filtered KNN compatibility and refreshed dependency/runtime packaging.
