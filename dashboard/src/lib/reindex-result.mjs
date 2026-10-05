/** The shipped MCP reindex API returns its human-readable report, not an object. */
export function parseReindexResult(report) {
  const completed =
    typeof report === "string" &&
    report.match(/^Reindex complete in (\d+)ms\n/);
  const counts =
    typeof report === "string" &&
    report.match(
      /^\s*Files: \d+ total, (\d+) indexed, (\d+) skipped, (\d+) removed$/m,
    );
  if (!completed || !counts || report.includes("Index repair required:")) {
    throw new Error(
      typeof report === "string"
        ? report
        : "Unrecognized indexing result. Check project status before retrying.",
    );
  }
  return {
    indexed: Number(counts[1]),
    skipped: Number(counts[2]),
    durationMs: Number(completed[1]),
  };
}
