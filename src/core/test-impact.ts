// test_impact — select the tests affected by changes since a git ref.
//
// FEATURE: Running the whole suite after a small change is slow and token-heavy.
// Using the import graph already in the index, walk REVERSE dependencies from each
// changed source file to the tests that (transitively) exercise it, plus any test
// files changed directly. Changes to build config / lockfiles can affect anything,
// so they force a safe run-all fallback — the discipline every production test-
// impact tool follows. O(diff), not O(repo).

import { execFile } from "child_process";
import { promisify } from "util";
import { findTestsForFiles, isTestFile } from "../tools/retrieval-helpers.js";

const execFileAsync = promisify(execFile);

export interface TestImpactOptions {
  since?: string;
}

export interface ImpactedTest {
  path: string;
  reason: string;
  score: number;
}

export interface TestImpactResult {
  ref: string;
  changedFiles: string[];
  /** Tests selected to run for this change set, ranked by confidence. */
  tests: ImpactedTest[];
  /**
   * True when a change affects something the dependency graph can't scope (build
   * config, lockfile, CI) — callers should run the full suite instead of trusting
   * the selection.
   */
  runAll: boolean;
  runAllReason: string | null;
}

// Files whose change can invalidate any test → never trust a scoped selection.
const RUN_ALL_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)babel\.config\.[cm]?js$/,
  /(^|\/)\.mocharc\./,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)go\.(mod|sum)$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)\.github\/workflows\//,
];

function isRunAllTrigger(path: string): boolean {
  return RUN_ALL_PATTERNS.some((re) => re.test(path));
}

async function gitChangedFiles(rootDir: string, ref: string): Promise<string[]> {
  const paths = new Set<string>();
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", ref], {
      cwd: rootDir, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (line.trim()) paths.add(line.trim());
    }
  } catch {
    // ignore — empty diff
  }
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir, timeout: 10000, maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (line.trim()) paths.add(line.trim());
    }
  } catch {
    // ignore
  }
  return [...paths];
}

export async function computeTestImpact(
  rootDir: string,
  options: TestImpactOptions = {},
): Promise<TestImpactResult> {
  const ref = options.since ?? "HEAD";
  const changedFiles = await gitChangedFiles(rootDir, ref);

  const runAllTrigger = changedFiles.find(isRunAllTrigger);
  const changedSources = changedFiles.filter((p) => !isTestFile(p));
  const changedTests = changedFiles.filter(isTestFile);

  // Reverse-dependency walk from changed sources to the tests that exercise them.
  const reverseTests = changedSources.length > 0
    ? await findTestsForFiles(rootDir, changedSources)
    : [];

  // A directly-edited test file is itself impacted (highest confidence).
  const byPath = new Map<string, ImpactedTest>();
  for (const test of reverseTests) {
    const existing = byPath.get(test.path);
    if (!existing || test.score > existing.score) byPath.set(test.path, test);
  }
  for (const testPath of changedTests) {
    byPath.set(testPath, { path: testPath, reason: "Test file changed directly", score: 1 });
  }

  const tests = [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    ref,
    changedFiles,
    tests,
    runAll: runAllTrigger !== undefined,
    runAllReason: runAllTrigger ? `${runAllTrigger} changed — run the full suite` : null,
  };
}
