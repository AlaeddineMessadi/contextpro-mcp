# Public launch checklist

Preparing this branch does not change repository visibility or publish a package. A maintainer must review the result and authorize those actions separately.

## Prepared in this change

- Public-facing README, source installation path, contributor/support/conduct/security guides and upstream attribution.
- Issue forms, PR template, code ownership and dependency update configuration.
- Core CI, secret/dependency checks and public-repository CodeQL/dependency review.
- SemVer release configuration and a separately gated manual npm publication workflow.
- Curated npm file list that excludes raw benchmark records, archives and caches.
- Honest comparison methodology and draft launch copy; no invented testimonials or universal ranking.

## Before publishing

- Review the diff and successful CI for the launch commit. Dependency scans and tests are point-in-time evidence, not a security guarantee.
- **Publish to a new repository; do not flip this one public.** GitHub keeps every pull request's refs and descriptions, and the old PRs here reference pre-cleanup commits and private project names. Rewriting and force-pushing this repository does not remove them. Create a fresh public repository and push only the cleaned `main` to it. Keep this private repository as an archive, or delete it once the new one is verified.
- Choose the public repository name. GitHub does not allow a second repository with the same owner and name, so rename this private repository first (for example `contextpro-mcp-archive`) before creating the new public `contextpro-mcp`. Otherwise every hard-coded `github.com/AlaeddineMessadi/contextpro-mcp` URL must change.
- After the history rewrite, remap the `bootstrap-sha` in `release-please-config.json` and the pinned ContextPro SHAs in `scripts/fixtures/*.json` through `.git/filter-repo/commit-map`.
- PR and Actions links from the private repository will not exist in the new one; remove or rewrite any that remain in documentation.
- Before pushing, confirm the cleaned history has no private identifiers: `git log --all -p | grep -i -E '<private names>'` must print nothing. A zero-finding secret scan does not clear privacy, ownership or licensing concerns.
- Verify rights to contributed code, assets and benchmark fixtures. Keep the original MIT license and NOTICE. No private third-party source should be published without permission.
- Choose a private contact/reporting route for both security and moderation. Current docs avoid publishing an unapproved personal email and provide GitHub-based fallback instructions.
- Review repository Actions permissions and installed third-party integrations. Use hosted runners for untrusted PRs. Do not provide provider credentials to contributor CI.
- Configure a main-branch ruleset requiring pull requests and the observed CI check names, with force pushes/deletion blocked. Avoid required checks that are intentionally skipped for private repositories.

## At public launch

- Verify the new public repository from a logged-out session: no stale branches, no PRs, no Actions history.
- Enable GitHub private vulnerability reporting and test that the reporting link is available. Enable available secret scanning, push protection, Dependabot alerts and code scanning.
- Enable Discussions if maintainers want a general question area; keep the support guide aligned with the actual channel.
- Confirm CodeQL and dependency review run successfully on the now-public repository.
- Add a concise repository description and relevant topics. Label a few scoped contributor issues; do not manufacture a backlog merely for appearances.
- Review and publish the [announcement](announcement.md) only after source installation works from a fresh checkout.

## Before any npm release

Follow [releasing](../releasing.md). The first public release is `1.4.0`, published manually to claim the package name. For later releases, configure the protected `npm` environment and trusted publisher, then opt in with `NPM_PUBLISH_ENABLED=true`. Test the packed artifact before approving publication.

Release automation remains gated by `RELEASE_AUTOMATION_ENABLED`; it is not enabled merely by making the repository public. No long-lived npm token is included in these workflows.
