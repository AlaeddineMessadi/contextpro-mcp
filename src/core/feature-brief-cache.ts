import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDB } from "./db.js";
import { getIndexState } from "./context-metadata.js";
import { listArtifacts, readArtifact, type ArtifactReference } from "./artifacts.js";
import { resolveProjectPath } from "./path-guard.js";
import { chatModelIdentity } from "./chat-model.js";

// v22 invalidates briefs predating explicit location precedence repairs.
export const FEATURE_BRIEF_VERSION = 28;
const BRIEF_ROLES = ["implementation", "dependency", "caller", "test"] as const;
export interface BriefCitation {
  id: string; file: string; start: number; end: number; hash: string;
  roles: Array<typeof BRIEF_ROLES[number]>;
}
export interface FeatureBrief {
  version: number; query: string; model: string; signature: string;
  files: string[]; citations: BriefCitation[];
  facts: string[]; interpretations: Array<{ text: string; citations: string[] }>;
  warnings: string[];
}
export const briefQuery = (query: string) => query.trim().replace(/\s+/g, " ");

/** Facts contain only validated citation coordinates and enumerated retrieval roles. */
export function briefFacts(citations: BriefCitation[]): string[] {
  return citations.map(citation => `[${citation.id}] ${citation.file}:${citation.start}-${citation.end} — ${citation.roles.join(", ")}`);
}

function validCitations(brief: FeatureBrief): boolean {
  if (!Array.isArray(brief.files) || !brief.files.every(file => typeof file === "string")
    || !Array.isArray(brief.citations) || !Array.isArray(brief.facts) || !Array.isArray(brief.interpretations)
    || !Array.isArray(brief.warnings) || !brief.warnings.every(warning => typeof warning === "string")) return false;
  const ids = new Set<string>();
  for (const citation of brief.citations) {
    if (!citation || !/^E\d+$/.test(citation.id) || ids.has(citation.id) || !brief.files.includes(citation.file)
      || !Number.isInteger(citation.start) || citation.start < 1 || !Number.isInteger(citation.end) || citation.end < citation.start
      || !/^[a-f0-9]{64}$/.test(citation.hash)
      || !Array.isArray(citation.roles) || !citation.roles.length || citation.roles.length > BRIEF_ROLES.length
      || new Set(citation.roles).size !== citation.roles.length || !citation.roles.every(role => BRIEF_ROLES.includes(role))) return false;
    ids.add(citation.id);
  }
  const expectedFacts = briefFacts(brief.citations);
  return brief.facts.length === expectedFacts.length && brief.facts.every((fact, i) => fact === expectedFacts[i])
    && brief.interpretations.every(claim => claim && typeof claim.text === "string" && Array.isArray(claim.citations)
      && claim.citations.length > 0 && claim.citations.every(id => ids.has(id)));
}
export async function featureSignature(rootDir: string, files: string[], expectedHashes?: Record<string, string>, citations?: BriefCitation[]): Promise<string | null> {
  const db = await getDB(rootDir), rows: unknown[] = [];
  for (const file of [...files].sort()) {
    try {
      const full = resolveProjectPath(rootDir, file);
      if ((await stat(full)).size > 2_000_000) return null;
      const source = await readFile(full);
      if (source.length > 2_000_000) return null;
      const sourceHash = createHash("sha256").update(source).digest("hex");
      if (expectedHashes && expectedHashes[file] !== sourceHash) return null;
      if (citations) {
        const lineCount = source.toString("utf8").split("\n").length;
        if (citations.some(citation => citation.file === file && (citation.hash !== sourceHash || citation.end > lineCount))) return null;
      }
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
        || (brief.model !== "deterministic" && brief.model !== model) || !validCitations(brief)) continue;
      if (await featureSignature(rootDir, brief.files, undefined, brief.citations) === brief.signature) return { artifact: ref, brief };
    }
  } catch { /* A corrupt or unavailable cache is a miss. */ }
  return null;
}
