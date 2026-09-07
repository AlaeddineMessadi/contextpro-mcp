// Code commit gatekeeper enforcing 2-line headers, no inline comments
// Validates abstraction rules and creates shadow restore points before writing

import { extname } from "path";
import { captureSource, publishSource, withSourceMutation } from "../core/source-mutation.js";
import { createRestorePoint } from "../git/shadow.js";
import { isSupportedFile } from "../core/parser.js";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";

export interface ProposeCommitOptions {
  rootDir: string;
  filePath: string;
  newContent: string;
  strict?: boolean;
  expectedContentHash?: string;
}

interface ValidationError {
  rule: string;
  message: string;
  line?: number;
  severity: "error" | "warning";
}

function stripBomAndCRLF(content: string): string {
  const noBom = content.startsWith("﻿") ? content.slice(1) : content;
  return noBom.replace(/\r\n/g, "\n");
}

function stripStringsAndComments(line: string): string {
  let result = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < line.length) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\" && i + 1 < line.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inStr = ch; i += 1; continue; }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) break;
    result += ch;
    i += 1;
  }
  return result;
}

function validateHeader(lines: string[], ext: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const commentPrefixes: Record<string, string> = {
    ".ts": "//", ".tsx": "//", ".js": "//", ".jsx": "//",
    ".rs": "//", ".go": "//", ".c": "//", ".cpp": "//",
    ".java": "//", ".cs": "//", ".swift": "//", ".kt": "//",
    ".py": "#", ".rb": "#", ".lua": "--", ".zig": "//",
  };

  const prefix = commentPrefixes[ext];
  if (!prefix) return errors;

  const headerLines = lines.slice(0, 5).filter((l) => l.startsWith(prefix));
  if (headerLines.length < 2) {
    errors.push({
      rule: "header",
      severity: "warning",
      message: `Recommended: 2-line file header. First 2 lines should be ${prefix} comments explaining the file.`,
    });
    return errors;
  }

  if (!headerLines[1].toUpperCase().includes("FEATURE:")) {
    errors.push({
      rule: "feature-tag",
      severity: "warning",
      message: `Recommended: line 2 includes a FEATURE: tag (e.g., "${prefix} FEATURE: Feature Name") to link to feature hubs.`,
    });
  }

  return errors;
}

function validateNoInlineComments(lines: string[], ext: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const isScriptLang = [".py", ".rb"].includes(ext);
  const commentPrefix = isScriptLang ? "#" : "//";

  for (let i = 2; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(commentPrefix) && !trimmed.startsWith("#!") && !trimmed.startsWith("#include")) {
      errors.push({
        rule: "no-comments",
        severity: "warning",
        message: `Comment outside header on line ${i + 1}: ${trimmed.substring(0, 80)}`,
        line: i + 1,
      });
    }
  }

  return errors;
}

function validateAbstraction(lines: string[]): ValidationError[] {
  const errors: ValidationError[] = [];
  let nestingDepth = 0;
  let maxNesting = 0;

  for (let i = 0; i < lines.length; i++) {
    const cleaned = stripStringsAndComments(lines[i]);
    nestingDepth += (cleaned.match(/{/g) || []).length;
    nestingDepth -= (cleaned.match(/}/g) || []).length;
    maxNesting = Math.max(maxNesting, nestingDepth);
  }

  if (maxNesting > 6) {
    errors.push({
      rule: "nesting",
      severity: "warning",
      message: `Nesting depth of ${maxNesting} detected. Maximum recommended is 3-4 levels. Flatten the structure.`,
    });
  }

  if (lines.length > 1000) {
    errors.push({
      rule: "file-length",
      severity: "warning",
      message: `File is ${lines.length} lines. Maximum recommended is 500-1000. Consider splitting.`,
    });
  }

  return errors;
}

export async function proposeCommit(options: ProposeCommitOptions): Promise<string> {
  return withSourceMutation(options.rootDir, () => proposeCommitLocked(options));
}

async function proposeCommitLocked(options: ProposeCommitOptions): Promise<string> {
  const snapshot = captureSource(options.rootDir, options.filePath);
  if (options.expectedContentHash !== undefined && options.expectedContentHash !== snapshot.hash) {
    throw new Error(`Source conflict: ${options.filePath} does not match expectedContentHash. Read current content and retry.`);
  }
  const fullPath = resolveProjectPath(options.rootDir, options.filePath, "filePath");
  const relativePath = toProjectRelativePath(options.rootDir, options.filePath, "filePath");
  const ext = extname(fullPath);
  const normalized = stripBomAndCRLF(options.newContent);
  const lines = normalized.split("\n");
  const allIssues: ValidationError[] = [];

  if (isSupportedFile(fullPath)) {
    allIssues.push(...validateHeader(lines, ext));
    allIssues.push(...validateNoInlineComments(lines, ext));
  }
  allIssues.push(...validateAbstraction(lines));

  const errors = options.strict ? allIssues.map((e) => ({ ...e, severity: "error" as const })) : allIssues;
  const blocking = errors.filter((e) => e.severity === "error");
  if (blocking.length > 0) {
    return [
      `REJECTED: ${blocking.length} blocking issue(s) (strict mode).\n`,
      ...blocking.slice(0, 10).map((e) => `  ❌ [${e.rule}] ${e.message}`),
      blocking.length > 10 ? `  ... and ${blocking.length - 10} more` : "",
      "\nFix issues and resubmit, or call without strict to save with warnings.",
    ].filter(Boolean).join("\n");
  }

  await createRestorePoint(options.rootDir, [relativePath], `Pre-commit: ${relativePath}`);
  await publishSource(options.rootDir, snapshot, normalized);

  const result = [`✅ File saved: ${relativePath}`];
  if (allIssues.length > 0) {
    result.push(`\n⚠ ${allIssues.length} advisory warning(s):`);
    for (const w of allIssues.slice(0, 10)) result.push(`  ⚠ [${w.rule}] ${w.message}`);
    if (allIssues.length > 10) result.push(`  ... and ${allIssues.length - 10} more`);
  }
  result.push(`\nRestore point created. Use restore tools if needed.`);

  return result.join("\n");
}
