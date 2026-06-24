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
  verbose?: boolean;
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

async function resolveLocalBinary(rootDir: string, name: string): Promise<string | null> {
  const candidates = [
    resolve(rootDir, "node_modules", ".bin", name),
    resolve(rootDir, "node_modules", ".bin", `${name}.cmd`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function resolvePythonTool(rootDir: string, name: string): Promise<{ cmd: string; args: string[] } | null> {
  // Priority order:
  // 1) ./.venv/bin/<name>  (uv/poetry/venv standard)
  // 2) ./.venv/Scripts/<name>.exe  (Windows venv)
  // 3) uv run <name>  (uv-managed projects)
  // 4) poetry run <name>  (poetry-managed projects)
  // 5) system <name>
  const venvBin = resolve(rootDir, ".venv", "bin", name);
  if (await exists(venvBin)) return { cmd: venvBin, args: [] };
  const venvScripts = resolve(rootDir, ".venv", "Scripts", `${name}.exe`);
  if (await exists(venvScripts)) return { cmd: venvScripts, args: [] };
  if (await exists(resolve(rootDir, "pyproject.toml")) || await exists(resolve(rootDir, "uv.lock"))) {
    if (await commandExists("uv")) {
      return { cmd: "uv", args: ["run", name] };
    }
  }
  if (await exists(resolve(rootDir, "poetry.lock"))) {
    if (await commandExists("poetry")) {
      return { cmd: "poetry", args: ["run", name] };
    }
  }
  if (await commandExists(name)) return { cmd: name, args: [] };
  return null;
}

async function readPackageJsonScripts(rootDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(resolve(rootDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function detectLinters(rootDir: string): Promise<LinterConfig[]> {
  const linters: LinterConfig[] = [];

  if (await exists(resolve(rootDir, "tsconfig.json"))) {
    const localTsc = await resolveLocalBinary(rootDir, "tsc");
    if (localTsc) {
      linters.push({ name: "tsc", extensions: [".ts", ".tsx"], cmd: localTsc, args: ["--noEmit", "--pretty"] });
    } else {
      // Use npx --no-install so we never silently fall through to a system tsc
      // (macOS ships /usr/bin/tsc as Apple's TextureSetCompiler, which is unrelated).
      const npxAvailable = await commandExists("npx");
      if (npxAvailable) {
        linters.push({ name: "tsc", extensions: [".ts", ".tsx"], cmd: "npx", args: ["--no-install", "tsc", "--noEmit", "--pretty"] });
      } else {
        linters.push({ name: "tsc-missing", extensions: [".ts", ".tsx"], cmd: "echo", args: ["[lint] TypeScript not installed. Run 'npm install' to enable tsc, or add a 'typecheck' npm script."] });
      }
    }
  }

  if (await exists(resolve(rootDir, "eslint.config.mjs")) ||
      await exists(resolve(rootDir, "eslint.config.js")) ||
      await exists(resolve(rootDir, "eslint.config.cjs")) ||
      await exists(resolve(rootDir, ".eslintrc.json")) ||
      await exists(resolve(rootDir, ".eslintrc.js")) ||
      await exists(resolve(rootDir, ".eslintrc.yml"))) {
    const localEslint = await resolveLocalBinary(rootDir, "eslint");
    if (localEslint) {
      linters.push({ name: "eslint", extensions: [".js", ".ts", ".tsx", ".jsx"], cmd: localEslint, args: ["."] });
    } else {
      linters.push({ name: "eslint", extensions: [".js", ".ts", ".tsx", ".jsx"], cmd: "npx", args: ["--no-install", "eslint", "."] });
    }
  }

  // Python: prefer ruff (in .venv, then `uv run`, then `poetry run`, then system).
  // Fall back to mypy if ruff missing. Final fallback: python3 -m py_compile.
  const ruff = await resolvePythonTool(rootDir, "ruff");
  if (ruff) {
    linters.push({ name: "ruff", extensions: [".py"], cmd: ruff.cmd, args: [...ruff.args, "check", "."] });
  } else {
    const mypy = await resolvePythonTool(rootDir, "mypy");
    if (mypy) {
      linters.push({ name: "mypy", extensions: [".py"], cmd: mypy.cmd, args: [...mypy.args, "--no-error-summary", "."] });
    } else if (await commandExists("python3")) {
      linters.push({ name: "python3", extensions: [".py"], cmd: "python3", args: ["-m", "py_compile"] });
    } else if (await commandExists("python")) {
      linters.push({ name: "python", extensions: [".py"], cmd: "python", args: ["-m", "py_compile"] });
    }
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
  const sourceEntries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 5 });
  const presentExtensions = new Set(
    sourceEntries
      .filter((e) => !e.isDirectory)
      .map((e) => extname(e.path).toLowerCase())
      .filter((e) => e.length > 0),
  );

  const extFilteredLinters = ext ? linters.filter((l) => l.extensions.includes(ext)) : linters;
  const applicableLinters = extFilteredLinters.filter((l) =>
    l.extensions.some((linterExt) => presentExtensions.has(linterExt)),
  );

  if (applicableLinters.length === 0) {
    results.push(ext ? `No linter configured for ${ext} files in scope.` : "No applicable linters detected for this project.");
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

  const sourceFiles = sourceEntries
    .filter((e) => !e.isDirectory && Object.keys(COMMENT_PATTERNS).includes(extname(e.path)))
    .slice(0, 50);

  if (sourceFiles.length > 0) {
    const skillScores = await Promise.all(sourceFiles.map((f) => checkFileSkill(f.path, options.rootDir)));
    const avgScore = Math.round(skillScores.reduce((sum, s) => sum + s.score, 0) / skillScores.length);
    const filesWithIssues = skillScores.filter((s) => s.issues.length > 0).sort((a, b) => a.score - b.score);

    results.push(`\n--- Skill Score ---`);
    results.push(`Project average: ${avgScore}/100 (${sourceFiles.length} files checked)`);

    if (filesWithIssues.length > 0) {
      const verbose = options.verbose === true;
      const showLimit = verbose ? filesWithIssues.length : 10;
      const totalShown = Math.min(showLimit, filesWithIssues.length);
      results.push(`\nFiles with issues (${filesWithIssues.length}${verbose ? "" : `, showing top ${totalShown} by lowest score`}):`);
      for (const fs of filesWithIssues.slice(0, showLimit)) {
        results.push(`  ${fs.file} (${fs.score}/100): ${fs.issues.slice(0, 3).join("; ")}`);
      }
      if (!verbose && filesWithIssues.length > showLimit) {
        results.push(`  ... and ${filesWithIssues.length - showLimit} more (pass verbose: true to see all)`);
      }
    } else {
      results.push("All files pass skill checks.");
    }
  }

  return results.join("\n");
}
