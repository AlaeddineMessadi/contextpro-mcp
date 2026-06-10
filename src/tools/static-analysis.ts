// Auto-detecting static analysis runner using native linters and compilers
// FEATURE: Lint — runs project-specific linters plus skill score checking

import { execFile } from "child_process";
import { readFile, stat as fsStat } from "fs/promises";
import { resolve, extname } from "path";
import { promisify } from "util";
import { walkDirectory } from "../core/walker.js";
import { resolveProjectPath } from "../core/path-guard.js";

const execFileAsync = promisify(execFile);

export interface StaticAnalysisOptions {
  rootDir: string;
  targetPath?: string;
}

interface LintResult {
  tool: string;
  output: string;
  exitCode: number;
}

interface LinterConfig {
  name: string;
  extensions: string[];
  cmd: string;
  args: string[];
}

interface SkillIssue {
  file: string;
  line: number;
  issue: string;
}

interface SkillScore {
  file: string;
  score: number;
  issues: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detectLinters(rootDir: string): Promise<LinterConfig[]> {
  const linters: LinterConfig[] = [];

  if (await exists(resolve(rootDir, "tsconfig.json"))) {
    linters.push({ name: "tsc", extensions: [".ts", ".tsx"], cmd: "npx", args: ["tsc", "--noEmit", "--pretty"] });
  }

  if (await exists(resolve(rootDir, "eslint.config.mjs")) ||
      await exists(resolve(rootDir, "eslint.config.js")) ||
      await exists(resolve(rootDir, "eslint.config.cjs")) ||
      await exists(resolve(rootDir, ".eslintrc.json")) ||
      await exists(resolve(rootDir, ".eslintrc.js")) ||
      await exists(resolve(rootDir, ".eslintrc.yml"))) {
    linters.push({ name: "eslint", extensions: [".js", ".ts", ".tsx", ".jsx"], cmd: "npx", args: ["eslint", "."] });
  }

  if (await commandExists("ruff")) {
    linters.push({ name: "ruff", extensions: [".py"], cmd: "ruff", args: ["check", "."] });
  } else if (await commandExists("python3")) {
    linters.push({ name: "python3", extensions: [".py"], cmd: "python3", args: ["-m", "py_compile"] });
  } else if (await commandExists("python")) {
    linters.push({ name: "python", extensions: [".py"], cmd: "python", args: ["-m", "py_compile"] });
  }

  if (await exists(resolve(rootDir, "Cargo.toml"))) {
    linters.push({ name: "cargo", extensions: [".rs"], cmd: "cargo", args: ["check", "--message-format=short"] });
  }

  if (await exists(resolve(rootDir, "go.mod"))) {
    linters.push({ name: "go", extensions: [".go"], cmd: "go", args: ["vet", "./..."] });
  }

  return linters;
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<LintResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 });
    return { tool: cmd, output: (stdout + stderr).trim(), exitCode: 0 };
  } catch (err: any) {
    return { tool: cmd, output: ((err.stdout ?? "") + (err.stderr ?? "")).trim(), exitCode: err.code ?? 1 };
  }
}

const COMMENT_PATTERNS: Record<string, RegExp[]> = {
  ".ts": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
  ".tsx": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
  ".js": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
  ".jsx": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
  ".py": [/^\s*#(?!\s*$)/, /^\s*"""/, /^\s*'''/],
  ".rs": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
  ".go": [/^\s*\/\/(?!\s*$)/, /^\s*\/\*/, /\*\/\s*$/],
};

function countNestingDepth(line: string): number {
  let depth = 0;
  let maxDepth = 0;
  for (const ch of line) {
    if (ch === "{" || ch === "(" || ch === "[") { depth++; maxDepth = Math.max(maxDepth, depth); }
    if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  return maxDepth;
}

async function checkFileSkill(filePath: string, rootDir: string): Promise<SkillScore> {
  const relPath = filePath.replace(rootDir + "/", "");
  const issues: string[] = [];
  let score = 100;

  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const ext = extname(filePath);

    if (lines.length > 1000) {
      issues.push(`File too long: ${lines.length} lines (max 1000)`);
      score -= 20;
    } else if (lines.length > 500) {
      issues.push(`File approaching limit: ${lines.length} lines (recommended max 500)`);
      score -= 5;
    }

    const commentPatterns = COMMENT_PATTERNS[ext];
    if (commentPatterns && lines.length > 2) {
      let inBlockComment = false;
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (inBlockComment) {
          if (line.includes("*/")) inBlockComment = false;
          continue;
        }
        if (/^\s*\/\*/.test(line)) {
          if (!line.includes("*/")) inBlockComment = true;
          issues.push(`L${i + 1}: inline comment (block comment start)`);
          score -= 2;
          continue;
        }
        if (/\S.*\/\/\s*\S/.test(line) && !/https?:\/\//.test(line) && !/^\s*\/\//.test(line)) {
          issues.push(`L${i + 1}: trailing inline comment`);
          score -= 2;
        }
      }
    }

    let maxNesting = 0;
    let currentNesting = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") { currentNesting++; maxNesting = Math.max(maxNesting, currentNesting); }
        if (ch === "}") currentNesting--;
      }
    }
    if (maxNesting > 4) {
      issues.push(`Max nesting depth: ${maxNesting} (max 4)`);
      score -= 10;
    } else if (maxNesting > 3) {
      issues.push(`Nesting depth: ${maxNesting} (recommended max 3)`);
      score -= 3;
    }

    if (commentPatterns && lines.length >= 2) {
      const hasHeader = /^\s*(\/\/|#|--)/.test(lines[0]);
      if (!hasHeader) {
        issues.push("Missing 2-line header comment");
        score -= 15;
      }
    }
  } catch {
    issues.push("Could not read file");
    score -= 50;
  }

  return { file: relPath, score: Math.max(0, score), issues };
}

export async function runStaticAnalysis(options: StaticAnalysisOptions): Promise<string> {
  const targetPath = options.targetPath ? resolveProjectPath(options.rootDir, options.targetPath, "targetPath") : resolve(options.rootDir);
  const results: string[] = [];

  const linters = await detectLinters(options.rootDir);

  const ext = extname(targetPath);
  const applicableLinters = ext ? linters.filter((l) => l.extensions.includes(ext)) : linters;

  if (applicableLinters.length === 0) {
    results.push(ext ? `No linter configured for ${ext} files.` : "No linters detected for this project.");
  } else {
    results.push(`Detected linters: ${applicableLinters.map((l) => l.name).join(", ")}\n`);
    for (const linter of applicableLinters) {
      const args = [...linter.args];
      if (ext && [".py"].includes(ext)) args.push(targetPath);

      const result = await runCommand(linter.cmd, args, options.rootDir);
      if (result.output) {
        results.push(`[${linter.name}]:\n${result.output.substring(0, 3000)}`);
      } else if (result.exitCode === 0) {
        results.push(`[${linter.name}]: No issues found.`);
      }
    }
  }

  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 5 });
  const sourceFiles = entries
    .filter((e) => !e.isDirectory && Object.keys(COMMENT_PATTERNS).includes(extname(e.path)))
    .slice(0, 50);

  if (sourceFiles.length > 0) {
    const skillScores = await Promise.all(sourceFiles.map((f) => checkFileSkill(f.path, options.rootDir)));
    const avgScore = Math.round(skillScores.reduce((sum, s) => sum + s.score, 0) / skillScores.length);
    const filesWithIssues = skillScores.filter((s) => s.issues.length > 0);

    results.push(`\n--- Skill Score ---`);
    results.push(`Project average: ${avgScore}/100 (${sourceFiles.length} files checked)`);

    if (filesWithIssues.length > 0) {
      results.push(`\nFiles with issues (${filesWithIssues.length}):`);
      for (const fs of filesWithIssues.slice(0, 20)) {
        results.push(`  ${fs.file} (${fs.score}/100): ${fs.issues.slice(0, 3).join("; ")}`);
      }
    } else {
      results.push("All files pass skill checks.");
    }
  }

  return results.join("\n");
}
