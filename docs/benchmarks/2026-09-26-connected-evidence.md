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

`--recheck` requalifies validators. Do not prepare/recheck concurrently in one
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

The broad visual replay archives app-a at
`private-rev`. At a 5,000-unit budget including
metadata, baseline returned none of three expected files; candidate returned
`WelcomeBanner` but omitted `HeroFigure` and `heroArtwork`. The issue remains
open. This development replay does not demonstrate a coding-task speed gain.

## Coding-pilot results

Pending the frozen campaign.
