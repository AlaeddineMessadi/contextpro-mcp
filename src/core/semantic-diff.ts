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
 * span. String/char literals are EXTRACTED first (in both branches) and replaced
 * with a word-only placeholder, so neither the whitespace-collapse (indent branch)
 * nor the punctuation-strip (free-form branch) can rewrite their contents. The
 * captured literals are appended verbatim, so any in-string edit — "a  b"->"a b",
 * "a - b"->"a-b", "a -b"->"a- b" — still changes the fingerprint, while pure code
 * reformatting does not. For indentation-significant languages we also keep per-line
 * indent DEPTH (block structure is semantic); free-form languages collapse layout.
 */
function bodyFingerprint(symbol: SymbolLocation, lines: string[], path: string): string {
  const start = Math.max(0, symbol.line - 1);
  const end = Math.min(lines.length, Math.max(symbol.endLine, symbol.line));
  const span = lines.slice(start, end);
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();

  const literals: string[] = [];
  // An order-sensitive serialization of captured literals, appended to the
  // fingerprint so an edit INSIDE any literal changes it.
  const tail = (): string => (literals.length > 0 ? "_LITS_" + literals.join("_LITSEP_") : "");

  if (INDENT_SIGNIFICANT_EXTS.has(ext)) {
    // Indentation is semantic here, so we keep per-line structure. Mask single-line
    // literals per line; multiline literals are rare in these languages and fall
    // through to whitespace-collapse (acceptable, documented limitation). Use the
    // EXACT indent width as the depth marker so e.g. 2-space vs 3-space — a real
    // block-level change — produces different fingerprints (no /2 bucketing).
    const body = span
      .map((line) => maskStringLiterals(line, literals))
      .map((line) => {
        const indentRun = line.match(/^[ \t]*/);
        const indent = (indentRun ? indentRun[0] : "").replace(/\t/g, "  ").length;
        const content = line.trim().replace(/[ \t]+/g, " ");
        return content.length > 0 ? "I".repeat(indent) + ">" + content : "";
      })
      .filter((line) => line.length > 0)
      .join("\n");
    return body + tail();
  }

  // Free-form languages: mask literals across the WHOLE span first (joined with
  // newlines), so a MULTILINE template literal is captured as one literal and its
  // contents can't be rewritten by normalization. Then collapse layout (multi-line
  // vs single-line, trailing ws) and strip whitespace adjacent to punctuation
  // (`(){`, `() {`, `; }` all match). Note: regexp literals are NOT masked — telling
  // a `/…/` regex from a `/` division reliably needs full tokenization, so a
  // whitespace-only edit inside a regex literal is a known, narrow blind spot.
  const masked = maskStringLiterals(span.join("\n"), literals);
  const joined = masked.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join(" ");
  return joined.replace(/[ \t]*([^\w\s])[ \t]*/g, "$1") + tail();
}

// A placeholder made of word characters only, so neither whitespace-collapse nor
// punctuation-strip normalization can alter or split it.
function literalPlaceholder(index: number): string {
  return "LIT" + index + "LIT";
}

/**
 * Replace each '…', "…", or `…` literal in `text` with a word-only placeholder,
 * pushing the verbatim literal (quotes included) into `literals`. Escaped quotes
 * inside a literal are handled. The placeholder survives all later normalization;
 * the captured literal is what makes an in-string edit change the fingerprint.
 */
function maskStringLiterals(text: string, literals: string[]): string {
  return text.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, (lit) => {
    const placeholder = literalPlaceholder(literals.length);
    literals.push(lit);
    return placeholder;
  });
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

  // Suppress coarse parent-container "modified" entries when the real change is in
  // a member. A class whose method changed has a different full-body fingerprint
  // and would otherwise be reported as modified ON TOP OF the precise method
  // change, polluting the token-lean member-level summary. If any change targets a
  // descendant (name starts with "<parent>."), drop the parent's own "modified".
  const changedNames = new Set(changes.map((c) => c.name));
  return changes.filter((c) => {
    if (c.change !== "modified") return true;
    const hasChangedMember = [...changedNames].some(
      (other) => other !== c.name && other.startsWith(`${c.name}.`),
    );
    return !hasChangedMember;
  });
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
