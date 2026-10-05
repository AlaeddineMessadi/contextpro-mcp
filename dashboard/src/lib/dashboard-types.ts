import type { IndexStats, ReindexState, ToolAggregate, ToolCall } from "./mcp";
import type { PerfSnapshot } from "./perf";
export type View = "overview" | "activity" | "index" | "graph" | "resources";
export interface Project {
  projectId: string | null;
  root: string;
  hasIndex: boolean;
  available?: boolean;
  lastActiveAt?: string | null;
}
export interface StatusData {
  runtime?: { serverVersion: string; buildStamp: string; pid: number };
  files?: { source: number; indexed: number };
  index?: {
    state?: string;
    generation?: number;
    missingIndexedFiles?: number;
    removedIndexedFiles?: number;
    lastReindexAt?: string | null;
    lastReindexDurationMs?: number | null;
    lastIndexedAt?: string | null;
  };
  memory?: { nodes: number; edges: number };
  embeddings?: {
    provider?: string | null;
    model?: string | null;
    total?: number;
    fileSearch?: number;
    identifiers?: number;
    memory?: number;
    dimension?: number | null;
    stale?: boolean;
    staleReason?: string | null;
    vectorTablesReady?: boolean;
    lastReindexSkipped?: boolean;
    lastReindexError?: string | null;
  };
  git?: { branch?: string; uncommitted?: number; recentCommits?: string[] };
  warnings?: string[];
}
export interface ToolsData {
  total: number;
  aggregates: ToolAggregate[];
  history: ToolCall[];
}
export interface CodeGraph {
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    path?: string;
    importance: number;
  }>;
  edges: Array<{ source: string; target: string; type: string }>;
  stats: Record<string, number>;
}
export interface MemGraph {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    accessCount?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
  }>;
}
export interface DashboardFeeds {
  status: { status: StatusData };
  tools: ToolsData;
  reindex: { state: ReindexState | null };
  stats: { stats: IndexStats };
  graph: { graph: CodeGraph };
  memory: { memory: MemGraph };
  perf: PerfSnapshot;
}
