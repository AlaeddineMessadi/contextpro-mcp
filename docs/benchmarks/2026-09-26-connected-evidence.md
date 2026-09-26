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

`CONTEXTPRO_PILOT_CODEX` selects a specific CLI executable; its path and version
are recorded with the campaign. `--recheck` requalifies validators. Do not prepare/recheck concurrently in one
output directory. Existing `runs.json` is never overwritten.
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
intervals. Named-definition source paths remain eligible even in a semantic-only
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
`gpt-6-sol` / `xhigh`. Results are pending.

The machine also hosts other user work; isolated source copies do not imply
isolated CPU or network resources. Local implementation tests are paused during
timed coding runs to avoid additional contention from this task.

Independent review after freezing found cache-identity omissions for connected
task-pack graph limits/source budgets, and missing validation of citation IDs in
previously cached briefs. The final changes harden these contracts separately;
the pilot build stays frozen at the identity above. These changes are not ranking
tuning against held-out results, and pilot timings do not measure that later
cache hardening.
