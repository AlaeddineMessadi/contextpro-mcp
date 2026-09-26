import { open } from "node:fs/promises";
import { basename } from "node:path";
import { searchTerms } from "../core/embeddings.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { walkDirectory } from "../core/walker.js";
import { isOrientationQuery, mentionedFiles } from "./discovery-hints.js";

/** Markdown is outside the structural index. Only document-oriented requests
 * pay for this bounded filename/heading lookup; ordinary code search is unchanged. */
export function wantsDocuments(query: string): boolean {
  return isOrientationQuery(query)
    || /\b(?:readme|roadmap|handoff|readiness|documentation)\b|\.(?:md|mdx|rst|txt)\b|\b(?:project|repository)\s+(?:instructions|status)\b|\b(?:status|qa|audit)\s+(?:documents?|reports?)\b|\bagent\s+brief\b/i.test(query);
}

export async function discoverDocuments(rootDir: string, query: string): Promise<{
  files: string[]; mentioned: string[]; limited: boolean;
}> {
  const documents = (await walkDirectory({ rootDir })).filter(entry =>
    !entry.isDirectory && /\.(?:md|mdx|rst|txt)$/i.test(entry.relativePath));
  const mentioned = mentionedFiles(rootDir, query, documents.map(entry => ({ path: entry.relativePath })));
  const terms = new Set(searchTerms(query));
  const overlap = (text: string): number => [...new Set(searchTerms(text))].filter(term => terms.has(term)).length;
  const statusRequest = /\b(?:status|handoff|next steps|blockers|readiness|roadmap)\b/i.test(query);
  const pathScore = (path: string): number => overlap(path) * 4
    + (mentioned.includes(path) ? 100 : 0)
    + (/^readme\./i.test(path) ? 3 : 0)
    + (statusRequest && /^(?:agent[-_]?brief|handoff|status|roadmap)\./i.test(basename(path)) ? 6 : 0);
  const candidates = documents.sort((a, b) => pathScore(b.relativePath) - pathScore(a.relativePath)
    || a.relativePath.localeCompare(b.relativePath)).slice(0, 64);
  const ranked: Array<{ file: string; score: number }> = [];
  for (const entry of candidates) {
    // Read a bounded prefix even for very large documents. Full excerpts are
    // later read once by context with its normal size and response limits.
    let handle;
    try {
      handle = await open(resolveProjectPath(rootDir, entry.relativePath, "discovery document"), "r");
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead).toString("utf8");
      if (prefix.includes("\0")) continue;
      const lines = prefix.split("\n");
      const headings = lines.filter(line => /^#{1,6}\s/.test(line)).join("\n");
      const score = pathScore(entry.relativePath) + overlap(headings) * 3 + overlap(lines.slice(0, 30).join("\n"));
      if (score > 0) ranked.push({ file: entry.relativePath, score });
    } catch { /* Deleted or unreadable files do not block other candidates. */ }
    finally { await handle?.close(); }
  }
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return { files: ranked.slice(0, 6).map(entry => entry.file), mentioned,
    limited: documents.length > candidates.length || ranked.length > 6 };
}
