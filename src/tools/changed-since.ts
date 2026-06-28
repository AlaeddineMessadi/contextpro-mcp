// changed_since tool — agent-facing per-PR review pack.
// FEATURE: One call → what changed (symbols), which tests to run, and what depends
// on the changed files. The review/next-stacked-PR loop in a single token-lean read.

import { computeChangedSince, type ChangedSinceResult } from "../core/changed-since.js";

export interface ChangedSinceToolOptions {
  rootDir: string;
  since?: string;
  format?: "text" | "json";
}

const CHANGE_MARK: Record<string, string> = { added: "+", removed: "-", modified: "~", moved: "→" };

export async function getChangedSince(options: ChangedSinceToolOptions): Promise<string> {
  const result = await computeChangedSince(options.rootDir, { since: options.since });
  if (options.format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return formatChangedSince(result);
}

function formatChangedSince(result: ChangedSinceResult): string {
  const { changes, tests, dependents } = result;
  const lines = [
    `=== Changed Since ${result.ref} ===`,
    `Files: ${changes.summary.filesChanged} | +${changes.summary.added} ~${changes.summary.modified} -${changes.summary.removed} symbols`,
    "",
  ];

  if (changes.files.length === 0) {
    lines.push("No symbol-level changes detected.");
    return lines.join("\n");
  }

  lines.push("CHANGED SYMBOLS:");
  for (const file of changes.files) {
    lines.push(`  ${file.path} (${file.status})`);
    const meaningful = file.symbols.filter((s) => s.change !== "moved");
    for (const sym of meaningful) {
      lines.push(`    ${CHANGE_MARK[sym.change] ?? "?"} ${sym.kind} ${sym.name}`);
    }
  }
  lines.push("");

  if (dependents.length > 0) {
    lines.push("IMPACT (files importing the changed ones):");
    for (const dep of dependents) {
      const preview = dep.importers.slice(0, 6).join(", ");
      const more = dep.importers.length > 6 ? ` +${dep.importers.length - 6} more` : "";
      lines.push(`  ${dep.path} ← ${preview}${more}`);
    }
    lines.push("");
  }

  lines.push("TESTS TO RUN:");
  if (tests.runAll) {
    lines.push(`  ⚠ RUN ALL — ${tests.runAllReason}`);
  } else if (tests.tests.length === 0) {
    lines.push("  (no mapped tests — consider adding coverage)");
  } else {
    for (const test of tests.tests) {
      lines.push(`  → ${test.path} (${Math.round(test.score * 100)}%)`);
    }
  }

  return lines.join("\n");
}
