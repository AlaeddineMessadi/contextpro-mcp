// Literal and regex string search across the indexed project file set
// FEATURE: Grep — fast literal lookups complementing semantic and identifier search

import { readFile } from "fs/promises";
import { resolve } from "path";
import { walkDirectory } from "../core/walker.js";
import { resolveProjectPath } from "../core/path-guard.js";

export interface GrepOptions {
  rootDir: string;
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  targetPath?: string;
  glob?: string;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
  maxFileBytes?: number;
  contextChars?: number;
  contextLines?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  context: string;
  surrounding?: Array<{ line: number; text: string }>;
}

interface GrepResult {
  matches: GrepMatch[];
  filesScanned: number;
  filesMatched: number;
  truncated: boolean;
  truncatedReason: string | null;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
}

const DEFAULT_MAX_PER_FILE = 10;
const DEFAULT_MAX_TOTAL = 200;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_CONTEXT_CHARS = 160;
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".webm", ".avi",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".bin", ".exe", ".dll", ".dylib", ".so",
  ".db", ".sqlite", ".sqlite3",
]);

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldSkipExtension(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function compilePattern(options: GrepOptions): RegExp {
  const flags = options.caseSensitive ? "g" : "gi";
  if (options.regex) {
    // Reject control characters in user-supplied regex sources. They can produce confusing
    // behavior or trip ReDoS in some V8 versions; legitimate code searches never need them.
    if (/[\x00-\x08\x0E-\x1F]/.test(options.pattern)) {
      throw new Error("regex pattern contains control characters (NULL or similar); reject for safety");
    }
    return new RegExp(options.pattern, flags);
  }
  return new RegExp(escapeRegex(options.pattern), flags);
}

const MAX_GLOB_EXPANSION = 1024;

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const inner = pattern.slice(open + 1, close);
  const options: string[] = [];
  let depthInner = 0;
  let buffer = "";
  for (const ch of inner) {
    if (ch === "{") {
      depthInner++;
      buffer += ch;
    } else if (ch === "}") {
      depthInner--;
      buffer += ch;
    } else if (ch === "," && depthInner === 0) {
      options.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  options.push(buffer);
  const expansions: string[] = [];
  for (const option of options) {
    for (const tail of expandBraces(suffix)) {
      if (expansions.length >= MAX_GLOB_EXPANSION) return expansions;
      expansions.push(`${prefix}${option}${tail}`);
    }
  }
  const out: string[] = [];
  for (const expanded of expansions) {
    if (out.length >= MAX_GLOB_EXPANSION) break;
    for (const inner of expandBraces(expanded)) {
      if (out.length >= MAX_GLOB_EXPANSION) break;
      out.push(inner);
    }
  }
  return out;
}

function globPartToRegex(part: string): string {
  let regex = "";
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (ch === "*") {
      if (part[i + 1] === "*") {
        const next = part[i + 2];
        if (next === "/" || next === undefined) {
          regex += "(?:.*/)?";
          i += next === "/" ? 2 : 1;
        } else {
          regex += ".*";
          i++;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if ("./+^$()|[]\\".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  return regex;
}

function splitGlobInput(input: string): string[] {
  const out: string[] = [];
  let buffer = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "{") {
      depth++;
      buffer += ch;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      buffer += ch;
    } else if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (buffer.length > 0) {
        out.push(buffer);
        buffer = "";
      }
    } else {
      buffer += ch;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

function matchesGlob(relativePath: string, glob: string | undefined): boolean {
  if (!glob || glob.trim().length === 0) return true;
  const trimmed = glob.trim();
  const expanded = splitGlobInput(trimmed).flatMap((part) => expandBraces(part));
  if (expanded.length === 0) return true;
  if (expanded.length >= MAX_GLOB_EXPANSION) {
    throw new Error(`Glob "${trimmed}" expands to >= ${MAX_GLOB_EXPANSION} sub-patterns (DoS guard). Simplify the brace expression — e.g., split into multiple comma-separated globs without nested {a,b}{c,d}...`);
  }
  const candidates = new Set<string>();
  for (const part of expanded) {
    candidates.add(part);
    if (!part.startsWith("**/") && !part.includes("/")) {
      candidates.add(`**/${part}`);
    }
  }
  const regexSource = [...candidates]
    .map((part) => `^${globPartToRegex(part)}$`)
    .join("|");
  return new RegExp(regexSource).test(relativePath);
}

async function scanFile(
  fullPath: string,
  relativePath: string,
  pattern: RegExp,
  maxPerFile: number,
  maxFileBytes: number,
  contextChars: number,
  contextLines: number,
): Promise<GrepMatch[]> {
  let content: string;
  try {
    const buffer = await readFile(fullPath);
    if (buffer.byteLength > maxFileBytes) return [];
    content = buffer.toString("utf-8");
  } catch {
    return [];
  }

  const matches: GrepMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxPerFile) break;
    pattern.lastIndex = 0;
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const half = Math.floor(contextChars / 2);
    const start = Math.max(0, match.index - half);
    const end = Math.min(lines[i].length, match.index + match[0].length + half);
    const snippet = (start > 0 ? "…" : "") + lines[i].slice(start, end) + (end < lines[i].length ? "…" : "");
    matches.push({
      path: relativePath,
      line: i + 1,
      column: match.index + 1,
      context: snippet.trim().substring(0, contextChars + 4),
      surrounding: contextLines ? lines
        .slice(Math.max(0, i - contextLines), i + contextLines + 1)
        .map((text, offset) => ({
          line: Math.max(0, i - contextLines) + offset + 1,
          text: text.length > contextChars ? text.slice(0, contextChars) + "…" : text,
        })) : undefined,
    });
  }
  return matches;
}

export async function grepProject(options: GrepOptions): Promise<string> {
  if (!options.pattern || options.pattern.trim().length === 0) {
    return "Error: pattern must be a non-empty string.";
  }
  let pattern: RegExp;
  try {
    pattern = compilePattern(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: invalid ${options.regex ? "regex" : "pattern"} "${options.pattern}": ${message}`;
  }

  const maxPerFile = Math.max(1, options.maxMatchesPerFile ?? DEFAULT_MAX_PER_FILE);
  const maxTotal = Math.max(1, options.maxTotalMatches ?? DEFAULT_MAX_TOTAL);
  const maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const contextChars = Math.max(40, Math.min(400, options.contextChars ?? DEFAULT_CONTEXT_CHARS));
  const contextLines = Math.max(0, Math.min(10, Math.floor(options.contextLines ?? 0)));

  const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
  let candidates;
  try {
    candidates = entries
      .filter((e) => !e.isDirectory && !shouldSkipExtension(e.relativePath) && matchesGlob(e.relativePath, options.glob));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }

  // Helpful warning: if a glob was provided and matched nothing, suggest src-layout alternatives.
  if (options.glob && candidates.length === 0) {
    const suggestions: string[] = [];
    const trimmedGlob = options.glob.trim();
    for (const prefix of ["src", "app", "lib", "packages"]) {
      const candidate = trimmedGlob.startsWith(prefix + "/") ? null : `${prefix}/${trimmedGlob}`;
      if (!candidate) continue;
      try {
        const wouldMatch = entries.some((e) => !e.isDirectory && matchesGlob(e.relativePath, candidate));
        if (wouldMatch) suggestions.push(candidate);
      } catch {
        // Skip suggestions that fail to parse — the user is on their own for that input.
      }
    }
    const suggestionHint = suggestions.length > 0
      ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`
      : "";
    return `grep: 0 matches — glob "${options.glob}" matched 0 files in the indexed set.${suggestionHint} Tip: drop the glob to scan all files, or use **/ for recursive matches.`;
  }

  const result: GrepResult = {
    matches: [],
    filesScanned: 0,
    filesMatched: 0,
    truncated: false,
    truncatedReason: null,
    pattern: options.pattern,
    regex: options.regex === true,
    caseSensitive: options.caseSensitive === true,
  };

  for (const entry of candidates) {
    if (result.matches.length >= maxTotal) {
      result.truncated = true;
      result.truncatedReason = `Reached max_total_matches (${maxTotal})`;
      break;
    }
    result.filesScanned++;
    const fullPath = resolveProjectPath(options.rootDir, entry.relativePath, "candidate file");
    const fileMatches = await scanFile(fullPath, entry.relativePath, pattern, maxPerFile, maxFileBytes, contextChars, contextLines);
    if (fileMatches.length === 0) continue;
    result.filesMatched++;
    const remaining = maxTotal - result.matches.length;
    if (fileMatches.length > remaining) {
      result.matches.push(...fileMatches.slice(0, remaining));
      result.truncated = true;
      result.truncatedReason = `Reached max_total_matches (${maxTotal})`;
      break;
    }
    result.matches.push(...fileMatches);
  }

  return formatGrepResult(result, candidates.length);
}

function formatGrepResult(result: GrepResult, totalCandidates: number): string {
  if (result.matches.length === 0) {
    const hint = !result.regex && /[|\\]/.test(result.pattern)
      ? "\nPattern was searched literally. If you intended alternation or regex escapes, pass regex: true."
      : "";
    return `grep: 0 matches for ${result.regex ? "regex" : "literal"} "${result.pattern}" (scanned ${result.filesScanned} of ${totalCandidates} files, case-${result.caseSensitive ? "sensitive" : "insensitive"})${hint}`;
  }

  const grouped = new Map<string, GrepMatch[]>();
  for (const match of result.matches) {
    const list = grouped.get(match.path) ?? [];
    list.push(match);
    grouped.set(match.path, list);
  }

  const header = `grep: ${result.matches.length} match(es) in ${result.filesMatched} file(s) (scanned ${result.filesScanned} of ${totalCandidates}; ${result.regex ? "regex" : "literal"}; case-${result.caseSensitive ? "sensitive" : "insensitive"})`;
  const lines = [header, ""];
  for (const [path, matches] of grouped) {
    lines.push(`${path}:`);
    const displayed = new Map<number, string>();
    for (const match of matches) {
      for (const neighbor of match.surrounding ?? []) {
        displayed.set(neighbor.line, `  L${neighbor.line}-  ${neighbor.text}`);
      }
    }
    for (const match of matches) {
      displayed.set(match.line, `  L${match.line}:${match.column}  ${match.context}`);
    }
    lines.push(...[...displayed].sort(([a], [b]) => a - b).map(([, text]) => text));
  }
  if (result.truncated && result.truncatedReason) {
    lines.push("");
    lines.push(`⚠ Output truncated: ${result.truncatedReason}. Narrow your pattern or pass max_total_matches/glob to refine.`);
  }
  return lines.join("\n");
}
