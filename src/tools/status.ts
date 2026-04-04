// Project overview dashboard for instant agent orientation
// FEATURE: Status — file count, index state, memory stats, recent changes

import { walkDirectory } from "../core/walker.js";
import { isSupportedFile } from "../core/parser.js";
import { getDB } from "../core/db.js";
import { exec } from "child_process";
import { promisify } from "util";
import { extname } from "path";

const execAsync = promisify(exec);

export interface StatusOptions {
  rootDir: string;
}

async function gitInfo(rootDir: string): Promise<{ branch: string; uncommitted: number; recentCommits: string[] }> {
  try {
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: rootDir, timeout: 5000 });
    const { stdout: status } = await execAsync("git status --porcelain", { cwd: rootDir, timeout: 5000 });
    const uncommitted = status.trim().split("\n").filter((l) => l.trim()).length;
    const { stdout: log } = await execAsync("git log --oneline -5", { cwd: rootDir, timeout: 5000 });
    const recentCommits = log.trim().split("\n").filter((l) => l.trim());
    return { branch: branch.trim(), uncommitted, recentCommits };
  } catch {
    return { branch: "unknown", uncommitted: 0, recentCommits: [] };
  }
}

function detectProjectType(files: { relativePath: string }[]): string {
  const exts = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f.relativePath).toLowerCase();
    if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const sorted = [...exts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([ext, count]) => `${ext} (${count})`).join(", ");

  const has = (ext: string) => exts.has(ext);
  let type = "Unknown";
  if (has(".ts") || has(".tsx")) type = "TypeScript";
  else if (has(".js") || has(".jsx")) type = "JavaScript";
  else if (has(".py")) type = "Python";
  else if (has(".rs")) type = "Rust";
  else if (has(".go")) type = "Go";
  else if (has(".java")) type = "Java";

  return `${type} — ${top}`;
}

export async function getStatus(options: StatusOptions): Promise<string> {
  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const allFiles = entries.filter((e) => !e.isDirectory);
  const sourceFiles = allFiles.filter((e) => isSupportedFile(e.path));

  const db = await getDB(options.rootDir);
  const indexedFiles = db.getAllFiles();
  const graphStats = db.getGraphStats();
  const git = await gitInfo(options.rootDir);

  const staleCount = indexedFiles.filter((f) => !allFiles.some((e) => e.relativePath === f.path)).length;
  const projectType = detectProjectType(allFiles);

  const lines = [
    `=== Context+ Status ===`,
    ``,
    `Project: ${options.rootDir.split("/").pop()} (${projectType})`,
    `Branch: ${git.branch}`,
    ``,
    `--- Files ---`,
    `Total files: ${allFiles.length}`,
    `Source files: ${sourceFiles.length}`,
    `Indexed in DB: ${indexedFiles.length}`,
    `Stale/removed: ${staleCount}`,
    ``,
    `--- Memory Graph ---`,
    `Nodes: ${graphStats.totalNodes}`,
    `Edges: ${graphStats.totalEdges}`,
    ``,
    `--- Git ---`,
    `Uncommitted changes: ${git.uncommitted}`,
    `Recent commits:`,
  ];

  for (const c of git.recentCommits) lines.push(`  ${c}`);

  if (indexedFiles.length === 0) {
    lines.push(``);
    lines.push(`⚠ Index is empty. Run reindex to populate the database.`);
  } else if (staleCount > 5) {
    lines.push(``);
    lines.push(`⚠ ${staleCount} files stale or removed. Run reindex to refresh.`);
  }

  return lines.join("\n");
}
