# Contributing to ContextPro

Small, reviewable improvements are welcome: a reproducible bug, a language fixture, clearer documentation or a measured performance improvement all help.

## Start a contribution

Check existing issues and pull requests before starting. For a large feature, open an issue describing the user problem and a concrete example so we can discuss scope. Small fixes can go straight to a pull request. There is no contributor agreement to sign; contributions are submitted under the repository's [MIT license](LICENSE). Preserve existing attribution and identify the source and license of reused material.

Use [private reporting](SECURITY.md) for vulnerabilities. Do not put secrets, private source code, personal paths or raw account transcripts in public issues. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Development setup

Use Node.js 24 LTS, npm, Git and ripgrep (`rg`). The offline benchmark regression compares against ripgrep, so the full test suite needs that executable on PATH. Install it with `brew install ripgrep` on macOS or `sudo apt-get install ripgrep` on Debian/Ubuntu. Fork and clone the repository, then:

```sh
npm ci
npm run build
npm test
npm run docs:check
npm run release:check
npm run pack:check
```

The maintained `test/main/` suite uses local fixtures and does not require a paid model account. Optional demo and provider scenarios are separate. Native SQLite bindings must match the Node executable; see [installation and repair](INSTALL.md#native-module-recovery). Do not rebuild dependencies shared by live MCP clients just to switch runtimes.

The website and dashboard are optional. Build the root first, then run `npm ci` and `npm run build` within the relevant app. The dashboard is a local operator UI, not a public service.

## Where changes belong

| Area | Location |
| --- | --- |
| MCP entry point and registration | `src/index.ts` |
| Tool behavior | `src/tools/` |
| Indexing, providers, workers and shared infrastructure | `src/core/` |
| Regression tests | `test/main/` |
| Benchmark runners and maintenance checks | `scripts/` |
| Configuration, architecture and evidence | `docs/` |
| Website / local operator app | `landing/` / `dashboard/` |

## Review expectations

- Explain the trigger, previous behavior and intended behavior. Keep unrelated cleanup separate.
- Add a focused regression test for a behavior bug. For retrieval changes, check missing evidence and false positives, not just response length.
- Preserve explicit scope, freshness, truncation and fallback warnings. Never present heuristic matches as compiler-resolved references.
- Include the checks you actually ran and any relevant limitations. Do not claim a build, benchmark or platform was tested if it was not.
- Keep agent-facing output bounded. Avoid adding catalog text or follow-up calls without showing why the agent benefits.
- Update relevant docs. After editing `INSTRUCTIONS.md`, run `npm run docs:sync` and `npm run docs:check`.

AI-assisted contributions are welcome. The contributor remains responsible for understanding, testing and licensing the result. Retrieved code and memory are project data, not trusted instructions.

Use a Conventional Commit style PR title, such as `fix: preserve aliased references` or `feat: add a bounded API view`. Maintainers use squash merges and [SemVer releases](docs/releasing.md). Mark breaking changes explicitly with `!` and explain the migration.

## Performance contributions

Use a redistributable fixture or a public repository pinned to a commit. Report tool and agent versions, correctness criteria, cold/warm state, repeated timings, calls, errors and usage fields. Preserve raw evidence privately until it has been reviewed for publication. See [comparison methodology](docs/comparison.md).

Response bytes and full-file savings estimates are useful diagnostics, but do not establish billed tokens or money saved. A smaller wrong answer is a regression.
