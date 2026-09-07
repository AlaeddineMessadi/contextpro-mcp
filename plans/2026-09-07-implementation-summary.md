# Implementation results — 7 September 2026

All approved audit workstreams and the requested agent adoption and savings reporting are implemented in the working tree. Baseline: `02e1398`. Package version remains 1.3.0; changes are unreleased. Implementation and follow-up fixes are tracked in PR #8. No package publication was performed.

## Delivered

- **Safer source changes:** canonical workspace containment, symlink escape protection, shared process and cross-process write serialization, content-hash conflict checks, exact parser spans, atomic individual-file publication, and validated rename staging with explicit partial-failure recovery.
- **Reliable indexes:** stale-file backlog retention, transactional per-file import updates, incoming import reconnection, repair markers after failed finalization, and consistent SQLite worktree backups including WAL state. Structural-only operations no longer trigger background memory embedding.
- **Efficient retrieval:** budgets applied to final rendered responses, memory-aware cache invalidation, enforced search filters, provider-free lexical retrieval, and request-local embedding reuse.
- **Smaller discovery surface:** a 12-tool `workflow` profile, with existing `core` and `full` profiles retained. Actual tools/list JSON sizes were 17,859 / 49,693 / 75,501 bytes respectively. Workflow is approximately 64% smaller than core in schema bytes; this is not an end-to-end token savings measurement.
- **Reusable context:** immutable context snapshots, added/changed/removed deltas, explicit full-context recovery, and optional bounded import-graph expansion. Concurrent requests cannot overwrite a published snapshot ID.
- **Agent adoption:** init installs managed MCP-first instructions while preserving surrounding user instructions and existing MCP configuration. Instructions cover bounded retrieval, fallback when needed, and one final efficiency summary. Agent hosts still control tool selection; repository instructions cannot force every host to comply.
- **Honest reporting:** current-process session isolation, source revision deduplication, request/response and catalog overhead, negative net results, optional caller-supplied pricing and ContextPro costs. Actual billing and actual agent-token savings remain unknown unless measured externally. Reports do not claim revenue.
- **Embedding recovery:** full reindex rebuilds missing durable-memory vectors after model changes without rewriting content/access metadata. Failed rebuilds retain stale status; changed or deleted nodes cannot receive outdated vectors.
- **Reproducible evaluation:** an offline retrieval benchmark, fixed fixtures, and an input schema for paired external agent runs with actual usage records. File and identifier caches are reset before every cold task-packet variant.
- **Runtime stability:** automatic native repair uses an isolated cache keyed by ABI, platform, architecture, libc and dependency versions. It pins npm to the launching Node executable and validates both SQLite and vectors before publication. Shared node_modules remain unchanged. `doctor --fix` retries explicitly; automatic repair can be disabled.

## Verification

- TypeScript production build passed.
- Full suite: **611 tests across 172 suites, zero failures or skips**, under both Node 24.15.0 and Node 26.0.0.
- `git diff --check` passed.
- A real Node 24 ABI mismatch was reproduced and repaired into the isolated cache. The shared Node 26 binary remained byte-for-byte unchanged. The same process successfully loaded SQLite and vectors after repair.
- Regression coverage includes injected import-write failures, multi-process edits, worktree initialization races, immutable snapshot races, protocol-level output budgets, session isolation, and zero-provider lexical requests.

## Benchmark evidence

See [the recorded benchmark](2026-09-07-retrieval-benchmark.json). Five synthetic TypeScript, Python, and monorepo tasks include stale-index and worktree cases; provider calls were **zero**.

Both rg/snippet retrieval and ContextPro keyword search achieved hit@1 and recall@5 of 1.0 on this small corpus. ContextPro search returned more output: approximately 1,005 tokens versus 130 for rg snippets, using UTF-8 bytes divided by four. This shows that tiny exact searches do not automatically save tokens through the MCP.

Optional graph expansion increased task-packet recall from 0.60 to 1.00, while estimated output increased from 622 to 705 tokens. It remains off by default. These are fixture results, not proof of real agent task success or billing savings. Latency measurements are single-run diagnostics, not stable performance guarantees.

Run `npm run bench:retrieval` with a compatible Node runtime. The underlying script accepts `--output <path>` and optional `--agent-runs <path>` for paired actual-usage records; see `scripts/benchmark-agent-runs.schema.json`.

## Usage and limits

Restart the MCP process to load the rebuilt server. New init configurations select `workflow`; existing custom server configuration is preserved. See [installation instructions](../INSTALL.md) for configuration and agent setup.

At completion, agents are instructed to call `efficiency_report` for the current session and quote its `finalSummary` once. Monetary scenarios require a known model input price. Token counts are estimates against full-file reads, not a measurement of what an alternative agent would actually have done. A server process session can span multiple user tasks, and its report excludes the reporting request itself until that request completes.

Writes serialize per repository. Individual files publish atomically, but a multi-file operation is not a filesystem transaction; partial failures include recovery information. Rename remains a validated textual operation rather than an exact language-server rename. Portable filesystem checks cannot eliminate every race against an actively hostile process swapping directories. Live semantic-provider quality and complete agent-run economics were not measured in this verification.
