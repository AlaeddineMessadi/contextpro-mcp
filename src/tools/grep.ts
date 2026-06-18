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
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  context: string;
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
  const source = options.regex ? options.pattern : escapeRegex(options.pattern);
  return new RegExp(source, flags);
}

function matchesGlob(relativePath: string, glob: string | undefined): boolean {
  if (!glob || glob.trim().length === 0) return true;
  const trimmed = glob.trim();
  const regexSource = trimmed
    .split(/[,\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part
      .replace(/[.+^$()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "@@DOUBLESTAR@@")
      .replace(/\*/g, "[^/]*")
      .replace(/@@DOUBLESTAR@@/g, ".*")
      .replace(/\?/g, ".")
    )
    .map((part) => `^${part}$`)
    .join("|");
  if (regexSource.length === 0) return true;
  return new RegExp(regexSource).test(relativePath);
}

async function scanFile(
  fullPath: string,
  relativePath: string,
  pattern: RegExp,
  maxPerFile: number,
  maxFileBytes: number,
  contextChars: number,
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

  const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
  const candidates = entries
    .filter((e) => !e.isDirectory && !shouldSkipExtension(e.relativePath) && matchesGlob(e.relativePath, options.glob));

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
    const fileMatches = await scanFile(fullPath, entry.relativePath, pattern, maxPerFile, maxFileBytes, contextChars);
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
    return `grep: 0 matches for ${result.regex ? "regex" : "literal"} "${result.pattern}" (scanned ${result.filesScanned} of ${totalCandidates} files, case-${result.caseSensitive ? "sensitive" : "insensitive"})`;
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
    for (const match of matches) {
      lines.push(`  L${match.line}:${match.column}  ${match.context}`);
    }
  }
  if (result.truncated && result.truncatedReason) {
    lines.push("");
    lines.push(`⚠ Output truncated: ${result.truncatedReason}. Narrow your pattern or pass max_total_matches/glob to refine.`);
  }
  return lines.join("\n");
}
