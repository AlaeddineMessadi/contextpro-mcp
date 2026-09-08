# Public launch checklist

Preparing this branch does not change repository visibility or publish a package. A maintainer must review the result and authorize those actions separately.

## Prepared in this change

- Public-facing README, source installation path, contributor/support/conduct/security guides and upstream attribution.
- Issue forms, PR template, code ownership and dependency update configuration.
- CI for the core and optional apps, secret/dependency checks and public-repository CodeQL/dependency review.
- SemVer release configuration and a separately gated manual npm publication workflow.
- Curated npm file list that excludes raw benchmark records, archives, caches and optional applications.
- Honest comparison methodology and draft launch copy; no invented testimonials or universal ranking.

## Before changing visibility

- Review the diff and successful CI for the launch commit. Dependency scans and tests are point-in-time evidence, not a security guarantee.
- Review **all Git history, branches, tags, issues, PRs, Actions logs and artifacts** that will become visible. Existing benchmark records mention private-project identifiers. A zero-finding secret scan does not clear privacy, ownership or licensing concerns. Deleting a current file does not erase its history. Decide whether to publish this history or create a separately reviewed clean public history; do not rewrite the shared repository casually.
- Verify rights to contributed code, assets and benchmark fixtures. Keep the original MIT license and NOTICE. No private third-party source should be published without permission.
- Choose a private contact/reporting route for both security and moderation. Current docs avoid publishing an unapproved personal email and provide GitHub-based fallback instructions.
- Review repository Actions permissions and installed third-party integrations. Use hosted runners for untrusted PRs. Do not provide provider credentials to contributor CI.
- Configure a main-branch ruleset requiring pull requests and the observed CI check names, with force pushes/deletion blocked. Avoid required checks that are intentionally skipped for private repositories.

## At public launch

- Explicitly approve the visibility change, then verify the public repository from a logged-out session.
- Enable GitHub private vulnerability reporting and test that the reporting link is available. Enable available secret scanning, push protection, Dependabot alerts and code scanning.
- Enable Discussions if maintainers want a general question area; keep the support guide aligned with the actual channel.
- Confirm CodeQL and dependency review run successfully on the now-public repository.
- Add a concise repository description and relevant topics. Label a few scoped contributor issues; do not manufacture a backlog merely for appearances.
- Review and publish the [announcement](announcement.md) only after source installation works from a fresh checkout.

## Before any npm release

Follow [releasing](../releasing.md). Confirm package-name ownership and the intended initial public version. The existing `1.3.0` metadata does not prove an npm release exists. Bootstrap ownership if needed, configure the protected `npm` environment and trusted publisher, then opt in with `NPM_PUBLISH_ENABLED=true`. Test the packed artifact before approving publication.

Release automation remains gated by `RELEASE_AUTOMATION_ENABLED`; it is not enabled merely by making the repository public. No long-lived npm token is included in these workflows.
