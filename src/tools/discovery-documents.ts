import { open } from "node:fs/promises";
import { basename } from "node:path";
import { searchTerms } from "../core/embeddings.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { walkDirectory } from "../core/walker.js";
import { isOrientationQuery, isUiOrientationQuery, mentionedFiles, discoveryPathWeight, positiveDiscoveryQuery } from "./discovery-hints.js";

/** Markdown is outside the structural index. Only document-oriented requests
 * pay for this bounded filename/heading lookup; ordinary code search is unchanged. */
export function wantsDocuments(query: string): boolean {
  const docsIntent = /\b(?:product|project|repository|api|setup|developer|user|security|compliance)\s+docs\b(?![/-]|\.[\w])|\b(?:read|find|open|show|locate|search|review|inspect)\s+(?:(?:the|relevant|existing)\s+)*docs\b(?![/-]|\.[\w])|\bdocs\s+(?:about|for|covering|describing)\b/i.test(query);
  return (isOrientationQuery(query) && !isUiOrientationQuery(query))
    || docsIntent
    || /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(query)
    || /\b(?:readme|roadmap|handoff|readiness|documentation)\b|\.(?:md|mdx|rst|txt)\b|\b(?:project|repository)\s+(?:instructions|status)\b|\b(?:status|qa|audit)\s+(?:documents?|reports?)\b|\bagent\s+brief\b/i.test(query);
}

export async function discoverDocuments(rootDir: string, query: string): Promise<{
  files: string[]; mentioned: string[]; limited: boolean;
}> {
  const documents = (await walkDirectory({ rootDir })).filter(entry =>
    !entry.isDirectory && /\.(?:md|mdx|rst|txt)$/i.test(entry.relativePath) && discoveryPathWeight(query, entry.relativePath) > 0);
  const mentioned = mentionedFiles(rootDir, query, documents.map(entry => ({ path: entry.relativePath })));
  const terms = new Set(searchTerms(positiveDiscoveryQuery(query)));
  const overlap = (text: string): number => [...new Set(searchTerms(text))].filter(term => terms.has(term)).length;
  const statusRequest = /\b(?:status|handoff|next steps|blockers|readiness|roadmap)\b/i.test(query);
  const pathScore = (path: string): number => overlap(path) * 4
    + (mentioned.includes(path) ? 100 : 0)
    + (/^readme\./i.test(path) ? 3 : 0)
    + (statusRequest && /^(?:agent[-_]?brief|handoff|status|roadmap)\./i.test(basename(path)) ? 6 : 0);
  const candidates = documents.sort((a, b) => pathScore(b.relativePath) - pathScore(a.relativePath)
    || a.relativePath.localeCompare(b.relativePath)).slice(0, 64);
  const ranked: Array<{ file: string; score: number; words: Set<string> }> = [];
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
      const score = pathScore(entry.relativePath) + overlap(lines.find(line => /^#\s/.test(line)) ?? "") * 4 + overlap(headings) + overlap(lines.slice(0, 30).join("\n"));
      if (score > 0) ranked.push({ file: entry.relativePath, score, words: new Set(searchTerms(entry.relativePath + " " + headings)) });
    } catch { /* Deleted or unreadable files do not block other candidates. */ }
    finally { await handle?.close(); }
  }
  const selected: string[] = [], covered = new Set<string>();
  const count = ranked.length, limit = isUiOrientationQuery(query) ? 3 : 6;
  while (ranked.length && selected.length < limit) {
    const novelty = (item: typeof ranked[number]) => [...terms].filter(term => item.words.has(term) && !covered.has(term)).length;
    ranked.sort((a,b) => (b.score * (1 + novelty(b))) - (a.score * (1 + novelty(a))) || a.file.localeCompare(b.file));
    const next = ranked.shift()!; selected.push(next.file); next.words.forEach(term=>covered.add(term));
  }
  return { files: selected, mentioned, limited: documents.length > candidates.length || count > limit };
}
