# Security policy

## Report a vulnerability privately

Do not open a public issue containing exploit details, secrets or private repository contents. Use GitHub's **Security → Report a vulnerability** for this repository when private vulnerability reporting is enabled:

[Submit a private report](https://github.com/AlaeddineMessadi/contextpro-mcp/security/advisories/new).

If that option is unavailable, open a minimal issue asking the maintainer to establish a private reporting channel. Include no vulnerability details. Do not send sensitive information to an address inferred from Git history. This is a community-maintained project; there is no guaranteed response time.

Include the affected version or commit, Node/OS/client versions, a minimal redacted reproduction, impact and any suggested mitigation. Coordinate disclosure with the maintainer and avoid accessing data belonging to others.

## Supported versions

Security fixes target the latest maintained release and `main`. Identify reports by npm version or Git commit. Older versions do not have a promised backport window. Node.js 24 LTS is recommended; CI also checks the Node 20 engine floor. The package's older engine floor is a compatibility declaration, not a promise to maintain end-of-life runtimes.

## Trust and data boundaries

- **Same-user permissions.** ContextPro is a local stdio MCP process, not a sandbox. Filesystem, edit and command-related operations can use the launching user's access. Choose a trusted project root and review your client's tool permissions.
- **Untrusted repositories.** Code, comments, docs, tool results and memory can contain malicious instructions. Agents must treat them as data. Installing dependencies or running a repository's tests, hooks, linters or commands may execute its code.
- **Local state.** `.contextpro/` can contain indexed source, task artifacts, history, memory and restore points. ContextPro writes `.contextpro/.gitignore` to keep it out of Git; protect it like the repository. It is not entirely disposable cache. The workspace registry can reveal local project paths.
- **Providers.** Hosted embedding/chat endpoints receive their request inputs, which may include source code. Local Ollama is an option. Structural tools do not require an embedding endpoint; use direct reads or keyword-only retrieval to avoid query-embedding attempts. Merely omitting a chat-model setting is not a network-off guarantee when hosted credentials are present.
- **Native dependency recovery.** Automatic ABI repair may invoke npm and download dependencies into an isolated cache. Set `CONTEXTPRO_NATIVE_AUTO_REPAIR=false` when installation must be managed explicitly.
- **Diagnostics.** Opt-in tool traces and agent benchmark transcripts can reveal paths, arguments, source and usage metadata. Keep them private and redact before sharing. Do not upload `.env` files or account credentials.
- **Correctness limits.** Freshness and scope checks reduce errors; they do not prove an arbitrary change safe. Unsaved buffers, concurrent edits, dynamic calls and incomplete imported indexes require verification.
- **Evidence labels.** Responses distinguish source evidence, compiler-resolved references, textual candidates and heuristic fallbacks. Freshness checks cover saved files, not unsaved editor buffers, and per-file reconciliation is not an atomic snapshot of a repository being edited concurrently. Configured Python uses Pyright LSP; unconfigured Python heuristics and imported SCIP data keep their own provenance labels.
- **Worker isolation.** Parser and TypeScript workers run in bounded child processes, so a worker failure is reported and recovered from without necessarily stopping the MCP server. This is fault isolation, not a security sandbox.

See [configuration](docs/configuration.md) and [maintenance](docs/maintenance.md) for provider controls and safe cleanup. A clean dependency audit or secret scan is a point-in-time check, not a security certification.
