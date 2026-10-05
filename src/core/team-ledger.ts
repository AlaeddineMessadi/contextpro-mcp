// Local, advisory coordination. SQLite transactions arbitrate claims; no agent execution.
import { ensureNativeStorage, loadNativeStorageBindings } from "./db-native.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, realpath } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, relative } from "node:path";
import { detectWorktreeInfo } from "./project-config.js";
import { resolveProjectPath } from "./path-guard.js";
import { readArtifact } from "./artifacts.js";

const LEASE_MS = 300_000;
type State = "queued" | "active" | "blocked" | "completed";
interface Task { id: string; title: string; state: State; dependencies: string; owner: string | null; root: string; expires: number; files: string; handoff: string | null }
export interface TeamTaskOptions {
  rootDir: string; action: "create" | "update" | "claim" | "renew" | "release" | "block" | "complete" | "handoff";
  taskId?: string; title?: string; dependencies?: string[]; owner?: string; files?: string[]; note?: string; handoffId?: string;
}
async function ledger(rootDir: string) {
  const root = await realpath(rootDir), worktree = await detectWorktreeInfo(root);
  const identity = await realpath(worktree.gitCommonDir).catch(() => root);
  const directory = join(process.env.CONTEXTPRO_TEAM_DIR ?? join(homedir(), ".contextpro", "teams"), createHash("sha256").update(identity).digest("hex").slice(0, 24));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureNativeStorage();
  const { Database } = loadNativeStorageBindings();
  const db = new Database(join(directory, "tasks.db"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','active','blocked','completed')),
    dependencies TEXT NOT NULL, owner TEXT, root TEXT NOT NULL, expires INTEGER NOT NULL, files TEXT NOT NULL, handoff TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, owner TEXT, root TEXT NOT NULL, note TEXT NOT NULL);`);
  return { db, root };
}
const effectiveState = (task: Task, now: number): State => task.state === "active" && task.expires <= now ? "queued" : task.state;
const describe = (task: Task, all: Task[], now: number) => ({ ...task, state: effectiveState(task, now),
  leaseExpired: task.state === "active" && task.expires <= now,
  dependencies: JSON.parse(task.dependencies) as string[], files: JSON.parse(task.files) as string[],
  ready: effectiveState(task, now) === "queued" && (JSON.parse(task.dependencies) as string[]).every(id => all.some(item => item.id === id && item.state === "completed")),
});

export async function teamStatus(rootDir: string, now = Date.now()) {
  const { db, root } = await ledger(rootDir);
  try {
    const all = db.prepare("SELECT * FROM tasks ORDER BY id").all() as Task[];
    return { root, advisory: true, total: all.length, omitted: Math.max(0, all.length - 100), tasks: all.slice(0, 100).map(task => describe(task, all, now)),
      readyTaskIds: all.filter(task => describe(task, all, now).ready).slice(0, 100).map(task => task.id),
      events: db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 20").all() };
  } finally { db.close(); }
}

export async function teamTask(options: TeamTaskOptions, now = Date.now()) {
  const { db, root } = await ledger(options.rootDir);
  try {
    const files = [...new Set((options.files ?? []).map(file => {
      const path = relative(root, resolveProjectPath(root, file, "advisory lease")).split("\\").join("/");
      if (!path || path === ".") throw new Error("Lease individual files, not an entire root.");
      try { if (statSync(resolveProjectPath(root, path)).isDirectory()) throw new Error("Lease individual files, not directories."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return path;
    }))];
    let handoff: string | undefined;
    if (options.action === "handoff") {
      const artifact = options.handoffId ? await readArtifact(root, options.handoffId) : null;
      if (!artifact || artifact.kind !== "handoff" || await realpath(artifact.repoRoot) !== root) throw new Error("A handoff artifact from this workspace is required.");
      handoff = JSON.stringify({ id: artifact.id, root });
    }
    return db.transaction(() => {
      const all = db.prepare("SELECT * FROM tasks").all() as Task[];
      const id = options.taskId ?? (options.action === "create" ? randomUUID() : "");
      let task = all.find(item => item.id === id);
      const dependencies = [...new Set(options.dependencies ?? [])];
      if (options.action === "create") {
        if (task) throw new Error("Task already exists.");
        if (!options.title?.trim()) throw new Error("Task title is required.");
        task = { id, title: options.title, state: "queued", dependencies: JSON.stringify(dependencies), owner: null, root, expires: 0, files: "[]", handoff: null };
      } else if (!task) throw new Error("Unknown task.");
      else task = { ...task };
      const owned = task.expires > now && task.owner !== null;
      if (owned && task.owner !== options.owner) throw new Error(`Task is owned by ${task.owner}; renew or release through that owner.`);
      if (options.action === "update") {
        if (options.title !== undefined) task.title = options.title;
        if (options.dependencies !== undefined) task.dependencies = JSON.stringify(dependencies);
      }
      const proposed = all.filter(item => item.id !== id).concat(task);
      const visited = new Set<string>();
      const visit = (key: string, path: Set<string>): void => {
        if (path.has(key)) throw new Error("Task dependencies form a cycle.");
        if (visited.has(key)) return;
        const item = proposed.find(value => value.id === key);
        if (!item) throw new Error(`Unknown dependency: ${key}`);
        const next = new Set(path); next.add(key);
        for (const dependency of JSON.parse(item.dependencies) as string[]) visit(dependency, next);
        visited.add(key);
      };
      visit(id, new Set());
      const warnings: string[] = [];
      if (["claim", "renew"].includes(options.action)) {
        if (!options.owner?.trim()) throw new Error("An explicit agent owner is required.");
        if (options.action === "renew" && (!owned || task.owner !== options.owner || task.root !== root)) throw new Error("Cannot renew an expired or foreign lease; claim the task again.");
        if (task.state === "completed" || task.state === "blocked") throw new Error("Completed or blocked task cannot be claimed; update its dependencies or release it first.");
        if ((JSON.parse(task.dependencies) as string[]).some(dep => !all.some(item => item.id === dep && item.state === "completed"))) throw new Error("Task dependencies are incomplete.");
        const leased = options.action === "renew" && options.files === undefined ? JSON.parse(task.files) as string[] : files;
        for (const other of all.filter(item => item.id !== id && item.expires > now)) {
          const overlap = leased.filter(file => (JSON.parse(other.files) as string[]).includes(file));
          if (!overlap.length) continue;
          if (other.root === root) throw new Error(`File lease conflict with ${other.id}: ${overlap.join(", ")}`);
          warnings.push(`Other worktree ${other.root} has overlapping work in ${other.id}: ${overlap.join(", ")}`);
        }
        task.state = "active"; task.owner = options.owner; task.root = root; task.files = JSON.stringify(leased); task.expires = now + LEASE_MS;
      } else if (["release", "block", "complete", "handoff"].includes(options.action)) {
        if (options.action !== "release" && (!owned || task.owner !== options.owner || task.root !== root)) throw new Error("An active claim in this worktree is required.");
        if (options.action === "handoff") task.handoff = handoff!;
        else { task.state = options.action === "complete" ? "completed" : options.action === "block" ? "blocked" : "queued"; task.owner = null; task.expires = 0; task.files = "[]"; }
      }
      db.prepare("INSERT OR REPLACE INTO tasks VALUES (@id,@title,@state,@dependencies,@owner,@root,@expires,@files,@handoff)").run(task);
      db.prepare("INSERT INTO events(task_id,at,action,owner,root,note) VALUES(?,?,?,?,?,?)").run(id, now, options.action, options.owner ?? null, root, options.note ?? "");
      return { task: describe(task, proposed, now), warnings, advisory: true, leaseMs: LEASE_MS };
    }).immediate();
  } finally { db.close(); }
}
