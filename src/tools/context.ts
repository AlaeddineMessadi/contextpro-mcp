// Locate and read evidence in one round trip. All excerpts come from one disk
// snapshot per file. Query packets can persist regenerable evidence artifacts;
// exact targets remain stateless and never request model enrichment.
import { readFile, stat } from "node:fs/promises";
import { relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { analyzeContent, flattenSymbols, type FileAnalysis } from "../core/parser.js";
import { maskSourceText } from "../core/source-mask.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { searchTerms } from "../core/embeddings.js";
import { getDB } from "../core/db.js";
import { walkDirectory } from "../core/walker.js";
import { readBoundedRanges, type BoundedRange } from "../core/bounded-source.js";
import { extractIdentifierHints, unifiedSearchData } from "./search.js";
import { mentionedFiles, documentTopicFiles, isUiOrientationQuery, isOrientationQuery, orientationFiles, isLockfile, wantsLockfile, queryLiterals, discoveryPathWeight, positiveDiscoveryQuery } from "./discovery-hints.js";
import { scopedSourceCandidates } from "./scoped-discovery.js";
import { discoverDocuments, wantsDocuments } from "./discovery-documents.js";
import { connectedRetrievalEnabled, retrieveEvidence, type EvidenceCandidate } from "./evidence-retrieval.js";
import { finishSourceContext } from "../core/source-context.js";
import { lookupFeatureBrief } from "../core/feature-brief-cache.js";
import { chatModelIdentity } from "../core/chat-model.js";
import { getProvider, getEmbedModelName } from "../core/provider-config.js";
import { getProjectRiskEvidence } from "./retrieval-helpers.js";

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
  previousContextId?: string;
  intent?: "auto" | "lookup" | "change" | "debug" | "review" | "overview";
  /** Internal evaluation override; the MCP surface uses configured defaults. */
  retrievalPreset?: "balanced" | "keyword_only" | "semantic_only";
  connected?: boolean;
  retrieved?: Awaited<ReturnType<typeof retrieveEvidence>>;
}
export interface Excerpt { file: string; start: number; end: number; text: string; }
export interface SourceEvidence {
  text: string; ranges: Excerpt[]; hashes: Record<string, string>; notices: string[];
  /** Delivery completeness, not a claim of exhaustive repository coverage. */
  complete: boolean; settings: string;
}
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const render = (part: Excerpt): string => `${part.file}:${part.start}-${part.end}\n${part.text}`;

/** Keep uncovered tails/interiors instead of rejecting every partial overlap. */
function uncoveredRanges(part: Excerpt, selected: Excerpt[]): Excerpt[] {
  const ranges: Array<[number, number]> = [];
  let start = part.start;
  for (const covered of selected.filter(item => item.file === part.file).sort((a, b) => a.start - b.start)) {
    if (covered.end < start) continue;
    if (covered.start > part.end) break;
    if (covered.start > start) ranges.push([start, covered.start - 1]);
    start = Math.max(start, covered.end + 1);
  }
  if (start <= part.end) ranges.push([start, part.end]);
  const lines = part.text.split("\n");
  return ranges.map(([start, end]) => ({ ...part, start, end, text: lines.slice(start - part.start, end - part.start + 1).join("\n") }));
}

export async function getContext(options: ContextOptions): Promise<string> {
  if (options.previousContextId && !/^source_context-[a-f0-9]{14}$/.test(options.previousContextId)) throw new Error("Invalid previous_context_id; use a source_context ID from a context response.");
  if (options.previousContextId && options.targets?.length) throw new Error("previous_context_id is for query discovery only; exact targets are stateless.");
  const packet = await collectSourceEvidence(options);
  return options.targets?.length ? packet.text : finishSourceContext(options, packet);
}

export async function collectSourceEvidence(options: ContextOptions): Promise<SourceEvidence> {
  const query = options.query?.trim() ?? "";
  if (options.targets?.length && options.intent) throw new Error("intent is for query discovery only.");
  const adaptive = !options.targets?.length && (options.intent !== undefined || process.env.CONTEXTPRO_ADAPTIVE_CONTEXT === "true");
  const intent = options.intent && options.intent !== "auto" ? options.intent
    : isOrientationQuery(query) ? "overview" : /\b(?:fix|debug|failure|error|broken)\b/i.test(query) ? "debug"
    : /\b(?:review|impact|regression)\b/i.test(query) ? "review"
    : /\b(?:change|implement|add|update|refactor|remove)\b/i.test(query) ? "change" : "lookup";
  const changeContext = adaptive && ["change", "debug", "review"].includes(intent);
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
  // Subjects such as authentication/frontend and output wording such as "source
  // ranges" do not request code. Only explicit code/implementation intent
  // authorizes a restricted document allowance.
  const mixedDocuments = changeContext || (!options.targets?.length && /\b(?:code|implementation)\b/i.test(query));
  const orientation = options.retrievalPreset !== "semantic_only" && (isOrientationQuery(query) || (adaptive && intent === "overview"));
  // File mentions within an overview supplement the requested architecture;
  // they must not switch discovery into a restricted whole-file read.
  const readRequestedFiles = !orientation && (/\b(?:read|show|open|whole|entire|full)\b/i.test(positiveDiscoveryQuery(query))
    || /^[\w@./-]+\.[A-Za-z][\w]*(?::\d+(?:-\d+)?)?$/.test(query));
  const overviewFiles = new Set<string>();
  const documentFiles = new Set<string>();
  const topicTerms = new Map<string, string[]>();
  const scopedFiles = new Set<string>();
  const coverageFiles = new Set<string>();
  let connectedCandidates: EvidenceCandidate[] = [];
  let rolesClassified = false;
  const connected = options.connected ?? (changeContext || connectedRetrievalEnabled());
  if (!targets.length) {
    // Exact identifiers need no embedding round trip. Natural language keeps the
    // hybrid retriever: no unvalidated lexical confidence gate discards recall.
    const exact = /^[A-Za-z_$][\w$]*$/.test(query);
    const packet = options.retrieved ?? (connected && (!exact || changeContext) ? await retrieveEvidence({ rootDir: options.rootDir, query, preset: options.retrievalPreset }) : undefined);
    // Gather beyond the first few hits before packing; incidental callers can
    // rank ahead of the implementation. The source/output budget stays fixed.
    const found = packet?.search ?? await unifiedSearchData({ rootDir: options.rootDir, query,
      mode: "file", preset: exact ? "keyword_only" : options.retrievalPreset ?? "balanced", topK: exact ? 4 : 12,
      inlineCode: "off", includeDependencies: true, persistArtifact: false });
    connectedCandidates = packet?.candidates ?? [];
    rolesClassified = packet !== undefined;
    if (packet?.relationNotice) notices.push(packet.relationNotice);
    if (packet?.relevanceNotice) notices.push(packet.relevanceNotice);
    if (packet?.limited) notices.push("Candidate pool capped at 32 files; additional paths omitted.");
    if (packet) {
      const brief = await lookupFeatureBrief(options.rootDir, query);
      if (brief) {
        const interpretation = brief.brief.interpretations[0];
        const detail = interpretation ? `Model interpretation: ${interpretation.text}` : brief.brief.facts[0];
        notices.push(`Cached feature explanation: ${brief.artifact.id}${detail ? `; ${detail.slice(0, 260)}` : ""}. Read artifact for citations.`);
      }
    }
    if (found.freshness.warning) notices.push(found.freshness.warning);
    if (!exact && options.retrievalPreset === "keyword_only") notices.push("Discovery used the requested keyword_only preset; semantic vectors were not consulted.");
    else if (!exact && found.trust.ambiguities.some(warning => warning.includes("keyword-only"))) notices.push("Discovery used lexical fallback; semantic vectors unavailable or weak. Reindex if semantic retrieval is needed.");
    if (!["fresh", "refreshed"].includes(found.freshness.indexState)) notices.push(`Discovery index: ${found.freshness.indexState}; verify scope with native search if incomplete.`);
    const primary = found.files?.results.map(item => ({ file: item.path })) ?? [];
    primary.forEach((item, index) => filePriors.set(item.file, 1 / (1 + index * .5)));
    targets = [...primary.slice(0, 2), ...found.dependencies?.slice(0, 2).map(item => ({ file: item.path, helper: true })) ?? [], ...primary.slice(2)];
    if (packet) {
      targets = packet.candidates.map(item => ({ file: item.path, helper: item.roles.includes("dependency") }));
      const high = Math.max(...packet.candidates.map(item => item.score), .001);
      packet.candidates.forEach(item => filePriors.set(item.path, .5 + item.score / high));
    }
    // A literal symbol is stronger evidence of the requested definition than
    // prose similarity. Look up defining files even if ranking omitted them;
    // ranges are still resolved against the current source below.
    const hints = extractIdentifierHints(query);
    const db = await getDB(options.rootDir);
    const indexed = db.getAllFiles();
    // Multi-key questions need evidence for each literal, even when one key's
    // many callers fill the primary result window before another key's source.
    const literalFiles = new Set<string>();
    const coverageTerms = [...new Set(searchTerms(query))];
    for (const literal of options.retrievalPreset === "semantic_only" ? [] : exact ? [query] : queryLiterals(query)) {
      const matches = db.searchFileText(literal, 40, true)
        .sort((a, b) => discoveryPathWeight(query, b.path) - discoveryPathWeight(query, a.path) || a.score - b.score).slice(0, 8);
      for (const match of matches) { literalFiles.add(match.path); filePriors.set(match.path, 1); }
    }
    // Common literals can fill the OR lane with short incidental files. Reserve
    // bounded candidates containing every normalized term without displacing
    // explicit quoted literals from the front of the candidate lane.
    if (options.retrievalPreset !== "semantic_only" && coverageTerms.length > 1 && coverageTerms.length <= 12) {
      for (const match of db.searchFileText(coverageTerms.join(" "), 8, false, true)) {
        if (discoveryPathWeight(query, match.path) < 1) continue;
        literalFiles.add(match.path); coverageFiles.add(match.path); filePriors.set(match.path, 1);
      }
    }
    targets = [...literalFiles].map(file => ({file})).concat(targets.filter(target => !literalFiles.has(target.file)));
    const files = new Map(indexed.map(file => [file.id, file.path]));
    const definingFiles = new Set<string>();
    for (const hint of options.retrievalPreset === "semantic_only" ? [] : hints.slice(0, 16)) {
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
    const documents = options.retrievalPreset !== "semantic_only" && (wantsDocuments(query) || (adaptive && (!exact || definitions.length === 0)))
      ? await discoverDocuments(options.rootDir, query, { requireRelevance: adaptive && !wantsDocuments(query) }) : undefined;
    // Strict multi-topic candidates can include controls without saying "code";
    // discovering them does not itself authorize capping documentation.
    if (documents && !orientation && options.retrievalPreset !== "semantic_only") {
      const topics = documentTopicFiles(db, query);
      for (const {file, terms} of topics) { topicTerms.set(file, terms); filePriors.set(file, Math.max(filePriors.get(file) ?? 0, 1)); }
      targets = topics.map(({file}) => ({file})).concat(targets.filter(target => !topicTerms.has(target.file)));
    }
    if (!exact && !orientation && options.retrievalPreset !== "semantic_only") {
      const scoped = scopedSourceCandidates(db, query, hints);
      for (const {file, terms} of scoped) {
        if (!topicTerms.has(file)) scopedFiles.add(file);
        topicTerms.set(file, [...new Set([...topicTerms.get(file) ?? [], ...terms])]);
        filePriors.set(file, Math.max(filePriors.get(file) ?? 0, 2));
      }
      targets = scoped.map(({file}) => ({file})).concat(targets.filter(target => !scoped.some(item => item.file === target.file)));
      if (scoped.length) notices.push("Scoped candidates use filename and literal-text hints, not resolved references; verify bindings with exact_references.");
    }
    const mentioned = [...new Set([...mentionedFiles(options.rootDir, query, indexed), ...documents?.mentioned ?? []])];
    for (const file of documents?.files ?? []) { documentFiles.add(file); filePriors.set(file, 2); }
    if (documentFiles.size) notices.push(`Document discovery uses filenames and bounded heading/intro previews${documents?.limited ? "; additional documents omitted" : ""}; verify scope with exact reads.`);
    if (mentioned.length > 6) notices.push("More than six files named; additional files omitted. Use batches of at most six exact targets.");
    for (const file of mentioned.slice(0, 6)) { requestedFiles.add(file); filePriors.set(file, 2); }
    if (orientation) {
      for (const file of orientationFiles(db, indexed, query)) { overviewFiles.add(file); filePriors.set(file, 2); }
      // Documentation is not necessarily part of the structural source index.
      // Use the ignore-aware walker so ignored files and symlinks stay excluded.
      const readme = (await walkDirectory({ rootDir: options.rootDir, depthLimit: 1 }))
        .filter(entry => !entry.isDirectory && entry.depth === 0 && /^readme\.(?:md|txt|rst)$/i.test(entry.relativePath))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))[0];
      if (readme && (!isUiOrientationQuery(query) || documents)) overviewFiles.add(readme.relativePath);
      notices.push("Orientation includes structural entry points and import hubs; excerpts are not exhaustive.");
    }
    const priority = new Set([...requestedFiles, ...documentFiles, ...overviewFiles]);
    targets = [...priority].map(file => ({ file })).concat(targets.filter(target => !priority.has(target.file)));
    if (readRequestedFiles && requestedFiles.size) targets = targets.filter(target => requestedFiles.has(target.file));
    targets = targets.filter(target => discoveryPathWeight(query, target.file) > 0);
    if (!wantsLockfile(query) && targets.some(target => !isLockfile(target.file))) {
      targets = targets.filter(target => !isLockfile(target.file) || requestedFiles.has(target.file));
    }
    if (changeContext) {
      const configurations = (await walkDirectory({rootDir:options.rootDir})).filter(entry => !entry.isDirectory
        && /(?:^|\/)(?:package\.json|(?:ts|js|pyright)config[^/]*\.json|pyproject\.toml|[^/]+\.config\.[^/]+)$/.test(entry.relativePath)
        && targets.some(target => dirname(entry.relativePath)==="." || target.file.startsWith(dirname(entry.relativePath)+"/")))
        .sort((a,b)=>b.depth-a.depth || a.relativePath.localeCompare(b.relativePath));
      targets.push(...configurations.slice(0,8).map(entry=>({file:entry.relativePath,helper:true})));
      if(configurations.length>8) notices.push("Additional configuration candidates omitted at the eight-file bound.");
    }
    if (packet) {
      targets = [...new Map(targets.map(target => [target.file, target])).values()];
      if (targets.length > 32) { targets = targets.slice(0, 32); notices.push("Additional discovery targets omitted at the 32-file bound."); }
    }
  }
  const terms = new Set(searchTerms(query));
  if (adaptive && !orientation && /\b(?:routes?|endpoints?|handlers?)\b/i.test(positiveDiscoveryQuery(query))) {
    // A named endpoint topic is stronger than an incidental prose match in a
    // client or workflow. This stays a soft lexical prior: callers, contracts
    // and tests still compete for the same bounded packet.
    const generic = new Set("api app apps src source web native server route routes endpoint endpoints handler handlers code file files implementation locate find show".split(" "));
    for (const target of targets) {
      if (!/(?:^|\/)(?:api|routes?|endpoints?|handlers?)(?:\/|[.-])/i.test(target.file)) continue;
      const topics = new Set(searchTerms(target.file).filter(term => terms.has(term) && !generic.has(term)));
      if (topics.size) filePriors.set(target.file, (filePriors.get(target.file) ?? .5) * (1 + Math.min(2, topics.size)));
    }
  }
  const candidates: Excerpt[] = [];
  const omitted: string[] = [];
  const snapshots = new Map<string, string>();
  const boundedSnapshots = new Map<string, Map<string, BoundedRange>>();
  const analyses = new Map<string, FileAnalysis>();
  const discoveryParts: Excerpt[] = [];
  const definitions: Excerpt[] = [];
  const literalParts: Excerpt[] = [];
  const identifierParts: Excerpt[] = [];
  const priorityParts: Excerpt[] = [];
  const documentPassages: Excerpt[] = [];
  const scopedParts: Excerpt[] = [];
  const smallDependencies: Excerpt[] = [];
  const seen = new Set<string>();
  const limit = budget * 4;
  const risks = changeContext ? await getProjectRiskEvidence(options.rootDir, query) : [];
  let riskNotice: string | undefined;
  if (changeContext) {
    riskNotice = "Known risks: unavailable in bounded current task memory; not proof of absence.";
    if (risks.length) {
      riskNotice = "Known risks (textual task notes; source evidence current):";
      const riskBudget = Math.min(480, Math.floor(limit * .15));
      riskEntries: for (const note of risks) for (const risk of note.risks) {
        const entry = `\n${note.id}: ${risk}`;
        if (bytes(riskNotice + entry) + 30 <= riskBudget) riskNotice += entry;
        else {
          riskNotice += "\nOmitted: more risk text.";
          break riskEntries;
        }
      }
    }
  }
  // Explicit targets are admitted whole. Discovery may select labelled interior
  // ranges, always copied verbatim from the snapshot rather than synthesized.
  let available = limit - 768 - (options.targets?.length ? 0 : 384) - (adaptive ? 480 : 0) - (riskNotice ? bytes(riskNotice) + 2 : 0);
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
        const stats = await stat(fullPath);
        if (!stats.isFile()) { omitted.push(`${file}: not a regular file`); continue; }
        if (stats.size > 2_000_000) {
          if (!options.targets?.length || target.symbol || target.end === undefined) {
            omitted.push(`${file}: exceeds 2 MB read limit; use explicit start/end targets`); continue;
          }
          let ranges = boundedSnapshots.get(file);
          if (!ranges) {
            const requested = options.targets.filter(item => !item.symbol && item.end !== undefined
              && Number.isInteger(item.start ?? 1) && (item.start ?? 1) > 0
              && Number.isInteger(item.end) && item.end >= (item.start ?? 1)
              && resolveProjectPath(options.rootDir, item.file, "context target") === fullPath);
            ranges = await readBoundedRanges(fullPath, requested.map(item => ({start:item.start ?? 1,end:item.end!})), limit);
            boundedSnapshots.set(file, ranges);
          }
          const result = ranges.get(`${target.start ?? 1}:${target.end}`)!;
          if ("omitted" in result) { omitted.push(`${file}:${/^\d/.test(result.omitted) ? "" : " "}${result.omitted}`); continue; }
          const excerpt: Excerpt = {file,...result};
          if (candidates.some(item => item.file === file && item.start <= excerpt.start && item.end >= excerpt.end)) continue;
          const cost = bytes(render(excerpt)) + 2;
          if (cost > available) { omitted.push(`${file}:${excerpt.start}-${excerpt.end}: over budget; request narrower targets or raise max_tokens`); continue; }
          candidates.push(excerpt); available -= cost; continue;
        }
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
    if (adaptive && documentFiles.has(file)) {
      // Operational notes often use long paragraphs or table rows. Rank the
      // actual matching line before generic heading previews and large windows.
      const hits = lines.map((text, index) => ({part:{file,start:index+1,end:index+1,text},
        score:[...new Set(searchTerms(text))].filter(term=>terms.has(term)).length}))
        .filter(item=>item.score>=Math.min(2,terms.size) && bytes(render(item.part))<=Math.min(1600,available))
        .sort((a,b)=>b.score-a.score || a.part.start-b.part.start);
      documentPassages.push(...hits.slice(0,2).map(item=>item.part));
    }
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
    if ((readRequestedFiles || lines.length <= 40) && requestedFiles.has(file) && bytes(render(excerpt)) + 2 <= available) {
      priorityParts.push(excerpt);
    } else if (overviewFiles.has(file) || documentFiles.has(file)) {
      // Bound each preview in bytes, not lines: one Markdown table row can be
      // larger than an entire packet. Leave room for the other requested roles.
      const share = Math.max(128, Math.min(1200, Math.floor(available * .4 / Math.max(1, overviewFiles.size + documentFiles.size))));
      // A long path or localized first line can exceed a small divided share.
      // Admit one line up to 512 bytes including its citation; global packing
      // still enforces the response budget and oversized rows remain bounded.
      const firstLineCost = bytes(render({file,start:1,end:1,text:lines[0]})) + 2;
      const cap = Math.max(share, Math.min(512, available, firstLineCost));
      const preview: Excerpt = {file, start:1, end:0, text:""};
      for (let line = 0; line < Math.min(25, lines.length); line++) {
        const next = {...preview, end:line+1, text:lines.slice(0,line+1).join("\n")};
        if (bytes(render(next)) + 2 > cap) break;
        Object.assign(preview,next);
      }
      if (preview.end) priorityParts.push(preview);
    }
    const topic = topicTerms.get(file);
    if (topic) {
      const cap = Math.min(800, Math.max(128, Math.floor(limit * .25 / topicTerms.size)));
      const windows = lines.flatMap((line, index) => {
        // Anchor to an actual hit so a tied window cannot put the matching
        // declaration at its tail and discard the following checks.
        if (!searchTerms(line).some(term => topic.includes(term))) return [];
        const from = Math.max(0, index - 2);
        let to = from, text = "";
        while (to < Math.min(lines.length, index + 9)) {
          const next = lines.slice(from, to + 1).join("\n");
          if (bytes(`${file}:${from+1}-${to+1}\n${next}`) + 2 > cap) break;
          text = next; to++;
        }
        const words = searchTerms(text);
        // Break coverage ties using bounded term frequency: a body using a
        // topic repeatedly is stronger evidence than its first setup mention.
        const score = topic.reduce((score, term) => {
          const count = words.filter(word => word === term).length;
          return score + (count ? 1 + Math.min(2, count - 1) * .1 : 0);
        }, 0);
        return [{part:{file,start:from+1,end:to,text},score}];
      }).filter(item=>item.part.end >= item.part.start && item.score > 0);
      windows.sort((a,b)=>b.score-a.score || a.part.start-b.part.start);
      if (windows[0]) (scopedFiles.has(file) ? scopedParts : priorityParts).push(windows[0].part);
    }
    // File ranking can now find literal text anywhere in full-source FTS.
    // Keep the actual matching lines, not just other terms from the same file.
    for (const literal of literals.filter(Boolean)) {
      const matches: Array<{part: Excerpt; score: number}> = [];
      for (let line = 0; line < lines.length; line++) {
        if (!lines[line].normalize("NFC").toLowerCase().includes(literal)) continue;
        const from = Math.max(0, line - 2), to = Math.min(lines.length, line + 4);
        const part = { file, start: from + 1, end: to, text: lines.slice(from, to).join("\n") };
        const words = new Set(searchTerms(part.text));
        matches.push({part, score:[...terms].filter(term=>words.has(term)).length});
      }
      matches.sort((a,b)=>b.score-a.score || a.part.start-b.part.start);
      const parts = /^[A-Za-z_$][\w$]*$/.test(literal) ? identifierParts : literalParts;
      parts.push(...matches.slice(0,3).map(match=>match.part));
      if (matches.length > 3) omitted.push(`${file}: additional literal matches omitted`);
    }
    const syntax = /\.[cm]?[jt]sx?$/i.test(file) ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) : undefined;
    const localNames = new Set(namedSymbols);
    // A type inferred from a local runtime schema needs that schema as evidence.
    for (const statement of syntax?.statements ?? []) if (ts.isTypeAliasDeclaration(statement) && localNames.has(statement.name.text)) {
      const visit = (node: ts.Node): void => {
        if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) localNames.add(node.exprName.text);
        ts.forEachChild(node, visit);
      };
      visit(statement.type);
    }
    if (namedSymbols.size && discoveryPathWeight(query, file) >= 1) {
      for (const symbol of flattenSymbols((await analyze()).symbols)) {
        if (!localNames.has(symbol.name)) continue;
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
    const spans = syntax ? syntax.statements.filter(s => !ts.isImportDeclaration(s)).map(s => ({
      line: syntax.getLineAndCharacterOfPosition(s.getStart(syntax)).line + 1,
      endLine: syntax.getLineAndCharacterOfPosition(s.end).line + 1,
    })) : (await analyze()).symbols.filter(s => s.line >= 1 && s.endLine <= lines.length);
    const add = (from: number, to: number) => discoveryParts.push({ file, start: from, end: to, text: lines.slice(from - 1, to).join("\n") });
    // A connected helper may not repeat any prose query terms. Its symbol or
    // call anchors supply real source evidence without treating a file header
    // as the implementation. Other windows still compete on query coverage.
    const connectedCandidate = connectedCandidates.find(item => item.path === file);
    for (const line of connectedCandidate?.anchors ?? []) add(Math.max(1, line - 2), Math.min(lines.length, line + 16));
    if (connectedCandidate && (connectedCandidate.roles.some(role => role !== "implementation") || (connectedCandidate.semanticScore ?? 0) > 40)) {
      for (const span of spans.slice(0, 4)) add(span.line, Math.min(span.endLine, span.line + 20));
    }
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
  const documentLimit = mixedDocuments || isUiOrientationQuery(query) ? Math.floor(limit * .3) : limit;
  // Keep quoted/compound keys ahead of generic literals, then prefer windows
  // covering the rest of the question over the first incidental occurrence.
  const literalRank = (part: Excerpt) => literals.findIndex(literal => part.text.normalize("NFC").toLowerCase().includes(literal));
  const coverage = (part: Excerpt) => [...new Set(searchTerms(part.text))].filter(term => terms.has(term)).length;
  documentPassages.sort((a,b)=>coverage(b)-coverage(a) || Number(requestedFiles.has(b.file))-Number(requestedFiles.has(a.file)) || a.file.localeCompare(b.file));
  literalParts.sort((a,b)=>literalRank(a)-literalRank(b) || coverage(b)-coverage(a));
  identifierParts.sort((a,b)=>Number(coverageFiles.has(b.file))-Number(coverageFiles.has(a.file)) || coverage(b)-coverage(a));
  let documentBytes = 0;
  // Topic/search/graph candidates need the same allowance as heading previews.
  const isDocument = (part: Excerpt) => (documentFiles.has(part.file) || /\.(?:md|mdx|rst|txt)$/i.test(part.file))
    && !requestedFiles.has(part.file);
  // Preserve the existing exact-name priority before adding scoped usage windows.
  for (const definition of [...documentPassages, ...priorityParts, ...definitions, ...literalParts, ...identifierParts, ...scopedParts]) {
    for (const part of uncoveredRanges(definition, candidates)) {
      const size = bytes(render(part)) + 2;
      if (size <= available && (!isDocument(part) || documentBytes + size <= documentLimit)) {
        candidates.push(part); available -= size;
        if (isDocument(part)) documentBytes += size;
      }
    }
  }
  // IDF across windows downweights ubiquitous identifiers; marginal coverage
  // reduces repetitive snippets while keeping some evidence for repeated terms.
  const remaining = discoveryParts.map(part => ({ part, words: new Set(searchTerms(part.text)), size: bytes(render(part)) + 2 }));
  const weights = new Map([...terms].map(term => [term, 1 + Math.log(1 + remaining.length / (1 + remaining.filter(item => item.words.has(term)).length))]));
  const covered = new Set(candidates.flatMap(part => searchTerms(part.text)));
  const selectedBytes = new Map<string, number>();
  const coveredRoles = new Set<string>();
  const roles = (part: Pick<Excerpt, "file">): string[] => [...new Set([
    ...connectedCandidates.find(item => item.path === part.file)?.roles ?? [],
    ...(/(?:^|\/)(?:[^/]*config[^/]*|package\.json|pyproject\.toml)$|\.(?:ya?ml|toml)$/i.test(part.file) ? ["configuration"] : []),
    ...(/(?:^|\/)(?:types|schemas?|contracts?)(?:[./-]|$)/i.test(part.file) ? ["contract"] : []),
  ])];
  for (const part of candidates) for (const role of roles(part)) coveredRoles.add(role);
  for (const part of candidates) selectedBytes.set(part.file, (selectedBytes.get(part.file) ?? 0) + bytes(render(part)));
  while (remaining.length && available > 0) {
    let best = -1, bestScore = 0;
    let bestParts: Excerpt[] = [], bestSize = 0;
    for (let i = 0; i < remaining.length; i++) {
      const { part } = remaining[i];
      const parts = uncoveredRanges(part, candidates);
      const size = parts.reduce((sum, item) => sum + bytes(render(item)) + 2, 0);
      if (!parts.length || size > available || (isDocument(part) && documentBytes + size > documentLimit)) continue;
      const unchanged = parts.length === 1 && parts[0].start === part.start && parts[0].end === part.end;
      const words = unchanged ? remaining[i].words : new Set(parts.flatMap(item => searchTerms(item.text)));
      let gain = [...terms].reduce((n, term) => n + (words.has(term) ? weights.get(term)! * (covered.has(term) ? .25 : 1) : 0), 0);
      const linkedRoles = roles(part).filter(role => role !== "implementation");
      if (linkedRoles.some(role => !coveredRoles.has(role))) gain += 5;
      // Reserve an opportunity for a facet's implementation even when another
      // file has already spent the query-term novelty bonus on incidental prose.
      const candidate = connectedCandidates.find(item => item.path === part.file);
      if (!selectedBytes.has(part.file) && candidate?.reason.split("; ").some(reason => reason.startsWith("facet:") && words.has(reason.slice(6)))) gain += 3;
      if (!selectedBytes.has(part.file) && gain > 0 && candidate?.reason.split("; ").includes("path topics")) gain += 3;
      if (!selectedBytes.has(part.file) && candidate?.reason.split("; ").some(reason => reason.startsWith("graph: imported by ") && selectedBytes.has(reason.slice("graph: imported by ".length)))) gain += 3;
      // Strong semantic-only implementations need a first excerpt even when
      // the user's paraphrase has no literal overlap with the source.
      if (!selectedBytes.has(part.file) && (candidate?.semanticScore ?? 0) > 40) gain += 2;
      // Retain control-flow predicates with their surrounding source; this is a
      // packing hint, not a claim that a particular predicate is a constraint.
      if (connectedCandidates.length && gain > 0 && parts.some(item => /\b(?:if|throw|assert|reject)\b/.test(item.text))) gain *= 1.15;
      // Keep the retriever's ordering as a prior; otherwise a rare incidental
      // word in a lower-ranked UI/test file can displace implementation evidence.
      // A large first-ranked file must not monopolize a cross-module question.
      // This is a soft diversity prior; strong evidence can still reuse a file.
      const repetition = 1 + (selectedBytes.get(part.file) ?? 0) / Math.max(512, limit / 4);
      const score = gain * (filePriors.get(part.file) ?? .5) / (Math.sqrt(size) * repetition);
      if (score > bestScore) { best = i; bestScore = score; bestParts = parts; bestSize = size; }
    }
    if (best < 0) break;
    const next = remaining.splice(best, 1)[0];
    candidates.push(...bestParts); available -= bestSize;
    if (isDocument(next.part)) documentBytes += bestSize;
    selectedBytes.set(next.part.file, (selectedBytes.get(next.part.file) ?? 0) + bestSize);
    for (const part of bestParts) for (const term of searchTerms(part.text)) covered.add(term);
    for (const role of roles(next.part)) coveredRoles.add(role);
  }
  for (const part of smallDependencies) {
    const cost = bytes(render(part)) + 2;
    if (cost <= available && (!isDocument(part) || documentBytes + cost <= documentLimit)
      && !candidates.some(item => item.file === part.file)) {
      candidates.push(part); available -= cost;
      if (isDocument(part)) documentBytes += cost;
    }
  }
  // Coalesce overlapping/adjacent ranges using the original snapshot. This also
  // makes a function included through multiple targets appear only once.
  const merged: Excerpt[] = [];
  for (const file of new Set(candidates.map(item => item.file))) {
    for (const part of candidates.filter(item => item.file === file).sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last?.file === file && part.start <= last.end + 1) {
        const uncovered = part.text.split("\n").slice(Math.max(0,last.end - part.start + 1));
        if (uncovered.length) last.text += "\n" + uncovered.join("\n");
        last.end = Math.max(last.end, part.end);
      } else merged.push({ ...part });
    }
  }
  const noticeText = notices.join("\n");
  const partialOmissions = omitted.filter(value => !merged.some(part => value === `${part.file}: partial; unreturned lines omitted`
    && part.start === 1 && part.end === snapshots.get(part.file)!.split("\n").length));
  const info = [...notices, ...partialOmissions.map(value => `Omitted: ${value}`)].join("\n");
  const footer = bytes(info) <= 650 ? info : [
    bytes(noticeText) <= 400 ? noticeText : [
      ...notices.filter(notice => notice.startsWith("Discovery used") || notice.startsWith("Discovery index:") || /stale|empty|refresh/i.test(notice)).slice(0, 2),
      "Additional discovery diagnostics omitted; narrow query/targets for detail.",
    ].join("\n"),
    "Some targets or lines omitted. Narrow query/targets or increase max_tokens; verify scope with native search.",
  ].filter(Boolean).join("\n");
  if (connectedCandidates.length) {
    const missing = ["implementation", "caller", "dependency", "test"].filter(role => !merged.some(part => roles(part).includes(role as never)));
    if (missing.length) notices.push(`Evidence not returned for: ${missing.join(", ")}; this is not proof of absence.`);
  }
  const summary = notices.at(-1)?.startsWith("Evidence not returned") ? notices.at(-1) : undefined;
  const coverageNotice = adaptive ? `Retrieval: ${intent}; ${rolesClassified ? "hybrid + structural relations" : "exact/lexical + configured semantic"}. Relations are structural/textual, not compiler-resolved.\nEvidence: ${["implementation", "caller", "dependency", "contract", "configuration", "test"].map(role => `${role}=${merged.some(part => roles(part).includes(role)) ? "returned" : targets.some(target => roles(target).includes(role)) ? "omitted" : rolesClassified ? "unavailable" : "unclassified"}`).join(", ")}. Unclassified roles were not evaluated. Unavailable is not proof of absence.` : undefined;
  const text = ["Source evidence (only the indicated ranges are included):", coverageNotice, ...merged.map(render), riskNotice, footer, summary,
    !merged.length ? "No source fit or matched. Try exact file/line targets or native search." : ""].filter(Boolean).join("\n\n");
  return { text, ranges: merged, hashes: Object.fromEntries([...snapshots].map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")])),
    notices: [coverageNotice, riskNotice, footer, summary].filter((value): value is string => !!value), complete: true,
    settings: JSON.stringify({ version: 33, adaptive, intent, connected, risks, preset: options.retrievalPreset ?? "balanced", rerank: process.env.CONTEXTPRO_CHAT_RERANK === "true",
      embedding: `${getProvider()}:${getEmbedModelName()}`, chat: options.targets?.length ? "unused" : await chatModelIdentity(options.rootDir) }) };
}
