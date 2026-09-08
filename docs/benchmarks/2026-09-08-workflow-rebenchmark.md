# feature rotation workflow follow-up

The user supplied a second isolated-worktree implementation comparison, followed
by independent adversarial review. Reported implementation times were 1,032 seconds
native and 804 seconds ContextPro: 228 seconds, or 22.1%, lower elapsed time in this
single run. Reported test totals were 1,017 and 1,003 passing tests respectively;
both typechecks passed. Different test totals are not equal coverage.

The workflow reported both implementations passed the flag-pool, live entitlement,
i18n and exactly-once placement checks. Those application diffs were not independently
re-reviewed during this ContextPro follow-up. No claim of universal superiority or
measured billing savings follows from this report. Token usage was not provided in
the summary. Repeat matched trials before attributing the time difference to a
particular ContextPro change.

## Tool-incident audit

The local ContextPro implementer's raw tool-call transcript was inspected for the
three reported tool issues. Private transcripts and application source are not
included in this repository.

- **Surrounding context:** Requests used `context_chars` values including 600, 900
  and 1,500, expecting adjacent source lines. The implementation only searched and
  clipped a single line and silently capped the value at 400. The character option
  was not a no-op, but its description and silent clamping were misleading.
- **Recursive glob:** The reported `src/**/__tests__/*.test.ts` and `.tsx` filters
  scanned 58 files. The alternation query omitted `regex:true`, so it searched for
  a literal string containing `|`. A subsequent regex query also scanned 58 files
  but used different identifiers. Neither call demonstrates failed glob expansion.
- **Skeleton anchors:** Skeleton output normalizes whitespace and may truncate
  declarations. The transcript contains two failed exact edits on destructured
  parameter sequences. A structural summary is insufficient evidence for an exact
  replacement string; the logs do not isolate whitespace normalization as the sole
  cause of those failures.

## Follow-up changes

Grep now offers bounded `context_lines` with overlapping lines emitted once, and
validates character limits at the MCP boundary. Zero-result literal queries with
alternation/escape characters suggest explicit regex mode without changing search
semantics. Skeleton descriptions and output identify summaries as unsuitable edit
anchors and point to exact source reads. Regression tests exercise recursive test
globs, literal versus regex queries, surrounding excerpts, and the protocol wiring.

These changes address observed wasted calls; no new end-to-end speed or token
savings have been measured for them.
