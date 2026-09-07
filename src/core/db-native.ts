// Native SQLite module loader — probes and loads better-sqlite3 and sqlite-vec
// FEATURE: Isolated bootstrap so DB class stays free of ABI error-handling noise

import { createRequire } from "module";
import { existsSync } from "fs";
import { join } from "path";
import { getNativeRuntime } from "./native-runtime.js";
import { attemptNativeAutoRepair, getContextPlusPackageRoot } from "./native-repair.js";

const requireFromHere = createRequire(import.meta.url);

type DatabaseType = import("better-sqlite3").Database;
export type BetterSqlite3Constructor = new (path: string, options?: unknown) => DatabaseType;
export type SqliteVecModule = { load: (db: DatabaseType) => void };

export interface NativeStorageDiagnostic {
  code: string;
  message: string;
  remediation: string[];
}

export interface NativeStorageProbe {
  ok: boolean;
  runtime: {
    nodeVersion: string;
    nodeAbi: string;
    execPath: string;
  };
  diagnostic?: NativeStorageDiagnostic;
}

let cachedBindings: { Database: BetterSqlite3Constructor; sqliteVec: SqliteVecModule } | null = null;

function normalizeBetterSqliteModule(candidate: unknown): BetterSqlite3Constructor {
  if (typeof candidate === "function") return candidate as BetterSqlite3Constructor;
  if (candidate && typeof (candidate as { default?: unknown }).default === "function") {
    return (candidate as { default: BetterSqlite3Constructor }).default;
  }
  throw new Error("better-sqlite3 did not expose a database constructor.");
}

function normalizeSqliteVecModule(candidate: unknown): SqliteVecModule {
  const maybeModule =
    candidate && typeof (candidate as SqliteVecModule).load === "function"
      ? (candidate as SqliteVecModule)
      : (candidate as { default?: SqliteVecModule } | null)?.default;
  if (maybeModule && typeof maybeModule.load === "function") return maybeModule;
  throw new Error("sqlite-vec did not expose a load(db) function.");
}

export function describeNativeStorageError(error: unknown): NativeStorageDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const remediation = [
    `Run ContextPro doctor --fix with the failing host's Node runtime (${process.execPath}).`,
    `Repair installs ABI-specific dependencies in the user cache without rebuilding shared node_modules.`,
    `Restart the MCP host after fixing native dependencies so it respawns the server cleanly.`,
  ];

  if (message.includes("Cannot find module") || message.includes("Could not locate the bindings file")) {
    return { code: "native_module_missing", message, remediation };
  }
  if (message.includes("NODE_MODULE_VERSION") || message.includes("compiled against a different Node.js version")) {
    return { code: "native_module_abi_mismatch", message, remediation };
  }
  return { code: "native_module_error", message, remediation };
}

export function loadNativeStorageBindings(): { Database: BetterSqlite3Constructor; sqliteVec: SqliteVecModule } {
  if (cachedBindings) return cachedBindings;
  const candidates: Array<() => { Database: BetterSqlite3Constructor; sqliteVec: SqliteVecModule }> = [];
  try {
    const { directory } = getNativeRuntime(getContextPlusPackageRoot());
    if (existsSync(join(directory, "package.json"))) candidates.push(() => ({
      Database: normalizeBetterSqliteModule(requireFromHere(join(directory, "node_modules/better-sqlite3"))),
      sqliteVec: normalizeSqliteVecModule(requireFromHere(join(directory, "node_modules/sqlite-vec"))),
    }));
  } catch { /* A working bundled installation does not need a repair descriptor. */ }
  candidates.push(() => ({
    Database: normalizeBetterSqliteModule(requireFromHere("better-sqlite3")),
    sqliteVec: normalizeSqliteVecModule(requireFromHere("sqlite-vec")),
  }));
  let lastError: unknown;
  for (const load of candidates) {
    try {
      const bindings = load();
      // better-sqlite3 loads its addon lazily. Do not cache a constructor until
      // opening SQLite and loading its vector extension actually succeed.
      const db = new bindings.Database(":memory:");
      try { bindings.sqliteVec.load(db); db.prepare("SELECT vec_version()").get(); }
      finally { db.close(); }
      cachedBindings = bindings;
      return bindings;
    } catch (error) { lastError = error; }
  }
  const diagnostic = describeNativeStorageError(lastError);
  throw new Error(
    `ContextPro storage engine is unavailable [${diagnostic.code}]. ` +
    `Runtime: ${process.execPath} (${process.version}, ABI ${process.versions.modules}). ` +
    `Automatic repair uses an isolated per-ABI cache; CONTEXTPRO_NATIVE_AUTO_REPAIR=false disables it. ` +
    `doctor --fix retries explicitly.\n${diagnostic.remediation.map((step) => `  - ${step}`).join("\n")}\n` +
    `Underlying error: ${diagnostic.message}`,
  );
}

export async function ensureNativeStorage(): Promise<void> {
  try { loadNativeStorageBindings(); }
  catch (error) {
    if (!await attemptNativeAutoRepair(describeNativeStorageError(error).code)) throw error;
    loadNativeStorageBindings();
  }
}

export function probeNativeStorage(): NativeStorageProbe {
  try {
    const { Database, sqliteVec } = loadNativeStorageBindings();
    const db = new Database(":memory:");
    try { sqliteVec.load(db); db.prepare("SELECT 1").get(); }
    finally { db.close(); }
    return {
      ok: true,
      runtime: { nodeVersion: process.version, nodeAbi: process.versions.modules ?? "unknown", execPath: process.execPath },
    };
  } catch (error) {
    return {
      ok: false,
      runtime: { nodeVersion: process.version, nodeAbi: process.versions.modules ?? "unknown", execPath: process.execPath },
      diagnostic: describeNativeStorageError(error),
    };
  }
}
