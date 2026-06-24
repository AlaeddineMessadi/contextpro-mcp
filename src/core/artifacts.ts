// Persistent artifact storage for reusable agent context packets and summaries
// FEATURE: Artifact cache — stable IDs for low-token reuse across MCP turns

import { createHash } from "crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";

/**
 * Atomic file write: write to a unique temp file then rename over the target. A crash mid-write
 * leaves the (untouched) original or the temp file, never a half-written target.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, data, "utf-8");
  try {
    await rename(tmp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" || (err as NodeJS.ErrnoException).code === "EPERM") {
      await unlink(target).catch(() => undefined);
      await rename(tmp, target);
    } else {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

export interface ArtifactReference {
  id: string;
  kind: string;
  key: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  indexGeneration?: number;
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
  indexGeneration?: number;
}

const ARTIFACT_DIR = ".contextpro/artifacts";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_LOCK_FILE = "manifest.lock";
const LOCK_RETRY_MS = 40;
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_AGE_MS = 30_000;
const MAX_ARTIFACTS_PER_MANIFEST = 200;

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

function manifestLockPath(rootDir: string): string {
  return join(artifactBaseDir(rootDir), MANIFEST_LOCK_FILE);
}

function buildArtifactId(kind: string, key: string, repoFingerprint?: string | null): string {
  const hash = createHash("sha256")
    .update(`${kind}|${repoFingerprint ?? "no-fingerprint"}|${key}`)
    .digest("hex")
    .slice(0, 14);
  return `${kind}-${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withManifestLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const baseDir = artifactBaseDir(rootDir);
  await mkdir(baseDir, { recursive: true });
  const lockPath = manifestLockPath(rootDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf-8");
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      // Stale-lock detection: if the lock file is older than STALE_LOCK_AGE_MS, an earlier
      // process crashed before releasing it. Clear it and retry. Without this we'd block until
      // LOCK_TIMEOUT_MS just because of a crashed prior process.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const statMod = await import("node:fs/promises");
          const lockStats = await statMod.stat(lockPath).catch(() => null);
          if (lockStats && Date.now() - lockStats.mtimeMs > STALE_LOCK_AGE_MS) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          // best-effort stale check
        }
      }
      if (Date.now() >= deadline) throw error;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function scanArtifactsOnDisk(rootDir: string): Promise<ArtifactReference[]> {
  const baseDir = artifactBaseDir(rootDir);
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const artifacts: ArtifactReference[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const kindDir = join(baseDir, entry.name);
      const files = await readdir(kindDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const fullPath = join(kindDir, file.name);
        const parsed = await readJsonFile<StoredArtifact | null>(fullPath, null);
        if (!parsed?.id || !parsed.kind || !parsed.key) continue;
        artifacts.push({
          id: parsed.id,
          kind: parsed.kind,
          key: parsed.key,
          path: fullPath,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
        });
      }
    }
    return artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  } catch {
    return [];
  }
}

async function loadManifestWithRepair(rootDir: string): Promise<ArtifactManifest> {
  const manifest = await readJsonFile<ArtifactManifest>(manifestPath(rootDir), { artifacts: [] });
  const existing = manifest.artifacts.filter((artifact) => Boolean(artifact?.id && artifact?.path));
  const diskArtifacts = await scanArtifactsOnDisk(rootDir);
  const merged = new Map<string, ArtifactReference>();

  for (const artifact of existing) merged.set(artifact.id, artifact);
  for (const artifact of diskArtifacts) {
    const current = merged.get(artifact.id);
    if (!current || artifact.updatedAt > current.updatedAt) merged.set(artifact.id, artifact);
  }

  return {
    artifacts: [...merged.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)),
  };
}

/**
 * Canonical JSON serializer used to build artifact keys. Sorts object keys, drops empty arrays
 * and null/undefined values so that `includeKinds: []`, `includeKinds: undefined`, and missing
 * fields all produce the same key (and therefore the same cached artifact).
 */
export function canonicalArtifactKey(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) {
      const arr = v.map(normalize).filter((item) => item !== undefined);
      return arr.length === 0 ? undefined : arr;
    }
    if (typeof v === "object") {
      const obj: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>).sort();
      for (const k of keys) {
        const nv = normalize((v as Record<string, unknown>)[k]);
        if (nv !== undefined) obj[k] = nv;
      }
      return Object.keys(obj).length === 0 ? undefined : obj;
    }
    return v;
  };
  const normalized = normalize(value);
  return JSON.stringify(normalized ?? {});
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
    indexGeneration: options.indexGeneration,
    repoRoot: resolve(options.rootDir),
    repoFingerprint: options.repoFingerprint ?? null,
    projectId: options.projectId ?? null,
    clientId: options.clientId ?? null,
    metadata: options.metadata ?? {},
    payload: options.payload,
  };

  await mkdir(kindDir, { recursive: true });
  await writeFileAtomic(artifactFile, JSON.stringify(record, null, 2) + "\n");

  const nextRef: ArtifactReference = {
    id: record.id,
    kind: record.kind,
    key: record.key,
    path: record.path,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    indexGeneration: record.indexGeneration,
  };

  await withManifestLock(options.rootDir, async () => {
    const manifest = await loadManifestWithRepair(options.rootDir);
    const filtered = manifest.artifacts.filter((artifact) => artifact.id !== id);
    filtered.unshift(nextRef);
    // LRU eviction: keep at most MAX_ARTIFACTS_PER_MANIFEST entries.
    const trimmed = filtered.slice(0, MAX_ARTIFACTS_PER_MANIFEST);
    await mkdir(baseDir, { recursive: true });
    await writeFileAtomic(manifestPath(options.rootDir), JSON.stringify({ artifacts: trimmed }, null, 2) + "\n");
  });

  return nextRef;
}

/**
 * Read an artifact only if it's still fresh for the given index generation. When the stored
 * artifact's indexGeneration is older than `currentGeneration`, returns null so the caller
 * recomputes instead of serving stale rankings.
 */
export async function readArtifactIfFresh<T = unknown>(
  rootDir: string,
  artifactId: string,
  currentGeneration: number,
): Promise<StoredArtifact<T> | null> {
  const record = await readArtifact<T>(rootDir, artifactId);
  if (!record) return null;
  if (record.indexGeneration !== undefined && record.indexGeneration < currentGeneration) {
    return null;
  }
  return record;
}

function migrateLegacyArtifactPath(path: string): string {
  // .contextplus was renamed to .contextpro in 1.2.0; manifest entries written before the rename
  // still carry the old path string. Rewrite on read so the user never sees the stale path.
  return path.replace(/(^|\/)\.contextplus(\/|$)/g, "$1.contextpro$2");
}

function migrateReference(ref: ArtifactReference): ArtifactReference {
  const migrated = migrateLegacyArtifactPath(ref.path);
  return migrated === ref.path ? ref : { ...ref, path: migrated };
}

export async function readArtifact<T = unknown>(rootDir: string, artifactId: string): Promise<StoredArtifact<T> | null> {
  const manifest = await loadManifestWithRepair(rootDir);
  const ref = manifest.artifacts.find((artifact) => artifact.id === artifactId);
  if (ref) {
    const migratedPath = migrateLegacyArtifactPath(ref.path);
    const record = await readJsonFile<StoredArtifact<T> | null>(migratedPath, null);
    if (record) return record;
    if (migratedPath !== ref.path) {
      const original = await readJsonFile<StoredArtifact<T> | null>(ref.path, null);
      if (original) return original;
    }
  }

  const fallback = (await scanArtifactsOnDisk(rootDir)).find((artifact) => artifact.id === artifactId);
  if (!fallback) return null;
  return readJsonFile<StoredArtifact<T> | null>(fallback.path, null);
}

export async function listArtifacts(rootDir: string, kind?: string, limit: number = 20): Promise<ArtifactReference[]> {
  const manifest = await loadManifestWithRepair(rootDir);
  return manifest.artifacts
    .map(migrateReference)
    .filter((artifact) => !kind || artifact.kind === kind)
    .slice(0, Math.max(1, limit));
}
