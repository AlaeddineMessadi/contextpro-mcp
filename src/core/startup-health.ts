// Startup health checks for project identity and native storage readiness
// FEATURE: Boot diagnostics — fail loud on root drift and native dependency breakage

import { closeDB, getDB, probeNativeStorage, type NativeStorageProbe } from "./db.js";
import { attemptNativeAutoRepair } from "./native-repair.js";
import { verifyProjectContext, type VerifiedProjectContext } from "./project-config.js";

export interface StartupHealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  rootDir: string;
  runtime: {
    nodeVersion: string;
    nodeAbi: string;
    pid: number;
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

export async function runStartupHealthCheck(rootDir: string): Promise<StartupHealthReport> {
  const timestamp = new Date().toISOString();
  let verifiedContext: VerifiedProjectContext | null = null;
  let projectError: unknown = null;

  try {
    verifiedContext = await verifyProjectContext(rootDir);
  } catch (error) {
    projectError = error;
  }

  let storageProbe = probeNativeStorage();
  if (!storageProbe.ok) {
    const repaired = await attemptNativeAutoRepair(storageProbe.diagnostic?.code, rootDir);
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
      nodeAbi: process.versions.modules ?? "unknown",
      pid: process.pid,
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
    `[contextplus/startup] status=${report.status} root=${report.rootDir}`,
    `[contextplus/startup] runtime node=${report.runtime.nodeVersion} abi=${report.runtime.nodeAbi} pid=${report.runtime.pid}`,
    `[contextplus/startup] project ok=${report.project.ok} projectId=${report.project.projectId ?? "unknown"} gitRoot=${report.project.gitRoot ?? "unknown"} fingerprint=${report.project.fingerprint ?? "unknown"}`,
    `[contextplus/startup] storage ok=${report.storage.ok} dbOpen=${report.storage.databaseOpen.ok}`,
  ];

  if (!report.project.ok) {
    lines.push(`[contextplus/startup] project_error ${report.project.message}`);
  }
  if (!report.storage.ok && report.storage.diagnostic) {
    lines.push(`[contextplus/startup] storage_error [${report.storage.diagnostic.code}] ${report.storage.diagnostic.message}`);
    for (const step of report.storage.diagnostic.remediation) {
      lines.push(`[contextplus/startup] remediation ${step}`);
    }
  } else if (!report.storage.databaseOpen.ok) {
    lines.push(`[contextplus/startup] storage_error ${report.storage.databaseOpen.message}`);
  }

  return lines.join("\n");
}
