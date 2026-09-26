// Locate and read evidence in one round trip. All excerpts come from one disk
// snapshot per file; no generated summaries, arbitrary code execution, or writes.
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import ts from "typescript";
import { analyzeContent, flattenSymbols, type FileAnalysis } from "../core/parser.js";
import { maskSourceText } from "../core/source-mask.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { searchTerms } from "../core/embeddings.js";
import { getDB } from "../core/db.js";
import { walkDirectory } from "../core/walker.js";
import { extractIdentifierHints, unifiedSearchData } from "./search.js";
import { mentionedFiles, isOrientationQuery, orientationFiles, isLockfile, wantsLockfile, queryLiterals, discoveryPathWeight } from "./discovery-hints.js";
import { discoverDocuments, wantsDocuments } from "./discovery-documents.js";

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
  const literals = [...new Set([...queryLiterals(query), query.replace(/^(["'`])([\s\S]*)\1$/, "$2").normalize("NFC").toLowerCase()])];
  if (!query && !options.targets?.length) throw new Error("Provide query or targets.");
  if (query.length > 2000 || (options.targets?.length ?? 0) > 6) throw new Error("Use a query up to 2000 characters and at most six targets.");
  const budget = options.maxTokens ?? 4000;
  if (!Number.isInteger(budget) || budget < 512 || budget > 12000) throw new Error("max_tokens must be from 512 to 12000 (estimated UTF-8 bytes/4).");
  let targets: Array<ContextTarget & { helper?: boolean }> = [...options.targets ?? []];
  const notices: string[] = [];
  const filePriors = new Map<string, number>();
  const namedSymbols = new Set<string>();
  const requestedFiles = new Set<string>();
  const orientation = isOrientationQuery(query);
  // File mentions within an overview supplement the requested architecture;
  // they must not switch discovery into a restricted whole-file read.
  const readRequestedFiles = !orientation && /\b(?:read|show|open|whole|entire|full)\b/i.test(query);
  const overviewFiles = new Set<string>();
  const documentFiles = new Set<string>();
  if (!targets.length) {
    // Exact identifiers need no embedding round trip. Natural language keeps the
    // hybrid retriever: no unvalidated lexical confidence gate discards recall.
    const exact = /^[A-Za-z_$][\w$]*$/.test(query);
    const found = await unifiedSearchData({ rootDir: options.rootDir, query,
      mode: "file", preset: exact ? "keyword_only" : "balanced", topK: 4,
      inlineCode: "off", includeDependencies: true, persistArtifact: false });
    if (found.freshness.warning) notices.push(found.freshness.warning);
    if (!exact && found.trust.ambiguities.some(warning => warning.includes("keyword-only"))) notices.push("Discovery used lexical fallback; semantic vectors unavailable or weak. Reindex if semantic retrieval is needed.");
    if (!["fresh", "refreshed"].includes(found.freshness.indexState)) notices.push(`Discovery index: ${found.freshness.indexState}; verify scope with native search if incomplete.`);
    const primary = found.files?.results.map(item => ({ file: item.path })) ?? [];
    primary.forEach((item, index) => filePriors.set(item.file, 1 / (1 + index * .5)));
    targets = [...primary.slice(0, 2), ...found.dependencies?.slice(0, 2).map(item => ({ file: item.path, helper: true })) ?? [], ...primary.slice(2)];
    // A literal symbol is stronger evidence of the requested definition than
    // prose similarity. Look up defining files even if ranking omitted them;
    // ranges are still resolved against the current source below.
    const hints = extractIdentifierHints(query);
    const db = await getDB(options.rootDir);
    const indexed = db.getAllFiles();
    // Multi-key questions need evidence for each literal, even when one key's
    // many callers fill the primary result window before another key's source.
    const literalFiles = new Set<string>();
    for (const literal of queryLiterals(query)) {
      const match = db.searchFileText(literal, 40, true)
        .sort((a, b) => discoveryPathWeight(query, b.path) - discoveryPathWeight(query, a.path) || a.score - b.score)[0];
      if (match) { literalFiles.add(match.path); filePriors.set(match.path, 1); }
    }
    targets = [...literalFiles].map(file => ({file})).concat(targets.filter(target => !literalFiles.has(target.file)));
    const files = new Map(indexed.map(file => [file.id, file.path]));
    const definingFiles = new Set<string>();
    for (const hint of hints.slice(0, 16)) {
      for (const symbol of db.searchSymbolsByName(hint).filter(symbol => symbol.name === hint)) {
        const file = files.get(symbol.file_id);
        if (file && discoveryPathWeight(query, file) >= 1) {
          definingFiles.add(file); namedSymbols.add(symbol.name);
        }
      }
    }
    const definitions = [...definingFiles].sort((a, b) => Number(query.includes(b)) - Number(query.includes(a)) || a.localeCompare(b));
    if (definitions.length > 6 || hints.length > 16) notices.push("Some named definitions omitted; narrow the query or use exact file/symbol targets.");
    targets = [...definitions.slice(0, 6).map(file => ({ file })), ...targets.filter(target => !definitions.slice(0, 6).includes(target.file))];
    const documents = wantsDocuments(query) ? await discoverDocuments(options.rootDir, query) : undefined;
    const mentioned = [...new Set([...mentionedFiles(options.rootDir, query, indexed), ...documents?.mentioned ?? []])];
    for (const file of documents?.files ?? []) { documentFiles.add(file); filePriors.set(file, 2); }
    if (documentFiles.size) notices.push(`Document discovery uses filenames and bounded heading/intro previews${documents?.limited ? "; additional documents omitted" : ""}; verify scope with exact reads.`);
    if (mentioned.length > 6) notices.push("More than six files named; additional files omitted. Use batches of at most six exact targets.");
    for (const file of mentioned.slice(0, 6)) { requestedFiles.add(file); filePriors.set(file, 2); }
    if (orientation) {
      for (const file of orientationFiles(db, indexed, query)) overviewFiles.add(file);
      // Documentation is not necessarily part of the structural source index.
      // Use the ignore-aware walker so ignored files and symlinks stay excluded.
      const readme = (await walkDirectory({ rootDir: options.rootDir, depthLimit: 1 }))
        .filter(entry => !entry.isDirectory && entry.depth === 0 && /^readme\.(?:md|txt|rst)$/i.test(entry.relativePath))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))[0];
      if (readme) overviewFiles.add(readme.relativePath);
      notices.push("Orientation includes structural entry points and import hubs; excerpts are not exhaustive.");
    }
    const priority = new Set([...requestedFiles, ...documentFiles, ...overviewFiles]);
    targets = [...priority].map(file => ({ file })).concat(targets.filter(target => !priority.has(target.file)));
    if (readRequestedFiles && requestedFiles.size) targets = targets.filter(target => requestedFiles.has(target.file));
    if (!wantsLockfile(query) && targets.some(target => !isLockfile(target.file))) {
      targets = targets.filter(target => !isLockfile(target.file) || requestedFiles.has(target.file));
    }
  }
  const terms = new Set(searchTerms(query));
  const candidates: Excerpt[] = [];
  const omitted: string[] = [];
  const snapshots = new Map<string, string>();
  const analyses = new Map<string, FileAnalysis>();
  const discoveryParts: Excerpt[] = [];
  const definitions: Excerpt[] = [];
  const literalParts: Excerpt[] = [];
  const priorityParts: Excerpt[] = [];
  const smallDependencies: Excerpt[] = [];
  const seen = new Set<string>();
  const limit = budget * 4;
  // Explicit targets are admitted whole. Discovery may select labelled interior
  // ranges, always copied verbatim from the snapshot rather than synthesized.
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
    const discovery = !options.targets?.length;
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
    if (!discovery && bytes(render(excerpt)) + 2 <= available) {
      candidates.push(excerpt); available -= bytes(render(excerpt)) + 2; continue;
    }
    if (target.symbol || target.start !== undefined || target.end !== undefined || !query) {
      omitted.push(`${key}: over budget; request narrower targets or raise max_tokens`); continue;
    }
    if (readRequestedFiles && requestedFiles.has(file) && bytes(render(excerpt)) + 2 <= available) {
      priorityParts.push(excerpt);
    } else if (overviewFiles.has(file) || documentFiles.has(file)) {
      priorityParts.push({ file, start: 1, end: Math.min(25, lines.length), text: lines.slice(0, 25).join("\n") });
    }
    // File ranking can now find literal text anywhere in full-source FTS.
    // Keep the actual matching lines, not just other terms from the same file.
    for (const literal of literals.filter(value => value && !/^[A-Za-z$][A-Za-z0-9$]*$/.test(value))) {
      let hits = 0;
      for (let line = 0; line < lines.length; line++) {
        if (!lines[line].normalize("NFC").toLowerCase().includes(literal)) continue;
        if (++hits > 3) { omitted.push(`${file}: additional literal matches omitted`); break; }
        const from = Math.max(0, line - 2), to = Math.min(lines.length, line + 4);
        literalParts.push({ file, start: from + 1, end: to, text: lines.slice(from, to).join("\n") });
      }
    }
    if (namedSymbols.size && discoveryPathWeight(query, file) >= 1) {
      for (const symbol of flattenSymbols((await analyze()).symbols)) {
        if (!namedSymbols.has(symbol.name)) continue;
        const definition = { file, start: symbol.line, end: symbol.endLine, text: lines.slice(symbol.line - 1, symbol.endLine).join("\n") };
        // Keep complete bodies when possible. Large bodies retain their entry
        // point and can contribute further query-relevant interior windows.
        if (bytes(render(definition)) + 2 > available) {
          definition.end = Math.min(symbol.endLine, symbol.line + 18);
          definition.text = lines.slice(symbol.line - 1, definition.end).join("\n");
        }
        definitions.push(definition);
      }
    }
    // Gather all files before packing so a low-value header/dependency cannot
    // consume the budget ahead of a decisive range in another file.
    // Compiler statements keep locals inside anonymous test/router callbacks
    // from masquerading as complete top-level declarations.
    const syntax = /\.[cm]?[jt]sx?$/i.test(file) ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) : undefined;
    const spans = syntax ? syntax.statements.filter(s => !ts.isImportDeclaration(s)).map(s => ({
      line: syntax.getLineAndCharacterOfPosition(s.getStart(syntax)).line + 1,
      endLine: syntax.getLineAndCharacterOfPosition(s.end).line + 1,
    })) : (await analyze()).symbols.filter(s => s.line >= 1 && s.endLine <= lines.length);
    const add = (from: number, to: number) => discoveryParts.push({ file, start: from, end: to, text: lines.slice(from - 1, to).join("\n") });
    if (lines.length <= 40 && bytes(render(excerpt)) <= available) {
      add(1, lines.length);
      if (target.helper) smallDependencies.push(excerpt);
    }
    else {
      for (const symbol of spans) if (symbol.endLine - symbol.line < 60) add(symbol.line, symbol.endLine);
      // Anchor windows to query hits instead of arbitrary page boundaries.
      // Extra trailing context retains checks following a relevant comment.
      let spanIndex = 0, previousStart = -1;
      for (let line = 1; line <= lines.length; line++) {
        while (spanIndex < spans.length && spans[spanIndex].endLine < line) spanIndex++;
        const whole = spans[spanIndex];
        if (whole && whole.line <= line && whole.endLine - whole.line < 60) continue;
        if (!searchTerms(lines[line - 1]).some(term => terms.has(term))) continue;
        const start = Math.max(1, line - 6), end = Math.min(lines.length, line + 18);
        if (start !== previousStart) add(start, end);
        previousStart = start;
      }
    }
    omitted.push(`${file}: partial; unreturned lines omitted`);
  }
  for (const definition of [...priorityParts, ...literalParts, ...definitions]) {
    const size = bytes(render(definition)) + 2;
    if (size <= available && !candidates.some(part => part.file === definition.file && part.start <= definition.end && part.end >= definition.start)) {
      candidates.push(definition); available -= size;
    }
  }
  // IDF across windows downweights ubiquitous identifiers; marginal coverage
  // reduces repetitive snippets while keeping some evidence for repeated terms.
  const remaining = discoveryParts.map(part => ({ part, words: new Set(searchTerms(part.text)), size: bytes(render(part)) + 2 }));
  const weights = new Map([...terms].map(term => [term, 1 + Math.log(1 + remaining.length / (1 + remaining.filter(item => item.words.has(term)).length))]));
  const covered = new Set(candidates.flatMap(part => searchTerms(part.text)));
  const selectedBytes = new Map<string, number>();
  for (const part of candidates) selectedBytes.set(part.file, (selectedBytes.get(part.file) ?? 0) + bytes(render(part)));
  while (remaining.length && available > 0) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < remaining.length; i++) {
      const { part, words, size } = remaining[i];
      if (size > available) continue;
      if (candidates.some(item => item.file === part.file && item.start <= part.end && item.end >= part.start)) continue;
      const gain = [...terms].reduce((n, term) => n + (words.has(term) ? weights.get(term)! * (covered.has(term) ? .25 : 1) : 0), 0);
      // Keep the retriever's ordering as a prior; otherwise a rare incidental
      // word in a lower-ranked UI/test file can displace implementation evidence.
      // A large first-ranked file must not monopolize a cross-module question.
      // This is a soft diversity prior; strong evidence can still reuse a file.
      const repetition = 1 + (selectedBytes.get(part.file) ?? 0) / Math.max(512, limit / 4);
      const score = gain * (filePriors.get(part.file) ?? .5) / (Math.sqrt(size) * repetition);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (best < 0) break;
    const next = remaining.splice(best, 1)[0];
    candidates.push(next.part); available -= next.size;
    selectedBytes.set(next.part.file, (selectedBytes.get(next.part.file) ?? 0) + next.size);
    for (const term of next.words) covered.add(term);
  }
  for (const part of smallDependencies) {
    const cost = bytes(render(part)) + 2;
    if (cost <= available && !candidates.some(item => item.file === part.file)) {
      candidates.push(part); available -= cost;
    }
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
  const partialOmissions = omitted.filter(value => !merged.some(part => value === `${part.file}: partial; unreturned lines omitted`
    && part.start === 1 && part.end === snapshots.get(part.file)!.split("\n").length));
  const info = [...notices, ...partialOmissions.map(value => `Omitted: ${value}`)].join("\n");
  const footer = bytes(info) <= 650 ? info : [
    bytes(noticeText) <= 400 ? noticeText : "Discovery index has freshness warnings; verify scope with native search.",
    "Some targets or lines omitted. Narrow query/targets or increase max_tokens; verify scope with native search.",
  ].filter(Boolean).join("\n");
  return ["Source evidence (only the indicated ranges are included):", ...merged.map(render), footer,
    !merged.length ? "No source fit or matched. Try exact file/line targets or native search." : ""].filter(Boolean).join("\n\n");
}
