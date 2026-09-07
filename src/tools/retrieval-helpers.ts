// Shared retrieval utilities: test discovery, diff summaries, memory hits, import resolution
// FEATURE: Helper layer for agentic-context — query-independent data fetching functions

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import { fetchQueryEmbedding } from "../core/embeddings.js";
import { getDB } from "../core/db.js";
import { loadProjectConfig } from "../core/project-config.js";
import { discoverHubs, parseHubFile } from "../core/hub.js";
import { walkDirectory } from "../core/walker.js";
import { resolveProjectPath } from "../core/path-guard.js";

const execFileAsync = promisify(execFile);

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

export function isTestFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return /\.test\.\w+$|\.spec\.\w+$|\.demo\.\w+$/.test(path)
    || /^test_[^/]+\.py$/.test(name)
    || /_test\.py$/.test(name);
}

function baseNameWithoutTestAffixes(path: string): string {
  const base = path.replace(/\.\w+$/, "").split("/").pop() ?? "";
  return base
    .replace(/\.(test|spec|demo)$/i, "")
    .replace(/^test_/i, "")
    .replace(/_test$/i, "");
}

async function findConventionTests(rootDir: string, sourceFile: string, allFiles: string[]): Promise<string[]> {
  const base = baseNameWithoutTestAffixes(sourceFile);
  return allFiles.filter((file) => {
    if (!isTestFile(file)) return false;
    const testBase = baseNameWithoutTestAffixes(file);
    return testBase === base;
  });
}

async function findImporterTests(
  rootDir: string,
  file: string,
  maxDepth: number,
): Promise<Array<{ path: string; reason: string; score: number }>> {
  const db = await getDB(rootDir);
  const target = db.getFile(file);
  if (!target) return [];

  const indexedFiles = db.getAllFiles();
  const fileById = new Map(indexedFiles.map((candidate) => [candidate.id, candidate]));
  const queue: Array<{ fileId: number; via: string[]; depth: number }> = [{ fileId: target.id, via: [file], depth: 0 }];
  const visited = new Set<number>([target.id]);
  const results: Array<{ path: string; reason: string; score: number }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const importer of db.getImportersOf(current.fileId)) {
      const source = fileById.get(importer.source_file_id);
      if (!source || visited.has(source.id)) continue;
      visited.add(source.id);
      const path = source.path;
      const via = [...current.via, path];
      const depth = current.depth + 1;
      if (isTestFile(path)) {
        results.push({
          path,
          reason: depth === 1 ? "Imports target module" : `Imports dependent chain: ${via.join(" <- ")}`,
          score: Math.max(0.68, 0.9 - depth * 0.08),
        });
        continue;
      }
      queue.push({ fileId: source.id, via, depth });
    }
  }

  return results;
}

export async function findTestsForFiles(rootDir: string, files: string[]): Promise<Array<{ path: string; reason: string; score: number }>> {
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const allFiles = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const results: Array<{ path: string; reason: string; score: number }> = [];

  for (const file of files) {
    const convention = await findConventionTests(rootDir, file, allFiles);
    for (const testPath of convention) {
      results.push({ path: testPath, reason: "Matched by test naming convention", score: 0.68 });
    }
    results.push(...await findImporterTests(rootDir, file, 5));
  }

  const deduped = new Map<string, { path: string; reason: string; score: number }>();
  for (const item of results) {
    const existing = deduped.get(item.path);
    if (!existing || item.score > existing.score) deduped.set(item.path, item);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}

export async function getRecentDiffSummary(rootDir: string, filePath: string): Promise<{ path: string; commit: string; summary: string } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-n", "1", "--", filePath], {
      cwd: rootDir,
      timeout: 5000,
    });
    const line = stdout.trim().split("\n")[0];
    if (!line) return null;
    const [commit, ...summary] = line.split(" ");
    return { path: filePath, commit, summary: summary.join(" ") };
  } catch {
    return null;
  }
}

export async function getProjectMemoryHits(rootDir: string, query: string, topK: number, keywordOnly = false): Promise<Array<{ id: string; kind: string; summary: string }>> {
  if (!Number.isFinite(topK) || topK <= 0) return [];
  const db = await getDB(rootDir);
  const config = await loadProjectConfig(rootDir);
  const projectId = config?.projectId ?? "";
  const clientId = config?.clientId ?? "";
  let queryVector: number[];
  try {
    queryVector = keywordOnly ? [] : await fetchQueryEmbedding(query);
  } catch {
    queryVector = [];
  }
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const lexicalHits = db.listMemoryNodes().map((node) => ({ node, distance: 1, score: terms.reduce((sum, term) => sum + Number(`${node.label} ${node.content}`.toLowerCase().includes(term)), 0) }))
    .filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const semanticHits = queryVector.length ? db.searchMemoryNodes(queryVector, Math.max(topK * 6, 18)) : [];
  const hits = [...semanticHits, ...lexicalHits.filter((hit) => !semanticHits.some((candidate) => candidate.node.id === hit.node.id))];
  const filtered: Array<{ id: string; kind: string; summary: string }> = [];
  for (const hit of hits) {
    const metadata = parseMetadata(hit.node.metadata);
    const scope = metadata.scope ?? "project";
    if (scope === "global") {
      // Global memories are always relevant.
    } else if (scope === "client") {
      if (metadata.client_id !== clientId) continue;
    } else if (scope === "project") {
      if (metadata.project_id !== projectId) continue;
    } else {
      continue;
    }
    filtered.push({
      id: hit.node.id,
      kind: metadata.record_kind ?? "memory",
      summary: hit.node.content.slice(0, 220),
    });
    if (filtered.length >= topK) break;
  }
  return filtered;
}

export async function resolveFilesFromSymbols(rootDir: string, symbols: string[] | undefined): Promise<string[]> {
  if (!symbols || symbols.length === 0) return [];
  const db = await getDB(rootDir);
  const files: string[] = [];
  const indexedFiles = db.getAllFiles();
  for (const symbol of symbols) {
    const matches = db.searchSymbolsByName(symbol);
    for (const match of matches) {
      const file = indexedFiles.find((candidate) => candidate.id === match.file_id);
      if (file) files.push(file.path);
    }
  }
  return unique(files);
}

export async function findTextDependents(rootDir: string, filePath: string, symbolNames: string[] = []): Promise<string[]> {
  const db = await getDB(rootDir);
  const dbFile = db.getFile(filePath);
  if (dbFile) {
    const importerRows = db.getImportersOf(dbFile.id);
    const importerPaths = importerRows
      .map((row) => db.getFileById(row.source_file_id)?.path)
      .filter((path): path is string => path !== undefined && path !== filePath);
    if (importerPaths.length > 0 || symbolNames.length === 0) return unique(importerPaths);
  }
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const candidates = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const baseName = basename(filePath).replace(/\.\w+$/, "");
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (candidate === filePath) continue;
    try {
      const content = await readFile(resolveProjectPath(rootDir, candidate, "candidate file"), "utf-8");
      if (content.includes(baseName) || symbolNames.some((symbol) => content.includes(symbol))) {
        matches.push(candidate);
      }
    } catch {}
  }
  return unique(matches);
}

export async function scanExactMentions(rootDir: string, candidateFiles: string[], symbolNames: string[]): Promise<string[]> {
  if (candidateFiles.length === 0 || symbolNames.length === 0) return [];
  const matches: string[] = [];
  for (const candidate of candidateFiles) {
    try {
      const content = await readFile(resolveProjectPath(rootDir, candidate, "candidate file"), "utf-8");
      if (symbolNames.some((symbol) => content.includes(symbol))) matches.push(candidate);
    } catch {}
  }
  return unique(matches);
}

export async function fileRisk(rootDir: string, filePath: string): Promise<{ importers: number; imports: number; churn: number }> {
  const db = await getDB(rootDir);
  const dbFile = db.getFile(filePath);
  let importers = 0;
  let imports = 0;
  if (dbFile) {
    importers = db.getImportersOf(dbFile.id).length;
    imports = db.getImportsFrom(dbFile.id).length;
  }
  let churn = 0;
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "--", filePath], { cwd: rootDir, timeout: 5000 });
    churn = stdout.trim().split("\n").filter(Boolean).length;
  } catch {}
  return { importers, imports, churn };
}

export async function hubMatchesForFiles(rootDir: string, filePaths: string[]): Promise<string[]> {
  const hubs = await discoverHubs(rootDir).catch(() => []);
  const matches: string[] = [];
  for (const hubPath of hubs) {
    const hub = await parseHubFile(resolveProjectPath(rootDir, hubPath, "hubPath")).catch(() => null);
    if (!hub) continue;
    if (hub.links.some((link) => filePaths.includes(link.target))) {
      matches.push(hubPath);
    }
  }
  return matches;
}
