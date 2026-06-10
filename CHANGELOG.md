# Changelog

## 1.1.0 - 2026-06-10

- Added primary agent workflow aliases: `start_task`, `plan_edit`, `impact`, `validate`, and `remember`.
- Added portable project graph export/query tools with confidence-tagged nodes and edges.
- Added `impact_delta` for comparing graph exports before and after edits.
- Added TypeScript/JavaScript exact references via the local TypeScript language service.
- Added optional SCIP JSON import/status support for exact cross-language reference evidence.
- Added SQLite FTS5/BM25 retrieval fallback and search presets.
- Hardened project path containment and shell command execution.
- Restored legacy memory graph compatibility over SQLite-backed memory storage.
- Fixed sqlite-vec filtered KNN compatibility and refreshed dependency/runtime packaging.
