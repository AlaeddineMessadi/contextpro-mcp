// Bundled skeleton view of all files linked from a hub map-of-content
// FEATURE: Hierarchical context management via feature hub graph

import { resolve, extname, dirname, relative } from "path";
import { readFile, stat, writeFile, mkdir } from "fs/promises";
import { parseHubFile, discoverHubs, findOrphanedFiles, extractFeatureTag } from "../core/hub.js";
import { getFileSkeleton } from "./file-skeleton.js";
import { walkDirectory } from "../core/walker.js";
import { extractImports } from "../core/parser.js";
import { chatCompletion, extractJsonBlock, hasConfiguredChatModel } from "../core/chat-model.js";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";

export interface FeatureHubOptions {
  rootDir: string;
  hubPath?: string;
  featureName?: string;
  showOrphans?: boolean;
  query?: string;
}

export interface AutoHubResult {
  generated: string[];
  message: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findHubByName(rootDir: string, name: string): Promise<string | null> {
  const hubs = await discoverHubs(rootDir);
  const lower = name.toLowerCase();

  const exact = hubs.find((h) => h.toLowerCase() === `${lower}.md` || h.toLowerCase().endsWith(`/${lower}.md`));
  if (exact) return exact;

  const partial = hubs.find((h) => h.toLowerCase().includes(lower));
  return partial ?? null;
}

export async function getFeatureHub(options: FeatureHubOptions): Promise<string> {
  const { rootDir, showOrphans } = options;
  const out: string[] = [];

  if (!options.hubPath && !options.featureName && !showOrphans) {
    let hubs = await discoverHubs(rootDir);
    if (hubs.length === 0) {
      const generated = await autoGenerateHubData(rootDir);
      hubs = await discoverHubs(rootDir);
      if (hubs.length === 0) {
        return generated.message;
      }
    }
    if (hubs.length === 0) {
      return "No hub files found. Create a .md file with [[path/to/file]] links to establish a feature hub.";
    }

    const hubInfos = await Promise.all(
      hubs.map(async (h) => ({ path: h, info: await parseHubFile(resolveProjectPath(rootDir, h, "hubPath")) })),
    );

    if (options.query) {
      const q = options.query.toLowerCase();
      const scored = hubInfos.map(({ path, info }) => {
        const title = info.title.toLowerCase();
        const pathLower = path.toLowerCase();
        const linkNames = info.links.map((l) => l.target.toLowerCase()).join(" ");
        let score = 0;
        if (title.includes(q)) score += 3;
        if (pathLower.includes(q)) score += 2;
        if (linkNames.includes(q)) score += 1;
        return { path, info, score };
      });
      scored.sort((a, b) => b.score - a.score);
      out.push(`Feature Hubs matching "${options.query}" (${hubs.length} total):`);
      out.push("");
      for (const { path, info, score } of scored) {
        const marker = score > 0 ? "★" : "·";
        out.push(`  ${marker} ${path} | ${info.title} | ${info.links.length} links`);
      }
    } else {
      out.push(`Feature Hubs (${hubs.length}):`);
      out.push("");
      for (const { path, info } of hubInfos) {
        out.push(`  ${path} | ${info.title} | ${info.links.length} links`);
      }
    }
    return out.join("\n");
  }

  if (showOrphans) {
    const entries = await walkDirectory({ rootDir, depthLimit: 10 });
    const filePaths = entries.filter((e) => !e.isDirectory).map((e) => e.relativePath);
    const orphans = await findOrphanedFiles(rootDir, filePaths);
    if (orphans.length === 0) return "No orphaned files. All source files are linked to a hub.";

    out.push(`Orphaned Files (${orphans.length}):`);
    out.push("These files are not linked to any feature hub:");
    out.push("");
    for (const o of orphans) out.push(`  ⚠ ${o}`);
    out.push("");
    out.push("Fix: Add [[" + orphans[0] + "]] to the appropriate hub .md file.");
    return out.join("\n");
  }

  let hubRelPath = options.hubPath;
  if (!hubRelPath && options.featureName) {
    hubRelPath = (await findHubByName(rootDir, options.featureName)) ?? undefined;
    if (!hubRelPath) {
      return `No hub found for feature "${options.featureName}". Available hubs:\n` +
        (await discoverHubs(rootDir)).map((h) => `  - ${h}`).join("\n") || "  (none)";
    }
  }

  if (!hubRelPath) return "Provide hub_path, feature_name, or set show_orphans=true.";

  const hubFull = resolveProjectPath(rootDir, hubRelPath, "hubPath");
  if (!(await fileExists(hubFull))) {
    return `Hub file not found: ${hubRelPath}`;
  }

  const hub = await parseHubFile(hubFull);

  out.push(`Hub: ${hub.title}`);
  out.push(`Path: ${hubRelPath}`);
  out.push(`Links: ${hub.links.length}`);
  if (hub.crossLinks.length > 0) {
    out.push(`Cross-links: ${hub.crossLinks.map((c) => c.hubName).join(", ")}`);
  }
  out.push("");
  out.push("---");
  out.push("");

  const resolved: string[] = [];
  const missing: string[] = [];

  for (const link of hub.links) {
    try {
      const linkFull = resolveProjectPath(rootDir, link.target, "hub link");
      if (await fileExists(linkFull)) {
        resolved.push(toProjectRelativePath(rootDir, link.target, "hub link"));
      } else {
        missing.push(link.target);
      }
    } catch {
      missing.push(`${link.target} (outside project root)`);
    }
  }

  for (const filePath of resolved) {
    const ext = extname(filePath);
    const desc = hub.links.find((l) => l.target === filePath)?.description;

    if (desc) out.push(`## ${filePath} - ${desc}`);
    else out.push(`## ${filePath}`);

    try {
      const skeleton = await getFileSkeleton({ rootDir, filePath });
      out.push(skeleton);
    } catch {
      const content = await readFile(resolveProjectPath(rootDir, filePath, "hub link"), "utf-8");
      out.push(content.split("\n").slice(0, 20).join("\n"));
    }
    out.push("");
  }

  if (missing.length > 0) {
    out.push("---");
    out.push(`Missing Links (${missing.length}):`);
    for (const m of missing) out.push(`  ✗ ${m}`);
  }

  return out.join("\n");
}

interface ImportEdge {
  from: string;
  to: string;
}

function resolveImportPath(importSource: string, fromFile: string, allFiles: Set<string>): string | null {
  if (!importSource.startsWith(".")) return null;

  const fromDir = dirname(fromFile);
  const candidates = [
    resolve(fromDir, importSource),
    resolve(fromDir, importSource + ".ts"),
    resolve(fromDir, importSource + ".tsx"),
    resolve(fromDir, importSource + ".js"),
    resolve(fromDir, importSource + ".jsx"),
    resolve(fromDir, importSource.replace(/\.js$/, ".ts")),
    resolve(fromDir, importSource + "/index.ts"),
    resolve(fromDir, importSource + "/index.js"),
  ];

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function findConnectedComponents(edges: ImportEdge[], allNodes: string[]): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const node of allNodes) adj.set(node, new Set());
  for (const edge of edges) {
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of allNodes) {
    if (visited.has(node)) continue;
    const component: string[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
}

function findEntryPoint(component: string[], edges: ImportEdge[]): string {
  const importedBy = new Map<string, number>();
  for (const file of component) importedBy.set(file, 0);
  for (const edge of edges) {
    if (importedBy.has(edge.to)) {
      importedBy.set(edge.to, (importedBy.get(edge.to) ?? 0) + 1);
    }
  }
  let maxFile = component[0];
  let maxCount = 0;
  for (const [file, count] of importedBy) {
    if (count > maxCount) { maxFile = file; maxCount = count; }
  }
  return maxFile;
}

function generateHubName(component: string[], entryPoint: string): string {
  const commonDir = component.reduce((prefix, path) => {
    const parts = path.split("/");
    const prefixParts = prefix.split("/");
    let i = 0;
    while (i < parts.length && i < prefixParts.length && parts[i] === prefixParts[i]) i++;
    return parts.slice(0, i).join("/");
  });
  const genericDirs = new Set(["src", "test", "tests", "lib", "app", "server", "client"]);
  const commonDirParts = commonDir.split("/").filter(Boolean).filter((part) => !genericDirs.has(part));
  const entryName = entryPoint.split("/").pop()?.replace(/\.\w+$/, "") ?? "module";
  const base = commonDirParts.at(-1) ?? entryName;
  return base.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function deriveHubLabel(
  rootDir: string,
  component: string[],
  entryPoint: string,
  entryHeader: string,
): Promise<{ slug: string; title: string }> {
  const heuristicSlug = generateHubName(component, entryPoint);
  const heuristicTitle = humanizeSlug(heuristicSlug);
  if (!(await hasConfiguredChatModel(rootDir))) {
    return { slug: heuristicSlug, title: entryHeader || heuristicTitle };
  }

  const prompt = [
    "Create a short feature-hub title and slug for this code cluster.",
    "The slug must be lowercase kebab-case and descriptive.",
    "Avoid generic names like src, utils, module, core, or feature.",
    "Return JSON only: {\"slug\":\"...\",\"title\":\"...\"}.",
    `Entry point: ${entryPoint}`,
    `Entry header: ${entryHeader || "(none)"}`,
    "Files:",
    ...component.slice(0, 12).map((file) => `- ${file}`),
  ].join("\n");

  try {
    const raw = await chatCompletion(rootDir, prompt);
    const json = extractJsonBlock(raw);
    if (!json) return { slug: heuristicSlug, title: entryHeader || heuristicTitle };
    const parsed = JSON.parse(json) as { slug?: string; title?: string };
    const slug = (parsed.slug ?? heuristicSlug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || heuristicSlug;
    const title = (parsed.title ?? entryHeader ?? heuristicTitle).trim() || heuristicTitle;
    if (slug === "src" || slug === "module" || slug === "feature") {
      return { slug: heuristicSlug, title };
    }
    return { slug, title };
  } catch {
    return { slug: heuristicSlug, title: entryHeader || heuristicTitle };
  }
}

export async function autoGenerateHubData(rootDir: string): Promise<AutoHubResult> {
  const entries = await walkDirectory({ rootDir, depthLimit: 10 });
  const sourceExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"]);
  const sourceFiles = entries.filter((e) => !e.isDirectory && sourceExts.has(extname(e.path)));

  const allFilePaths = new Set(sourceFiles.map((e) => e.path));
  const allRelPaths = sourceFiles.map((e) => e.relativePath);
  const edges: ImportEdge[] = [];

  for (const entry of sourceFiles) {
    try {
      const content = await readFile(entry.path, "utf-8");
      const imports = extractImports(content, entry.path);

      for (const imp of imports) {
        const resolved = resolveImportPath(imp.source, entry.path, allFilePaths);
        if (resolved) {
          const fromRel = entry.relativePath;
          const toRel = relative(rootDir, resolved).replace(/\\/g, "/");
          edges.push({ from: fromRel, to: toRel });
        }
      }
    } catch {}
  }

  const components = findConnectedComponents(edges, allRelPaths);
  const significantComponents = components.filter((c) => c.length >= 3);

  if (significantComponents.length === 0) {
    return {
      generated: [],
      message: "No significant clusters found (minimum 3 connected files). Import graph too sparse.",
    };
  }

  const hubDir = resolveProjectPath(rootDir, ".contextplus/hubs", "hubDir");
  await mkdir(hubDir, { recursive: true });

  const generated: string[] = [];
  const usedNames = new Set<string>();
  for (const component of significantComponents) {
    const clusterEdges = edges.filter((e) => component.includes(e.from) && component.includes(e.to));
    const entryPoint = findEntryPoint(component, clusterEdges);

    let header = "";
    try {
      const content = await readFile(resolveProjectPath(rootDir, entryPoint, "entryPoint"), "utf-8");
      header = extractFeatureTag(content) ?? "";
      if (!header) {
        const firstLine = content.split("\n")[0];
        if (firstLine.startsWith("//") || firstLine.startsWith("#")) {
          header = firstLine.replace(/^[/#\s]+/, "").trim();
        }
      }
    } catch {}
    const derivedLabel = await deriveHubLabel(rootDir, component, entryPoint, header);

    const hubContent = [
      `<!-- Auto-generated by Context+ -->`,
      `# ${derivedLabel.title}`,
      ``,
      `Entry point: ${entryPoint}`,
      ``,
      `## Files`,
      ...component.sort().map((f) => `- [[${f}]]`),
      ``,
    ].join("\n");

    let finalName = derivedLabel.slug;
    let counter = 2;
    while (usedNames.has(finalName)) {
      finalName = `${derivedLabel.slug}-${counter}`;
      counter++;
    }
    usedNames.add(finalName);

    const hubPath = resolve(hubDir, `${finalName}.md`);
    await writeFile(hubPath, hubContent);
    generated.push(`${finalName}.md (${component.length} files, entry: ${entryPoint})`);
  }

  return {
    generated,
    message: `Auto-generated ${generated.length} feature hubs in .contextplus/hubs/:\n\n${generated.map((g) => `  - ${g}`).join("\n")}`,
  };
}

export async function autoGenerateHubs(rootDir: string): Promise<string> {
  const result = await autoGenerateHubData(rootDir);
  return result.message;
}
