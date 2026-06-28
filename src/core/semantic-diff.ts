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
import { analyzeContent, flattenSymbols, isSupportedFile, type SymbolLocation } from "./parser.js";
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

function symbolKey(symbol: SymbolLocation): string {
  // Include parent context so a class method (Foo.bar) is keyed distinctly from a
  // top-level bar — and so method add/remove/modify is reported as a method change,
  // not collapsed into a coarse change on the enclosing class.
  return `${symbol.kind}:${symbol.parentName ? `${symbol.parentName}.` : ""}${symbol.name}`;
}

function displayName(symbol: SymbolLocation): string {
  return symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name;
}

// Languages where leading indentation is syntactically significant — there, the
// indentation level is part of the meaning and must survive into the fingerprint.
const INDENT_SIGNIFICANT_EXTS = new Set([".py", ".pyi", ".yaml", ".yml", ".coffee", ".hs", ".elm", ".fs", ".nim"]);

/**
 * A formatting-insensitive — but NOT whitespace-blind — view of a symbol's source
 * span. Stripping ALL whitespace would mask semantically meaningful whitespace: a
 * string-literal change `"a b"` → `"ab"`, or Python indentation that moves a
 * statement into/out of a block, would read as "no change".
 *
 * For indentation-significant languages we keep newlines and per-line indent DEPTH
 * (so block structure counts) while collapsing interior whitespace runs. For brace/
 * free-form languages indentation is not semantic, so we collapse the whole span to
 * one normalized token stream — that way `f(){return 1;}` and a multi-line
 * `f() {\n  return 1;\n}` fingerprint identically, but a change inside a string or
 * identifier still differs (runs are collapsed, not stripped).
 */
function bodyFingerprint(symbol: SymbolLocation, lines: string[], path: string): string {
  const start = Math.max(0, symbol.line - 1);
  const end = Math.min(lines.length, Math.max(symbol.endLine, symbol.line));
  const span = lines.slice(start, end);
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();

  if (INDENT_SIGNIFICANT_EXTS.has(ext)) {
    return span
      .map((line) => {
        const indent = (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "  ").length;
        const depth = Math.floor(indent / 2);
        const content = line.trim().replace(/[ \t]+/g, " ");
        return content.length > 0 ? `${"⁣".repeat(depth)}${content}` : "";
      })
      .filter((line) => line.length > 0)
      .join("\n");
  }

  // Free-form languages: normalize FORMATTING whitespace without touching
  // whitespace inside literals. We only:
  //   - trim each line and drop blank lines (so multi-line vs single-line layout
  //     and trailing whitespace don't matter), joining with a single space, then
  //   - remove whitespace that sits ADJACENT TO PUNCTUATION (so `(){`, `() {`,
  //     `; }` all match).
  // Crucially we do NOT collapse interior whitespace RUNS between word characters,
  // so a change inside a string literal — `"a  b"` → `"a b"`, or `"a b"` → `"ab"` —
  // still alters the fingerprint instead of being silently masked. (This can't be
  // perfect without full tokenization, but it no longer hides intra-literal edits.)
  const joined = span.map((line) => line.trim()).filter((line) => line.length > 0).join(" ");
  return joined.replace(/[ \t]*([^\w\s])[ \t]*/g, "$1");
}

interface DiffEntry {
  status: string;
  /** New-side path (what to read from the working tree). */
  path: string;
  /** Old-side path for renames/copies — where to read the OLD blob from. */
  oldPath?: string;
}

async function gitDiffNameStatus(rootDir: string, ref: string): Promise<DiffEntry[]> {
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
        const parts = line.split("\t");
        const status = parts[0].trim();
        // Rename (R###) and copy (C###) records carry TWO paths: old then new.
        // The new-side path is what exists in the working tree; the old-side path
        // is where the OLD blob lives. Without this, the tab-joined "old\tnew"
        // path breaks both `git show <ref>:<path>` and the working-tree read.
        if (/^[RC]\d*/.test(status) && parts.length >= 3) {
          return { status, oldPath: parts[1].trim(), path: parts[2].trim() };
        }
        return { status, path: parts.slice(1).join("\t").trim() };
      });
  } catch (error) {
    // git exits 128 for an unresolvable ref (a typo'd baseline like `mian`). An
    // EMPTY diff exits 0, so reaching here means the ref/command genuinely failed —
    // surface it instead of silently reporting "no changes" and skipping review.
    throw new Error(`semantic_diff: could not diff against '${ref}' — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
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
  oldSymbols: SymbolLocation[],
  oldLines: string[],
  newSymbols: SymbolLocation[],
  newLines: string[],
  path: string,
): SemanticSymbolChange[] {
  const changes: SemanticSymbolChange[] = [];
  const oldByKey = new Map(oldSymbols.map((s) => [symbolKey(s), s]));
  const newByKey = new Map(newSymbols.map((s) => [symbolKey(s), s]));

  for (const newSym of newSymbols) {
    const key = symbolKey(newSym);
    const oldSym = oldByKey.get(key);
    if (!oldSym) {
      changes.push({ name: displayName(newSym), kind: newSym.kind, change: "added", line: newSym.line, signature: newSym.signature });
      continue;
    }
    // Compare formatting-insensitive body fingerprints. The signature text is itself
    // formatting-sensitive (tree-sitter captures it differently across layouts), so
    // relying on it would flag pure reformatting; the fingerprint already includes
    // the signature line, so a real signature change still shows up as a body change.
    const oldBody = bodyFingerprint(oldSym, oldLines, path);
    const newBody = bodyFingerprint(newSym, newLines, path);
    if (oldBody !== newBody) {
      changes.push({ name: displayName(newSym), kind: newSym.kind, change: "modified", line: newSym.line, signature: newSym.signature });
    } else if (oldSym.line !== newSym.line) {
      changes.push({ name: displayName(newSym), kind: newSym.kind, change: "moved", line: newSym.line, signature: newSym.signature });
    }
  }

  for (const oldSym of oldSymbols) {
    if (!newByKey.has(symbolKey(oldSym))) {
      changes.push({ name: displayName(oldSym), kind: oldSym.kind, change: "removed", line: oldSym.line, signature: oldSym.signature });
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
  const untracked: DiffEntry[] = (await gitUntrackedFiles(rootDir))
    .filter((path) => !trackedPaths.has(path))
    .map((path) => ({ status: "A", path }));
  const entries = [...tracked, ...untracked].filter((e) => isSupportedFile(e.path));

  const files: SemanticFileDiff[] = [];
  for (const entry of entries) {
    const isDelete = entry.status.startsWith("D");
    const isAdd = entry.status.startsWith("A");

    const oldRaw = isAdd ? null : await gitShow(rootDir, ref, entry.oldPath ?? entry.path);
    const newRaw = isDelete ? null : await readWorkingTree(rootDir, entry.path);

    const oldAnalysis = oldRaw != null ? await analyzeContent(entry.oldPath ?? entry.path, oldRaw) : null;
    const newAnalysis = newRaw != null ? await analyzeContent(entry.path, newRaw) : null;

    // Flatten nested symbols (class methods, etc.) so a method change is reported
    // as a method change, not collapsed into a coarse change on its parent class.
    const oldSymbols = oldAnalysis ? flattenSymbols(oldAnalysis.symbols) : [];
    const newSymbols = newAnalysis ? flattenSymbols(newAnalysis.symbols) : [];
    const oldLines = (oldRaw ?? "").split("\n");
    const newLines = (newRaw ?? "").split("\n");

    const symbols = classifyFile(oldSymbols, oldLines, newSymbols, newLines, entry.path);
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
