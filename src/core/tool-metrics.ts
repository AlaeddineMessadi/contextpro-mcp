// Lightweight in-process timing stats for MCP tool latency and error visibility
// FEATURE: Runtime metrics — status exposes which tools are hot or failing

import { resolve } from "path";

export interface ToolTimingSnapshot {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
  lastStatus: "ok" | "error";
  lastAt: string;
}

interface ToolTimingMutable {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastStatus: "ok" | "error";
  lastAt: string;
}

const toolMetricsByRoot = new Map<string, Map<string, ToolTimingMutable>>();
// Bound the per-root metrics map so a long-lived server hopping across many project directories
// can't grow it without limit. LRU-evict the oldest root when over the cap.
const MAX_TRACKED_ROOTS = 50;

export function recordToolTiming(rootDir: string, tool: string, durationMs: number, status: "ok" | "error"): void {
  const normalizedRoot = resolve(rootDir);
  // Touch-to-front LRU: delete + re-set moves this root to the end of insertion order.
  const existingByTool = toolMetricsByRoot.get(normalizedRoot);
  if (existingByTool) toolMetricsByRoot.delete(normalizedRoot);
  const byTool = existingByTool ?? new Map<string, ToolTimingMutable>();
  const existing = byTool.get(tool) ?? {
    calls: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastStatus: "ok" as const,
    lastAt: new Date().toISOString(),
  };
  existing.calls += 1;
  if (status === "error") existing.errors += 1;
  existing.totalMs += durationMs;
  existing.maxMs = Math.max(existing.maxMs, durationMs);
  existing.lastMs = durationMs;
  existing.lastStatus = status;
  existing.lastAt = new Date().toISOString();
  byTool.set(tool, existing);
  toolMetricsByRoot.set(normalizedRoot, byTool);
  // Evict the least-recently-used root(s) if over the cap.
  while (toolMetricsByRoot.size > MAX_TRACKED_ROOTS) {
    const oldest = toolMetricsByRoot.keys().next().value;
    if (oldest === undefined) break;
    toolMetricsByRoot.delete(oldest);
  }
}

export function getToolTimingSnapshots(rootDir: string, limit: number = 10): ToolTimingSnapshot[] {
  const normalizedRoot = resolve(rootDir);
  const byTool = toolMetricsByRoot.get(normalizedRoot);
  if (!byTool) return [];
  return [...byTool.entries()]
    .map(([tool, value]) => ({
      tool,
      calls: value.calls,
      errors: value.errors,
      avgMs: Number((value.totalMs / Math.max(value.calls, 1)).toFixed(1)),
      maxMs: Number(value.maxMs.toFixed(1)),
      lastMs: Number(value.lastMs.toFixed(1)),
      lastStatus: value.lastStatus,
      lastAt: value.lastAt,
    }))
    .sort((left, right) => right.lastAt.localeCompare(left.lastAt))
    .slice(0, Math.max(1, limit));
}
