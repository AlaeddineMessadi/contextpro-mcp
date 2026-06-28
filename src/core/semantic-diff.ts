// semantic_diff — AST-level symbol change detection between git revisions.
//
// FEATURE: A line-based git diff tells an agent which LINES changed; it cannot
// say which SYMBOLS changed, and it flags pure reformatting as a change. This
// computes, per changed file, which symbols were added / removed / modified
// (body actually changed) / moved (only relocated), by parsing BOTH the old blob
// and the new content with tree-sitter and diffing the symbol sets. Output is
// token-lean and pairs with change_impact/blast_radius (what changed → what it
// affects). Reformatting that leaves symbol bodies semantically identical is
// intentionally ignored.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { analyzeContent, isSupportedFile, type CodeSymbol } from "./parser.js";
import { resolveProjectPath } from "./path-guard.js";

const execFileAsync = promisify(execFile);

export type SymbolChange = "added" | "removed" | "modified" | "moved";

export interface SemanticSymbolChange {
  name: string;
  kind: string;
  change: SymbolChange;
  /** New-side line (or old-side line for removals). */
  line: number;
  signature: string | null;
}

export interface SemanticFileDiff {
  path: string;
  status: "added" | "removed" | "modified";
  symbols: SemanticSymbolChange[];
}

export interface SemanticDiffSummary {
  filesChanged: number;
  added: number;
  removed: number;
  modified: number;
  moved: number;
}

export interface SemanticDiffResult {
  ref: string;
  files: SemanticFileDiff[];
  summary: SemanticDiffSummary;
}

export interface SemanticDiffOptions {
  /** Git ref to diff the working tree against (e.g. "HEAD", "main"). */
  since?: string;
}

function symbolKey(symbol: CodeSymbol): string {
  return `${symbol.kind}:${symbol.name}`;
}

/**
 * A whitespace-free view of a symbol's source span, so two formattings of the same
 * code hash identically and reformatting is not reported as a modification. We strip
 * ALL whitespace (not just collapse runs) because reformatting changes spacing
 * around punctuation too (`(){` vs `() {`), which a collapse-to-single-space would
 * still treat as different.
 */
function bodyFingerprint(symbol: CodeSymbol, lines: string[]): string {
  const start = Math.max(0, symbol.line - 1);
  const end = Math.min(lines.length, Math.max(symbol.endLine, symbol.line));
  return lines.slice(start, end).join("\n").replace(/\s+/g, "");
}

async function gitDiffNameStatus(rootDir: string, ref: string): Promise<Array<{ status: string; path: string }>> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-status", ref], {
      cwd: rootDir,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status.trim(), path: rest.join("\t").trim() };
      });
  } catch {
    return [];
  }
}

async function gitUntrackedFiles(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function gitShow(rootDir: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
      cwd: rootDir,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function readWorkingTree(rootDir: string, path: string): Promise<string | null> {
  try {
    const full = resolveProjectPath(rootDir, path, "semantic-diff file");
    return await readFile(full, "utf-8");
  } catch {
    return null;
  }
}

function classifyFile(
  oldSymbols: CodeSymbol[],
  oldLines: string[],
  newSymbols: CodeSymbol[],
  newLines: string[],
): SemanticSymbolChange[] {
  const changes: SemanticSymbolChange[] = [];
  const oldByKey = new Map(oldSymbols.map((s) => [symbolKey(s), s]));
  const newByKey = new Map(newSymbols.map((s) => [symbolKey(s), s]));

  for (const newSym of newSymbols) {
    const key = symbolKey(newSym);
    const oldSym = oldByKey.get(key);
    if (!oldSym) {
      changes.push({ name: newSym.name, kind: newSym.kind, change: "added", line: newSym.line, signature: newSym.signature });
      continue;
    }
    // Compare whitespace-free body fingerprints only. The signature text is itself
    // formatting-sensitive (tree-sitter captures it differently across layouts), so
    // relying on it would flag pure reformatting; the fingerprint already includes
    // the signature line, so a real signature change still shows up as a body change.
    const oldBody = bodyFingerprint(oldSym, oldLines);
    const newBody = bodyFingerprint(newSym, newLines);
    if (oldBody !== newBody) {
      changes.push({ name: newSym.name, kind: newSym.kind, change: "modified", line: newSym.line, signature: newSym.signature });
    } else if (oldSym.line !== newSym.line) {
      changes.push({ name: newSym.name, kind: newSym.kind, change: "moved", line: newSym.line, signature: newSym.signature });
    }
  }

  for (const oldSym of oldSymbols) {
    if (!newByKey.has(symbolKey(oldSym))) {
      changes.push({ name: oldSym.name, kind: oldSym.kind, change: "removed", line: oldSym.line, signature: oldSym.signature });
    }
  }

  return changes;
}

export async function computeSemanticDiff(
  rootDir: string,
  options: SemanticDiffOptions = {},
): Promise<SemanticDiffResult> {
  const ref = options.since ?? "HEAD";
  const tracked = await gitDiffNameStatus(rootDir, ref);
  // `git diff` omits untracked files, but "what changed since main" must include
  // brand-new files an agent just created — surface them as additions.
  const trackedPaths = new Set(tracked.map((e) => e.path));
  const untracked = (await gitUntrackedFiles(rootDir))
    .filter((path) => !trackedPaths.has(path))
    .map((path) => ({ status: "A", path }));
  const entries = [...tracked, ...untracked].filter((e) => isSupportedFile(e.path));

  const files: SemanticFileDiff[] = [];
  for (const entry of entries) {
    const isDelete = entry.status.startsWith("D");
    const isAdd = entry.status.startsWith("A");

    const oldRaw = isAdd ? null : await gitShow(rootDir, ref, entry.path);
    const newRaw = isDelete ? null : await readWorkingTree(rootDir, entry.path);

    const oldAnalysis = oldRaw != null ? await analyzeContent(entry.path, oldRaw) : null;
    const newAnalysis = newRaw != null ? await analyzeContent(entry.path, newRaw) : null;

    const oldSymbols = oldAnalysis?.symbols ?? [];
    const newSymbols = newAnalysis?.symbols ?? [];
    const oldLines = (oldRaw ?? "").split("\n");
    const newLines = (newRaw ?? "").split("\n");

    const symbols = classifyFile(oldSymbols, oldLines, newSymbols, newLines);
    if (symbols.length === 0 && !isAdd && !isDelete) continue;

    files.push({
      path: entry.path,
      status: isAdd ? "added" : isDelete ? "removed" : "modified",
      symbols,
    });
  }

  const summary: SemanticDiffSummary = {
    filesChanged: files.length,
    added: 0,
    removed: 0,
    modified: 0,
    moved: 0,
  };
  for (const file of files) {
    for (const sym of file.symbols) summary[sym.change] += 1;
  }

  return { ref, files, summary };
}
