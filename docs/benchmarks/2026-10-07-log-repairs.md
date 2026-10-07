# October 7 issue-log repairs

Baseline: `5f95d1d`. These are bounded retrieval and compiler checks, not an
agent productivity, semantic-quality, or billing benchmark.

## Discovery

Named implementations now precede incidental document excerpts. Historical
document paths receive the existing secondary-evidence weighting unless history
or that path is requested. Specification and task/design/implementation-plan
requests enter document discovery. Translation modules retain their penalty only
when the query does not request locale evidence. Exact reads are unchanged.

The regression in `test/main/discovery-routing.test.mjs` fails on the baseline:
an archived document is first while the implementation is displaced. It passes
for default, lookup and change requests after the repair, preserves the complete
function within 800 estimated tokens, and checks explicit plan/history retrieval.

A separate local replay uses one frozen 591-file application corpus, zero
vectors, identical queries/budgets and the `keyword_only` preset. Private source
and raw responses remain local.

| Request | Baseline document bytes | Candidate document bytes | Observed change |
| --- | ---: | ---: | --- |
| Guided workflow, named shell | 17,699 | 7,556 | Shell implementation moves first; current forms/routes remain |
| Named listing actions/form | 9,136 | 5,723 | Named source precedes document excerpts |
| Named shell/layout | 3,673 | 3,673 | Three named implementations precede documents |
| Reviewed specification/task plan | 0 | 9,661 | Relevant design specification is returned first |

Bytes describe document excerpt content, not complete packets or token savings.
The returned source remains bounded; this does not close general lexical recall
or older unrelated write-path omissions.

PR review reproduced two polarity regressions: negated plan phrases enabled
document discovery, and negated history phrases removed the archive penalty.
Both intent checks now reuse the existing positive-clause parser after explicit
file exclusions. The regressions fail on `137ebd9` and pass after the repair,
including source-first packing and explicit later requests for documents/history.
The follow-up covers "without task plans" and "without historical notes" while
preserving behavioral descriptions such as "routes without authentication".

## References

The compiler host exposes a project version that changes on every project/request.
Multiple compiler APIs within that request reuse the synchronized project;
the next request still validates disk snapshots and configuration.

The regression in `test/main/reference-correctness.test.mjs` observes four
baseline filesystem checks of an unchanged target versus three after the repair,
then verifies that the next edit is visible. Worker checks additionally edit the
definition after querying five configurations. Binding identity, call counts,
aliases, renames, imported changes and configuration invalidation pass.

A frozen 308-file repository replay returns the same seven occurrences across
three configurations without warnings. Baseline times are 4,120 / 1,926 / 1,784 ms;
candidate times are 3,726 / 3,132 / 1,937 ms. These mixed samples do not establish
an end-to-end speed improvement. A separate fresh public MCP call takes 9,978 ms
and returns all seven indexed occurrences, with no warnings.

Cold compiler construction and structural indexing remain separate latency costs.
No general latency guarantee or reference completeness outside indexed scope is
claimed.

## Dependencies and landing checks

- SDK minimum is 1.31.0; the lockfile installs 1.32.0 to address
  [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
  The advisory affects HTTP OAuth clients, not SDK servers or stdio clients.
- Both apps install Sharp 0.35.5 for
  [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
  Landing narrowly overrides Miniflare's exact 0.35.4 pin; native image encoding
  and both app builds pass.
- Core/dashboard full audits and all production audits are clean. Landing still
  has five development findings propagated from the unpatched
  [Braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- Landing lint has zero errors and seven existing warnings. Theme initialization
  uses React's external-store API; browser checks confirm toggling, persistence
  after reload, return to light mode, and no captured console errors.

Validation on Node 26: 829 core tests, 33 demos, 14 dashboard tests; core and both
app builds; documentation, release metadata and package checks. A fresh configured
MCP launcher verifies health and the bundled instruction resource. Restarting an
already-running client is separate from compiling and verifying a fresh process.
