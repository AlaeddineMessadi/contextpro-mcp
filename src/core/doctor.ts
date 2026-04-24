// Doctor diagnostics and optional repair actions for Context+ runtime health
// FEATURE: Explicit remediation — inspect startup health and repair native storage dependencies

import { resolve } from "path";
import { runStartupHealthCheck, type StartupHealthReport } from "./startup-health.js";
import { getContextPlusPackageRoot, isRepairableNativeError, repairNativeDependencies, type NativeRepairAction } from "./native-repair.js";

export type DoctorAction = NativeRepairAction;

export interface DoctorReport {
  rootDir: string;
  fixApplied: boolean;
  before: StartupHealthReport;
  actions: DoctorAction[];
  after: StartupHealthReport;
}

function needsNativeRepair(report: StartupHealthReport): boolean {
  if (report.storage.ok && report.storage.databaseOpen.ok) return false;
  return isRepairableNativeError(report.storage.diagnostic?.code);
}

export async function runDoctor(rootDir: string, fix: boolean): Promise<DoctorReport> {
  const normalizedRoot = resolve(rootDir);
  const before = await runStartupHealthCheck(normalizedRoot);
  const actions: DoctorAction[] = [];

  if (fix && needsNativeRepair(before)) {
    actions.push(...await repairNativeDependencies(getContextPlusPackageRoot(), before.storage.diagnostic?.code));
  }

  const after = await runStartupHealthCheck(normalizedRoot);
  return {
    rootDir: normalizedRoot,
    fixApplied: fix,
    before,
    actions,
    after,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Context+ Doctor`,
    ``,
    `Root: ${report.rootDir}`,
    `Fix Applied: ${report.fixApplied ? "yes" : "no"}`,
    `Before: ${report.before.status} | storage=${report.before.storage.ok} | dbOpen=${report.before.storage.databaseOpen.ok}`,
  ];

  if (report.actions.length > 0) {
    lines.push(``, `Actions:`);
    for (const action of report.actions) {
      lines.push(`- ${action.label}: ${action.success ? "ok" : "failed"}`);
      lines.push(`  ${action.command}`);
      if (action.output) lines.push(`  ${action.output.split("\n").slice(-3).join(" | ")}`);
    }
  }

  lines.push(``, `After: ${report.after.status} | storage=${report.after.storage.ok} | dbOpen=${report.after.storage.databaseOpen.ok}`);
  if (report.after.storage.diagnostic) {
    lines.push(`Diagnostic: [${report.after.storage.diagnostic.code}] ${report.after.storage.diagnostic.message}`);
  }
  if (!report.after.project.ok) {
    lines.push(`Project Error: ${report.after.project.message}`);
  }
  return lines.join("\n");
}
