// Contextual file discovery via import graph, directory, tests, and hubs
// FEATURE: Related — show what files connect to a given file

import { getDB } from "../core/db.js";
import { walkDirectory } from "../core/walker.js";
import { discoverHubs, parseHubFile } from "../core/hub.js";
import { dirname } from "path";
import { resolveProjectPath, toProjectRelativePath } from "../core/path-guard.js";

export interface RelatedOptions {
  rootDir: string;
  file: string;
}

function findTestFile(filePath: string, allFiles: string[]): string | null {
  const base = filePath.replace(/\.\w+$/, "");
  const name = base.split("/").pop() ?? "";
  const candidates = [
    `test/main/${name}.test.mjs`,
    `test/main/${name}.test.ts`,
    `test/main/${name}.test.js`,
    `test/${name}.test.ts`,
    `test/${name}.test.js`,
    `tests/${name}.test.ts`,
    `tests/${name}.test.js`,
    `__tests__/${name}.test.ts`,
    `__tests__/${name}.test.js`,
    `${base}.test.ts`,
    `${base}.test.js`,
    `${base}.spec.ts`,
    `${base}.spec.js`,
  ];
  for (const c of candidates) {
    if (allFiles.includes(c)) return c;
  }
  return null;
}

function fuzzyResolveIndexedFile(db: ReturnType<typeof getDB> extends Promise<infer T> ? T : never, requested: string): { path: string; note: string | null } {
  if (db.getFile(requested)) return { path: requested, note: null };
  // Try common src-layout prefixes.
  const allDbFiles = db.getAllFiles();
  const indexedPaths = new Set(allDbFiles.map((f) => f.path));
  for (const prefix of ["src", "app", "lib", "packages"]) {
    const candidate = requested.startsWith(`${prefix}/`) ? null : `${prefix}/${requested}`;
    if (candidate && indexedPaths.has(candidate)) {
      return { path: candidate, note: `Fuzzy-resolved "${requested}" → "${candidate}".` };
    }
  }
  // Basename suffix match.
  const suffix = requested.split("/").pop();
  if (suffix) {
    const hits = allDbFiles.filter((f) => f.path.endsWith(`/${suffix}`)).map((f) => f.path);
    if (hits.length === 1) {
      return { path: hits[0], note: `Fuzzy-resolved "${requested}" → "${hits[0]}".` };
    }
  }
  return { path: requested, note: null };
}

export async function getRelated(options: RelatedOptions): Promise<string> {
  const requestedRaw = toProjectRelativePath(options.rootDir, options.file, "file");
  const db = await getDB(options.rootDir);
  const resolution = fuzzyResolveIndexedFile(db, requestedRaw);
  const requestedFile = resolution.path;
  const file = db.getFile(requestedFile);

  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const allFiles = entries.filter((e) => !e.isDirectory).map((e) => e.relativePath);

  const lines: string[] = [
    ...(resolution.note ? [`[${resolution.note}]`, ""] : []),
    `=== Related to: ${requestedFile} ===`,
    "",
  ];

  if (file) {
    const allDbFiles = db.getAllFiles();
    const fileById = new Map(allDbFiles.map((f) => [f.id, f]));

    const importsFrom = db.getImportsFrom(file.id);
    if (importsFrom.length > 0) {
      lines.push("Imports:");
      for (const imp of importsFrom) {
        const targetFile = imp.target_file_id ? fileById.get(imp.target_file_id) : null;
        lines.push(`  → ${targetFile?.path ?? imp.target_path}${imp.symbols_imported ? ` (${JSON.parse(imp.symbols_imported).join(", ")})` : ""}`);
      }
      lines.push("");
    }

    const importers = db.getImportersOf(file.id);
    if (importers.length > 0) {
      lines.push("Imported by:");
      for (const imp of importers) {
        const sourceFile = fileById.get(imp.source_file_id);
        if (sourceFile) lines.push(`  ← ${sourceFile.path}`);
      }
      lines.push("");
    }

    if (importsFrom.length === 0 && importers.length === 0) {
      lines.push("Import graph: not indexed. Run reindex to build the import graph.");
      lines.push("");
    }
  } else {
    // Distinguish "wrong path" from "truly not indexed" by checking the basename across the index.
    const suffix = requestedFile.split("/").pop();
    const sameNameHits = suffix ? db.getAllFiles().filter((f) => f.path.endsWith(`/${suffix}`)).map((f) => f.path) : [];
    if (sameNameHits.length > 0) {
      lines.push(`"${requestedFile}" is not in the index, but files with that name exist at: ${sameNameHits.slice(0, 5).join(", ")}. Did you mean one of those?`);
    } else {
      lines.push(`"${requestedFile}" is not in the index. If it exists, run reindex; otherwise check the path (project-relative).`);
    }
    lines.push("");
  }

  const dir = dirname(requestedFile);
  const siblings = allFiles.filter((f) => dirname(f) === dir && f !== requestedFile);
  if (siblings.length > 0) {
    lines.push(`Same directory (${dir}):`);
    for (const s of siblings.slice(0, 15)) lines.push(`  ${s}`);
    if (siblings.length > 15) lines.push(`  ... and ${siblings.length - 15} more`);
    lines.push("");
  }

  const testFile = findTestFile(requestedFile, allFiles);
  if (testFile) {
    lines.push(`Test file: ${testFile}`);
    lines.push("");
  }

  try {
    const hubs = await discoverHubs(options.rootDir);
    const matchingHubs: string[] = [];
    for (const hubPath of hubs) {
      const hub = await parseHubFile(resolveProjectPath(options.rootDir, hubPath, "hubPath"));
      if (hub.links.some((l) => l.target === requestedFile)) {
        matchingHubs.push(`${hubPath} (${hub.title})`);
      }
    }
    if (matchingHubs.length > 0) {
      lines.push("Feature hubs:");
      for (const h of matchingHubs) lines.push(`  ${h}`);
      lines.push("");
    }
  } catch {}

  return lines.join("\n");
}
