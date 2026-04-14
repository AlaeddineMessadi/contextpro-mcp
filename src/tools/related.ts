// Contextual file discovery via import graph, directory, tests, and hubs
// FEATURE: Related — show what files connect to a given file

import { getDB } from "../core/db.js";
import { walkDirectory } from "../core/walker.js";
import { discoverHubs, parseHubFile } from "../core/hub.js";
import { dirname, extname, resolve, relative } from "path";

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

export async function getRelated(options: RelatedOptions): Promise<string> {
  const db = await getDB(options.rootDir);
  const file = db.getFile(options.file);

  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const allFiles = entries.filter((e) => !e.isDirectory).map((e) => e.relativePath);

  const lines: string[] = [`=== Related to: ${options.file} ===`, ""];

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
    lines.push("File not in index. Run reindex to populate the database.");
    lines.push("");
  }

  const dir = dirname(options.file);
  const siblings = allFiles.filter((f) => dirname(f) === dir && f !== options.file);
  if (siblings.length > 0) {
    lines.push(`Same directory (${dir}):`);
    for (const s of siblings.slice(0, 15)) lines.push(`  ${s}`);
    if (siblings.length > 15) lines.push(`  ... and ${siblings.length - 15} more`);
    lines.push("");
  }

  const testFile = findTestFile(options.file, allFiles);
  if (testFile) {
    lines.push(`Test file: ${testFile}`);
    lines.push("");
  }

  try {
    const hubs = await discoverHubs(options.rootDir);
    const matchingHubs: string[] = [];
    for (const hubPath of hubs) {
      const hub = await parseHubFile(resolve(options.rootDir, hubPath));
      if (hub.links.some((l) => l.target === options.file)) {
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
