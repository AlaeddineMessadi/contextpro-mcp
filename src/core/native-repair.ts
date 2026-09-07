// Recover native dependencies in a private ABI/version cache without changing shared node_modules.
import { execFile } from "child_process";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "fs/promises";
import { delimiter, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { getNativeRuntime } from "./native-runtime.js";

const execFileAsync = promisify(execFile);
const attemptedRepairKeys = new Set<string>();
const activeRepairs = new Map<string, Promise<boolean>>();
export interface NativeRepairAction { label: string; command: string; success: boolean; output: string; }

export function getContextPlusPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
export function isNativeAutoRepairEnabled(): boolean {
  const raw = (process.env.CONTEXTPRO_NATIVE_AUTO_REPAIR ?? process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR ?? "true").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}
export function isRepairableNativeError(code: string | undefined): boolean {
  return code === "native_module_missing" || code === "native_module_abi_mismatch" || code === "native_module_error";
}

async function runCommand(root: string, label: string, command: string, args: string[]): Promise<NativeRepairAction> {
  // Pin lifecycle scripts to the host runtime too. Inherited Electron/node-gyp
  // targeting variables must not produce another host's ABI in this cache.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter) };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(target|runtime|arch|target_arch|platform|target_platform|disturl|dist_url|nodedir)$/i.test(key)) delete env[key];
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    return { label, command: [command, ...args].join(" "), success: true, output: [stdout, stderr].filter(Boolean).join("\n").trim() };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return { label, command: [command, ...args].join(" "), success: false, output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n").trim() };
  }
}

async function resolveNpmCli(): Promise<string> {
  const candidates = [
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, "npm")),
  ];
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      if (path.endsWith(".js")) { await access(path); return path; }
    } catch { /* Try the next installation. */ }
  }
  throw new Error(`Cannot locate npm-cli.js. Install npm, then run ContextPro doctor --fix with ${process.execPath}.`);
}

async function validateRuntime(directory: string): Promise<NativeRepairAction> {
  return runCommand(directory, "verify-isolated-native-deps", process.execPath, ["-e", `
    const Database = require('./node_modules/better-sqlite3');
    const vec = require('./node_modules/sqlite-vec');
    const db = new Database(':memory:');
    try { vec.load(db); db.prepare('SELECT vec_version()').get(); } finally { db.close(); }
  `]);
}

async function withRepairLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(directory), { recursive: true });
  const lock = `${directory}.lock`;
  const deadline = Date.now() + 240_000;
  while (true) {
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lock, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (pidError) {
            if ((pidError as NodeJS.ErrnoException).code === "ESRCH") await unlink(lock).catch(() => undefined);
          }
        }
      } catch { // Give a newly created lock time to receive its owner metadata.
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 240_000) await unlink(lock).catch(() => undefined);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for native runtime repair: ${directory}`);
      await new Promise((done) => setTimeout(done, 100));
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await fn(); }
    finally { await handle.close(); await unlink(lock).catch(() => undefined); }
  }
}

export async function repairNativeDependencies(rootDir: string, _issueCode?: string): Promise<NativeRepairAction[]> {
  const runtime = getNativeRuntime(rootDir);
  return withRepairLock(runtime.directory, async () => {
    // Another process may have completed the same ABI repair while we waited.
    const existing = await validateRuntime(runtime.directory);
    if (existing.success) return [existing];
    const actions: NativeRepairAction[] = [];
    const staging = await mkdtemp(`${runtime.directory}.staging-`);
    try {
      await writeFile(join(staging, "package.json"), JSON.stringify({ name: "contextpro-native-runtime", version: "1.0.0", private: true, dependencies: runtime.dependencies }));
      const npmCli = await resolveNpmCli();
      actions.push(await runCommand(staging, "install-isolated-native-deps", process.execPath, [npmCli, "install", "--foreground-scripts", "--no-audit", "--no-fund", "--package-lock=false"]));
      if (!actions.at(-1)?.success) return actions;
      actions.push(await validateRuntime(staging));
      if (!actions.at(-1)?.success) return actions;
      await rm(runtime.directory, { recursive: true, force: true });
      await rename(staging, runtime.directory);
      return actions;
    } finally { await rm(staging, { recursive: true, force: true }); }
  });
}

export async function attemptNativeAutoRepair(issueCode: string | undefined, rootDir: string = getContextPlusPackageRoot()): Promise<boolean> {
  if (!isNativeAutoRepairEnabled() || !isRepairableNativeError(issueCode)) return false;
  const key = getNativeRuntime(rootDir).directory;
  const active = activeRepairs.get(key);
  if (active) return active;
  if (attemptedRepairKeys.has(key)) return false;
  attemptedRepairKeys.add(key);
  if (attemptedRepairKeys.size > 200) attemptedRepairKeys.delete(attemptedRepairKeys.values().next().value!);
  const repair = (async () => {
    process.stderr.write(`[contextpro/native-repair] preparing isolated SQLite runtime for Node ${process.version} (ABI ${process.versions.modules})\n`);
    try {
      const actions = await repairNativeDependencies(rootDir, issueCode);
      const ok = actions.at(-1)?.success === true;
      if (!ok) process.stderr.write(`[contextpro/native-repair] failed: ${actions.at(-1)?.output.slice(-2000)}\n`);
      return ok;
    } catch (error) {
      process.stderr.write(`[contextpro/native-repair] failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    } finally { activeRepairs.delete(key); }
  })();
  activeRepairs.set(key, repair);
  return repair;
}
