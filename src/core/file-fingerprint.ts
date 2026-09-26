import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export interface FileFingerprint {
  file_size: number;
  file_mtime_ms: number;
  file_ctime_ms: number;
}

export function maxSourceFileSize(): number {
  const configured = parseInt(process.env.CONTEXTPRO_MAX_FILE_SIZE ?? process.env.CONTEXTPLUS_MAX_FILE_SIZE ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 1024 * 1024;
}

/** Metadata is a fast change detector, not a cryptographic content guarantee. */
export function matchesFileFingerprint(file: FileFingerprint, current: Stats): boolean {
  return file.file_ctime_ms > 0 && file.file_size === current.size
    && file.file_mtime_ms === current.mtimeMs && file.file_ctime_ms === current.ctimeMs;
}

/** Hashing and parsing must consume these same bytes, with metadata from that read. */
export async function readSourceSnapshot(path: string): Promise<{ content: string; stats: Stats }> {
  const before = await stat(path);
  if (before.size > maxSourceFileSize()) throw new Error(`Source exceeds configured file-size cap: ${path}`);
  const content = await readFile(path, "utf8");
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`Source changed while reading ${path}; retry after the edit settles.`);
  }
  return { content, stats: after };
}
