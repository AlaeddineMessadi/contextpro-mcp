# ContextPro backlog

This is the current implementation backlog. Earlier upstream proposals are preserved in the [archive](docs/archive/README.md). See the [roadmap](docs/roadmaps/contextpro-roadmap.md) for acceptance criteria; completed code is not automatically a published release.

## Implemented foundation

- [x] Lean context workflow and batched source reads.
- [x] Parser crash isolation and bounded optional retrieval-model work.
- [x] TS/JS project-aware references, occurrence categories and explicit truncation.
- [x] Reusable isolated compiler services.
- [x] Stronger source fingerprints and reconciliation after watcher failures.
- [x] Record tool replays separately from provider-usage trials and estimates.

## Next priorities

- [ ] Reduce cold compiler initialization and duplicate freshness work per request.
- [ ] Make cache invalidation dependency-aware, including file inventory for negative results.
- [ ] Improve one-call routing and retain supporting types, guards and tests in small packets; add a held-out fixture where exact scaffolding identifiers compete with generic UI matches.
- [ ] Evaluate complete feature implementations against a shared adverse-state suite (revoked entitlements, feature flags, locale coverage), not only lookup accuracy.
- [ ] Add bounded reference pagination and validate imported SCIP source revisions.
- [ ] Validate memory against source/config revisions; preserve supersession and add scoped offline lexical retrieval.
- [ ] Benchmark held-out repos with matched agent settings, repeated trials, correctness scoring and actual provider usage.
- [ ] Evaluate optional learned pruning only after it beats the deterministic baseline without unacceptable recall loss.

## Later, if justified

- [ ] Split the large registration module while preserving schemas and profiles.
- [ ] Improve additional-language semantic coverage and editor-buffer integration.
- [ ] Extend resource limits and shared-worktree coordination where profiling shows a need.

Additional TUI, peer-agent session import and transport proposals remain historical ideas, not current delivery commitments.
