// Structured git diff output with affected symbols and files
// FEATURE: Diff — change awareness for agents without manual git commands

import { exec } from "child_process";
import { promisify } from "util";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import { resolve } from "path";

const execAsync = promisify(exec);

export interface DiffOptions {
  rootDir: string;
  since?: string;
  branch?: string;
  file?: string;
}

interface FileDiff {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

async function runGitDiff(rootDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execAsync(`git diff ${args.join(" ")}`, { cwd: rootDir, timeout: 15000, maxBuffer: 1024 * 512 });
    return stdout;
  } catch (err: any) {
    return err.stdout ?? "";
  }
}

async function getChangedFiles(rootDir: string, diffArgs: string[]): Promise<FileDiff[]> {
  try {
    const { stdout } = await execAsync(`git diff --numstat ${diffArgs.join(" ")}`, { cwd: rootDir, timeout: 10000 });
    return stdout.trim().split("\n").filter((l) => l.trim()).map((line) => {
      const [add, del, ...pathParts] = line.split("\t");
      return {
        path: pathParts.join("\t"),
        status: "modified",
        additions: parseInt(add, 10) || 0,
        deletions: parseInt(del, 10) || 0,
      };
    });
  } catch {
    return [];
  }
}

async function getUntrackedFiles(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git ls-files --others --exclude-standard", { cwd: rootDir, timeout: 5000 });
    return stdout.trim().split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

async function getAffectedSymbols(rootDir: string, filePath: string): Promise<string[]> {
  const fullPath = resolve(rootDir, filePath);
  if (!isSupportedFile(fullPath)) return [];
  try {
    const analysis = await analyzeFile(fullPath);
    return flattenSymbols(analysis.symbols).map((s) => `${s.kind}: ${s.name} (L${s.line})`);
  } catch {
    return [];
  }
}

export async function getDiff(options: DiffOptions): Promise<string> {
  const diffArgs: string[] = [];

  if (options.file) {
    diffArgs.push("--", options.file);
  } else if (options.branch) {
    diffArgs.push(`${options.branch}...HEAD`);
  } else if (options.since) {
    diffArgs.push(options.since);
  }

  const changedFiles = await getChangedFiles(options.rootDir, diffArgs);
  const untracked = !options.since && !options.branch ? await getUntrackedFiles(options.rootDir) : [];

  if (changedFiles.length === 0 && untracked.length === 0) {
    return "No changes detected.";
  }

  const lines: string[] = [];
  const totalAdd = changedFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = changedFiles.reduce((s, f) => s + f.deletions, 0);

  lines.push(`=== Changes ${options.since ? `since ${options.since}` : options.branch ? `vs ${options.branch}` : "(working tree)"} ===`);
  lines.push(`${changedFiles.length} files changed, +${totalAdd} -${totalDel} lines`);
  if (untracked.length > 0) lines.push(`${untracked.length} new untracked files`);
  lines.push("");

  lines.push("--- Modified Files ---");
  for (const f of changedFiles) {
    lines.push(`  ${f.path} (+${f.additions} -${f.deletions})`);

    const symbols = await getAffectedSymbols(options.rootDir, f.path);
    if (symbols.length > 0 && symbols.length <= 10) {
      for (const sym of symbols) lines.push(`    ${sym}`);
    } else if (symbols.length > 10) {
      for (const sym of symbols.slice(0, 8)) lines.push(`    ${sym}`);
      lines.push(`    ... and ${symbols.length - 8} more symbols`);
    }
  }

  if (untracked.length > 0) {
    lines.push("");
    lines.push("--- New Files ---");
    for (const f of untracked.slice(0, 20)) lines.push(`  + ${f}`);
    if (untracked.length > 20) lines.push(`  ... and ${untracked.length - 20} more`);
  }

  if (options.file) {
    const rawDiff = await runGitDiff(options.rootDir, diffArgs);
    if (rawDiff) {
      lines.push("");
      lines.push("--- Diff ---");
      lines.push(rawDiff.slice(0, 5000));
    }
  }

  return lines.join("\n");
}
