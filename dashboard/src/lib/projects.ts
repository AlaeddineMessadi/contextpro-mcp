// Project/workspace enumeration for the dashboard.
//
// The MCP records every indexed workspace in a per-user registry. We read it to
// offer a project switcher, and fall back to the dashboard's own CWD / an env
// override so it works even before any registry exists.

import { readFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface DashboardProject {
  projectId: string | null;
  clientId: string | null;
  root: string;
  gitRoot: string | null;
  lastActiveAt: string | null;
  /** Whether a .contextpro/index.db actually exists for this root right now. */
  hasIndex: boolean;
}

const REGISTRY_PATHS = [
  join(homedir(), ".contextpro", "workspace-registry.json"),
  join(homedir(), ".contextplus", "workspace-registry.json"),
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readRegistry(): Promise<Array<Record<string, unknown>>> {
  for (const path of REGISTRY_PATHS) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
      if (Array.isArray((parsed as { workspaces?: unknown }).workspaces)) {
        return (parsed as { workspaces: Array<Record<string, unknown>> }).workspaces;
      }
    } catch {
      // try next
    }
  }
  return [];
}

export function dbPathFor(root: string): string {
  return join(root, ".contextpro", "index.db");
}

/** All known projects, annotated with whether their index DB currently exists. */
export async function listProjects(): Promise<DashboardProject[]> {
  const entries = await readRegistry();
  const projects: DashboardProject[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const root = (entry.workspaceRoot ?? entry.root ?? entry.gitRoot) as string | undefined;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    projects.push({
      projectId: (entry.projectId as string) ?? null,
      clientId: (entry.clientId as string) ?? null,
      root,
      gitRoot: (entry.gitRoot as string) ?? null,
      lastActiveAt: (entry.lastActiveAt as string) ?? null,
      hasIndex: await exists(dbPathFor(root)),
    });
  }

  // Always include an explicit override / CWD fallback so the dashboard is useful
  // even with an empty registry (e.g. pointed straight at one repo).
  const fallbackRoot = process.env.CONTEXTPRO_DASHBOARD_ROOT ?? process.cwd();
  if (!seen.has(fallbackRoot) && (await exists(dbPathFor(fallbackRoot)))) {
    projects.unshift({
      projectId: null,
      clientId: null,
      root: fallbackRoot,
      gitRoot: null,
      lastActiveAt: null,
      hasIndex: true,
    });
  }

  // Indexed projects first, then most-recently-active.
  return projects.sort((a, b) => {
    if (a.hasIndex !== b.hasIndex) return a.hasIndex ? -1 : 1;
    return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
  });
}

/** Resolve the root a request is asking about, defaulting to the first project. */
export async function resolveRoot(requested: string | null): Promise<string | null> {
  if (requested) return requested;
  if (process.env.CONTEXTPRO_DASHBOARD_ROOT) return process.env.CONTEXTPRO_DASHBOARD_ROOT;
  const projects = await listProjects();
  return projects.find((p) => p.hasIndex)?.root ?? projects[0]?.root ?? process.cwd();
}
