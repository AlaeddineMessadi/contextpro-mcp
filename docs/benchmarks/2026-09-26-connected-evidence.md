# Connected evidence and coding-task pilot

Connected retrieval remains opt-in. This experiment separates retrieved evidence
from completed coding tasks; response bytes are not billed tokens.

## Frozen contracts

`scripts/fixtures/coding-pilot.json` fixes eight prompts, historical fixes and
acceptance tests. Each task starts at its fix's first parent. The contract hash
also includes `scripts/pilot-text-preview.mjs`. All eight validators failed before
their historical fix and passed afterward before the campaign started.

The baseline server is `7cf79035fa093772929218e3e517a0ede1b246bb`. The candidate
is frozen separately. Build fingerprints are checked before and after trials.
Ranking is not tuned using pilot outcomes.

The campaign runs eight matched pairs, alternating baseline/candidate order.
Each agent has ten minutes, identical configured model/effort settings, native
fallbacks, and an isolated Git repository without historical commits. Model
enrichment is off; indexes are structurally seeded without corpus embeddings.
Local provider evaluation is a separate experiment.

Instruction files and retrospective benchmark reports are removed symmetrically;
build scripts remain. Independent validators are injected after the agent stops.
Installed dependencies are APFS copies from each local project, identical within
a pair; this is not a clean lockfile installation. Raw events, source, patches
and traces stay in the ignored local output directory.

The routing validator omits its bundled-instructions assertion because those
documents are excluded. app-d browser checks use the production test server
and installed Chrome. The plain-text validator bundles the actual source panel
and text/Markdown components, stubs unrelated previewers, and checks content,
whitespace, integrity errors, retry, fallback and scroll anchoring in Chrome.
It is a component contract test, not a database/authentication integration test.

Usage comes from provider-reported agent events; cached input is a subset of
input and is not added twice. Missing counts remain unavailable. Server-side
embedding/chat usage is separate. Time includes the agent and independent
validation; setup is reported separately. Native command totals and heuristic
read-command candidates are reported; these are not exact fallback counts.

The rollout target is at least 20% lower median paired task time or provider
tokens on jointly passing tasks, no more than 10% regression in the other metric,
and no correctness regression. Failures/timeouts stay in the report. Eight
single-run pairs are preliminary evidence, not a universal savings claim.

## Reproduction

Create an output directory with `repos.json` mapping `contextpro`, `app-d`
and `app-c` to absolute paths, and separately built server launchers at
`<output>/<variant>/build/index.js`.

```sh
CONTEXTPRO_PILOT_OUTPUT=/absolute/output node scripts/benchmark-coding-pilot.mjs --plan
CONTEXTPRO_PILOT_OUTPUT=/absolute/output node scripts/benchmark-coding-pilot.mjs --prepare
# Explicitly consumes coding-agent quota; never runs by default.
CONTEXTPRO_PILOT_OUTPUT=/absolute/output node scripts/benchmark-coding-pilot.mjs --run
```

New campaigns now default to validator v2 (see the repair follow-up below).
Set `CONTEXTPRO_PILOT_VALIDATOR_VERSION=1` to reproduce this document's original
frozen campaign. Version 2 requires a fresh output directory and new qualification;
the runner rejects changes to an existing campaign's contract.

`CONTEXTPRO_PILOT_CODEX` selects a specific CLI executable; its path and version
are recorded with the campaign. `--recheck` requalifies validators. Do not prepare/recheck concurrently in one
output directory. `--run` refuses an existing `runs.json`. After stopping a failed
harness process, `--resume` verifies the saved contracts, build fingerprints,
CLI/model settings and completed plan prefix before continuing. A residual
interrupted trial is retained as a failure with unavailable timing/usage rather
than retried; only unstarted trials run. Never resume a still-running harness.
`CONTEXTPRO_PILOT_VARIANTS` also accepts `native` and
`CONTEXTPRO_PILOT_REPEATS` supports repeated runs. This campaign uses only
`baseline,candidate`, once each.

## Retrieval development evaluation

`benchmark-semantic-evidence.mjs` compares lexical-only, semantic-only and
combined retrieval with both selectors on identical sources/budgets. It records
decisive-source coverage, irrelevant file output, latency, unmet evidence needing
follow-up, vector provenance and provider usage. Exact-name fast paths are marked
separately. Unknown-symbol and unrelated-query controls are included.

The real local `bge-m3:latest` evaluation completed 90 observations across absent,
valid and obsolete vectors. Both selectors retained all expected evidence in the
three positive combined-retrieval cases. Absent/obsolete vectors produced zero
semantic file hits. The corpus contains only 16 synthetic files; production
semantic quality is not established. With valid vectors, connected retrieval
returned source for the unrelated natural-language control. Abstention remains
a limitation; the unknown-symbol control returned no source. `gemma4:latest`
was not installed, so chat quality was not evaluated. Mock-provider tests verify
deadlines, output validation and fallback behavior, not model quality.

The [sanitized observations](2026-09-26-semantic-evidence.json) retain all 90
results and their provider-reported counts. Irrelevant output is measured as
file occurrences against each fixture's declared relevant-file set; follow-up
need means a missing expected predicate, not an observed human/agent read.
These small sequential measurements have no warm/cold randomization or confidence
intervals. Main tests ran alongside the final development retrieval evaluation;
its latency values are contended and are not used for the rollout gate.
Named-definition source paths remain eligible even in a semantic-only
experiment, while exact-name fast paths are separately marked.

The broad visual replay archives app-a at
`private-rev`. At a 5,000-unit budget including
metadata, baseline returned none of three expected files; candidate returned
`WelcomeBanner` but omitted `HeroFigure` and `heroArtwork`. The issue remains
open. This development replay does not demonstrate a coding-task speed gain.

## Coding-pilot results

The frozen candidate is `ba3d3aa789173cf0579e588158acc04e0f87358b`. Its compiled
JavaScript fingerprint is `6dae30731cbe2fd0a53c8b113d72342ca0b20663cf48b479012e09c036f17292`;
baseline fingerprint is `58600b5288de007ec603d7317dd71e5b9fcfca5c6be7416fc13a0dba56148741`.

Four initial starts through standalone CLI 0.154.0 rejected `gpt-6-sol` before
coding (zero source calls/patches, usage unavailable). Execution was stopped;
these infrastructure failures are retained separately. Desktop bundled CLI
0.155.0-alpha.16.4 accepted the same model in a readiness probe (18,191 input,
11,776 cached-input subset, 5 output tokens), counted as setup rather than a
coding task. The unchanged 16-trial contract runs with that executable at
`gpt-6-sol` / `xhigh`. A host restart interrupted the eleventh planned attempt
(country-normalization candidate). Its application source is unchanged and the copy is retained;
agent start, duration and usage could not be recovered. It is an infrastructure
failure, not a demonstrated retrieval failure. The first ten completed results
were preserved and only the five unstarted trials resumed, with identical builds,
contracts and CLI/model settings. All 16 planned attempts are accounted for:
15 have agent outcomes (including two ten-minute timeouts), and one was
interrupted by the host restart. There are no replacement runs.

Baseline passes **1/8** frozen contracts; candidate passes **0/8**. There are
**zero jointly passing pairs**, so median paired task-time and provider-token
improvements are **unavailable**. The video-export pair fails the no-regression
condition. The rollout gate is **not met**; connected retrieval stays opt-in.
These are strict acceptance results, with the validator limitations below;
they do not establish that retrieval caused every task failure.

The [sanitized trial report](2026-09-26-coding-pilot.json) contains all outcomes,
provider usage, setup/validation time, native-read candidates and MCP traces.
In the table, every pair is **baseline / candidate**. Time includes independent
validation. Tokens mean provider-reported input plus output, with cached input
counted once. Unavailable counts are not estimated.

| Task | Outcome | Task minutes | Provider tokens |
| --- | --- | ---: | ---: |
| Worktree routing | Fail / Fail | 7.85 / 8.93 | 2,810,415 / 3,466,414 |
| Grep context | Fail / Fail | 4.28 / 5.36 | 669,417 / 769,696 |
| Offline contact | Fail / Fail | 6.35 / 5.40 | 1,246,747 / 647,376 |
| Reporting withdrawal | Fail / Timeout | 6.71 / 10.82 | 2,137,926 / — |
| Video export | Pass / Fail | 6.86 / 4.68 | 1,850,064 / 1,268,229 |
| Country normalization | Fail / Interrupted | 2.92 / — | 529,931 / — |
| Empty-field comparison | Fail / Fail | 6.78 / 7.31 | 2,074,175 / 1,517,159 |
| Plain-text preview | Timeout / Fail | 10.60 / 9.54 | — / 2,167,033 |

Observed calls comprise 33 query-context and 72 exact-target requests. No agent
requested a feature brief, task pack or source delta; this pilot therefore
does not measure productivity gains from those capabilities. Missing tool
events for the interrupted attempt remain unknown.

The machine also hosts other user work; isolated source copies do not imply
isolated CPU or network resources. Local implementation tests are paused during
timed coding runs to avoid additional contention from this task.

Agent commands use the `workspace-write` sandbox. Captured command output shows
`listen EPERM` for local-server tests inside it; independent validators run on the
host and can start their servers. Removing instruction documents also causes
unrelated full-suite assertions when agents run every repository test. These
environment differences can affect agent behavior and timing; a historical
validator passing before/after qualification does not remove those limitations.

Independent review after freezing found cache-identity omissions for connected
task-pack graph limits/source budgets, and missing validation of citation IDs in
previously cached briefs. Further review added source-hash and line-bound checks
for cached citations, and rejection of malformed warning metadata. The final
changes also bind context IDs to packet contents and delivery completeness,
reject altered baselines and repair corrupt records on full reads. These
changes harden the cache contracts separately;
the pilot build stays frozen at the identity above. These changes are not ranking
tuning against held-out results, and pilot timings do not measure that later
cache hardening.

## Failure interpretation

Acceptance is deliberately binary, but failure causes differ. The retained logs
show the following; these are observations about task patches, not proof that a
specific retrieval decision caused them.

| Task | Baseline | Candidate |
| --- | --- | --- |
| Worktree routing | Missing required routing-trace fields | Ambiguous-root rejection assertion failed |
| Grep context | Five of seven checks pass; literal-regex diagnostic and neighbor-marker format differ | Same two failures |
| Offline contact | Offline shell retains the old contact | Contact refreshes, but the public-shell request includes cookies |
| Reporting withdrawal | Five of six checks pass; archival/reload withdrawal flow fails | Ten-minute timeout; independent validation also fails the archival/reload flow |
| Video export | All export checks pass | Twelve of thirteen checks pass; excluded-media manifest count is wrong |
| Country normalization | Thirty-nine of forty checks pass; numeric `12` is accepted as a country | Host interruption; unchanged source retained and timing/usage unavailable |
| Empty-field comparison | Ninety of ninety-three checks pass; the required classification-validation warning is absent | Ninety of ninety-three checks pass; two warning assertions fail and a valid omission repair is rejected |
| Plain-text preview | Ten-minute timeout; validator then could not locate its expected per-line DOM node for scroll testing | Rejected at the CSS whitespace assertion because `break-spaces` does not match `/pre/`; later checks did not run |

The grep validator requires exact diagnostic/marker conventions that the prompt
does not spell out. The video validator checks manifest accounting in addition
to the requested media-access behavior. The empty-field validator also requires
a specific warning log not named in the prompt. These strict contracts constrain how
the pass rate should be interpreted; their frozen results are not changed after
seeing the patches. The video pair still prevents the declared no-correctness-
regression rollout gate from passing.

The plain-text validator has a confirmed limitation: it checks the CSS value
with `/pre/`, which rejects `break-spaces` even though that value preserves
whitespace ([CSS Text specification](https://www.w3.org/TR/css-text-3/#valdef-white-space-break-spaces)).
The candidate's recorded failure is retained, but this assertion does not
demonstrate a rendering defect, and the remaining checks were not reached.
The baseline's validator also stops at a per-line text-node locator, while
its patch renders the complete literal text in one `pre` element. That locator
assumes DOM structure not required by the prompt. The task's full correctness
is inconclusive for both patches; baseline additionally exceeded its deadline.
Do not use it to claim comparative productivity. A future campaign needs a separately frozen behavioral validator;
the held-out contract and recorded outcomes were not revised to accept this patch.

## Final implementation verification

Final source changes are at `a7b6a6b` (subsequent commits contain report updates).
All 11 applicable CI checks pass, including **722 main tests** across Node
20/22/24/26 and macOS, both application builds, documentation, release metadata,
package checks, dependency audits and secret scanning. The frozen candidate
also passed 33 parser demos. Private-repository conditions skip CodeQL and
dependency review; those skips are not counted as passes.

The final local build has 105 JavaScript files and fingerprint
`4f76153c8cc9e5ffc0fe0faeaaf57307811315bdde14a22c98313ef0d77500b8`.
Direct before/after probes accepted all four corrupted-cache cases on the
frozen candidate and rejected all four on the final build: out-of-file citation
ranges, mismatched citation hashes, malformed warning metadata and altered
source snapshots. Focused local tests also verify forged completion flags and
cache repair. These repairs are outside the frozen pilot's measured build.

A fresh real `bge-m3` fixture had a positive semantic hit; explicitly selecting
`keyword_only` correctly reported that selection with both source selectors,
without calling a provider during the lexical reads. It no longer misdiagnoses
available vectors as unavailable. This is a diagnostic regression check, not
a new retrieval-performance comparison.

## Post-merge repair follow-up

The original pilot above remains frozen. Development replays against merged
baseline `b08e282` found that the connected selector promoted weak semantic
neighbors into graph seeds and counted repeated identifiers as independent file
ranking votes. Both are repaired. The selector now shares bounded graph expansion
across query facets, preserves multi-topic filenames and a selected implementation's
local helpers, and downweights incidental generated reports for source requests.
PR #27 review narrowed that last heuristic to known report directories: ordinary
JSON configuration, Markdown content and CSV data retain full source weight.
The regression failed before the repair and passes afterward, including bounded
default/connected source packets. All 738 main tests pass, and the frozen visual
replay retains all three expected files. Task/source cache versions and the brief
generator version were advanced so older rankings are not reused as current.
A subsequent review found that a large facet-owner union could evict associated
tests or graph evidence at the 32-file cap. Slots are now reserved for the four
seeds, up to sixteen graph files and four tests before adding other facet/topic
owners. A 24-topic fixture reproduced the missing test before the fix and passes
with graph budgets of eight and sixteen afterward. All 739 main tests pass;
both frozen visual and cleanup replays retain all three expected files per pair.
The absolute semantic floor follows the existing caller-expansion heuristic
(greater than 40/100 similarity); it is not a probability or a guarantee across
embedding models. Strong semantic paraphrases remain eligible without literal overlap.
Source packets, task packs and briefs invalidate the previous selector's caches.

Frozen zero-vector development replays used the original queries and budgets:

| Reproduction | Merged baseline | Repaired selector |
| --- | --- | --- |
| app-a `private-rev`, visual query, 5,000 units | WelcomeBanner only | WelcomeBanner, HeroFigure, heroArtwork |
| app-b `private-rev`, cleanup query, 3,200 units | Migration and operator script | Migration, operator script and security test |

Each result repeated twice with alternating handler order on a fresh structural
index. These checks assert source-file coverage, not complete task correctness.
The broader app-b write-path query still misses requested paths at its 3,000-unit
budget and remains open in the canonical issue log. General broad lexical recall
and the default selector have not been declared fixed. Connected retrieval remains
opt-in; the coding-pilot rollout gate and original outcomes have not changed.

The real local `bge-m3:latest` development evaluation again completed 90 observations.
The connected selector returned no source for either negative control in all vector
states/presets, while retaining all expected positive evidence with fresh vectors
and in lexical/combined fallback. Semantic-only queries with absent or obsolete
vectors correctly had no semantic evidence. `gemma4:latest` remains unavailable.
No new coding-agent campaign or billing comparison was run.

For future campaigns, `pilot-text-preview-v2.mjs` checks rendered newline/tab
geometry and uses DOM text ranges for scroll anchors. It accepts both whole-text
and per-line structures, including `break-spaces`. Fourteen isolated browser
checks cover preserving/collapsing CSS modes, multiple tab sizes, truncation and
scroll anchors. The historical before/fix pair still fails/passes respectively,
and the fixed component also passes using `break-spaces`. The frozen v1 script
and all 16 pilot outcomes remain unchanged. Reproduce the independent browser
checks with `node scripts/test-preview-contract.mjs /absolute/app-c-root`;
that root supplies Playwright and an installed Chrome is required. The v2 script
and its browser helper are included in the new contract hash.
