import { open } from "node:fs/promises";
import { constants } from "node:fs";

export interface LineRange { start: number; end: number; }
export type BoundedRange = { start: number; end: number; text: string } | { omitted: string };
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** One open-file snapshot for all requested ranges; never retain skipped lines.
 * LF coordinates and CR/UTF-8 bytes match readFile(...).split("\n"). */
export async function readBoundedRanges(
  path: string, ranges: LineRange[], maxRangeBytes: number,
): Promise<Map<string, BoundedRange>> {
  const selected = new Map(ranges.map(range => [`${range.start}:${range.end}`, {
    ...range, chunks: [] as Buffer[], bytes: 0, oversized: false,
  }]));
  const lastRequested = Math.max(...ranges.map(range => range.end));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) return new Map([...selected.keys()].map(key => [key, { omitted: "not a regular file" }]));
    const buffer = Buffer.alloc(64 * 1024);
    let line = 1, position = 0, eof = false, failure = "";
    while (line <= lastRequested) {
      if (position >= MAX_SCAN_BYTES) { failure = "exceeds 64 MiB range scan limit"; break; }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_SCAN_BYTES - position), position);
      if (!bytesRead) { eof = true; break; }
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) { failure = "binary file"; break; }
      let offset = 0;
      while (offset < bytesRead && line <= lastRequested) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? bytesRead : newline;
        for (const range of selected.values()) {
          if (range.oversized || line < range.start || line > range.end) continue;
          // A selected final line has no LF; interior lines preserve their LF.
          const stop = newline >= 0 && line < range.end ? end + 1 : end;
          const size = stop - offset;
          if (range.bytes + size > maxRangeBytes) {
            range.oversized = true; range.chunks = []; continue;
          }
          if (size) range.chunks.push(Buffer.from(chunk.subarray(offset, stop)));
          range.bytes += size;
        }
        if (newline < 0) break;
        line++; offset = newline + 1;
      }
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) failure = "file changed during range read; retry";
    return new Map<string, BoundedRange>([...selected].map(([key, range]): [string, BoundedRange] => {
      // A scan limit only invalidates unfinished ranges. Binary or modified
      // snapshots invalidate every range from this file.
      if (failure && (failure !== "exceeds 64 MiB range scan limit" || range.end >= line)) return [key, { omitted: failure }];
      if (range.start > line && eof) return [key, { omitted: `${range.start}: beyond end of file` }];
      if (range.oversized) return [key, { omitted: `${range.start}-${range.end}: over budget; request narrower targets or raise max_tokens` }];
      return [key, { start: range.start, end: Math.min(range.end, line), text: Buffer.concat(range.chunks).toString("utf8") }];
    }));
  } finally { await handle.close(); }
}
