# Changelog

All notable changes to this project are recorded here. The project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/) conventions. Pair with `STATUS.md` (live state) and `AUDIT.md` (deep findings with evidence).

## [1.3.0] - 2026-06-25

Production-readiness pass. A 13-agent adversarial audit (6 lenses × find + skeptic-verify + synthesis) returned **READY-WITH-FIXES, no ship blockers**; the one "CRITICAL" command-injection finding was refuted by direct test (`execFile` uses arg arrays — no shell). All SHIP-WITH-MONITORING items below are now fixed.

### Fixed — Production hardening

- **Atomic file writes** for every JSON artifact a crash could corrupt. New `writeFileAtomic` (tmp + rename, reused from the shadow.ts pattern) now backs artifact records, the artifact manifest, `graph.json` / `GRAPH_REPORT.md` / dashboard, and the SCIP cache. A crash mid-write leaves the original intact, never a torn file. (`src/core/artifacts.ts`, `src/core/project-graph.ts`, `src/core/scip-index.ts`)
- **`impact_delta` no longer crashes on a missing or corrupt baseline.** Returns "run graph_export first" or "baseline is corrupt — regenerate" instead of throwing a raw `SyntaxError`. (`src/tools/impact-delta.ts`)
- **`related` no longer crashes on malformed import JSON.** Uses the safe `parseJsonArray` helper instead of a bare `JSON.parse` on `symbols_imported`. (`src/tools/related.ts`)
- **`shadow.ts` manifest-mutex entry leak fixed.** The identity check compared two distinct `previous.then()` promises (never equal), so the per-root Map entry was never cleared. Now stores the chained promise in a variable. (`src/git/shadow.ts`)
- **`quickRefresh` logs degraded files** instead of swallowing per-file failures silently — surfaces a count + per-path stderr line so a stale graph is visible. (`src/tools/reindex.ts`)
- **Bounded in-memory caches.** `toolMetricsByRoot` is now an LRU capped at 50 roots; `attemptedRepairKeys` clears past 200 entries. Prevents slow unbounded growth in a long-lived multi-project server. (`src/core/tool-metrics.ts`, `src/core/native-repair.ts`)
- **Schema-version migration gates use numeric comparison** (`current < 2`) instead of lexicographic string compare (`"10" < "2"` was a latent bug that would misfire past v9). (`src/core/db.ts`)
- **`diff` validates `branch`/`since` against a git-ref whitelist** (defense-in-depth) and rejects leading `-` so an arg can't be misread as a git flag. (`src/tools/diff.ts`)
- **`unhandledRejection` safety-net handler** added so a stray promise rejection produces a clear log instead of silent termination. (`src/index.ts`)

### Added — Build/version visibility

- **`health` now reports `version=` and `build=` (compiled-artifact mtime).** After a server restart you can confirm the new code is actually loaded — if `build=` matches the latest `tsc` run, the fresh modules are live; if it's stale, the process is still running old code. This directly addresses the "reconnect vs rebuild+restart" confusion: `/mcp reconnect` reuses the running process, so a code change requires the **process** to restart, not just the connection. (`src/core/startup-health.ts`, `package.json` → 1.3.0)

### Strengths confirmed by the audit (genuinely production-grade)

- Reindex crash-safety: any in-process exception resets the index lock to IDLE and does **not** bump the generation (bump only on the success path) — "stuck lock" / "generation drift" apply only to a hard process kill.
- Graceful shutdown: SIGINT/SIGTERM/SIGHUP/disconnect + broken-pipe detection on all std streams, re-entrancy guard, idle + parent-exit monitors, `Promise.allSettled` cleanup.
- Embedding-provider degradation: Ollama/OpenAI failure falls back to keyword-only ranking at query and index time; server stays up.
- Path traversal: uniform `resolveProjectPath()` on every write. SQL: parameterized prepared statements throughout. External commands: `execFile` with arg arrays (no shell).

### Testing

- New `test/main/production-hardening.test.mjs` (6 tests): atomic write + no temp leftovers, impact_delta corrupt/missing baseline, related() malformed JSON, diff git-ref validation.
- Full suite: **336 tests, 0 failures**.

## [Unreleased]

### Fixed — Round-5 audit (B+ → A path)

Four critical heuristic/ranking-layer fixes plus high/medium items from the third external audit. The indexing/graph/embedding layers were already sound; these close the "heuristics don't model what an LLM agent is doing" gap.

**Critical**

- **`replace_symbol_body` now parse-validates before committing, and preserves body indentation.** The previous reindent logic flattened nested indentation (`return 3` landed at 4 spaces instead of 8 inside a method), shipping broken Python with a success message. `reindentBody` now re-anchors the block so every line keeps its indent *relative to the signature line*. A new `validateSyntax` (tree-sitter) runs the post-edit content and **rejects + leaves the file untouched** if the edit would introduce a syntax error — applied to `replace_symbol_body`, `insert_after_symbol`, and `insert_before_symbol` for a consistent contract. (`src/core/tree-sitter.ts`, `src/tools/symbolic-edit.ts`)
- **Search trust is decomposed and bound by `min(semantic, keyword)`.** A keyword-only top hit (semantic≈0) previously got the same 0.74 confidence as a semantically-strong hit. Now `unifiedSearchData` emits a `topResultBreakdown` (`{semantic, keyword, combined, signal, confidenceLabel}`), the base confidence is derived from the top result's weaker component, and an ambiguities entry fires: *"top hit is keyword-only (semantic≈0); it matches the query text but may not be semantically relevant."* (`src/tools/search.ts`)
- **Directory-purpose / Protocol-implementation ranker prior.** For "add a new X for Y" tasks, `task_pack`/`edit_scope`/`decision_brief` previously surfaced unrelated single-token keyword hits (`status.py` for a fee-model task) at 98% while the entire `fees/` directory and the `FeeModel` Protocol stayed invisible. New `findDirectoryPriorMatches` detects add-intent + a directory hosting ≥2 sibling implementations matching a query noun (singular/plural aware), boosts every file in that directory plus the base/Protocol definition to the top of the candidate set before reranking. (`src/tools/directory-prior.ts`, `src/tools/agentic-context.ts`)
- **`cluster` labels stopword the Python import vocabulary.** `__future__`, `annotations`, `decimal`, `dataclass`, `pathlib`, `typing`, `collections`, `abc`, etc. were producing labels like `[future]`/`[decimal]`. Added to the stopword set; the directory-name preference threshold dropped from 50% → 40% so feature folders win more reliably. (`src/tools/semantic-navigate.ts`)

**High**

- **`graph_query` shows scoped counts.** The `kind=file` view header reported the *global* node/edge totals, reading as if it hadn't scoped. Now shows `This view: N nodes | M edges` plus `Project total: …`. (`src/tools/project-graph.ts`)
- **`related()` fuzzy-resolves src-layout paths** (`tradebot/scanner.py` → `src/tradebot/scanner.py`) and replaces the misleading "Run reindex" message with a "did you mean `<canonical>`?" hint when the file IS indexed under a different prefix. (`src/tools/related.ts`)
- **`resolve_symbol` uses snake_case/camelCase word-boundary scoring with tie-breakers.** `'fee'` no longer collides with `run_venue_a_feed` (substring tier dropped to 20; whole-word-segment match scores 50–55). Tie-breakers when `file_context` is absent: de-prioritize test files, bonus for importer count. (`src/tools/resolve-symbol.ts`)
- **Artifact cache carries `indexGeneration`** with a `readArtifactIfFresh` helper that returns null on stale generations, plus LRU eviction (max 200 per manifest). Search and agentic artifacts now stamp the live generation. (`src/core/artifacts.ts`, `src/tools/search.ts`, `src/tools/agentic-context.ts`)
- **Restore points are session-tagged and tombstone-aware.** Each point records a `session` id; `checkpoints` marks foreign-session points `[OTHER SESSION]`. Snapshots of not-yet-existing files are flagged as tombstones, and restoring one deletes the file (instead of the silent "backup was empty" no-op). (`src/git/shadow.ts`, `src/tools/register-tools.ts`)

**Medium**

- **`repo_map` default covers ~60% of the project** (capped at 80 files) instead of a flat 40 when no budget is given. (`src/tools/repo-map.ts`)
- **`diff` tags changed symbols `[M]`** by intersecting git hunk line ranges with symbol line ranges — the symbol list now reflects *what changed*, not the file's whole table of contents. (`src/tools/diff.ts`)
- **`scip_status` explains what SCIP is**, which tools gain `SCIP_RESOLVED` evidence, and how to generate an index per language, when none is present. (`src/tools/scip-index.ts`)
- **`find_symbol` supports wildcards** — `*` lists all symbols, `get*` matches by prefix, `**` spans path separators. (`src/tools/symbolic-edit.ts`)

### Testing

- New `test/main/round5-fixes.test.mjs` (6 tests): indentation preservation, syntax-error rejection, find_symbol wildcards, directory prior, resolve_symbol word-boundary scoring, search trust decomposition.
- Full suite: **330 tests, 0 failures**.

### Fixed — Audit feedback from tradebot-plus (Python project)

A B-grade external audit on a 112-file uv-managed Python project exposed several heuristic gaps that hurt agents using ContextPro for Python work and edit planning. Critical/High items addressed:

- **`lint` discovers Python tools via `.venv/bin/` and `uv run` before system PATH.** Previously `lint` only saw ruff/mypy when they were on the global PATH, so it fell back to `python3 -m py_compile` on every uv-managed project. New `resolvePythonTool()` tries `./.venv/bin/<tool>` → `./.venv/Scripts/<tool>.exe` → `uv run <tool>` (when `uv.lock`/`pyproject.toml` present) → `poetry run <tool>` (when `poetry.lock` present) → system. Same priority chain for `ruff`, `mypy`, `pytest`. (`src/tools/static-analysis.ts`)
- **`validate_scope` parses `pyproject.toml` and `pytest.ini`.** New `detectPythonProfile()` reads `[tool.pytest.ini_options]`, `testpaths`, `[tool.ruff]`, `[tool.mypy]`, and presence of `.venv` / `uv.lock` / `poetry.lock`. `buildValidateScope` then emits the right `pytest`, `ruff check`, and `mypy` commands instead of "No safe script-level validation command could be inferred." (`src/tools/agentic-context.ts`)
- **Hybrid search trust dampener** caps combined score at 0.7 when either component is below 0.05. Stops the "94% confidence" trust killer where a pure-keyword 94 looked like a high-confidence hybrid match. (`src/core/embeddings.ts`)
- **Planning helpers learn lemmatization, directory-name match, and stopword filtering.** `lemmatize()` matches `fees`↔`fee`, `models`↔`model`. New `pathSegments()` adds directory bonus. `STOPWORD_VERBS` filters out generic verbs (`add`/`get`/`update`/etc.) that previously made `status.py` outrank `fees/*.py` for fee-model tasks. `rerankPlanningFiles` emits per-candidate `reason` evidence — the `why_picked` field requested in the audit. (`src/tools/planning-helpers.ts`)
- **`repo_map` honors `max_tokens` for breadth.** Effective file budget = `floor(max_tokens / 120)` clamped to `[8, 400]`. Low floor (8) means small token budgets actually reduce breadth instead of landing on the same 40-file response. (`src/tools/repo-map.ts`)
- **`hub` falls back to directory-derived hubs when the import graph is too sparse.** Groups files by `src/<dir>`, `app/<dir>`, `lib/<dir>`, `packages/<dir>` (≥2 files per group). (`src/tools/feature-hub.ts`)
- **`cluster` labels use directory names + dominant header tokens.** Emits dominant dir if ≥50% file coverage, dominant header word if ≥2 files share it, combines as `"<dir> (<header>)"` when both differ. (`src/tools/semantic-navigate.ts`)
- **`tree` fuzzy-resolves `target_path`.** Tries `src/<path>` / `app/<path>` / `lib/<path>` / `packages/<path>` prefixes; surfaces a `[Fuzzy-resolved → ...]` notice; errors explicitly when no candidate matches. (`src/tools/context-tree.ts`)
- **`explain` reports depth-N status.** Emits `(depth N added 0 nodes beyond depth 1)` or `(depth N added M additional node(s))` so agents know whether to deepen further. (`src/tools/explain.ts`)
- **Stale `.contextplus/` paths migrated on read** in `listArtifacts` / `readArtifact`. (`src/core/artifacts.ts`)
- **`graph_export` cold-open race** caught with one-shot retry that pre-warms `getDB()`. (`src/tools/project-graph.ts`)
- **Search exposes `semantic_only` / `keyword_only` presets** distinct from `hybrid`. (`src/tools/semantic-search.ts`, `src/tools/register-tools.ts`)
- **`diff` accepts a `scope` arg** with `unstaged` (default), `staged`, or `both`. (`src/tools/diff.ts`)

### Fixed — Bug-hunt adversarial pass

Following the audit fixes, a separate adversarial bug-hunt found 5 critical bugs in the symbolic-edit + parser work. All fixed:

- **`replaceSymbolBody` rejects malformed bodies** via a new `looksLikeDefinitionStart()` check. Previously, passing just inner statements silently dropped the function signature. Now throws with the original signature quoted. (`src/tools/symbolic-edit.ts`)
- **`replaceSymbolBody` uses correct nested-method indent.** New `detectBodyIndent` walks past the definition line to find the actual body indent; `reindentBody` strips min body indent before reapplying context indent. (`src/tools/symbolic-edit.ts`)
- **`renameSymbol` rejects same-file collisions** and identical-name no-op renames. (`src/tools/symbolic-edit.ts`)
- **`extractConfigKeys` only fires inside `export default {…}` and respects `CONFIG_MAX_DEPTH=6`.** Brace-depth counter + string/comment state machine + global dedup. Previously matched anywhere in the file including type aliases, function parameter destructuring, and any object literal. (`src/core/parser.ts`)
- **`isIndexableSymbol` detects exported consts with tree-sitter signatures.** Tree-sitter strips the `export ` keyword from `lexical_declaration` node text; the filter now also inspects the raw source line. (`src/tools/semantic-identifiers.ts`)

### Testing

- New `test/main/audit-improvements.test.mjs` covers the audit surface (5 tests).
- Full suite: **324 tests, 0 failures** (was 319; +5 audit-coverage tests).

## [Unreleased — earlier in this session]

### Fixed — Live-MCP performance sweep findings

A post-reconnect sweep with a fresh MCP server surfaced two more issues that the cached-module sessions had masked. Both stem from the same root cause: the symbol table treats every `const`/`let` declaration as a callable symbol.

- **Identifier search no longer surfaces internal local bindings.** Search for "singleton shared module federation react" was returning `containerStyle`, `parts`, `outerVignetteStyle` — all internal style variables inside React components. Fixed in `buildIdentifierIndex` (the hot path in `semantic-identifiers.ts`) with a kind filter (`function|method|class|interface|enum|type|struct|trait|export`) plus a fallback for top-level exported consts identified via parent-name + line-range containment in structural symbols. Same filter applied to `buildIdentifierDocsForFile` (the per-file refresh path). (`src/tools/semantic-identifiers.ts`)
- **`graph_query` no longer dumps hundreds of internal `const`/`let` nodes.** Both `kind="file"` and `kind="impact"` were returning every variable binding (e.g., `symbol:.../blast-radius.ts:42:content`, `symbol:.../blast-radius.ts:65:usages`). `buildProjectGraph` now applies the same structural-kind + line-containment filter when emitting symbol nodes. The DB itself still retains all symbols so `blast_radius`, `rename_symbol`, and other textual tools work unchanged. (`src/core/project-graph.ts`)

### Performance note

- `reindex` with full embedding pass on a 132-file repo: ~110s (4264 identifiers × Ollama embedding). Use `reindex({no_embed: true})` for ~4s structural-only refresh; search will lazily populate embeddings on first call. The 110s figure is Ollama-bound (≈25ms per embedding) and won't change without a faster embedding backend.

## [Unreleased — earlier in this session]

### Fixed — Round-3 external-feedback issues

These three issues were surfaced by a Round-3 external assessment that exercised ContextPro . Each fix had a follow-up adversarial review that caught additional bugs, all of which are also fixed.

- **`lint` prefers local TypeScript over system tsc.** macOS ships `/usr/bin/tsc` as Apple's TextureSetCompiler — wholly unrelated. Previously `detectLinters` always ran `npx tsc`, which could fall through to system tsc in some environments. Now `resolveLocalBinary` prefers `./node_modules/.bin/tsc` (including `.cmd` shim on Windows), then falls back to `npx --no-install` to prevent silent system fallthrough, and finally emits a clear "TypeScript not installed" message if npx isn't on PATH. Same pattern applied to `eslint`. (`src/tools/static-analysis.ts`)
- **`*.config.ts` property keys are now indexed.** Semantic search previously missed `shared: { react: { singleton: true } }` in `rsbuild.config.ts` because property keys weren't symbols. New `extractConfigKeys()` runs only on detected config files (`*.config.ts`, named framework configs like `rsbuild.config.ts`, `webpack.config.ts`, `next.config.ts`, etc.) and extracts top-level property keys via three patterns: `name: {`, `name: true|false` (matches EOL with or without trailing `,`/`}` — adversarial-review fix), and `"name": {`. Reserved words and length-bounded names filter noise. Non-config files are untouched. (`src/core/parser.ts`)
- **`graph_query kind="impact"` is now a real impact view, not a duplicate of `kind="file"`.** Previously both kinds applied identical edge filters. Impact now performs BFS over incoming dependencies up to 3 hops: collect symbols defined by the start file, then for each hop find files that import the frontier OR call/reference/test its symbols, expand the frontier, repeat. Limit is a single edge budget consistently applied — fixes adversarial-review blocker C where edges were sliced but `dependentFileIds` were collected pre-slice. (`src/core/project-graph.ts`)
- **`graph_query` empty-result message disambiguates three cases.** Previously every empty result said "may not be indexed yet". Now: (1) file not in graph → "may not be indexed yet"; (2) impact returned only the start file and its own symbols → "is indexed but has no incoming dependencies (leaf module, types-only file, or entry point)"; (3) file view returned start node with no edges → "is indexed but has no graph edges". (`src/tools/project-graph.ts`)

### Testing

- New `test/main/round3-fixes.test.mjs` covers config-key extraction (3 fixtures including the EOL-boolean regression), transitive BFS impact view (3-level chain `leaf ← middle ← consumer`), differentiated empty-result messages, and the lint module surface (8 tests).
- Full suite: **318 tests, 0 failures** (was 310 before round-3 work, 5 new round-3 tests added then 3 more covering adversarial-review blockers).

### Added — Serena-parity symbolic editing surface

- **`find_symbol` tool** — find symbols by name path (`ClassName/methodName`, `/AbsolutePath/Name`, or `Name`) with optional substring matching, kind filters, body inclusion, and child depth. Same name-path semantics as Serena's `find_symbol`. (`src/tools/symbolic-edit.ts`)
- **`replace_symbol_body` tool** — replace the full body of a symbol identified by its name path. Auto-detects indentation, reindents the replacement to match context, creates a shadow restore point before writing, and invalidates search caches. (`src/tools/symbolic-edit.ts`)
- **`insert_after_symbol` and `insert_before_symbol` tools** — insert sibling code adjacent to an anchor symbol without re-reading the file. Restore-pointed and cache-aware. (`src/tools/symbolic-edit.ts`)
- **`rename_symbol` tool** — rename a symbol in its defining file and propagate to importers and callers via the indexed import/call graph. Backs up the definition file and every cross-file site before any write. Validates new names against `/^[A-Za-z_][A-Za-z0-9_]*$/`. (`src/tools/symbolic-edit.ts`)

### Fixed — Honest-assessment regressions

- **`grep` glob no longer drops `{ts,tsx}` brace expansions.** `matchesGlob` previously ran `split(/[,\s]+/)` before brace expansion, splitting `src/**/*.{ts,tsx}` into `src/**/*.{ts` and `tsx}` and matching nothing. Brace-aware splitting (`splitGlobInput`) plus full brace expansion (`expandBraces`) plus `**/`-aware globbing (`globPartToRegex`) fix it. A cap of 1024 sub-patterns prevents `{a,b}{c,d}...` DoS. Errors flow back through the tool result instead of crashing the server. (`src/tools/grep.ts`)
- **`skeleton` returns more than `[kind] L1 name`.** Now emits: file header, line count, imports section (grouped by source with specifier lists), exports list, per-symbol full signature, leading-comment/docstring extraction (bounded by the previous symbol's `endLine` to avoid grabbing the wrong doc), and nested method/property signatures. Approaches Serena's symbolic depth. (`src/tools/file-skeleton.ts`)
- **`explain` is no longer redundant with reading the file.** Output now adds: extracted leading doc-comment, signature line, caller count + file list + top-5 call sites, related test files (via import graph and call sites), sibling symbols at the same scope. The raw body is still included but is no longer the only payload. (`src/tools/explain.ts`)
- **`search` finds matches inside config literals and non-keyword code.** `buildCodeSearchBody` previously gated lines through a narrow keyword whitelist (`function|class|...`), filtering out config object lines like `shared: { react: { singleton: true } }`. It now skips only empty lines and pure-syntax lines (`}`, `)`, `;`, etc.), so `singleton:` and other property-value content reach the embedding and FTS indexes. (`src/tools/semantic-search.ts`)
- **`decision_brief` open questions are no longer mechanical.** Questions are now generated from actual signals: missing test coverage per file, hot-symbol back-compat risk (with call counts), absent feature-hub links, and score-tied top candidates. The brief also surfaces a new `hotSymbols` array (name + total calls + path) and bumps `topK` to 7 for wider candidate consideration. Existing fields (`summary`, `topSymbols`, `doNotReadYet`) are preserved. (`src/tools/agentic-context.ts`)

### Fixed — Adversarial-review blockers

- **Cross-file rename no longer silently skips short files after long ones.** `renameSymbol` previously reused a single `g`-flag `RegExp` across files, so `lastIndex` from a long file could exceed a subsequent short file's length and cause `.test()` to return false even when the symbol was present. Each cross-file iteration now constructs a fresh regex. (`src/tools/symbolic-edit.ts`)
- **Glob brace expansion is DoS-resistant.** `expandBraces` is now capped at 1024 sub-patterns; pathological inputs like `{a,b}{c,d}...{w,x}` short-circuit instead of producing millions of expansions (~346 MB / 4.7s observed before the cap). Over-cap globs surface a clear error through the tool result. (`src/tools/grep.ts`)

### Fixed — Post-reconnect live-MCP sweep

These six issues were surfaced by exercising every tool through the live MCP after the symbolic-editing tools shipped. None affected correctness of the core symbolic edits, but all degraded the quality of the planning-layer tools.

- **Call-site extractor no longer treats `Math.max`, `console.log`, `JSON.parse` as user calls.** `extractCallSites` previously matched every `name(` pattern, so any file containing `Math.max(...)` was indexed as "calling" a local `const max` defined elsewhere in the codebase. The graph then showed 32 files "calling" `symbolic-edit.ts:145:max`. Fixed with a negative-lookbehind for `.` (skips method calls), a JS-keyword denylist (`if`, `for`, `while`, `return`, `new`, `throw`, ...), and a stdlib-globals denylist (`Math`, `JSON`, `Array`, `Object`, `Promise`, `console`, `process`, ...). 4168 → 4168 symbols (no loss), but the spurious call edges drop dramatically on the next reindex. (`src/core/parser.ts`)
- **`edit_scope` now respects identifier-mode signal.** Previously built recommendations purely from `search.files` semantic header matches, so "add a find_referencing_symbols tool to ContextPro" recommended `project-graph.ts` / `walker.ts` / `InstructionsSection.tsx` — none relevant. Now prepends identifier-resolved paths (score ≥ 60 OR keywordScore ≥ 90) before file-search results and dedupes. (`src/tools/agentic-context.ts`)
- **`decision_brief` no-test-coverage flag uses basename comparison.** The previous substring-match logic could mark a file as "no test coverage" even when the matching test file (`test/main/symbolic-edit.test.mjs` ↔ `src/tools/symbolic-edit.ts`) was already in the tests section. Switched to filename-without-extension equality. (`src/tools/agentic-context.ts`)
- **`task_pack` / `edit_scope` / `decision_brief` planning scores no longer saturate at 100%.** Per-bonus weights in `scorePlanningCandidate` were tuned aggressively (`+0.34` source path + `+0.28` symbol overlap + `+0.24` exact-id + ...), so any source file in `src/` with a symbol match would clamp to `1.0`. Halved each bonus and capped at `0.97` so users can distinguish high-confidence from medium-confidence results. (`src/tools/planning-helpers.ts`)
- **`exact_references` auto-locates the symbol's definition line when `line` is omitted.** Previously defaulted to `line: 1` when only `file` was given, which the TypeScript language service treats as a position with no symbol — so `{symbol_name: "renameSymbol", file: "src/tools/symbolic-edit.ts"}` returned "No exact references found." Now queries the indexed symbol table for the symbol's actual `line_start` in that file. (`src/tools/exact-references.ts`)
- **`skeleton` no longer dumps every `const`/`let` from inside function bodies.** Children of structural symbols are now filtered to the kinds that matter for an API-surface view (`function`, `method`, `class`, `interface`, `enum`, `type`, `struct`, `trait`, `export`). Internal local variables stay in the DB for cross-reference resolution but no longer pollute the displayed skeleton. (`src/tools/file-skeleton.ts`)

### Testing

- New `test/main/grep-glob.test.mjs` covers brace expansion, recursive `**` globbing, non-matching globs, and the DoS cap (4 tests).
- New `test/main/symbolic-edit.test.mjs` covers `find_symbol` (top-level, name-path, missing), `replace_symbol_body`, `insert_after_symbol`, `rename_symbol` single-file, **cross-file rename with mismatched file lengths (regex-state regression)**, and rename-validation rejection (7 tests).
- New `test/main/call-site-filter.test.mjs` covers method-call rejection, keyword filtering, and stdlib-globals filtering (3 tests).
- Full suite: **310 tests, 0 failures**.

## [1.2.2] - 2026-06-18

Verification follow-up to 1.2.1. Closes 8 issues from the dev-lifecycle audit and adds a literal-string `grep` tool to fill the keyword-search gap.

### Added

- **`grep` tool** — fast literal or regex string search across the project's indexed file set. Closes the gap where `search` (semantic) and `search` mode `identifier` aren't a fit: log-message lookups, config-key searches, error-message tracing. Supports case-sensitivity, regex, target_path scoping, glob filter, per-file and total caps, file-size skip, and context-window control. Skips binary files; respects `.gitignore` via the indexed walker. (`AUDIT.md` 2026-06-18 dev-lifecycle audit, `src/tools/grep.ts`)

### Fixed — Validation gaps

- **Empty-input rejection.** All required string params now enforce `z.string().min(1)`: `blast_radius.symbol_name`, `resolve_symbol.symbol_name`, `exact_references.symbol_name`, `search.query`, `memory_search.query`, `memory_create.label`, `memory_create.content`, `memory_link.source_id`/`target_id`, `memory_explore.start_node_id`, `memory_delete.node_id`, `task_pack.task`, `start_task.task`, `edit_scope.task`, `plan_edit.task`, `validate.task`, `validate_scope.task`, `decision_brief.query`, `memory_record_task.task` and `.summary`, `remember.task` and `.summary`, `promote_pattern.source_memory_id` and `.summary`, `artifact_read.artifact_id`, `scip_import.index_path`, `skeleton.file_path`, `checkpoint.file_path` and `.new_content`, `restore.point_id`, `related.file`. Closes audit findings #26, #27, #29. (`src/tools/register-tools.ts`)
- **`blast_radius` defense in depth.** Handler-level guard rejects empty/whitespace `symbolName` even if Zod is bypassed — previously empty input returned 29,573 usages / 1.5MB output. (Audit #26, `src/tools/blast-radius.ts`)
- **`memory_delete` explicitly drops edges.** Existing schema has `ON DELETE CASCADE` but the delete now also runs `DELETE FROM memory_edges WHERE source = ? OR target = ?` defensively in case foreign-keys PRAGMA is disabled per-connection. (Audit #28, `src/core/db.ts`)

### Fixed — Output and error quality

- **`change_impact` truncation explicit.** When the importer or test list is shortened, output now appends `... and N more affected file(s) (full list in artifact <id>)`. (Audit #33, `src/tools/agentic-context.ts`)
- **`graph_query` missing-file error.** Empty result for `kind="file"` or `kind="impact"` returns "No graph nodes found for file '...'. The file may not be indexed yet — run reindex, or check the path is correct (project-relative)." instead of leaking the DB-not-open internal error. Same disambiguated message for `kind="symbol"`. Required-arg checks added (`kind="file"` requires `file`; `kind="symbol"` requires `symbol`). (Audit #32, `src/tools/project-graph.ts`)
- **`reindex(target_path=non-existent)` warns.** Returns `Reindex: target_path "X" matched no files (path may not exist, or is fully gitignored). No-op.` instead of silently completing in 1ms with zero indexed. (Audit #31, `src/tools/reindex.ts`)
- **`cluster` label fallback.** When the chat model is unavailable or returns malformed JSON, cluster labels now derive from the most-frequent path/header tokens instead of generic "Cluster 1/2". Also writes a `[contextpro/cluster] degraded:` line to stderr so users know to configure or fix the chat model. (Audit #30, `src/tools/semantic-navigate.ts`)

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
