// Map source files to their test files using import graph and naming conventions
// FEATURE: TestMap — which tests cover which code

import { getDB } from "../core/db.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { findTestsForFiles, isTestFile } from "./retrieval-helpers.js";
import { isSupportedFile } from "../core/parser.js";

const execFileAsync = promisify(execFile);

export interface TestMapOptions {
  rootDir: string;
  file?: string;
  symbol?: string;
  changed?: boolean;
}

async function getChangedFiles(rootDir: string): Promise<string[]> {
  try {
    const [{ stdout: unstaged }, { stdout: staged }, { stdout: untracked }] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], { cwd: rootDir, timeout: 5000 }),
      execFileAsync("git", ["diff", "--name-only", "--cached"], { cwd: rootDir, timeout: 5000 }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: rootDir, timeout: 5000 }),
    ]);
    const dirty = [...new Set(`${unstaged}\n${staged}\n${untracked}`.trim().split("\n").filter((l) => l.trim()))]
      .filter(isSourceTarget);
    if (dirty.length > 0) return dirty;
    const { stdout: recent } = await execFileAsync("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: rootDir, timeout: 5000 });
    return [...new Set(recent.trim().split("\n").filter((line) => line.trim()))].filter(isSourceTarget);
  } catch {
    return [];
  }
}

function isSourceTarget(path: string): boolean {
  return !path.startsWith(".contextpro/")
    && !path.startsWith(".contextplus/")
    && !isTestFile(path)
    && isSupportedFile(path);
}

export async function getTestMap(options: TestMapOptions): Promise<string> {
  const db = await getDB(options.rootDir);

  let targetFiles: string[] = [];

  if (options.changed) {
    targetFiles = await getChangedFiles(options.rootDir);
    targetFiles = targetFiles.filter(isSourceTarget);
  } else if (options.file) {
    targetFiles = [options.file];
  } else if (options.symbol) {
    const symbols = db.searchSymbolsByName(options.symbol);
    const fileIds = [...new Set(symbols.map((s) => s.file_id))];
    const allDbFiles = db.getAllFiles();
    targetFiles = fileIds.map((id) => allDbFiles.find((f) => f.id === id)?.path).filter(Boolean) as string[];
  }

  if (targetFiles.length === 0) {
    return options.changed ? "No changed or recently committed source files to map." : "No target files specified. Use file, symbol, or changed parameter.";
  }

  const lines: string[] = [`=== Test Map ===`, ""];

  for (const file of targetFiles) {
    const allTests = await findTestsForFiles(options.rootDir, [file]);

    lines.push(`${file}:`);
    if (allTests.length > 0) {
      for (const test of allTests) {
        lines.push(`  → ${test.path} (${test.reason}, ${Math.round(test.score * 100)}%)`);
      }
    } else {
      lines.push("  ⚠ No tests found");
    }
    lines.push("");
  }

  const totalMapped = targetFiles.length;
  let withTests = 0;
  for (const file of targetFiles) {
    if ((await findTestsForFiles(options.rootDir, [file])).length > 0) withTests++;
  }

  lines.push(`Coverage: ${withTests}/${totalMapped} files have tests`);

  return lines.join("\n");
}
