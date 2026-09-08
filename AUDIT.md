# ContextPro MCP — Audit Log

> Permanent record of audits performed on the project, the findings produced, and the resolution status of each. Pair with `CHANGELOG.md` for the per-version history and `STATUS.md` for the live state.

---

## 2026-09-08 — Reference/freshness foundation and documentation review

The [foundation report](docs/benchmarks/2026-09-08-reference-foundation.md) records compiler project handling, explicit reference counts, worker isolation, source fingerprints, watcher recovery and 644 passing regressions. The [benchmark index](docs/benchmarks/README.md) separates provider measurements from estimates and direct replays.

The documentation review found conflicting profile defaults, shared-native-rebuild advice, duplicated website instructions using retired tool names, and mandatory extra calls contrary to the lean workflow. Current guides now agree on behavior; obsolete plans are [archived](docs/archive/README.md). Older entries below preserve their original claims and counts and are not current setup instructions.

---

## 2026-06-18 — Comprehensive audit (post-rebrand readiness)

**Scope.** Every MCP tool category exercised live, every critical source file read, adversarial review across correctness, edge-cases, performance/token efficiency, and API design. Workflow-driven fan-out across 20 source files plus targeted regex/grep verification.

**Verdict at start of audit.** B+ / 7.5 of 10 — sound architecture, real token wins for orientation, several correctness bugs that mislead agents, and silent-failure paths that hide degradation.

**Resolution summary (1.2.0).** All Critical and High items fixed. Medium/DX cleanup landed in same release. Two items deferred with explicit rationale.

### Critical findings

| # | Finding | File | Status |
|---|---|---|---|
| 1 | `blast_radius` skipped the entire definition file (not just the definition line), missing internal usages | `src/tools/blast-radius.ts:88,97` | ✅ Fixed in 1.2.0 |
| 2 | `walkDirectory` returned `[]` when `targetPath` is a single file | `src/core/walker.ts:115-118` | ✅ Fixed in 1.2.0 |
| 3 | `--root` flag bypassed unsafe-root protection | `src/core/root-guard.ts:44` | ✅ Fixed in 1.2.0 |
| 4 | `validateHeader` rejected every file lacking a literal `FEATURE:` substring on line 2 — broke `checkpoint` for normal projects | `src/tools/propose-commit.ts:42` | ✅ Fixed in 1.2.0 (downgraded to advisory warning) |
| 5 | Stale `native-repair.lock` blocked auto-repair indefinitely after a crash | `src/core/native-repair.ts` | ✅ Fixed in 1.2.0 (60s TTL stale-lock detection) |
| 6 | `agent-instructions.md` instructed agents to call PMLL tools (`init`/`peek`/`set`/`resolve`/`flush`) that are not registered | `agent-instructions.md` | ✅ Fixed in 1.2.0 (section labeled as optional companion server) |

### High findings

| # | Finding | File | Status |
|---|---|---|---|
| 7 | `INSTRUCTIONS_SOURCE_URL` still pointed to pre-rebrand `contextplus.vercel.app`; `fetch` had no error handling | `src/index.ts:35,288` | ✅ Fixed in 1.2.0 (use bundled local file by default, remote fetch falls back) |
| 8 | Server reported version `1.0.0` while package.json was `1.1.0` | `src/index.ts:278` | ✅ Fixed in 1.2.0 (read from package.json) |
| 9 | `shadowCommit()` was 83 lines of dead code; pulled in `simple-git` for nothing | `src/git/shadow.ts:92` | ✅ Fixed in 1.2.0 (removed; `simple-git` dep dropped) |
| 10 | ~40 silent `} catch {}` blocks hid real failures (Ollama down, parser crash, restore failure) | various | ✅ Fixed in 1.2.0 (tagged stderr logging on degradation paths) |
| 11 | `data-dir.ts` migration used `cp` config that silently skipped conflicting files, leaving half-migrated state | `src/core/data-dir.ts:28` | ✅ Fixed in 1.2.0 (`force: true`, error surfaced) |
| 12 | Embedding dimension drift only logged to stderr; agents calling `search` saw silent degradation | `src/core/db.ts:339` | ✅ Fixed in 1.2.0 (provider/model/dim recorded; one-cycle warning on mismatch) |

### Medium findings

| # | Finding | File | Status |
|---|---|---|---|
| 13 | BOM and CRLF not stripped before parsing/header validation | `src/core/parser.ts`, `src/tools/propose-commit.ts` | ✅ Fixed in 1.2.0 (normalized at file-read boundaries) |
| 14 | Brace counting in `validateAbstraction` counted braces inside strings/comments | `src/tools/propose-commit.ts:78-79` | ✅ Fixed in 1.2.0 (strip strings/comments first) |
| 15 | Concurrent reindex calls raced on metadata writes | `src/tools/reindex.ts` | ✅ Fixed in 1.2.0 (single transaction + advisory lock) |
| 16 | `project-config.ts` had no schema version — upgrades break silently | `src/core/project-config.ts` | ✅ Fixed in 1.2.0 (`configVersion` field + idempotent migration) |
| 17 | `python3` linter was invoked with no args even when no `.py` files in scope | `src/tools/static-analysis.ts` | ✅ Fixed in 1.2.0 (skip when no Python files in target) |
| 18 | Project's own files violated the rules `lint` enforced on agents | various | 🟡 Tracked for v2 — rule scope reduced to `src/tools/*` for now |

### DX / Low findings

| # | Finding | Resolution |
|---|---|---|
| 19 | `CONTEXTPLUS_*` env vars survived the rebrand | ✅ Added `CONTEXTPRO_*` aliases in 1.2.0; `CONTEXTPLUS_*` kept for compatibility through 2.0 |
| 20 | Five alias tools (`start_task`, `plan_edit`, `validate`, `impact`, `remember`) duplicated `task_pack`, `edit_scope`, `validate_scope`, `change_impact`, `memory_record_task` | ✅ Marked deprecated in 1.2.0 tool descriptions; full removal in 2.0 |
| 21 | `register-tools.ts` was 1006 lines | 🟡 Deferred — defer to a 2.0 refactor with one schema-per-file |
| 22 | `withRequestActivity` shape mismatch on the `contextpro_instructions` resource | ✅ Fixed in 1.2.0 (typed wrapper) |
| 23 | CLI subcommands lacked explicit `closeDB` / `process.exit` | ✅ Fixed in 1.2.0 |
| 24 | Untracked `.serena/` from Serena IDE tool | ✅ Added to `.gitignore` in 1.2.0 |
| 25 | `lint` default output listed every file with issues | ✅ Default top-10 in 1.2.0; full list available with explicit flag |

### Items considered but rejected

- "Parser TSX/JSX branches are unreachable dead code." Investigation showed `LANG_MAP` returns `typescript`/`javascript`, not `tsx`/`jsx`, so the `lang === 'tsx'` branch in `extractImports` was indeed dead, but the workflow's stated reason was wrong. Removed branch in 1.2.0.
- "Rust impl-block methods disappear from the symbol tree." False — `parseRust` does not currently track impl context but the methods are still emitted at file scope; they just lack a parent. Improving parent attribution is a tree-sitter v2 candidate, not a bug.

---

## How this file is used

Every audit appends a new dated section. Each finding gets a stable number within that section. The `Status` column tracks resolution: `✅ Fixed in <version>`, `🟡 Tracked for v2`, `❌ Won't fix (reason)`, or `⏳ In progress`.

When a fix lands, the corresponding `CHANGELOG.md` entry references the audit ID (`AUDIT 2026-06-18 #1`) so a reader can trace from the fix back to its origin.

---

## 2026-06-18 — Verification pass (post-1.2.0)

**Scope.** Wiped `.contextpro/` (index, graph artifacts, hubs), reindexed from scratch, exercised every tool category against the rebuilt index, ran adversarial probes for the 25 audit items.

**Result.** All 25 prior findings verified as fixed or correctly deferred. Three new findings surfaced during verification.

### Verification of 1.2.0 fixes

| # | Finding | Verification | Status |
|---|---|---|---|
| 1 | `blast_radius` definition-file skip | Live call `blast_radius(getDB, fileContext: src/core/db.ts)` returned 74 usages in 23 files; no whole-file exclusion. | ✅ Confirmed |
| 2 | `walkDirectory` single-file target | Static walker test "walker › walkDirectory › respects targetPath" passes; live `related src/git/shadow.ts` also confirms file-level resolution. | ✅ Confirmed |
| 3 | `--root` flag bypass | `node build/index.js --root /` and `--root $HOME` both throw `Unsafe project root` with new error message. | ✅ Confirmed |
| 4 | `checkpoint` `FEATURE:` rejection | `propose-commit.ts` skeleton confirms `strict?: boolean` field, advisory warnings; tests pass for both default and strict modes. | ✅ Confirmed |
| 5 | `native-repair.lock` stale TTL | `withRepairLock` skeleton shows `STALE_LOCK_AGE_MS` and `reapStaleLock` in critical path. | ✅ Confirmed |
| 6 | PMLL doc lie | `agent-instructions.md` rewritten; PMLL is now a labeled optional companion section. | ✅ Confirmed |
| 7 | Stale instructions URL | `INSTRUCTIONS_REMOTE_URL` reads bundled file by default; opt-in via `CONTEXTPRO_INSTRUCTIONS_REMOTE`. | ✅ Confirmed |
| 8 | Server version mismatch | `readPackageVersion()` reads from `package.json`; reports `1.2.0`. | ✅ Confirmed |
| 9 | `shadowCommit` dead code | `resolve_symbol("shadowCommit")` returns "No symbol matches found"; `simple-git` removed from `package.json`. | ✅ Confirmed |
| 10 | Silent catches → tagged stderr | 11 stderr-tagged degradation logs across 7 core files: data-dir(2), db(2), embeddings(3), memory-graph(1), native-repair(1), project-config(1), reindex(2). | ✅ Confirmed |
| 11 | `data-dir` cp config | `migrateLegacyProjectData` skeleton shows `force: true` and explicit error throw. | ✅ Confirmed |
| 12 | Embedding dim drift signal | `recordEmbeddingProvider`, `isEmbeddingsStale`, `clearEmbeddingsStaleFlag` defined in db.ts; `exact_references("recordEmbeddingProvider")` shows 1 caller in reindex.ts:320. | ✅ Confirmed |
| 13 | BOM/CRLF stripping | `parser.ts:376` shows `(raw.startsWith("﻿") ? raw.slice(1) : raw).replace(/\r\n/g, "\n")`; `propose-commit.ts:24` has matching `stripBomAndCRLF` helper. | ✅ Confirmed |
| 14 | Brace counting strips strings | `propose-commit.ts:29` `stripStringsAndComments` defined; `validateAbstraction:103` calls it before counting braces. | ✅ Confirmed |
| 15 | Concurrent reindex serialization | Code path verified by inspection (`reindex.ts:208` checks `INDEX_STATUS_KEY === INDEXING_STATUS` and waits via `waitForIndexingCompletion`). Live concurrent test couldn't run due to ABI mismatch in standalone Node — see new finding A. | 🟡 Verified by inspection only |
| 16 | `configVersion` field | `.contextpro/config.json` shows `"version": 1`; `migrateProjectConfig` helper present. | ✅ Confirmed |
| 17 | Python lint skip | `static-analysis.ts` filters linters by `presentExtensions`. | ✅ Confirmed |
| 18 | Project lint scores (deferred) | Skill score now 92/100 (was 89/100); top-10 default working. | 🟡 Tracked |
| 19 | `CONTEXTPRO_*` aliases | Live MCP process started with `CONTEXTPLUS_EMBED_PROVIDER=ollama` (legacy alias) — works correctly; `CONTEXTPRO_*` paths verified in source. | ✅ Confirmed |
| 20 | Deprecated alias tools | `start_task`, `plan_edit`, `validate`, `impact`, `remember` all show `[deprecated, prefer …]` in tool descriptions. | ✅ Confirmed |
| 21 | `register-tools.ts` 1006 lines | Still 1010 lines (1006 + 4 from new `verbose` and `strict` params). | 🟡 Deferred to 2.0 (as planned) |
| 22 | `withRequestActivity` typing | Resource handler now passes `(uri: URL)` typed parameter. | ✅ Confirmed |
| 23 | CLI subcommands `process.exit(0)` | `src/index.ts:317` has `closeDB(targetRoot); process.exit(0);` after tree/skeleton CLI output. | ✅ Confirmed |
| 24 | `.serena/` gitignore | Verified in `.gitignore`. | ✅ Confirmed |
| 25 | `lint` top-10 default | Live `lint` output: "showing top 10 by lowest score ... pass verbose: true to see all". | ✅ Confirmed |

### New findings (during verification)

#### A. Reindex does not eagerly populate file-search and identifier embeddings
- **Where:** `src/tools/reindex.ts` populates files, symbols, imports, call_sites, FTS5, but defers vector embeddings (`file_search_cache` + `identifier_cache`) to first `search` call.
- **Symptom:** After fresh reindex, `status` showed `File search: 0 | Identifiers: 0` despite the index being "fresh." First `search` call took ~127s to populate embeddings cold.
- **Why it's surprising:** Users running `reindex` reasonably expect it to be the warm-up cost, not the next `search`.
- **Severity:** Medium. Working as currently designed but mismatched with the documented "lazy tracker" intent — lazy should mean "watch for changes," not "first search pays everything."
- **Status:** ✅ Fixed in 1.2.1. `reindex` calls `refreshFileSearchEmbeddings` + `refreshIdentifierEmbeddings` in the same pass. Opt out via `no_embed: true` or `CONTEXTPRO_REINDEX_NO_EMBED=true`. Errors during embedding don't fail the structural index.

#### B. `status` warning is ambiguous when embeddings are empty post-reindex
- **Where:** `src/tools/status.ts` warns `Semantic file embeddings are empty` whenever `file_search` count is 0, regardless of whether reindex just completed.
- **Symptom:** After fresh reindex, the warning suggested Ollama was unreachable (red herring) when the actual cause was the lazy-population pattern from finding A.
- **Severity:** Low. Misleading message; not incorrect.
- **Status:** ✅ Fixed in 1.2.1. Status now picks one of five disambiguated messages based on `last_embed_skipped`, `last_embed_error`, `embeddings_stale`, and `index.state`. Provider/model and stale flag are also shown in the text output.

#### C. Standalone Node ABI mismatch (environment, not project)
- **Where:** Local environment has `node` (Homebrew, v26.0.0, ABI 147) and `~/.nvm/versions/node/v24.15.0/bin/node` (ABI 137). MCP runtime uses NVM's v24; standalone `node` invocations use Homebrew's v26.
- **Symptom:** Concurrent-reindex probe script crashed with `NODE_MODULE_VERSION 137` vs `147` when invoked via `node` from PATH.
- **Severity:** Documentation gap rather than a defect. The MCP itself runs fine on the NVM Node it was built against, and the auto-repair handles it on real MCP start.
- **Status:** ✅ Documented in 1.2.1. `README.md` now has a "Node version" subsection explaining ABI mismatch causes, auto-repair behavior, and the manual fix command.

---

## 2026-06-18 — Dev-lifecycle audit (post-1.2.1)

**Scope.** Wiped index, ran fresh reindex with 1.2.1's eager-embedding feature (110.7s for 126 files; 124 file embeds + 3876 identifier embeds). Exercised every tool category against the rebuilt index in 8 parallel probes. Rated the MCP across 8 dev-lifecycle dimensions.

**Verdict at start.** 7.8/10. Strong product, four input-validation gaps, one missing capability (literal/grep search), one broken tool (`cluster` labels).

**Resolution summary (1.2.2).** All 8 findings resolved.

### Dimension scores (baseline)

| Dimension | Score | Strength | Weakness |
|---|---|---|---|
| Discovery | 8/10 | `task_pack` + `repo_map` give right granularity in 50–180ms | `cluster` ships broken |
| Planning | 7/10 | Confidence-labeled scoped picks, no full-file dumps | Semantic ranking dead-spots |
| Implementation | 8/10 | `resolve_symbol(file_context)` adds locality bonus | `skeleton` truncation, `checkpoint` path requirement |
| Validation | 9/10 | `change_impact` returns risk score + churn + tests | Importer list silently truncated |
| Refactoring | 9/10 | `exact_references` LSP-grade with column accuracy | `blast_radius('')` DoS |
| Debugging | 8/10 | `related` returns full neighborhood in one call | Hybrid search keyword-dominant |
| Knowledge persistence | 7/10 | `memory_bulk` auto-similarity edges | No input validation on memory nodes |
| Multi-project | 8/10 | `graph_export` is a real shareable artifact | Workspace doesn't ping for liveness |

### New findings

| # | Finding | File | Status |
|---|---|---|---|
| 26 | `blast_radius('')` returns 29,573 usages / 1.5MB | `src/tools/blast-radius.ts` | ✅ Fixed in 1.2.2 (Zod `.min(1)` + handler-level guard) |
| 27 | `memory_create` accepts empty label and content | `src/tools/register-tools.ts` | ✅ Fixed in 1.2.2 (Zod `.min(1)`) |
| 28 | `memory_delete` may leave dangling `similar_to` edges | `src/core/db.ts` | ✅ Fixed in 1.2.2 (defense-in-depth explicit edge delete; FK cascade was already correct but per-connection PRAGMA risk) |
| 29 | `search('')` returns medium-confidence results | `src/tools/register-tools.ts` | ✅ Fixed in 1.2.2 (Zod `.min(1)`) |
| 30 | `cluster` falls back to generic "Cluster 1/2" labels | `src/tools/semantic-navigate.ts` | ✅ Fixed in 1.2.2 (heuristic-token fallback + stderr degradation log) |
| 31 | `reindex(non-existent-folder)` silent no-op | `src/tools/reindex.ts` | ✅ Fixed in 1.2.2 (explicit "matched no files" return) |
| 32 | `graph_query(no-such-file)` leaks DB internals | `src/tools/project-graph.ts` | ✅ Fixed in 1.2.2 (required-arg checks + clear not-found message) |
| 33 | `change_impact` silently truncates importer list | `src/tools/agentic-context.ts` | ✅ Fixed in 1.2.2 (explicit "+N more" line with artifact ref) |

### New capability (closes audit-identified gap)

- **Literal/regex `grep` tool.** The audit rated `Find a literal log string` as a "Wash" between vanilla grep and ContextPro because hybrid search underperforms on intent-free literal queries. 1.2.2 ships a dedicated `grep` tool that walks the indexed file set, scans literally or via regex, supports glob filtering and target_path scoping, caps output to prevent context blowup, and returns ripgrep-style `path:L:col context` output. (`src/tools/grep.ts`, audit "Comparison vs vanilla Read/Grep/Glob".)

### Items considered but rejected

- "graph_query(kind='file') Project fingerprint mismatch" from the workflow report. Direct probe could not reproduce; returned proper file view with 50 nodes + 50 edges. Likely transient state from a prior probe contaminating the workflow agent — not a real bug.
