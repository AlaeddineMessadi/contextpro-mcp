#!/usr/bin/env node
// Context+ MCP - Semantic codebase navigator for AI agents
// Structural AST tree, blast radius, semantic search, commit gatekeeper

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { copyFile, mkdir, readdir, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { cancelAllEmbeddings } from "./core/embeddings.js";
import { createEmbeddingTrackerController } from "./core/embedding-tracker.js";
import { createIdleMonitor, getIdleShutdownMs, getParentPollMs, isBrokenPipeError, runCleanup, startParentMonitor } from "./core/process-lifecycle.js";
import { getContextTree } from "./tools/context-tree.js";
import { quickRefresh, waitForIndexingCompletion } from "./tools/reindex.js";
import { ensureProjectConfig, registerWorkspace, verifyProjectContext } from "./core/project-config.js";
import { formatStartupHealthReport, runStartupHealthCheck } from "./core/startup-health.js";
import { formatDoctorReport, runDoctor } from "./core/doctor.js";
import { recordToolTiming } from "./core/tool-metrics.js";
import { registerTools } from "./tools/register-tools.js";

type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode";

const AGENT_CONFIG_PATH: Record<AgentTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  windsurf: ".windsurf/mcp.json",
  opencode: "opencode.json",
};

const SUB_COMMANDS = ["init", "skeleton", "tree", "doctor"];
const INSTRUCTIONS_SOURCE_URL = "https://contextplus.vercel.app/api/instructions";
const INSTRUCTIONS_RESOURCE_URI = "contextplus://instructions";

let noteServerActivity = () => { };
let ensureTrackerRunning = () => { };

interface ParsedCliArgs {
  command?: string;
  rootDir: string;
  runner?: string;
  projectId?: string;
  clientId?: string;
  sessionSource?: string;
  fix?: boolean;
  positional: string[];
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    rootDir: process.cwd(),
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
  if (parsed.command === "init") {
    if (parsed.positional.length > 0) parsed.positional = parsed.positional.slice(0, 1);
  } else if (parsed.command === "tree" || parsed.command === "skeleton") {
    if (parsed.positional.length > 0) parsed.rootDir = resolve(parsed.positional[0]);
  } else if (parsed.positional.length > 0) {
    parsed.rootDir = resolve(parsed.positional[0]);
  }
  return parsed;
}

const parsedCliArgs = parseCliArgs(process.argv.slice(2));
const ROOT_DIR = parsedCliArgs.rootDir;

function withRequestActivity<TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean; toolName?: string; waitForIndexing?: boolean },
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const started = Date.now();
    noteServerActivity();
    if (options?.useEmbeddingTracker) ensureTrackerRunning();
    try {
      await verifyProjectContext(ROOT_DIR);
      if (options?.waitForIndexing !== false) {
        const waitState = await waitForIndexingCompletion(ROOT_DIR);
        if (waitState.timedOut) {
          throw new Error("Indexing is still in progress and did not settle before timeout.");
        }
      }
      const result = await handler(args);
      recordToolTiming(ROOT_DIR, options?.toolName ?? "unknown", Date.now() - started, "ok");
      return result;
    } catch (error) {
      recordToolTiming(ROOT_DIR, options?.toolName ?? "unknown", Date.now() - started, "error");
      throw error;
    }
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

async function migrateFromMcpData(rootDir: string): Promise<void> {
  const oldDir = join(rootDir, ".mcp_data");
  const newDir = join(rootDir, ".contextplus");
  try {
    await stat(oldDir);
  } catch {
    return;
  }
  try {
    await stat(newDir);
    return;
  } catch {}

  console.error("Migrating .mcp_data/ → .contextplus/ ...");
  await mkdir(join(newDir, "backups"), { recursive: true });
  await mkdir(join(newDir, "hubs"), { recursive: true });

  const entries = await readdir(oldDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "backups" && entry.isDirectory()) {
      const backupEntries = await readdir(join(oldDir, "backups"), { withFileTypes: true });
      for (const be of backupEntries) {
        const src = join(oldDir, "backups", be.name);
        const dst = join(newDir, "backups", be.name);
        if (be.isDirectory()) {
          await mkdir(dst, { recursive: true });
          const files = await readdir(src);
          for (const f of files) {
            await copyFile(join(src, f), join(dst, f));
          }
        } else {
          await copyFile(src, dst);
        }
      }
    } else if (entry.isFile()) {
      await copyFile(join(oldDir, entry.name), join(newDir, entry.name));
    }
  }
  console.error("Migration complete. You can safely delete .mcp_data/");
}

async function ensureContextPlusDir(rootDir: string): Promise<void> {
  await migrateFromMcpData(rootDir);
  await mkdir(join(rootDir, ".contextplus", "backups"), { recursive: true });
  await mkdir(join(rootDir, ".contextplus", "hubs"), { recursive: true });
}

function buildMcpConfig(runner: "npx" | "bunx") {
  const commandArgs = runner === "npx" ? ["-y", "contextplus"] : ["contextplus"];
  return JSON.stringify(
    {
      mcpServers: {
        contextplus: {
          command: runner,
          args: commandArgs,
          env: {
            OLLAMA_EMBED_MODEL: "nomic-embed-text",
            OLLAMA_CHAT_MODEL: "gemma2:27b",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
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
  const command = runner === "npx" ? ["npx", "-y", "contextplus"] : ["bunx", "contextplus"];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        contextplus: {
          type: "local",
          command,
          enabled: true,
          environment: {
            OLLAMA_EMBED_MODEL: "nomic-embed-text",
            OLLAMA_CHAT_MODEL: "gemma2:27b",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
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

  const contextPlusDir = join(process.cwd(), ".contextplus");
  await mkdir(join(contextPlusDir, "backups"), { recursive: true });
  await mkdir(join(contextPlusDir, "hubs"), { recursive: true });
  const configPath = join(contextPlusDir, "config.json");
  try {
    await stat(configPath);
  } catch {
    await writeFile(configPath, JSON.stringify({ provider: "ollama", embedModel: "nomic-embed-text", chatModel: "llama3.2" }, null, 2) + "\n");
  }
  await ensureProjectConfig({
    rootDir: process.cwd(),
    projectId: parsed.projectId,
    clientId: parsed.clientId,
    sessionSource: parsed.sessionSource ?? "mcp",
  });

  console.error(`Context+ initialized for ${target} using ${runner}.`);
  console.error(`Wrote MCP config: ${outputPath}`);
  console.error(`Created .contextplus/ directory with config.json`);
}

const server = new McpServer({
  name: "contextplus",
  version: "1.0.0",
}, {
  capabilities: { logging: {} },
});

server.resource(
  "contextplus_instructions",
  INSTRUCTIONS_RESOURCE_URI,
  withRequestActivity(async (uri) => {
    const response = await fetch(INSTRUCTIONS_SOURCE_URL);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: await response.text(),
      }],
    };
  }),
);

registerTools(server, ROOT_DIR, withRequestActivity, noteServerActivity);

async function main() {
  const args = process.argv.slice(2);
  if (parsedCliArgs.command === "init") {
    await runInitCommand(args.slice(1));
    return;
  }
  if (parsedCliArgs.command === "doctor") {
    await runDoctorCommand(args.slice(1));
    return;
  }
  if (parsedCliArgs.command === "skeleton" || parsedCliArgs.command === "tree") {
    const targetRoot = parsedCliArgs.rootDir;
    const tree = await getContextTree({
      rootDir: targetRoot,
      includeSymbols: true,
      maxTokens: 50000,
    });
    process.stdout.write(tree + "\n");
    return;
  }
  await ensureContextPlusDir(ROOT_DIR);
  const projectConfig = await ensureProjectConfig({
    rootDir: ROOT_DIR,
    projectId: parsedCliArgs.projectId ?? process.env.CONTEXTPLUS_PROJECT_ID,
    clientId: parsedCliArgs.clientId ?? process.env.CONTEXTPLUS_CLIENT_ID,
    sessionSource: parsedCliArgs.sessionSource ?? process.env.CONTEXTPLUS_SESSION_SOURCE ?? "mcp",
  });
  await registerWorkspace(projectConfig);
  const startupHealth = await runStartupHealthCheck(ROOT_DIR);
  console.error(formatStartupHealthReport(startupHealth));
  const trackerController = createEmbeddingTrackerController({
    rootDir: ROOT_DIR,
    mode: process.env.CONTEXTPLUS_EMBED_TRACKER,
    debounceMs: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS ?? "700", 10),
    maxFilesPerTick: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_MAX_FILES ?? "8", 10),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  let stopParentMonitor = () => { };
  const idleMonitor = createIdleMonitor({
    timeoutMs: getIdleShutdownMs(process.env.CONTEXTPLUS_IDLE_TIMEOUT_MS),
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
    console.error(`Context+ MCP shutdown requested: ${reason}`);
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
    pollIntervalMs: getParentPollMs(process.env.CONTEXTPLUS_PARENT_POLL_MS),
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
  console.error(`Context+ MCP server running on stdio | root: ${ROOT_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
