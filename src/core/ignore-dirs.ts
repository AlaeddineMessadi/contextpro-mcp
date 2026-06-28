// Framework-aware directory ignore policy for indexing.
//
// FEATURE: The walker honors a project's `.gitignore`, but that's not enough on
// its own — many repos have an absent or incomplete `.gitignore`, and some heavy
// build/cache dirs (e.g. `target`, `.next`, `__pycache__`) are not always listed.
// This is the SAFETY NET: a curated set of dependency / build / cache / tooling
// directories, across the major languages and frameworks, that should never be
// indexed regardless of `.gitignore`. Skipping them keeps the index small and the
// reindex fast (it's the difference between indexing your code and indexing all of
// node_modules + target + .venv).
//
// `.gitignore` is applied SEPARATELY by the walker; this set composes with it.

// Exact directory names to always skip (matched case-sensitively by basename).
export const ALWAYS_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // Version control
  ".git", ".svn", ".hg", ".bzr", "CVS",

  // JS/TS dependencies & package managers
  "node_modules", "bower_components", ".pnp", ".yarn", ".pnpm-store",

  // JS/TS build output & framework caches
  // (bare "out" omitted — ambiguous; `.gitignore` handles it when it's build output)
  "dist", "build", ".next", ".nuxt", ".svelte-kit", ".astro",
  ".vercel", ".netlify", ".docusaurus", ".vitepress", ".angular",
  "storybook-static", ".storybook-out",

  // JS/TS tooling caches
  ".cache", ".turbo", ".parcel-cache", ".vite", ".rollup.cache",
  ".eslintcache", ".rpt2_cache",

  // Test / coverage
  "coverage", ".nyc_output", ".vscode-test", "playwright-report",
  "test-results", "__snapshots__",

  // Python  (bare "env" omitted — ambiguous; ".venv"/"venv" are conventional)
  "__pycache__", ".venv", "venv", ".tox", ".nox",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".pytype",
  ".eggs", ".hypothesis", "site-packages", ".pyenv",

  // JVM (Java / Kotlin / Scala / Gradle / Maven)
  // NOTE: bare "bin"/"out" are intentionally NOT here — they're too often real
  // source dirs; `.gitignore` covers them when they're genuinely build output.
  "target", ".gradle", ".settings", ".metadata",
  ".idea", ".project", "out-tsc",

  // Rust
  // ("target" already covered above)

  // Go
  "vendor",

  // Elixir / Erlang
  "_build", ".elixir_ls",

  // Dart / Flutter
  ".dart_tool", ".flutter-plugins", ".pub-cache",

  // iOS / CocoaPods / Carthage
  "Pods", "Carthage", "DerivedData", ".swiftpm",

  // PHP (Composer "vendor" already covered)
  // Ruby
  ".bundle",

  // Infra / IaC
  ".terraform", ".serverless", "cdk.out",

  // Editor / OS / misc
  ".DS_Store", ".vscode-test", ".history", ".vs",
  ".contextpro", ".contextplus",
]);

// Suffix patterns (glob-style `*.suffix`) matched against the basename. Kept small
// and specific so it can't accidentally swallow source directories.
const IGNORE_SUFFIXES: readonly string[] = [
  ".egg-info",
  ".dSYM",
  ".xcodeproj",
  ".xcworkspace",
];

/**
 * Whether a directory basename should always be skipped during indexing,
 * independent of `.gitignore`. Matches exact names and a few suffix globs.
 */
export function isAlwaysIgnoredDir(name: string): boolean {
  if (ALWAYS_IGNORE_DIRS.has(name)) return true;
  for (const suffix of IGNORE_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) return true;
  }
  return false;
}
