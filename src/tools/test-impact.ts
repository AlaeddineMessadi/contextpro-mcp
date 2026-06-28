// test_impact tool — agent-facing wrapper selecting tests affected by a change set.
// FEATURE: "Which tests must I run for my change since <ref>" — token-lean, with a
// safe run-all fallback when build config changed.

import { computeTestImpact, type TestImpactResult } from "../core/test-impact.js";

export interface TestImpactToolOptions {
  rootDir: string;
  since?: string;
  format?: "text" | "json";
}

export async function getTestImpact(options: TestImpactToolOptions): Promise<string> {
  const result = await computeTestImpact(options.rootDir, { since: options.since });
  if (options.format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return formatTestImpact(result);
}

function formatTestImpact(result: TestImpactResult): string {
  const lines = [
    `=== Test Impact (since ${result.ref}) ===`,
    `Changed files: ${result.changedFiles.length} | Impacted tests: ${result.tests.length}`,
    "",
  ];

  if (result.runAll) {
    lines.push(`⚠ RUN ALL TESTS: ${result.runAllReason}`);
    lines.push("A scoped selection can't be trusted for this change set.");
    return lines.join("\n");
  }

  if (result.tests.length === 0) {
    lines.push(result.changedFiles.length === 0
      ? "No changes detected."
      : "No tests map to the changed files. Consider adding coverage.");
    return lines.join("\n");
  }

  for (const test of result.tests) {
    lines.push(`  → ${test.path}  (${test.reason}, ${Math.round(test.score * 100)}%)`);
  }
  return lines.join("\n");
}
