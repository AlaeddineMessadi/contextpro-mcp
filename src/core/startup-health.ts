// Startup health checks for project identity and native storage readiness
// FEATURE: Boot diagnostics — fail loud on root drift and native dependency breakage

import { closeDB, getDB, probeNativeStorage, type NativeStorageProbe } from "./db.js";
import { attemptNativeAutoRepair } from "./native-repair.js";
import { verifyProjectContext, type VerifiedProjectContext } from "./project-config.js";
import { readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HEALTH_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(HEALTH_PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "unknown";
  }
}

function readBuildStamp(): string {
  // The mtime of the compiled entry point. Lets a user confirm — after a restart — that the
  // running process is using a freshly-built artifact (different timestamp = new code loaded).
  try {
    const stat = statSync(resolve(HEALTH_PACKAGE_ROOT, "build/index.js"));
    return stat.mtime.toISOString();
  } catch {
    return "unknown";
  }
}

// Capture identity when this module loads. Reading the artifact timestamp on
// every health request falsely labels an old process as a newly compiled build.
const runtimeBuild = Object.freeze({ serverVersion: readServerVersion(), buildStamp: readBuildStamp() });
export function getRuntimeBuildIdentity(): typeof runtimeBuild { return runtimeBuild; }

export interface StartupHealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  rootDir: string;
  runtime: {
    nodeVersion: string;
    execPath: string;
    parserBackend: string;
    nodeAbi: string;
    pid: number;
    serverVersion: string;
    buildStamp: string;
  };
  project: {
    ok: boolean;
    message: string;
    projectId: string | null;
    clientId: string | null;
    gitRoot: string | null;
    fingerprint: string | null;
  };
  storage: NativeStorageProbe & {
    databaseOpen: {
      ok: boolean;
      message: string;
    };
  };
}

function summarizeProjectContext(context: VerifiedProjectContext | null, error: unknown) {
  if (context) {
    return {
      ok: true,
      message: "project context verified",
      projectId: context.config.projectId,
      clientId: context.config.clientId,
      gitRoot: context.gitRoot,
      fingerprint: context.config.repoFingerprint,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message,
    projectId: null,
    clientId: null,
    gitRoot: null,
    fingerprint: null,
  };
}

export async function runStartupHealthCheck(rootDir: string, options: { autoRepair?: boolean } = {}): Promise<StartupHealthReport> {
  const timestamp = new Date().toISOString();
  let verifiedContext: VerifiedProjectContext | null = null;
  let projectError: unknown = null;

  try {
    verifiedContext = await verifyProjectContext(rootDir);
  } catch (error) {
    projectError = error;
  }

  let storageProbe = probeNativeStorage();
  if (!storageProbe.ok && options.autoRepair !== false) {
    const repaired = await attemptNativeAutoRepair(storageProbe.diagnostic?.code);
    if (repaired) storageProbe = probeNativeStorage();
  }
  let databaseOpen = { ok: false, message: "native storage unavailable" };

  if (storageProbe.ok) {
    try {
      const db = await getDB(rootDir);
      db.getGraphStats();
      databaseOpen = { ok: true, message: "database opened successfully" };
    } catch (error) {
      databaseOpen = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      closeDB(rootDir);
    }
  }

  const project = summarizeProjectContext(verifiedContext, projectError);
  const status = project.ok && storageProbe.ok && databaseOpen.ok ? "ok" : "degraded";

  return {
    status,
    timestamp,
    rootDir,
    runtime: {
      nodeVersion: process.version,
      execPath: process.execPath,
      parserBackend: "isolated-process/liftoff",
      nodeAbi: process.versions.modules ?? "unknown",
      pid: process.pid,
      ...getRuntimeBuildIdentity(),
    },
    project,
    storage: {
      ...storageProbe,
      databaseOpen,
    },
  };
}

export function formatStartupHealthReport(report: StartupHealthReport): string {
  const lines = [
    `[contextpro/startup] status=${report.status} root=${report.rootDir}`,
    `[contextpro/startup] version=${report.runtime.serverVersion} build=${report.runtime.buildStamp}`,
    `[contextpro/startup] runtime node=${report.runtime.nodeVersion} abi=${report.runtime.nodeAbi} pid=${report.runtime.pid}`,
    `[contextpro/startup] executable=${report.runtime.execPath} parser=${report.runtime.parserBackend}`,
    `[contextpro/startup] project ok=${report.project.ok} projectId=${report.project.projectId ?? "unknown"} gitRoot=${report.project.gitRoot ?? "unknown"} fingerprint=${report.project.fingerprint ?? "unknown"}`,
    `[contextpro/startup] storage ok=${report.storage.ok} dbOpen=${report.storage.databaseOpen.ok}`,
  ];

  if (!report.project.ok) {
    lines.push(`[contextpro/startup] project_error ${report.project.message}`);
  }
  if (!report.storage.ok && report.storage.diagnostic) {
    lines.push(`[contextpro/startup] storage_error [${report.storage.diagnostic.code}] ${report.storage.diagnostic.message}`);
    for (const step of report.storage.diagnostic.remediation) {
      lines.push(`[contextpro/startup] remediation ${step}`);
    }
  } else if (!report.storage.databaseOpen.ok) {
    lines.push(`[contextpro/startup] storage_error ${report.storage.databaseOpen.message}`);
  }

  return lines.join("\n");
}
