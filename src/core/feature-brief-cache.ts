import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDB } from "./db.js";
import { getIndexState } from "./context-metadata.js";
import { listArtifacts, readArtifact, type ArtifactReference } from "./artifacts.js";
import { resolveProjectPath } from "./path-guard.js";
import { chatModelIdentity } from "./chat-model.js";

export const FEATURE_BRIEF_VERSION = 1;
export interface BriefCitation { id: string; file: string; start: number; end: number; hash: string }
export interface FeatureBrief {
  version: number; query: string; model: string; signature: string;
  files: string[]; citations: BriefCitation[];
  facts: string[]; interpretations: Array<{ text: string; citations: string[] }>;
  warnings: string[];
}
export const briefQuery = (query: string) => query.trim().replace(/\s+/g, " ");
export async function featureSignature(rootDir: string, files: string[], expectedHashes?: Record<string, string>): Promise<string | null> {
  const db = await getDB(rootDir), rows: unknown[] = [];
  for (const file of [...files].sort()) {
    try {
      const full = resolveProjectPath(rootDir, file);
      if ((await stat(full)).size > 2_000_000) return null;
      const source = await readFile(full);
      if (source.length > 2_000_000) return null;
      const sourceHash = createHash("sha256").update(source).digest("hex");
      if (expectedHashes && expectedHashes[file] !== sourceHash) return null;
      const row = db.getFile(file);
      if (!row) return null;
      const edges = [...db.getImportsFrom(row.id).map(edge => `out:${edge.target_path}:${edge.target_file_id ? db.getFileById(edge.target_file_id)?.path : "?"}`),
        ...db.getImportersOf(row.id).map(edge => `in:${db.getFileById(edge.source_file_id)?.path}`)].sort();
      rows.push([file, sourceHash, edges]);
    } catch { return null; }
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export async function lookupFeatureBrief(rootDir: string, query: string): Promise<{ artifact: ArtifactReference; brief: FeatureBrief } | null> {
  try {
    if ((await getIndexState(rootDir)).state !== "fresh") return null;
    const model = await chatModelIdentity(rootDir);
    for (const ref of await listArtifacts(rootDir, "feature_brief", 200)) {
      const artifact = await readArtifact<FeatureBrief>(rootDir, ref.id);
      const brief = artifact?.payload;
      if (!brief || artifact?.repoRoot !== resolve(rootDir) || brief.query !== briefQuery(query) || brief.version !== FEATURE_BRIEF_VERSION
        || (brief.model !== "deterministic" && brief.model !== model)) continue;
      if (await featureSignature(rootDir, brief.files) === brief.signature) return { artifact: ref, brief };
    }
  } catch { /* A corrupt or unavailable cache is a miss. */ }
  return null;
}
