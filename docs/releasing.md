# Versioning and releases

ContextPro uses [Semantic Versioning](https://semver.org/). A patch fixes compatible behavior, a minor release adds compatible functionality, and a major release changes a supported contract incompatibly. Tool arguments/results, CLI flags, configuration and persisted-state migrations deserve explicit compatibility review. Experimental or heuristic behavior must be documented as such; do not use that label to hide a breaking change.

## Release pull requests

Use Conventional Commit style squash titles: `fix:`, `feat:`, `docs:` and so on. Mark breaking changes with `!` and a migration explanation. Release Please updates the root package version, lockfile and changelog through a reviewable PR.

The checked-in manifest starts at the existing `1.3.0` metadata. That is not a claim that a registry release exists. Before enabling automation, choose the intended first public version and adjust the release PR if necessary. The bootstrap commit is the reviewed base before launch preparation; older private development history is not automatically imported into the new generated notes.

Enable repository permission for Actions to create PRs, then set the repository variable `RELEASE_AUTOMATION_ENABLED=true`. The workflow also requires a public repository and `main`. It uses GitHub's short-lived built-in token, not a personal access token.

**Important:** events produced by `GITHUB_TOKEN` do not trigger ordinary follow-on Actions runs. After Release Please opens or updates its PR, manually run the **CI** and **Security** workflows against that release branch and verify the exact head commit before merging. Do not bypass required checks. A narrowly scoped GitHub App can automate this later if needed. See the [Release Please action documentation](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).

Merging a reviewed release PR allows Release Please to create a tag and GitHub release. It does **not** publish npm. Keep the version files synchronized with `npm run release:check` and inspect `npm run pack:check` before tagging.

## One-time npm setup

1. Confirm ownership and availability of `contextpro-mcp` with the npm account intended to maintain it. No working registry install is advertised before a release is verified.
2. If the package does not exist and its settings cannot be configured, bootstrap the first reviewed tarball using the maintainer's authenticated npm account and required 2FA. Review the exact tarball, version and access before publishing. Do not store that login token in GitHub.
3. Create a GitHub environment named `npm`, restrict deployments to release tags matching `v*`, and require a maintainer reviewer where the repository plan supports it. Protect release tags against unauthorized creation, updates and deletion with a repository ruleset.
4. Configure the package's npm trusted publisher for GitHub owner `AlaeddineMessadi`, repository `contextpro-mcp`, workflow filename `publish.yml`, environment `npm`. Select permission for **direct `npm publish`**: newer trusted-publisher configurations can default to staged publishing, which this workflow does not use.
5. Set the repository variable `NPM_PUBLISH_ENABLED=true` only when ownership, the environment and trusted publishing are ready. Review trusted publisher settings after renaming or transferring the repository.

Use [npm's current trusted-publishing instructions](https://docs.npmjs.com/trusted-publishers/) for account setup. The workflow uses a GitHub-hosted runner and OIDC, with no `NPM_TOKEN` secret. Provenance establishes build origin; it does not establish that code is secure.

## Publish an existing reviewed tag

Run **Publish npm** manually **on the existing release tag**, for example `gh workflow run publish.yml --ref v1.4.0`. A SemVer prerelease is also supported. Dispatching from `main` intentionally skips publication: the workflow's GitHub commit must be the released source commit so provenance identifies the correct input. The prepare job validates the tag, requires its resolved commit to match the workflow commit and be on `main`, checks the version, installs/builds/tests, audits production dependencies and inspects the package file list. It uploads the resulting tarball for the separately approved publication job.

The publish job uses the prepared tarball and does not rebuild source. It uses `latest` for stable versions and `next` for prereleases, with provenance and lifecycle scripts disabled during publication. It requires the public repository, opt-in variable and protected environment. A validation failure must be fixed through a new reviewed commit/tag; do not move a published release tag or overwrite a version.

After publication, verify the registry version, dist-tag and provenance and test installation in a clean temporary project. Update the README's installation guidance only then. If a release is broken, deprecate it with a clear reason and publish a corrected version; do not assume unpublishing is available or appropriate.

## Workflow security

Actions are pinned to reviewed full commit SHAs. Default permissions are read-only; release and publication grants are job-scoped. Contributor workflows do not use `pull_request_target` or receive provider credentials. Dependabot proposes action and dependency updates for review. These choices follow [GitHub's Actions security guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).
