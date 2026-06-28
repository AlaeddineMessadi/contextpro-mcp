// semantic_diff tool — agent-facing wrapper over the AST symbol-change engine.
// FEATURE: "What symbols changed since <ref>" as token-lean text or JSON, pairing
// with change_impact/blast_radius for the per-PR review loop.

import { computeSemanticDiff, type SemanticDiffResult, type SymbolChange } from "../core/semantic-diff.js";

export interface SemanticDiffToolOptions {
  rootDir: string;
  since?: string;
  format?: "text" | "json";
}

const CHANGE_MARK: Record<SymbolChange, string> = {
  added: "+",
  removed: "-",
  modified: "~",
  moved: "→",
};

export async function getSemanticDiff(options: SemanticDiffToolOptions): Promise<string> {
  const result = await computeSemanticDiff(options.rootDir, { since: options.since });
  if (options.format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return formatSemanticDiff(result);
}

function formatSemanticDiff(result: SemanticDiffResult): string {
  const { summary } = result;
  const lines = [
    `=== Semantic Diff (vs ${result.ref}) ===`,
    `Files: ${summary.filesChanged} | +${summary.added} added | ~${summary.modified} modified | -${summary.removed} removed | →${summary.moved} moved`,
    "",
  ];

  if (result.files.length === 0) {
    lines.push("No symbol-level changes detected.");
    return lines.join("\n");
  }

  for (const file of result.files) {
    lines.push(`${file.path} (${file.status})`);
    // Show meaningful changes first; suppress pure moves unless they're all there is.
    const meaningful = file.symbols.filter((s) => s.change !== "moved");
    const shown = meaningful.length > 0 ? meaningful : file.symbols;
    for (const sym of shown) {
      lines.push(`  ${CHANGE_MARK[sym.change]} ${sym.kind} ${sym.name} (L${sym.line})`);
    }
    const movedCount = file.symbols.length - meaningful.length;
    if (meaningful.length > 0 && movedCount > 0) {
      lines.push(`  (${movedCount} symbol${movedCount === 1 ? "" : "s"} relocated only)`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
