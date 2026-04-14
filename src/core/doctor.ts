// Doctor diagnostics and optional repair actions for Context+ runtime health
// FEATURE: Explicit remediation — inspect startup health and repair native storage dependencies

import { execFile } from "child_process";
import { access, readFile } from "fs/promises";
import { constants } from "fs";
import { dirname, join, resolve } from "path";
import { promisify } from "util";
import { runStartupHealthCheck, type StartupHealthReport } from "./startup-health.js";

const execFileAsync = promisify(execFile);

export interface DoctorAction {
  label: string;
  command: string;
  success: boolean;
  output: string;
}

export interface DoctorReport {
  rootDir: string;
  fixApplied: boolean;
  before: StartupHealthReport;
  actions: DoctorAction[];
  after: StartupHealthReport;
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

async function runCommand(rootDir: string, label: string, command: string, args: string[]): Promise<DoctorAction> {
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
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      label,
      command: [command, ...args].join(" "),
      success: true,
      output,
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

function needsNativeRepair(report: StartupHealthReport): boolean {
  if (report.storage.ok && report.storage.databaseOpen.ok) return false;
  const code = report.storage.diagnostic?.code ?? "";
  return code === "native_module_missing" || code === "native_module_abi_mismatch" || code === "native_module_error";
}

export async function runDoctor(rootDir: string, fix: boolean): Promise<DoctorReport> {
  const normalizedRoot = resolve(rootDir);
  const before = await runStartupHealthCheck(normalizedRoot);
  const actions: DoctorAction[] = [];

  if (fix && needsNativeRepair(before)) {
    const npmCommand = await resolveNpmCommand();
    const betterSqliteSpec = sanitizeInstallSpec("better-sqlite3", await readDependencyVersion(normalizedRoot, "better-sqlite3"));
    const sqliteVecSpec = sanitizeInstallSpec("sqlite-vec", await readDependencyVersion(normalizedRoot, "sqlite-vec"));

    actions.push(await runCommand(
      normalizedRoot,
      "install-native-deps",
      npmCommand,
      ["install", "--foreground-scripts", "--no-save", betterSqliteSpec, sqliteVecSpec],
    ));

    actions.push(await runCommand(
      normalizedRoot,
      "rebuild-better-sqlite3",
      npmCommand,
      ["explore", "better-sqlite3", "--", "npm", "run", "build-release"],
    ));
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
