// Optional per-user compute service. No source edits or network listener.
import { createConnection, createServer } from "node:net";
import { chmod, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { fork } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateSelectedRoot } from "./root-guard.js";
import { resolveProjectPath } from "./path-guard.js";

const PROTOCOL = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const directory = () => process.env.CONTEXTPRO_RUNTIME_DIR ?? join(homedir(), ".contextpro", "runtime");
const endpoint = () => process.platform === "win32"
  ? `\\\\.\\pipe\\contextpro-${createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}`
  : join(directory(), "compute.sock");
let identity: Promise<string> | undefined;
async function buildIdentity(): Promise<string> {
  return identity ??= (async () => {
    const hash = createHash("sha256").update(`protocol:${PROTOCOL};node:${process.versions.modules};`);
    const visit = async (path: string): Promise<void> => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.name.endsWith(".js")) hash.update(entry.name).update(await readFile(file));
      }
    };
    await visit(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    // Different provider/ignore/runtime policies cannot share global module state.
    for (const key of Object.keys(process.env).sort()) if (/^(?:CONTEXTPRO_|CONTEXTPLUS_|OLLAMA_|OPENAI_|ANTHROPIC_)/.test(key)
      && !/DAEMON|TRACE|IDLE|PARENT/.test(key)) hash.update(key).update(process.env[key] ?? "");
    return hash.digest("hex");
  })();
}

async function request(method: string, args: unknown): Promise<unknown> {
  if (process.platform === "win32") throw new Error("Shared compute requires a private Unix socket; local compute remains available on Windows.");
  const build = await buildIdentity();
  return new Promise((done, reject) => {
    const socket = createConnection(endpoint());
    socket.setEncoding("utf8");
    let buffer = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else done(value);
    };
    socket.setTimeout(65_000, () => finish(new Error("Shared service timed out.")));
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Shared service closed without a result.")));
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: PROTOCOL, build, method, args }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_BYTES) return finish(new Error("Shared service response exceeds capacity."));
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.error) finish(new Error(response.error)); else finish(undefined, response.result);
      } catch (error) { finish(error as Error); }
    });
  });
}

export async function sharedCompute<T>(method: "freshness" | "references" | "reindex" | "quickRefresh" | "compiler", args: unknown): Promise<{ value: T } | undefined> {
  if (process.env.CONTEXTPRO_DAEMON !== "true" || process.env.CONTEXTPRO_DAEMON_SERVER === "true") return;
  try { return { value: await request(method, args) as T }; }
  catch (error) {
    process.stderr.write(`[contextpro/daemon] ${String((error as Error).message).slice(0, 200)} Using local compute.\n`);
    return undefined;
  }
}

export async function daemonCommand(action: string): Promise<unknown> {
  if (!["start", "status", "stop"].includes(action)) throw new Error("Use daemon start|status|stop.");
  if (action !== "start") return request(action, {});
  try { return await request("status", {}); } catch (error) {
    if (!/ENOENT|ECONNREFUSED/.test(String(error))) throw error;
  }
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const child = fork(new URL(import.meta.url), ["--serve"], {
    detached: true, stdio: "ignore", execArgv: [], env: { ...process.env, CONTEXTPRO_DAEMON_SERVER: "true" },
  });
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; }); child.unref();
  for (let i = 0; i < 50; i++) {
    if (spawnError) throw spawnError;
    try { return await request("status", {}); } catch (error) {
      if (!/ENOENT|ECONNREFUSED/.test(String(error))) throw error;
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Shared service did not start; local compute remains available.");
}

const rootSchema = z.string().min(1).refine(value => resolve(value) === value, "Absolute root required");
const filesSchema = z.array(z.string()).max(20_000);
async function serve(): Promise<void> {
  const build = await buildIdentity();
  let active = 0, closing = false;
  let idle: NodeJS.Timeout;
  const stop = () => { closing = true; clearTimeout(idle); server.close(() => process.exit(0)); };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { if (!active) stop(); else touch(); }, 300_000); };
  const dispatch = async (method: string, args: unknown): Promise<unknown> => {
    if (method === "status") return { protocol: PROTOCOL, build, pid: process.pid, active, memory: process.memoryUsage(), closing };
    if (method === "stop") { setImmediate(stop); return { stopping: true }; }
    if (closing || active >= 16) throw new Error("Shared service busy; use local compute.");
    const root = z.object({ rootDir: rootSchema }).passthrough().parse(args).rootDir;
    validateSelectedRoot({ rootDir: root, source: "flag" });
    active++; touch();
    try {
      if (method === "freshness") return (await import("./index-freshness.js")).ensureFreshIndex(root);
      if (method === "references") {
        const input = z.object({ rootDir: rootSchema, files: filesSchema, file: z.string(), line: z.number().int().positive(), symbol: z.string().min(1), limit: z.number().optional() }).strict().parse(args);
        input.file = resolveProjectPath(root, input.file);
        input.files = input.files.map(file => resolveProjectPath(root, file));
        return await (await import("./typescript-reference-process.js")).queryTypeScriptReferences(input);
      }
      if (method === "reindex") {
        const input = z.object({ rootDir: rootSchema, targetPath: z.string().optional(), force: z.boolean().optional(), noEmbed: z.boolean().optional(), autoHubs: z.boolean().optional() }).strict().parse(args);
        return await (await import("../tools/reindex.js")).reindex(input);
      }
      if (method === "quickRefresh") {
        const input = z.object({ rootDir: rootSchema, options: z.object({ includeEmbeddings: z.boolean().optional() }).strict() }).strict().parse(args);
        return await (await import("../tools/reindex.js")).quickRefresh(root, input.options);
      }
      throw new Error("Unsupported shared operation.");
    } finally { active--; touch(); }
  };
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "", accepted = false;
    socket.setTimeout(70_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", async chunk => {
      if (accepted) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_BYTES) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      accepted = true;
      try {
        const input = z.object({ protocol: z.literal(PROTOCOL), build: z.literal(build), method: z.string(), args: z.unknown() }).strict().safeParse(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        if (!input.success) throw new Error("Incompatible service protocol/build/configuration. Stop it with its original installation.");
        const result = await dispatch(input.data.method, input.data.args);
        const output = JSON.stringify({ result }) + "\n";
        if (Buffer.byteLength(output) > MAX_BYTES) throw new Error("Shared result exceeds capacity.");
        socket.end(output);
      } catch (error) { socket.end(JSON.stringify({ error: (error as Error).message }) + "\n"); }
    });
  });
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory(), 0o700);
  // Remove only a refused stale endpoint, never a compatible or incompatible live service.
  try { await request("status", {}); return; } catch (error) {
    if (!/ENOENT|ECONNREFUSED/.test(String(error))) return;
    if (process.platform !== "win32" && /ECONNREFUSED/.test(String(error))) await unlink(endpoint()).catch(() => undefined);
  }
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(endpoint(), done); });
  if (process.platform !== "win32") await chmod(endpoint(), 0o600);
  touch();
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--serve") {
  await serve();
}
