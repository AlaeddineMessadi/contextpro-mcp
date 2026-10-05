// Hash-bound evidence shared by memory, validation receipts and handoffs.
import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectPath } from "./path-guard.js";
import { walkDirectory } from "./walker.js";
import { persistArtifact, readArtifact } from "./artifacts.js";
import { getDB, type MemoryNodeRow } from "./db.js";

const exec = promisify(execFile);
export interface EvidenceFile { file: string; hash?: string; start?: number; end?: number }
export interface EvidenceState { root: string; revision: string | null; files: Array<EvidenceFile & { hash: string }>; digest: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function evidenceConfigurationFiles(rootDir:string):Promise<string[]> {
  return (await walkDirectory({rootDir})).filter(entry=>!entry.isDirectory
    && /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|setup\.(?:py|cfg)|environment\.ya?ml|pyproject\.toml|requirements[^/]*\.txt|(?:ts|js|pyright)config[^/]*\.json|[^/]+\.config\.[^/]+)$/.test(entry.relativePath))
    .map(entry=>entry.relativePath).sort();
}

export async function bindEvidence(rootDir: string, files: EvidenceFile[]): Promise<EvidenceState> {
  const root = await realpath(rootDir);
  if (files.length > 20_000) throw new Error("Evidence exceeds 20,000 files; narrow the workspace.");
  const bound: EvidenceState["files"] = [];
  for (const item of files) {
    const path = resolveProjectPath(root, item.file, "evidence file");
    if ((item.start !== undefined && (!Number.isInteger(item.start) || item.start < 1))
      || (item.end !== undefined && (!Number.isInteger(item.end) || item.end < (item.start ?? 1)))) throw new Error("Invalid evidence range.");
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`Evidence requires a regular file: ${item.file}`);
      const hash = createHash("sha256");
      let lines = 1;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        if(item.start !== undefined || item.end !== undefined) for(const byte of chunk) if(byte === 10) lines++;
      }
      if ((item.start ?? 1)>lines || (item.end ?? item.start ?? 1)>lines) throw new Error(`Evidence range exceeds source: ${item.file}`);
      const after = await handle.stat();
      const published = await stat(path);
      if (published.ino !== after.ino || published.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || published.size !== after.size || published.mtimeMs !== after.mtimeMs || published.ctimeMs !== after.ctimeMs) throw new Error(`Evidence changed while reading: ${item.file}`);
      const value = hash.digest("hex");
      if (item.hash && value !== item.hash) throw new Error(`Evidence hash mismatch: ${item.file}`);
      bound.push({ ...item, file: relative(root, path).split("\\").join("/"), hash: value });
    } finally { await handle.close(); }
  }
  bound.sort((a, b) => a.file.localeCompare(b.file) || (a.start ?? 0) - (b.start ?? 0));
  const revision = await exec("git", ["rev-parse", "HEAD"], { cwd: root }).then(result => result.stdout.trim(), () => null);
  return { root, revision, files: bound, digest: digest(bound) };
}

export async function evidenceCurrent(rootDir: string, state: EvidenceState): Promise<boolean> {
  try {
    if (!state?.files?.length || state.root !== await realpath(rootDir)) return false;
    const fresh = await bindEvidence(rootDir, state.files);
    return fresh.digest === state.digest;
  } catch { return false; }
}

export async function memoryEvidenceStatus(rootDir: string, node: MemoryNodeRow): Promise<"current" | "stale" | "unverified" | "superseded"> {
  const db = await getDB(rootDir);
  if (db.getMemoryEdgesForNode(node.id).some(edge => {
    try { return edge.source === node.id && edge.relation === "resolved_by" && JSON.parse(edge.metadata || "{}").relation_kind === "supersedes"; }
    catch { return false; }
  })) return "superseded";
  try {
    const metadata = JSON.parse(node.metadata);
    if (!metadata.source_evidence) return "unverified";
    const state = JSON.parse(metadata.source_evidence);
    if (!state.files?.length) return "unverified";
    if(metadata.configuration_paths && metadata.configuration_paths!==JSON.stringify(await evidenceConfigurationFiles(rootDir))) return "stale";
    if (!await evidenceCurrent(rootDir, state)) return "stale";
    return JSON.parse(metadata.unavailable_evidence ?? "[]").length ? "unverified" : "current";
  } catch { return "unverified"; }
}

export async function workspaceState(rootDir: string): Promise<EvidenceState> {
  const paths = async () => (await walkDirectory({ rootDir })).filter(entry => !entry.isDirectory).map(entry => entry.relativePath).sort();
  const before = await paths();
  const state = await bindEvidence(rootDir, before.map(file => ({ file })));
  if (JSON.stringify(before) !== JSON.stringify(await paths())) throw new Error("Workspace membership changed while taking the validation snapshot; retry.");
  return state;
}

export async function createValidationSnapshot(rootDir: string) {
  const state = await workspaceState(rootDir);
  return persistArtifact({ rootDir, kind: "validation_snapshot", key: randomUUID(), immutable: true,
    payload: { state, createdAt: new Date().toISOString(), scope: "ignore-aware workspace files; excludes ignored dependencies and build output" } });
}

export async function recordValidation(options: { rootDir: string; snapshotId: string; command: string; exitCode: number; runtime: string; evidence?: string }) {
  const snapshot = await readArtifact<{ state: EvidenceState }>(options.rootDir, options.snapshotId);
  if (!snapshot || snapshot.kind !== "validation_snapshot" || await realpath(snapshot.repoRoot) !== await realpath(options.rootDir)) throw new Error("Unknown validation snapshot for this workspace.");
  const current = await workspaceState(options.rootDir);
  const applicable = current.digest === snapshot.payload.state.digest && current.revision === snapshot.payload.state.revision;
  const payload = { snapshotId: options.snapshotId, command: options.command, exitCode: options.exitCode,
    runtime: options.runtime, evidence: (options.evidence ?? "").slice(0, 8000), reportedAt: new Date().toISOString(),
    provenance: "host-reported; ContextPro did not execute the command", applicable,
    result: options.exitCode === 0 ? "passed" : "failed" };
  const artifact = await persistArtifact({ rootDir: options.rootDir, kind: "validation_result", key: randomUUID(), immutable: true, payload });
  return { ...payload, artifact };
}

export async function validationState(rootDir: string, id: string): Promise<string> {
  const receipt = await readArtifact<{ snapshotId: string; result: string; applicable: boolean }>(rootDir, id);
  if (!receipt || receipt.kind !== "validation_result") return "unverified";
  if (!receipt.payload.applicable) return "stale";
  const snapshot = await readArtifact<{ state: EvidenceState }>(rootDir, receipt.payload.snapshotId);
  if (!snapshot) return "unverified";
  const current = await workspaceState(rootDir);
  return current.digest === snapshot.payload.state.digest && current.revision === snapshot.payload.state.revision
    ? `host-reported ${receipt.payload.result}` : "stale";
}
