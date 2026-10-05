export function parseReindexResult(report: unknown): {
  indexed: number;
  skipped: number;
  durationMs: number;
};
