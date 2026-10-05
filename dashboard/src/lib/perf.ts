// Process resource sampling for the dashboard's Performance panel.
//
// Reads OS process stats via `ps` and buckets them into the categories that matter
// for "why is my laptop hot": the contextpro MCP servers (across agent sessions),
// Ollama (local embeddings), and this dashboard. Pure read-only; macOS/Linux `ps`.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ProcSample {
  pid: number;
  ppid: number;
  cpu: number; // %CPU
  rssMB: number; // resident memory
  etime: string; // elapsed time
  kind: "mcp" | "ollama" | "nextjs" | "other";
  command: string;
}

export interface PerfSnapshot {
  sampledAt: number;
  processes: ProcSample[];
  totals: {
    mcp: { count: number; cpu: number; rssMB: number };
    ollama: { count: number; cpu: number; rssMB: number };
  };
  mcpSessions: number;
}

function classify(cmd: string): ProcSample["kind"] {
  if (/build\/index\.js/.test(cmd) && /contextpro/i.test(cmd)) return "mcp";
  if (/ollama|llama-server/i.test(cmd)) return "ollama";
  if (/next-server|next dev|next start/i.test(cmd)) return "nextjs";
  return "other";
}

export async function perfSnapshot(): Promise<PerfSnapshot> {
  // Fail visibly if sampling is unavailable; an empty sample is not zero usage.
  const { stdout: out } = await execFileAsync(
    "ps",
    ["-Ao", "pid=,ppid=,pcpu=,rss=,etime=,command="],
    { maxBuffer: 4 * 1024 * 1024 },
  );

  const processes: ProcSample[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/,
    );
    if (!m) continue;
    const command = m[6];
    const kind = classify(command);
    if (kind === "other") continue; // only show the relevant processes
    processes.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssMB: Math.round(Number(m[4]) / 1024),
      etime: m[5],
      kind,
      command: command.length > 90 ? command.slice(0, 90) + "…" : command,
    });
  }

  processes.sort((a, b) => b.cpu - a.cpu);

  const sum = (k: ProcSample["kind"]) =>
    processes
      .filter((p) => p.kind === k)
      .reduce(
        (acc, p) => ({
          count: acc.count + 1,
          cpu: Math.round((acc.cpu + p.cpu) * 10) / 10,
          rssMB: acc.rssMB + p.rssMB,
        }),
        { count: 0, cpu: 0, rssMB: 0 },
      );

  return {
    sampledAt: Date.now(),
    processes,
    totals: { mcp: sum("mcp"), ollama: sum("ollama") },
    mcpSessions: processes.filter((p) => p.kind === "mcp").length,
  };
}
