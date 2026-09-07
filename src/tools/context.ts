// Locate and read evidence in one round trip. All excerpts come from one disk
// snapshot per file; no generated summaries, arbitrary code execution, or writes.
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { analyzeContent, flattenSymbols, type FileAnalysis } from "../core/parser.js";
import { maskSourceText } from "../core/source-mask.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { searchTerms } from "../core/embeddings.js";
import { unifiedSearchData } from "./search.js";

export interface ContextTarget {
  file: string;
  symbol?: string;
  start?: number;
  end?: number;
}
export interface ContextOptions {
  rootDir: string;
  query?: string;
  targets?: ContextTarget[];
  maxTokens?: number;
}
interface Excerpt { file: string; start: number; end: number; text: string; }
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const render = (part: Excerpt): string => `${part.file}:${part.start}-${part.end}\n${part.text}`;

export async function getContext(options: ContextOptions): Promise<string> {
  const query = options.query?.trim() ?? "";
  if (!query && !options.targets?.length) throw new Error("Provide query or targets.");
  if (query.length > 2000 || (options.targets?.length ?? 0) > 6) throw new Error("Use a query up to 2000 characters and at most six targets.");
  const budget = options.maxTokens ?? 4000;
  if (!Number.isInteger(budget) || budget < 512 || budget > 12000) throw new Error("max_tokens must be from 512 to 12000 (estimated UTF-8 bytes/4).");
  let targets: Array<ContextTarget & { helper?: boolean }> = [...options.targets ?? []];
  const notices: string[] = [];
  if (!targets.length) {
    // Exact identifiers need no embedding round trip. Natural language keeps the
    // hybrid retriever: no unvalidated lexical confidence gate discards recall.
    const exact = /^[A-Za-z_$][\w$]*$/.test(query);
    const found = await unifiedSearchData({ rootDir: options.rootDir, query,
      mode: "file", preset: exact ? "keyword_only" : "balanced", topK: 4,
      inlineCode: "off", includeDependencies: true, persistArtifact: false });
    if (found.freshness.warning) notices.push(found.freshness.warning);
    if (found.freshness.indexState !== "fresh") notices.push(`Discovery index: ${found.freshness.indexState}; verify scope with native search if incomplete.`);
    const primary = found.files?.results.map(item => ({ file: item.path })) ?? [];
    targets = [...primary.slice(0, 2), ...found.dependencies?.slice(0, 2).map(item => ({ file: item.path })) ?? [], ...primary.slice(2)];
  }
  const terms = new Set(searchTerms(query));
  const candidates: Excerpt[] = [];
  const omitted: string[] = [];
  const snapshots = new Map<string, string>();
  const analyses = new Map<string, FileAnalysis>();
  const seen = new Set<string>();
  const limit = budget * 4;
  // Reserve bounded space for freshness, failures, and omissions. Source blocks
  // are admitted whole, never cut midway through a function to meet the budget.
  let available = limit - 768;
  for (const target of targets) {
    const fullPath = resolveProjectPath(options.rootDir, target.file, "context target");
    const file = relative(options.rootDir, fullPath).split("\\").join("/");
    if (bytes(file) > 240 || (target.symbol?.length ?? 0) > 200) throw new Error("Target path or symbol is too long; use a shorter repository-relative target.");
    for (const line of [target.start, target.end]) if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error("Line numbers must be positive integers.");
    if (target.symbol && (target.start !== undefined || target.end !== undefined)) throw new Error("Choose symbol or line range for a target.");
    if (target.end !== undefined && target.end < (target.start ?? 1)) throw new Error("end must be at least start.");
    let source = snapshots.get(file);
    try {
      if (source === undefined) {
        if ((await stat(fullPath)).size > 2_000_000) { omitted.push(`${file}: exceeds 2 MB read limit`); continue; }
        source = await readFile(fullPath, "utf8");
        if (bytes(source) > 2_000_000) { omitted.push(`${file}: exceeds 2 MB read limit`); continue; }
        if (source.includes("\0")) { omitted.push(`${file}: binary file`); continue; }
        snapshots.set(file, source);
      }
    } catch { omitted.push(`${file}: unreadable`); continue; }
    const lines = source.split("\n");
    let start = target.start ?? 1, end = Math.min(target.end ?? lines.length, lines.length);
    const analyze = async (): Promise<FileAnalysis> => {
      let value = analyses.get(file);
      if (!value) { value = await analyzeContent(fullPath, source!); analyses.set(file, value); }
      return value;
    };
    const analysis = target.symbol ? await analyze() : undefined;
    if (target.symbol) {
      const matches = flattenSymbols(analysis!.symbols).filter(item => item.name === target.symbol);
      if (matches.length !== 1) { omitted.push(`${file}: ${target.symbol} ${matches.length ? "ambiguous; use line range" : "not found"}`); continue; }
      start = matches[0].line; end = matches[0].endLine;
    }
    if (start > lines.length) { omitted.push(`${file}:${start}: beyond end of file`); continue; }
    const key = `${file}:${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const excerpt = { file, start, end, text: lines.slice(start - 1, end).join("\n") };
    if (target.symbol && !target.helper && end - start < 10 && bytes(excerpt.text) < 600) {
      const executable = maskSourceText(excerpt.text, file);
      const calls = new Set([...executable.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]));
      const local = analysis!.symbols.filter(symbol => symbol.name !== target.symbol && symbol.kind === "function" && calls.has(symbol.name));
      for (const helper of local.slice(0, 2)) {
        const name = helper.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const shadowed = new RegExp(`(?:\\b(?:const|let|var|function)\\s+${name}\\b|[,(]\\s*${name}\\s*[:=,)])`).test(executable);
        if (shadowed || local.filter(item => item.name === helper.name).length !== 1) continue;
        if (!targets.some(item => item.file === file && item.symbol === helper.name)) targets.push({ file, symbol: helper.name, helper: true });
        const note = "Includes possible same-file helpers for short forwarding functions; verify call bindings from source.";
        if (!notices.includes(note)) notices.push(note);
      }
    }
    // Fully covered overlapping targets do not consume the budget twice.
    if (candidates.some(item => item.file === file && item.start <= start && item.end >= end)) continue;
    if (bytes(render(excerpt)) + 2 <= available) {
      candidates.push(excerpt); available -= bytes(render(excerpt)) + 2; continue;
    }
    if (target.symbol || target.start !== undefined || target.end !== undefined || !query) {
      omitted.push(`${key}: over budget; request narrower targets or raise max_tokens`); continue;
    }
    // For a large discovered file, prefer complete top-level declarations by
    // marginal query-term coverage per byte. Partition spans to avoid overlap.
    const parsed = await analyze();
    let cursor = 1;
    const units = parsed.symbols.filter(s => s.line >= 1 && s.endLine <= lines.length)
      .sort((a, b) => a.line - b.line).flatMap(symbol => {
        if (symbol.endLine < cursor) return [];
        const part = { file, start: cursor, end: symbol.endLine, text: lines.slice(cursor - 1, symbol.endLine).join("\n") };
        cursor = symbol.endLine + 1;
        return [part];
      });
    const remaining = units.map(part => ({ part, words: new Set(searchTerms(part.text)), size: bytes(render(part)) + 2 }));
    const covered = new Set<string>();
    let count = 0;
    while (remaining.length) {
      const ranked = remaining.map(({ part, words, size }) => {
        const gain = [...terms].reduce((n, term) => n + (words.has(term) ? covered.has(term) ? .15 : 1 : 0), 0);
        return { part, words, size, gain, score: gain / Math.sqrt(size) };
      }).sort((a, b) => b.score - a.score || a.part.start - b.part.start);
      const next = ranked.find(item => item.gain > 0 && item.size <= available);
      if (!next) break;
      candidates.push(next.part); available -= next.size; count++;
      for (const term of next.words) covered.add(term);
      remaining.splice(remaining.findIndex(item => item.part === next.part), 1);
    }
    omitted.push(`${file}: partial (${count} declarations); unreturned lines omitted`);
  }
  // Coalesce overlapping/adjacent ranges using the original snapshot. This also
  // makes a function included through multiple targets appear only once.
  const merged: Excerpt[] = [];
  for (const file of new Set(candidates.map(item => item.file))) {
    for (const part of candidates.filter(item => item.file === file).sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last?.file === file && part.start <= last.end + 1) {
        last.end = Math.max(last.end, part.end);
        last.text = snapshots.get(file)!.split("\n").slice(last.start - 1, last.end).join("\n");
      } else merged.push({ ...part });
    }
  }
  const noticeText = notices.join("\n");
  const info = [...notices, ...omitted.map(value => `Omitted: ${value}`)].join("\n");
  const footer = bytes(info) <= 650 ? info : [
    bytes(noticeText) <= 400 ? noticeText : "Discovery index has freshness warnings; verify scope with native search.",
    "Some targets or lines omitted. Narrow query/targets or increase max_tokens; verify scope with native search.",
  ].filter(Boolean).join("\n");
  return ["Source evidence (only the indicated ranges are included):", ...merged.map(render), footer,
    !merged.length ? "No source fit or matched. Try exact file/line targets or native search." : ""].filter(Boolean).join("\n\n");
}
