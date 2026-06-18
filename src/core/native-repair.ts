// Native dependency repair helpers — rebuild/install native SQLite bindings for the active Node runtime
// FEATURE: Startup self-healing — recover from better-sqlite3 ABI drift without manual npm commands

import { execFile } from "child_process";
import { constants } from "fs";
import { access, mkdir, open, readFile, unlink } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const LOCK_RETRY_MS = 40;
const LOCK_TIMEOUT_MS = 60_000;
const attemptedRepairKeys = new Set<string>();
let activeRepair: Promise<boolean> | null = null;

export interface NativeRepairAction {
  label: string;
  command: string;
  success: boolean;
  output: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveNpmCommand(): Promise<string> {
  const sibling = join(dirname(process.execPath), "npm");
  if (await executableExists(sibling)) return sibling;
  return "npm";
}

async function readDependencyVersion(rootDir: string, packageName: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(rootDir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return raw.dependencies?.[packageName] ?? raw.devDependencies?.[packageName] ?? null;
  } catch {
    return null;
  }
}

function sanitizeInstallSpec(packageName: string, version: string | null): string {
  if (!version) return packageName;
  const clean = version.replace(/^[~^]/, "");
  return `${packageName}@${clean}`;
}

async function runCommand(rootDir: string, label: string, command: string, args: string[]): Promise<NativeRepairAction> {
  const envPath = [dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(":");
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: envPath,
      },
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      label,
      command: [command, ...args].join(" "),
      success: true,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : "";
    return {
      label,
      command: [command, ...args].join(" "),
      success: false,
      output: [stdout, stderr, message].filter(Boolean).join("\n").trim(),
    };
  }
}

function nativeRepairLockDir(rootDir: string): string {
  return join(rootDir, ".contextpro");
}

function nativeRepairLockPath(rootDir: string): string {
  return join(nativeRepairLockDir(rootDir), "native-repair.lock");
}

async function withRepairLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(nativeRepairLockDir(rootDir), { recursive: true });
  const lockPath = nativeRepairLockPath(rootDir);
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
      if (Date.now() >= deadline) throw error;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export function getContextPlusPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function isNativeAutoRepairEnabled(): boolean {
  const raw = (process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function isRepairableNativeError(code: string | undefined): boolean {
  return code === "native_module_missing" || code === "native_module_abi_mismatch" || code === "native_module_error";
}

export async function repairNativeDependencies(rootDir: string, issueCode?: string): Promise<NativeRepairAction[]> {
  const normalizedRoot = resolve(rootDir);
  const npmCommand = await resolveNpmCommand();
  const betterSqliteSpec = sanitizeInstallSpec("better-sqlite3", await readDependencyVersion(normalizedRoot, "better-sqlite3"));
  const sqliteVecSpec = sanitizeInstallSpec("sqlite-vec", await readDependencyVersion(normalizedRoot, "sqlite-vec"));
  const actions: NativeRepairAction[] = [];

  const runRebuild = () => runCommand(normalizedRoot, "rebuild-native-deps", npmCommand, ["rebuild", "better-sqlite3", "sqlite-vec"]);
  const runInstall = () =>
    runCommand(normalizedRoot, "install-native-deps", npmCommand, ["install", "--foreground-scripts", "--no-save", betterSqliteSpec, sqliteVecSpec]);

  if (issueCode === "native_module_missing") {
    actions.push(await runInstall());
    if (!actions[0]?.success) actions.push(await runRebuild());
    return actions;
  }

  actions.push(await runRebuild());
  if (!actions[0]?.success) actions.push(await runInstall());
  return actions;
}

export async function attemptNativeAutoRepair(issueCode: string | undefined, rootDir: string = getContextPlusPackageRoot()): Promise<boolean> {
  if (!isNativeAutoRepairEnabled() || !isRepairableNativeError(issueCode)) return false;
  const repairKey = `${resolve(rootDir)}|${process.execPath}|${process.versions.modules ?? "unknown"}|${issueCode ?? "unknown"}`;
  if (attemptedRepairKeys.has(repairKey)) return false;
  if (activeRepair) return activeRepair;

  attemptedRepairKeys.add(repairKey);
  activeRepair = withRepairLock(rootDir, async () => {
    const actions = await repairNativeDependencies(rootDir, issueCode);
    return actions.some((action) => action.success);
  });

  try {
    return await activeRepair;
  } finally {
    activeRepair = null;
  }
}
