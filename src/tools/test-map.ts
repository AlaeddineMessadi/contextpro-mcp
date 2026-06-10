// Map source files to their test files using import graph and naming conventions
// FEATURE: TestMap — which tests cover which code

import { getDB } from "../core/db.js";
import { walkDirectory } from "../core/walker.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { extname, dirname } from "path";

const execFileAsync = promisify(execFile);

export interface TestMapOptions {
  rootDir: string;
  file?: string;
  symbol?: string;
  changed?: boolean;
}

const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /\.test\.\w+\.mjs$/,
  /\.demo\.\w+$/,
];

function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}

function findTestsByConvention(sourceFile: string, allFiles: string[]): string[] {
  const base = sourceFile.replace(/\.\w+$/, "").split("/").pop() ?? "";
  return allFiles.filter((f) => {
    if (!isTestFile(f)) return false;
    const testBase = f.replace(/\.\w+$/, "").replace(/\.(test|spec|demo)$/, "").split("/").pop() ?? "";
    return testBase === base;
  });
}

async function getChangedFiles(rootDir: string): Promise<string[]> {
  try {
    const [{ stdout: unstaged }, { stdout: staged }] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], { cwd: rootDir, timeout: 5000 }),
      execFileAsync("git", ["diff", "--name-only", "--cached"], { cwd: rootDir, timeout: 5000 }),
    ]);
    return [...new Set(`${unstaged}\n${staged}`.trim().split("\n").filter((l) => l.trim()))];
  } catch {
    return [];
  }
}

export async function getTestMap(options: TestMapOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const allFiles = entries.filter((e) => !e.isDirectory).map((e) => e.relativePath);
  const testFiles = allFiles.filter(isTestFile);
  const sourceFiles = allFiles.filter((f) => !isTestFile(f));

  let targetFiles: string[] = [];

  if (options.changed) {
    targetFiles = await getChangedFiles(options.rootDir);
    targetFiles = targetFiles.filter((f) => !isTestFile(f));
  } else if (options.file) {
    targetFiles = [options.file];
  } else if (options.symbol) {
    const symbols = db.searchSymbolsByName(options.symbol);
    const fileIds = [...new Set(symbols.map((s) => s.file_id))];
    const allDbFiles = db.getAllFiles();
    targetFiles = fileIds.map((id) => allDbFiles.find((f) => f.id === id)?.path).filter(Boolean) as string[];
  }

  if (targetFiles.length === 0) {
    return options.changed ? "No uncommitted changes to map." : "No target files specified. Use file, symbol, or changed parameter.";
  }

  const lines: string[] = [`=== Test Map ===`, ""];

  for (const file of targetFiles) {
    const conventionTests = findTestsByConvention(file, testFiles);

    const dbFile = db.getFile(file);
    const importerTests: string[] = [];
    if (dbFile) {
      const importers = db.getImportersOf(dbFile.id);
      const allDbFiles = db.getAllFiles();
      for (const imp of importers) {
        const srcFile = allDbFiles.find((f) => f.id === imp.source_file_id);
        if (srcFile && isTestFile(srcFile.path)) {
          importerTests.push(srcFile.path);
        }
      }
    }

    const allTests = [...new Set([...conventionTests, ...importerTests])];

    lines.push(`${file}:`);
    if (allTests.length > 0) {
      for (const t of allTests) {
        const source = conventionTests.includes(t) && importerTests.includes(t) ? "convention+import"
          : conventionTests.includes(t) ? "convention" : "import";
        lines.push(`  → ${t} (${source})`);
      }
    } else {
      lines.push("  ⚠ No tests found");
    }
    lines.push("");
  }

  const totalMapped = targetFiles.length;
  const withTests = targetFiles.filter((f) => {
    const ct = findTestsByConvention(f, testFiles);
    return ct.length > 0;
  }).length;

  lines.push(`Coverage: ${withTests}/${totalMapped} files have tests`);

  return lines.join("\n");
}
