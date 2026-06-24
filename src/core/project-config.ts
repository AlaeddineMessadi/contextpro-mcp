// Project identity, verification, registry, and pattern promotion utilities
// FEATURE: Trust foundation for multi-project and multi-client ContextPro usage

import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { promisify } from "util";
import { CONTEXTPRO_DIR } from "./data-dir.js";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = "config.json";
const REGISTRY_DIR = CONTEXTPRO_DIR;
const LEGACY_REGISTRY_DIR = ".contextplus";
const REGISTRY_FILE = "workspace-registry.json";
const PATTERN_FILE = "promoted-patterns.json";
const CONFIG_VERSION = 1;

export type ContextScope = "session" | "project" | "client" | "global";

export interface ProjectConfig {
  version: number;
  clientId: string | null;
  projectId: string;
  workspaceRoot: string;
  gitRoot: string;
  repoFingerprint: string;
  sessionSource: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  embedModel?: string;
  chatModel?: string;
  [key: string]: unknown;
}

export interface VerifiedProjectContext {
  rootDir: string;
  gitRoot: string;
  config: ProjectConfig;
  verifiedAt: string;
}

export interface WorkspaceRegistryEntry {
  clientId: string | null;
  projectId: string;
  workspaceRoot: string;
  gitRoot: string;
  repoFingerprint: string;
  sessionSource: string;
  lastActiveAt: string;
}

export interface PromotedPattern {
  patternId: string;
  targetScope: "client" | "global";
  clientId: string | null;
  projectId: string;
  sourceMemoryId: string;
  summary: string;
  sanitized: boolean;
  linkedSource: string;
  createdAt: string;
}

export interface EnsureProjectConfigOptions {
  rootDir: string;
  clientId?: string | null;
  projectId?: string;
  sessionSource?: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeNullable(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultProjectId(rootDir: string): string {
  return basename(resolve(rootDir)).replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase() || "project";
}

function registryBaseDir(): string {
  return join(homedir(), REGISTRY_DIR);
}

function registryPath(): string {
  return join(registryBaseDir(), REGISTRY_FILE);
}

function patternPath(): string {
  return join(registryBaseDir(), PATTERN_FILE);
}

function legacyRegistryPath(fileName: string): string {
  return join(homedir(), LEGACY_REGISTRY_DIR, fileName);
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function readRegistryFile<T>(fileName: string, fallback: T): Promise<T> {
  const current = await readJsonFile<T | null>(join(registryBaseDir(), fileName), null);
  if (current !== null) return current;
  return readJsonFile<T>(legacyRegistryPath(fileName), fallback);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function detectGitRoot(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: rootDir,
      timeout: 4000,
    });
    const gitRoot = stdout.trim();
    return gitRoot.length > 0 ? resolve(gitRoot) : resolve(rootDir);
  } catch {
    return resolve(rootDir);
  }
}

async function detectGitRemote(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: rootDir,
      timeout: 4000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function computeRepoFingerprint(input: {
  workspaceRoot: string;
  gitRoot: string;
  projectId: string;
  clientId: string | null;
  remoteUrl: string;
}): string {
  const raw = [
    input.workspaceRoot,
    input.gitRoot,
    input.projectId,
    input.clientId ?? "",
    input.remoteUrl,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function migrateProjectConfig(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const incomingVersion = typeof raw.version === "number" ? raw.version : 0;
  if (incomingVersion === CONFIG_VERSION) return raw;
  if (incomingVersion < CONFIG_VERSION) {
    return { ...raw, version: CONFIG_VERSION };
  }
  process.stderr.write(`[contextpro/project-config] config version ${incomingVersion} is newer than supported ${CONFIG_VERSION}; reading as-is\n`);
  return raw;
}

export async function loadProjectConfig(rootDir: string): Promise<ProjectConfig | null> {
  const configPath = join(resolve(rootDir), CONTEXTPRO_DIR, CONFIG_FILE);
  const raw = await readJsonFile<Record<string, unknown> | null>(configPath, null);
  const migrated = migrateProjectConfig(raw);
  return migrated as ProjectConfig | null;
}

export async function ensureProjectConfig(options: EnsureProjectConfigOptions): Promise<ProjectConfig> {
  const workspaceRoot = resolve(options.rootDir);
  const gitRoot = await detectGitRoot(workspaceRoot);
  const remoteUrl = await detectGitRemote(workspaceRoot);
  const configPath = join(workspaceRoot, CONTEXTPRO_DIR, CONFIG_FILE);
  const rawExisting = await readJsonFile<Record<string, unknown> | null>(configPath, null);
  const existing = migrateProjectConfig(rawExisting);
  const projectId = normalizeNullable(options.projectId) ?? stringField(existing, "projectId") ?? defaultProjectId(workspaceRoot);
  const clientId = normalizeNullable(options.clientId) ?? normalizeNullable(stringField(existing, "clientId")) ?? null;
  const sessionSource = normalizeNullable(options.sessionSource) ?? stringField(existing, "sessionSource") ?? "mcp";
  const repoFingerprint = computeRepoFingerprint({
    workspaceRoot,
    gitRoot,
    projectId,
    clientId,
    remoteUrl,
  });
  const createdAt = stringField(existing, "createdAt") ?? new Date().toISOString();
  const config: ProjectConfig = {
    ...(existing ?? {}),
    version: CONFIG_VERSION,
    clientId,
    projectId,
    workspaceRoot,
    gitRoot,
    repoFingerprint,
    sessionSource,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(join(workspaceRoot, CONTEXTPRO_DIR), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return config;
}

export async function verifyProjectContext(rootDir: string): Promise<VerifiedProjectContext> {
  const workspaceRoot = resolve(rootDir);
  const config = await ensureProjectConfig({
    rootDir: workspaceRoot,
    clientId: process.env.CONTEXTPRO_CLIENT_ID ?? process.env.CONTEXTPLUS_CLIENT_ID,
    projectId: process.env.CONTEXTPRO_PROJECT_ID ?? process.env.CONTEXTPLUS_PROJECT_ID,
    sessionSource: process.env.CONTEXTPRO_SESSION_SOURCE ?? process.env.CONTEXTPLUS_SESSION_SOURCE ?? "mcp",
  });
  const actualGitRoot = await detectGitRoot(workspaceRoot);
  if (config.workspaceRoot !== workspaceRoot) {
    throw new Error(`Project config workspace root mismatch. Expected ${config.workspaceRoot}, got ${workspaceRoot}.`);
  }
  if (config.gitRoot !== actualGitRoot) {
    throw new Error(`Project config git root mismatch. Expected ${config.gitRoot}, got ${actualGitRoot}.`);
  }
  const remoteUrl = await detectGitRemote(workspaceRoot);
  const actualFingerprint = computeRepoFingerprint({
    workspaceRoot,
    gitRoot: actualGitRoot,
    projectId: config.projectId,
    clientId: config.clientId,
    remoteUrl,
  });
  if (config.repoFingerprint !== actualFingerprint) {
    throw new Error(`Project fingerprint mismatch for ${workspaceRoot}. Re-run init or update .contextpro/config.json.`);
  }
  return {
    rootDir: workspaceRoot,
    gitRoot: actualGitRoot,
    config,
    verifiedAt: new Date().toISOString(),
  };
}

export async function registerWorkspace(entry: ProjectConfig): Promise<void> {
  const path = registryPath();
  const items = await readRegistryFile<WorkspaceRegistryEntry[]>(REGISTRY_FILE, []);
  const now = new Date().toISOString();
  const next: WorkspaceRegistryEntry = {
    clientId: entry.clientId,
    projectId: entry.projectId,
    workspaceRoot: entry.workspaceRoot,
    gitRoot: entry.gitRoot,
    repoFingerprint: entry.repoFingerprint,
    sessionSource: entry.sessionSource,
    lastActiveAt: now,
  };
  const filtered = items.filter((item) => item.workspaceRoot !== entry.workspaceRoot);
  filtered.push(next);
  filtered.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  await mkdir(registryBaseDir(), { recursive: true });
  await writeFile(path, JSON.stringify(filtered, null, 2) + "\n", "utf-8");
}

const KNOWN_CLI_SUBCOMMANDS = new Set([
  "init", "skeleton", "tree", "doctor", "reindex", "status", "search", "help",
  "version", "--help", "-h", "--version", "-v", "list", "ls",
]);

function looksLikeCliFlag(projectId: string): boolean {
  if (!projectId) return true;
  if (projectId.startsWith("-")) return true;
  if (KNOWN_CLI_SUBCOMMANDS.has(projectId.toLowerCase())) return true;
  return false;
}

export async function listRegisteredWorkspaces(clientId?: string): Promise<WorkspaceRegistryEntry[]> {
  const items = await readRegistryFile<WorkspaceRegistryEntry[]>(REGISTRY_FILE, []);
  // Filter out phantom projects created by accidental CLI invocations like
  // `npx contextpro --help` or `npx contextpro reindex` outside any project.
  const filtered = items.filter((item) => !looksLikeCliFlag(item.projectId ?? ""));
  if (!clientId) return filtered;
  return filtered.filter((item) => item.clientId === clientId);
}

export async function createPromotedPattern(input: {
  sourceMemoryId: string;
  targetScope: "client" | "global";
  clientId: string | null;
  projectId: string;
  summary: string;
  sanitize: boolean;
}): Promise<PromotedPattern> {
  const items = await readRegistryFile<PromotedPattern[]>(PATTERN_FILE, []);
  const pattern: PromotedPattern = {
    patternId: generateId("pattern"),
    targetScope: input.targetScope,
    clientId: input.clientId,
    projectId: input.projectId,
    sourceMemoryId: input.sourceMemoryId,
    summary: input.summary,
    sanitized: input.sanitize,
    linkedSource: input.sourceMemoryId,
    createdAt: new Date().toISOString(),
  };
  items.push(pattern);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await mkdir(registryBaseDir(), { recursive: true });
  await writeFile(patternPath(), JSON.stringify(items, null, 2) + "\n", "utf-8");
  return pattern;
}

export async function listPromotedPatterns(clientId?: string): Promise<PromotedPattern[]> {
  const items = await readRegistryFile<PromotedPattern[]>(PATTERN_FILE, []);
  if (!clientId) return items;
  return items.filter((item) => item.clientId === clientId || item.targetScope === "global");
}
