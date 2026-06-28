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

interface ChangedFiles {
  /** Paths that exist now (added/modified/renamed-to) — safe to select & run. */
  present: string[];
  /** Paths removed by the change (deleted / renamed-away) — never runnable. */
  deleted: string[];
  /** True if the diff ref was invalid/unresolvable — caller must run all. */
  invalidRef: boolean;
}

async function gitChangedFiles(rootDir: string, ref: string): Promise<ChangedFiles> {
  const present = new Set<string>();
  const deleted = new Set<string>();
  let invalidRef = false;

  try {
    // --name-status keeps the change type so a DELETED test isn't re-selected as a
    // runnable file, and rename records (R###  old  new) resolve to the new path.
    const { stdout } = await execFileAsync("git", ["diff", "--name-status", ref], {
      cwd: rootDir, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0].trim();
      if (status.startsWith("D")) {
        if (parts[1]) deleted.add(parts[1].trim());
      } else if (/^[RC]\d*/.test(status) && parts.length >= 3) {
        deleted.add(parts[1].trim());   // old path is gone
        present.add(parts[2].trim());   // new path exists
      } else if (parts[1]) {
        present.add(parts[1].trim());
      }
    }
  } catch (error) {
    // A non-zero exit here means the ref couldn't be resolved (e.g. `main` in a
    // repo that only has `master`) — NOT an empty diff (which exits 0). Treat it as
    // unknown scope so the caller runs the full suite rather than silently skipping.
    invalidRef = true;
  }

  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir, timeout: 10000, maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (line.trim()) present.add(line.trim());
    }
  } catch {
    // untracked enumeration is best-effort
  }

  return { present: [...present], deleted: [...deleted], invalidRef };
}

export async function computeTestImpact(
  rootDir: string,
  options: TestImpactOptions = {},
): Promise<TestImpactResult> {
  const ref = options.since ?? "HEAD";
  const { present, deleted, invalidRef } = await gitChangedFiles(rootDir, ref);

  // An unresolvable ref means we can't scope safely — run everything.
  if (invalidRef) {
    return {
      ref,
      changedFiles: present,
      tests: [],
      runAll: true,
      runAllReason: `could not diff against '${ref}' (unknown ref) — run the full suite`,
    };
  }

  const runAllTrigger = present.find(isRunAllTrigger);
  const changedSources = present.filter((p) => !isTestFile(p));
  // Only test files that STILL EXIST (present) are runnable; a deleted/renamed-away
  // test must never be selected as a path to run.
  const changedTests = present.filter(isTestFile);
  const deletedSet = new Set(deleted);

  // Reverse-dependency walk from changed sources to the tests that exercise them.
  const reverseTests = changedSources.length > 0
    ? await findTestsForFiles(rootDir, changedSources)
    : [];

  // A directly-edited test file is itself impacted (highest confidence).
  const byPath = new Map<string, ImpactedTest>();
  for (const test of reverseTests) {
    if (deletedSet.has(test.path)) continue; // never run a test that was removed
    const existing = byPath.get(test.path);
    if (!existing || test.score > existing.score) byPath.set(test.path, test);
  }
  for (const testPath of changedTests) {
    byPath.set(testPath, { path: testPath, reason: "Test file changed directly", score: 1 });
  }

  const tests = [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    ref,
    changedFiles: present,
    tests,
    runAll: runAllTrigger !== undefined,
    runAllReason: runAllTrigger ? `${runAllTrigger} changed — run the full suite` : null,
  };
}
