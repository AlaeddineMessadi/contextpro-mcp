// Tool-surface profiles and MCP safety hints
// FEATURE: Reduce agent tool-choice noise while preserving the full expert surface

export type ToolProfile = "lean" | "workflow" | "core" | "full";

export interface ContextProToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const CORE_TOOLS = new Set([
  "discover_tools",
  "health",
  "status",
  "efficiency_report",
  "artifact_read",
  "artifact_list",
  "repo_map",
  "graph_query",
  "search",
  "grep",
  "tree",
  "skeleton",
  "resolve_symbol",
  "exact_references",
  "blast_radius",
  "explain",
  "related",
  "task_pack",
  "decision_brief",
  "change_impact",
  "edit_scope",
  "validate_scope",
  "changed_since",
  "test_impact",
  "reindex",
  "memory_record_task",
  "lint",
  "diff",
  "semantic_diff",
  "checkpoint",
  "checkpoints",
  "restore",
  "workspace_context",
  "find_symbol",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "rename_symbol",
]);

const WORKFLOW_TOOLS = new Set([
  "discover_tools",
  "status", "task_pack", "search", "grep", "skeleton", "explain",
  "blast_radius", "validate_scope", "memory_record_task", "efficiency_report",
  "artifact_read", "reindex",
]);

const MUTATING_TOOLS = new Set([
  "gc",
  "graph_export",
  "scip_import",
  "checkpoint",
  "restore",
  "cluster",
  "memory_create",
  "memory_link",
  "memory_bulk",
  "memory_delete",
  "reindex",
  "memory_record_task",
  "promote_pattern",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "rename_symbol",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "gc",
  "restore",
  "memory_delete",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "rename_symbol",
]);

export function resolveToolProfile(value?: string): ToolProfile {
  const name = value?.trim().toLowerCase();
  return name === "lean" ? "lean" : !name || name === "workflow" ? "workflow" : name === "core" ? "core" : "full";
}

export function isToolEnabled(name: string, profile: ToolProfile): boolean {
  if (profile === "lean") return name === "context" || name === "discover_tools";
  return profile === "full" || (profile === "workflow" ? WORKFLOW_TOOLS : CORE_TOOLS).has(name);
}

export function annotationsForTool(name: string): ContextProToolAnnotations {
  const mutating = MUTATING_TOOLS.has(name);
  return {
    readOnlyHint: !mutating,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: !mutating,
    openWorldHint: false,
  };
}

export function listCoreTools(): string[] {
  return [...CORE_TOOLS].sort();
}
