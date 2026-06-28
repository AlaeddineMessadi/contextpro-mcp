// changed_since — the per-PR review pack in one call.
//
// FEATURE: Reviewing a PR / picking the next stacked PR means answering three
// questions together: what symbols changed, which tests must run, and what else
// depends on the changed files. This composes semantic_diff + test_impact + a
// graph-based dependents lookup since a git ref, so an agent gets the whole
// review picture in a single token-lean call instead of three round-trips.

import { computeSemanticDiff, type SemanticDiffResult } from "./semantic-diff.js";
import { computeTestImpact, type TestImpactResult } from "./test-impact.js";
import { getDB } from "./db.js";

export interface ChangedSinceOptions {
  since?: string;
}

export interface DependentEntry {
  /** A changed file. */
  path: string;
  /** Files that import it (its blast radius at file granularity). */
  importers: string[];
}

export interface ChangedSinceResult {
  ref: string;
  changes: SemanticDiffResult;
  tests: TestImpactResult;
  /** For each changed file, the files that import it (impact surface). */
  dependents: DependentEntry[];
}

export async function computeChangedSince(
  rootDir: string,
  options: ChangedSinceOptions = {},
): Promise<ChangedSinceResult> {
  const ref = options.since ?? "HEAD";

  // semantic_diff and test_impact are independent — run them concurrently.
  const [changes, tests] = await Promise.all([
    computeSemanticDiff(rootDir, { since: ref }),
    computeTestImpact(rootDir, { since: ref }),
  ]);

  // Dependents: for each changed file, the files that import it (file-level blast
  // radius) from the indexed import graph. This is the "what else does my change
  // touch" signal without a full per-symbol blast_radius sweep.
  const db = await getDB(rootDir);
  const dependents: DependentEntry[] = [];
  for (const file of changes.files) {
    const row = db.getFile(file.path);
    if (!row) continue;
    const importers = db.getImportersOf(row.id)
      .map((imp) => db.getFileById(imp.source_file_id)?.path)
      .filter((p): p is string => typeof p === "string")
      .sort();
    if (importers.length > 0) {
      dependents.push({ path: file.path, importers });
    }
  }

  return { ref, changes, tests, dependents };
}
