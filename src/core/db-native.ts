// Native SQLite module loader — probes and loads better-sqlite3 and sqlite-vec
// FEATURE: Isolated bootstrap so DB class stays free of ABI error-handling noise

import { createRequire } from "module";

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
    `Run npm install in the ContextPro repo to restore native dependencies.`,
    `Rebuild better-sqlite3 with the same Node runtime that launches ContextPro (${process.execPath}).`,
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
  try {
    const Database = normalizeBetterSqliteModule(requireFromHere("better-sqlite3"));
    const sqliteVec = normalizeSqliteVecModule(requireFromHere("sqlite-vec"));
    cachedBindings = { Database, sqliteVec };
    return cachedBindings;
  } catch (error) {
    const diagnostic = describeNativeStorageError(error);
    // Lead with a short, actionable summary — the underlying error (kept below for
    // diagnosability) can be a 10+ line bindings-search path dump that otherwise buries the
    // fact that this self-repairs automatically on server startup and is usually transient.
    throw new Error(
      `ContextPro storage engine is unavailable [${diagnostic.code}]. This is usually transient: ` +
      `ContextPro attempts an automatic native-module repair on server startup (~1-2 min) — call the ` +
      `"health" tool for live repair status, then retry this call.\n` +
      `Manual fix if it persists (run in a shell, then restart the MCP host):\n${diagnostic.remediation.map((step) => `  - ${step}`).join("\n")}\n` +
      `Underlying error: ${diagnostic.message}`,
    );
  }
}

export function probeNativeStorage(): NativeStorageProbe {
  try {
    const { Database, sqliteVec } = loadNativeStorageBindings();
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.prepare("SELECT 1").get();
    db.close();
    return {
      ok: true,
      runtime: { nodeVersion: process.version, nodeAbi: process.versions.modules ?? "unknown" },
    };
  } catch (error) {
    return {
      ok: false,
      runtime: { nodeVersion: process.version, nodeAbi: process.versions.modules ?? "unknown" },
      diagnostic: describeNativeStorageError(error),
    };
  }
}
