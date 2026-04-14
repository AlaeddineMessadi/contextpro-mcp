// Persistent artifact storage for reusable agent context packets and summaries
// FEATURE: Artifact cache — stable IDs for low-token reuse across MCP turns

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

export interface ArtifactReference {
  id: string;
  kind: string;
  key: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredArtifact<T = unknown> extends ArtifactReference {
  repoRoot: string;
  repoFingerprint: string | null;
  projectId: string | null;
  clientId: string | null;
  metadata: Record<string, string>;
  payload: T;
}

interface ArtifactManifest {
  artifacts: ArtifactReference[];
}

interface PersistArtifactOptions<T = unknown> {
  rootDir: string;
  kind: string;
  key: string;
  repoFingerprint?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  metadata?: Record<string, string>;
  payload: T;
}

const ARTIFACT_DIR = ".contextplus/artifacts";
const MANIFEST_FILE = "manifest.json";

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function artifactBaseDir(rootDir: string): string {
  return resolve(rootDir, ARTIFACT_DIR);
}

function manifestPath(rootDir: string): string {
  return join(artifactBaseDir(rootDir), MANIFEST_FILE);
}

function buildArtifactId(kind: string, key: string, repoFingerprint?: string | null): string {
  const hash = createHash("sha256")
    .update(`${kind}|${repoFingerprint ?? "no-fingerprint"}|${key}`)
    .digest("hex")
    .slice(0, 14);
  return `${kind}-${hash}`;
}

export async function persistArtifact<T>(options: PersistArtifactOptions<T>): Promise<ArtifactReference> {
  const baseDir = artifactBaseDir(options.rootDir);
  const kindDir = join(baseDir, options.kind);
  const id = buildArtifactId(options.kind, options.key, options.repoFingerprint);
  const artifactFile = join(kindDir, `${id}.json`);
  const existing = await readArtifact<T>(options.rootDir, id);
  const now = new Date().toISOString();
  const record: StoredArtifact<T> = {
    id,
    kind: options.kind,
    key: options.key,
    path: artifactFile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    repoRoot: resolve(options.rootDir),
    repoFingerprint: options.repoFingerprint ?? null,
    projectId: options.projectId ?? null,
    clientId: options.clientId ?? null,
    metadata: options.metadata ?? {},
    payload: options.payload,
  };

  await mkdir(kindDir, { recursive: true });
  await writeFile(artifactFile, JSON.stringify(record, null, 2) + "\n", "utf-8");

  const manifest = await readJsonFile<ArtifactManifest>(manifestPath(options.rootDir), { artifacts: [] });
  const nextRef: ArtifactReference = {
    id: record.id,
    kind: record.kind,
    key: record.key,
    path: record.path,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  const filtered = manifest.artifacts.filter((artifact) => artifact.id !== id);
  filtered.unshift(nextRef);
  await mkdir(baseDir, { recursive: true });
  await writeFile(manifestPath(options.rootDir), JSON.stringify({ artifacts: filtered }, null, 2) + "\n", "utf-8");
  return nextRef;
}

export async function readArtifact<T = unknown>(rootDir: string, artifactId: string): Promise<StoredArtifact<T> | null> {
  const manifest = await readJsonFile<ArtifactManifest>(manifestPath(rootDir), { artifacts: [] });
  const ref = manifest.artifacts.find((artifact) => artifact.id === artifactId);
  if (!ref) return null;
  return readJsonFile<StoredArtifact<T> | null>(ref.path, null);
}

export async function listArtifacts(rootDir: string, kind?: string, limit: number = 20): Promise<ArtifactReference[]> {
  const manifest = await readJsonFile<ArtifactManifest>(manifestPath(rootDir), { artifacts: [] });
  return manifest.artifacts
    .filter((artifact) => !kind || artifact.kind === kind)
    .slice(0, Math.max(1, limit));
}
