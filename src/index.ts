#!/usr/bin/env node
// ContextPro MCP - Semantic codebase navigator for AI agents
// Structural AST tree, blast radius, semantic search, commit gatekeeper

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { mkdir, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { cancelAllEmbeddings } from "./core/embeddings.js";
import { createEmbeddingTrackerController } from "./core/embedding-tracker.js";
import { createIdleMonitor, getIdleShutdownMs, getParentPollMs, isBrokenPipeError, runCleanup, startParentMonitor } from "./core/process-lifecycle.js";
import { getContextTree } from "./tools/context-tree.js";
import { quickRefresh, waitForIndexingCompletion } from "./tools/reindex.js";
import { ensureProjectConfig, registerWorkspace, verifyProjectContext } from "./core/project-config.js";
import { formatStartupHealthReport, runStartupHealthCheck } from "./core/startup-health.js";
import { formatDoctorReport, runDoctor } from "./core/doctor.js";
import { recordToolTiming, setToolCallSink } from "./core/tool-metrics.js";
import { registerTools } from "./tools/register-tools.js";
import { selectRootDir, validateSelectedRoot } from "./core/root-guard.js";
import { resolveRequestRoot } from "./core/request-root.js";
import { runWithRequestRoot } from "./core/request-context.js";
import { CONTEXTPRO_DIR, ensureContextProDir } from "./core/data-dir.js";
import { closeDB, getDB } from "./core/db.js";
import { ensureFreshIndex } from "./core/index-freshness.js";
import { addToSessionSavings, appendEfficiencyFooter, estimateToolEfficiency } from "./core/efficiency.js";
import type { IndexFreshnessResult } from "./core/index-freshness.js";

type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode";

const AGENT_CONFIG_PATH: Record<AgentTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  windsurf: ".windsurf/mcp.json",
  opencode: "opencode.json",
};

const SUB_COMMANDS = ["init", "skeleton", "tree", "doctor"];
const INSTRUCTIONS_RESOURCE_URI = "contextpro://instructions";
const INSTRUCTIONS_REMOTE_URL = process.env.CONTEXTPRO_INSTRUCTIONS_REMOTE_URL ?? "https://contextpro.dev/api/instructions";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PACKAGE_VERSION = readPackageVersion();

let agentInstructions: string | undefined;
try {
  agentInstructions = readFileSync(resolve(PACKAGE_ROOT, "agent-instructions.md"), "utf8");
} catch {
  process.stderr.write("[contextpro/startup] agent-instructions.md not found; manifest instructions disabled\n");
}

function isInstructionsRemoteEnabled(): boolean {
  const raw = (process.env.CONTEXTPRO_INSTRUCTIONS_REMOTE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

let noteServerActivity = () => { };
let ensureTrackerRunning = () => { };

function appendFreshnessNotice(result: unknown, freshness: IndexFreshnessResult | undefined): void {
  if (!freshness?.refreshed || !result || typeof result !== "object") return;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  const item = content.find((candidate) => candidate && typeof candidate === "object" && typeof (candidate as { text?: unknown }).text === "string") as { text: string } | undefined;
  if (!item) return;
  try {
    JSON.parse(item.text);
    return;
  } catch {
    // Text response; add a concise provenance notice.
  }
  const mode = freshness.fullReindex ? "structural reindex" : "incremental refresh";
  const subject = freshness.fullReindex ? "indexed file" : "changed file";
  item.text = `[ContextPro ${mode}: ${freshness.staleCount} ${subject}${freshness.staleCount === 1 ? "" : "s"} in ${freshness.durationMs}ms]\n\n${item.text}`;
}

interface ParsedCliArgs {
  command?: string;
  rootDir: string;
  rootSource: "cwd" | "positional" | "flag";
  runner?: string;
  projectId?: string;
  clientId?: string;
  sessionSource?: string;
  fix?: boolean;
  flagRoot?: string;
  positional: string[];
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    rootDir: process.cwd(),
    rootSource: "cwd",
    positional: [],
  };
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (index === 0 && SUB_COMMANDS.includes(arg)) {
      parsed.command = arg;
      index += 1;
      continue;
    }
    if (arg.startsWith("--runner=")) {
      parsed.runner = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--runner") {
      parsed.runner = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.flagRoot = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--root") {
      parsed.flagRoot = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--project-id=")) {
      parsed.projectId = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--client-id=")) {
      parsed.clientId = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--client-id") {
      parsed.clientId = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--session-source=")) {
      parsed.sessionSource = arg.split("=")[1];
      index += 1;
      continue;
    }
    if (arg === "--session-source") {
      parsed.sessionSource = args[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--fix") {
      parsed.fix = true;
      index += 1;
      continue;
    }
    parsed.positional.push(arg);
    index += 1;
  }
  if (parsed.command === "init" && parsed.positional.length > 0) parsed.positional = parsed.positional.slice(0, 1);
  const rootArgs = parsed.command === "init" ? [] : parsed.positional;
  const selectedRoot = selectRootDir(process.cwd(), rootArgs, parsed.flagRoot);
  parsed.rootDir = selectedRoot.rootDir;
  parsed.rootSource = selectedRoot.source;
  return parsed;
}

const parsedCliArgs = parseCliArgs(process.argv.slice(2));
const ROOT_DIR = validateSelectedRoot({ rootDir: parsedCliArgs.rootDir, source: parsedCliArgs.rootSource }).rootDir;

// Cache the client's advertised roots briefly so auto-detection doesn't round-trip
// to the client on every single tool call. The TTL is short because a client can
// add/remove workspace roots mid-session.
const ROOTS_CACHE_TTL_MS = 5000;
let rootsCache: { uris: string[]; at: number } | null = null;

async function getClientRoots(): Promise<string[]> {
  const now = Date.now();
  if (rootsCache && now - rootsCache.at < ROOTS_CACHE_TTL_MS) return rootsCache.uris;
  // Only the client advertising the roots capability can answer; otherwise this
  // throws and resolveAutoRoot falls back to the boot root.
  const caps = server.server.getClientCapabilities?.();
  if (!caps?.roots) throw new Error("client does not support roots capability");
  const result = await server.server.listRoots();
  const uris = (result.roots ?? []).map((r) => r.uri).filter((u): u is string => typeof u === "string");
  rootsCache = { uris, at: now };
  return uris;
}

function withRequestActivity<TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean; toolName?: string; waitForIndexing?: boolean; ensureFreshIndex?: boolean },
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const started = Date.now();
    noteServerActivity();
    if (options?.useEmbeddingTracker) ensureTrackerRunning();
    // Resolve the workspace this request targets. Precedence: an explicit `root`
    // arg → the MCP client's advertised roots (auto-detected) → the server's boot
    // ROOT_DIR. The resolved root is made active for the handler via
    // AsyncLocalStorage, and `root` is stripped so handlers see their normal args.
    const resolution = await resolveRequestRoot(args as Record<string, unknown>, ROOT_DIR, {
      rootsProvider: getClientRoots,
      requestCwd: process.cwd(),
    });
    const effectiveRoot = resolution.rootDir;
    const handlerArgs = resolution.handlerArgs as TArgs;
    return runWithRequestRoot(effectiveRoot, async () => {
      try {
        await verifyProjectContext(effectiveRoot);
        let freshness: IndexFreshnessResult | undefined;
        if (options?.ensureFreshIndex) {
          freshness = await ensureFreshIndex(effectiveRoot);
          if (freshness.warning) process.stderr.write(`[contextpro/freshness] ${freshness.warning}\n`);
        } else if (options?.waitForIndexing !== false) {
          const waitState = await waitForIndexingCompletion(effectiveRoot);
          if (waitState.timedOut) {
            throw new Error("Indexing is still in progress and did not settle before timeout.");
          }
        }
        const result = await handler(handlerArgs);
        const durationMs = Date.now() - started;
        const toolName = options?.toolName ?? "unknown";
        appendFreshnessNotice(result, freshness);
        let efficiency: Awaited<ReturnType<typeof estimateToolEfficiency>> | undefined;
        try {
          efficiency = await estimateToolEfficiency(effectiveRoot, handlerArgs, result);
          const sessionSavedTokens = addToSessionSavings(effectiveRoot, efficiency);
          if (toolName !== "efficiency_report") appendEfficiencyFooter(result, efficiency, sessionSavedTokens);
        } catch {
          // Efficiency telemetry is optional and must never affect the tool result.
        }
        recordToolTiming(effectiveRoot, toolName, durationMs, "ok", efficiency);
        return result;
      } catch (error) {
        recordToolTiming(effectiveRoot, options?.toolName ?? "unknown", Date.now() - started, "error");
        throw error;
      }
    });
  };
}

function parseAgentTarget(input?: string): AgentTarget {
  const normalized = (input ?? "claude").toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "vscode" || normalized === "vs-code" || normalized === "vs") return "vscode";
  if (normalized === "windsurf") return "windsurf";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  throw new Error(`Unsupported coding agent \"${input}\". Use one of: claude, cursor, vscode, windsurf, opencode.`);
}

function parseRunner(args: string[]): "npx" | "bunx" {
  const parsed = parseCliArgs(args);
  if (parsed.runner) {
    if (parsed.runner === "npx" || parsed.runner === "bunx") return parsed.runner;
    throw new Error(`Unsupported runner \"${parsed.runner}\". Use --runner=npx or --runner=bunx.`);
  }
  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();
  if (userAgent.includes("bun/") || execPath.includes("bun")) return "bunx";
  return "npx";
}

function buildMcpConfig(runner: "npx" | "bunx") {
  const commandArgs = runner === "npx" ? ["-y", "contextpro-mcp"] : ["contextpro-mcp"];
  return JSON.stringify(
    {
      mcpServers: {
        contextpro: {
          command: runner,
          args: commandArgs,
          env: {
            CONTEXTPRO_PROVIDER: "ollama",
            CONTEXTPRO_EMBED_MODEL: "nomic-embed-text:latest",
            CONTEXTPRO_CHAT_MODEL: "nemotron-3-ultra:cloud",
            CONTEXTPRO_EMBED_TRACKER: "lazy",
            CONTEXTPRO_TOOL_PROFILE: "core",
          },
        },
      },
    },
    null,
    2,
  );
}

async function runDoctorCommand(args: string[]) {
  const parsed = parseCliArgs(["doctor", ...args]);
  const report = await runDoctor(parsed.rootDir, parsed.fix === true);
  process.stdout.write(formatDoctorReport(report) + "\n");
}

function buildOpenCodeConfig(runner: "npx" | "bunx") {
  const command = runner === "npx" ? ["npx", "-y", "contextpro-mcp"] : ["bunx", "contextpro-mcp"];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        contextpro: {
          type: "local",
          command,
          enabled: true,
          environment: {
            CONTEXTPRO_PROVIDER: "ollama",
            CONTEXTPRO_EMBED_MODEL: "nomic-embed-text:latest",
            CONTEXTPRO_CHAT_MODEL: "nemotron-3-ultra:cloud",
            CONTEXTPRO_EMBED_TRACKER: "lazy",
            CONTEXTPRO_TOOL_PROFILE: "core",
          },
        },
      },
    },
    null,
    2,
  );
}

async function runInitCommand(args: string[]) {
  const parsed = parseCliArgs(["init", ...args]);
  const target = parseAgentTarget(parsed.positional[0]);
  const runner = parseRunner(args);
  const outputPath = resolve(process.cwd(), AGENT_CONFIG_PATH[target]);
  const content = target === "opencode" ? buildOpenCodeConfig(runner) : buildMcpConfig(runner);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${content}\n`, "utf8");

  const migratedFrom = await ensureContextProDir(process.cwd());
  const contextProDir = join(process.cwd(), CONTEXTPRO_DIR);
  const configPath = join(contextProDir, "config.json");
  try {
    await stat(configPath);
  } catch {
    await writeFile(configPath, JSON.stringify({ provider: "ollama", embedModel: "nomic-embed-text:latest", chatModel: "nemotron-3-ultra:cloud" }, null, 2) + "\n");
  }
  await ensureProjectConfig({
    rootDir: process.cwd(),
    projectId: parsed.projectId,
    clientId: parsed.clientId,
    sessionSource: parsed.sessionSource ?? "mcp",
  });

  console.error(`ContextPro initialized for ${target} using ${runner}.`);
  console.error(`Wrote MCP config: ${outputPath}`);
  if (migratedFrom) console.error(`Migrated ${migratedFrom}/ to ${CONTEXTPRO_DIR}/.`);
  console.error(`Created .contextpro/ directory with config.json`);
}

const server = new McpServer({
  name: "contextpro",
  version: PACKAGE_VERSION,
}, {
  capabilities: { logging: {} },
  ...(agentInstructions && { instructions: agentInstructions }),
});

server.resource(
  "contextpro_instructions",
  INSTRUCTIONS_RESOURCE_URI,
  withRequestActivity(async (uri: URL) => {
    if (isInstructionsRemoteEnabled()) {
      try {
        const response = await fetch(INSTRUCTIONS_REMOTE_URL);
        if (response.ok) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: "text/markdown",
              text: await response.text(),
            }],
          };
        }
        process.stderr.write(`[contextpro/instructions] remote fetch failed (${response.status}); falling back to bundled\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[contextpro/instructions] remote fetch error: ${message}; falling back to bundled\n`);
      }
    }
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: agentInstructions ?? "ContextPro instructions are not bundled with this build.",
      }],
    };
  }, { toolName: "instructions_resource", waitForIndexing: false }),
);

registerTools(server, ROOT_DIR, withRequestActivity, noteServerActivity);

// Persist every tool call to the per-root DB so a separate dashboard process can
// show real tool-call history across restarts. Best-effort and fire-and-forget:
// getDB is async + cached, and a failure here must never disturb the tool itself.
// Prune occasionally to keep the table bounded.
let toolCallWrites = 0;
setToolCallSink((event) => {
  void (async () => {
    try {
      const db = await getDB(event.rootDir);
      db.recordToolCall(event.tool, event.status, event.durationMs, event.calledAt, event.efficiency);
      if (++toolCallWrites % 200 === 0) db.pruneToolCalls(5000);
    } catch {
      // telemetry is non-critical
    }
  })();
});

async function main() {
  const args = process.argv.slice(2);
  if (parsedCliArgs.command === "init") {
    await runInitCommand(args.slice(1));
    process.exit(0);
  }
  if (parsedCliArgs.command === "doctor") {
    await runDoctorCommand(args.slice(1));
    process.exit(0);
  }
  if (parsedCliArgs.command === "skeleton" || parsedCliArgs.command === "tree") {
    const targetRoot = parsedCliArgs.rootDir;
    const tree = await getContextTree({
      rootDir: targetRoot,
      includeSymbols: true,
      maxTokens: 50000,
    });
    process.stdout.write(tree + "\n");
    closeDB(targetRoot);
    process.exit(0);
  }
  const migratedFrom = await ensureContextProDir(ROOT_DIR);
  if (migratedFrom) console.error(`[contextpro/startup] migrated ${migratedFrom}/ to ${CONTEXTPRO_DIR}/`);
  const projectConfig = await ensureProjectConfig({
    rootDir: ROOT_DIR,
    projectId: parsedCliArgs.projectId ?? process.env.CONTEXTPRO_PROJECT_ID ?? process.env.CONTEXTPLUS_PROJECT_ID,
    clientId: parsedCliArgs.clientId ?? process.env.CONTEXTPRO_CLIENT_ID ?? process.env.CONTEXTPLUS_CLIENT_ID,
    sessionSource: parsedCliArgs.sessionSource ?? process.env.CONTEXTPRO_SESSION_SOURCE ?? process.env.CONTEXTPLUS_SESSION_SOURCE ?? "mcp",
  });
  await registerWorkspace(projectConfig);
  const startupHealth = await runStartupHealthCheck(ROOT_DIR);
  console.error(formatStartupHealthReport(startupHealth));
  const trackerController = createEmbeddingTrackerController({
    rootDir: ROOT_DIR,
    mode: process.env.CONTEXTPRO_EMBED_TRACKER ?? process.env.CONTEXTPLUS_EMBED_TRACKER,
    debounceMs: Number.parseInt(process.env.CONTEXTPRO_EMBED_TRACKER_DEBOUNCE_MS ?? process.env.CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS ?? "700", 10),
    maxFilesPerTick: Number.parseInt(process.env.CONTEXTPRO_EMBED_TRACKER_MAX_FILES ?? process.env.CONTEXTPLUS_EMBED_TRACKER_MAX_FILES ?? "8", 10),
    reconcileIntervalMs: Number.parseInt(process.env.CONTEXTPRO_RECONCILE_INTERVAL_MS ?? process.env.CONTEXTPLUS_RECONCILE_INTERVAL_MS ?? "30000", 10),
    reconcileMaxFiles: Number.parseInt(process.env.CONTEXTPRO_RECONCILE_MAX_FILES ?? process.env.CONTEXTPLUS_RECONCILE_MAX_FILES ?? "40", 10),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  let stopParentMonitor = () => { };
  const idleMonitor = createIdleMonitor({
    timeoutMs: getIdleShutdownMs(process.env.CONTEXTPRO_IDLE_TIMEOUT_MS ?? process.env.CONTEXTPLUS_IDLE_TIMEOUT_MS),
    onIdle: () => requestShutdown("idle-timeout", 0),
    isTransportAlive: () => process.stdin.readable && !process.stdin.destroyed,
  });

  noteServerActivity = idleMonitor.touch;
  ensureTrackerRunning = trackerController.ensureStarted;

  const closeServer = async () => {
    const closable = server as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const closeTransport = async () => {
    const closable = transport as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const shutdown = async (reason: string, exitCode: number = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
  console.error(`ContextPro MCP shutdown requested: ${reason}`);
    await runCleanup({
      cancelEmbeddings: cancelAllEmbeddings,
      stopTracker: trackerController.stop,
      closeServer,
      closeTransport,
      stopMonitors: () => {
        idleMonitor.stop();
        stopParentMonitor();
      },
    });
    process.exit(exitCode);
  };
  const requestShutdown = (reason: string, exitCode: number = 0) => {
    void shutdown(reason, exitCode);
  };

  stopParentMonitor = startParentMonitor({
    parentPid: process.ppid,
    pollIntervalMs: getParentPollMs(process.env.CONTEXTPRO_PARENT_POLL_MS ?? process.env.CONTEXTPLUS_PARENT_POLL_MS),
    onParentExit: () => requestShutdown("parent-exit", 0),
  });

  process.once("SIGINT", () => requestShutdown("SIGINT", 0));
  process.once("SIGTERM", () => requestShutdown("SIGTERM", 0));
  process.once("SIGHUP", () => requestShutdown("SIGHUP", 0));
  process.once("disconnect", () => requestShutdown("disconnect", 0));
  process.once("exit", () => {
    idleMonitor.stop();
    stopParentMonitor();
    trackerController.stop();
  });
  process.stdin.once("end", () => requestShutdown("stdin-end", 0));
  process.stdin.once("close", () => requestShutdown("stdin-close", 0));
  process.stdin.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdin-error", 0);
  });
  process.stdout.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdout-error", 0);
  });
  process.stderr.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stderr-error", 0);
  });

  noteServerActivity();
  console.error(`ContextPro MCP server running on stdio | root: ${ROOT_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  if (isBrokenPipeError(error)) {
    process.exit(0);
  }
  console.error("Uncaught exception:", error);
  // Last-resort guard ONLY. Reaching here means an error escaped every local
  // try/catch, and Node considers the process state undefined — so a clean exit
  // (which the MCP client recovers from by respawning) is safer than resuming
  // into possible corruption. Do NOT "fix" disconnects by swallowing here:
  // instead ensure the source can't throw uncaught. Known background timers
  // (reconcile sweep, idle monitor, parent monitor) are individually guarded so
  // a routine background failure never reaches this hard-exit path.
  // The `process.once("exit")` handler in main() synchronously stops the idle monitor, parent
  // monitor, and embedding tracker — those run even on this hard exit. Async cleanup (server /
  // transport close) cannot run during a synchronous exit and is reclaimed by the OS.
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  // Surface unhandled rejections instead of letting Node terminate silently in some versions.
  // Most paths use try/catch; this is a safety net so a stray rejection produces a clear log.
  console.error("Unhandled promise rejection:", reason);
});
