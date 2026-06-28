// sql_schema tool — agent-facing Postgres/Supabase schema + RLS navigator.
// FEATURE: Answer "what columns does X have / who has a SELECT policy on Y / what's
// the body of function Z" from the migration files, without dropping to psql.

import { readFile } from "fs/promises";
import { walkDirectory } from "../core/walker.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { extractSqlSchema, type SqlSchema, type SqlTable, type SqlPolicy, type SqlFunction } from "../core/sql-schema.js";

export interface SqlSchemaOptions {
  rootDir: string;
  /** Restrict to a subtree (default: scan the whole repo for .sql files). */
  targetPath?: string;
  /** Filter to a single table / policy table / function name (case-insensitive). */
  name?: string;
  format?: "text" | "json";
}

export interface AggregatedSchema {
  tables: SqlTable[];
  policies: SqlPolicy[];
  functions: SqlFunction[];
  filesScanned: number;
}

function isSqlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

async function collectSchemas(options: SqlSchemaOptions): Promise<SqlSchema[]> {
  const entries = await walkDirectory({ rootDir: options.rootDir, targetPath: options.targetPath, depthLimit: 0 });
  const sqlFiles = entries.filter((e) => !e.isDirectory && isSqlFile(e.relativePath));
  const schemas: SqlSchema[] = [];
  for (const file of sqlFiles) {
    try {
      const full = resolveProjectPath(options.rootDir, file.relativePath, "sql file");
      const source = await readFile(full, "utf-8");
      schemas.push(extractSqlSchema(file.relativePath, source));
    } catch {
      // Unreadable file — skip, never throw.
    }
  }
  return schemas;
}

/**
 * Merge per-file schemas into one project view. Later migrations win for tables of
 * the same name (a later CREATE/ALTER reflects the current shape), and RLS-enabled
 * is sticky (once enabled in any migration it stays enabled).
 */
export function aggregateSchemas(schemas: SqlSchema[]): AggregatedSchema {
  const tablesByName = new Map<string, SqlTable>();
  const policies: SqlPolicy[] = [];
  const functions: SqlFunction[] = [];

  for (const schema of schemas) {
    for (const table of schema.tables) {
      const existing = tablesByName.get(table.name);
      tablesByName.set(table.name, {
        ...table,
        rlsEnabled: table.rlsEnabled || (existing?.rlsEnabled ?? false),
      });
    }
    policies.push(...schema.policies);
    functions.push(...schema.functions);
  }

  // A later `enable row level security` in a different file than the CREATE TABLE
  // still applies — re-apply RLS flags across the merged set.
  for (const schema of schemas) {
    for (const table of schema.tables) {
      if (table.rlsEnabled) {
        const merged = tablesByName.get(table.name);
        if (merged) merged.rlsEnabled = true;
      }
    }
  }

  return {
    tables: [...tablesByName.values()],
    policies,
    functions,
    filesScanned: schemas.length,
  };
}

export async function getSqlSchema(options: SqlSchemaOptions): Promise<string> {
  const schemas = await collectSchemas(options);
  const aggregated = aggregateSchemas(schemas);

  const wanted = options.name?.toLowerCase();
  const tables = wanted ? aggregated.tables.filter((t) => t.name.toLowerCase() === wanted) : aggregated.tables;
  const policies = wanted ? aggregated.policies.filter((p) => p.table.toLowerCase() === wanted || p.name.toLowerCase() === wanted) : aggregated.policies;
  const functions = wanted ? aggregated.functions.filter((f) => f.name.toLowerCase() === wanted) : aggregated.functions;

  if (options.format === "json") {
    return JSON.stringify({ tables, policies, functions, filesScanned: aggregated.filesScanned }, null, 2);
  }

  return formatSchema(tables, policies, functions, aggregated.filesScanned, wanted);
}

function formatSchema(
  tables: SqlTable[],
  policies: SqlPolicy[],
  functions: SqlFunction[],
  filesScanned: number,
  wanted: string | undefined,
): string {
  const lines = [
    `=== SQL Schema${wanted ? ` (filter: ${wanted})` : ""} ===`,
    `Files scanned: ${filesScanned} | Tables: ${tables.length} | Policies: ${policies.length} | Functions: ${functions.length}`,
    "",
  ];

  if (tables.length === 0 && policies.length === 0 && functions.length === 0) {
    lines.push("No matching SQL schema found.");
    return lines.join("\n");
  }

  for (const table of tables) {
    lines.push(`TABLE ${table.schema}.${table.name}${table.rlsEnabled ? "  [RLS enabled]" : "  [RLS OFF]"}`);
    for (const col of table.columns) {
      const flags = [
        col.notNull ? "NOT NULL" : null,
        col.defaultValue ? `default ${col.defaultValue}` : null,
        col.check ? `check (${col.check})` : null,
      ].filter(Boolean).join(", ");
      lines.push(`  ${col.name} ${col.type}${flags ? `  — ${flags}` : ""}`);
    }
    const tablePolicies = policies.filter((p) => p.table === table.name);
    for (const p of tablePolicies) {
      lines.push(`  POLICY "${p.name}" ${p.command.toUpperCase()}${p.roles.length ? ` to ${p.roles.join(", ")}` : ""}${p.using ? ` using (${p.using})` : ""}`);
    }
    lines.push("");
  }

  // Policies whose table wasn't in the (possibly filtered) table list.
  const shownTables = new Set(tables.map((t) => t.name));
  const orphanPolicies = policies.filter((p) => !shownTables.has(p.table));
  if (orphanPolicies.length > 0) {
    lines.push("POLICIES:");
    for (const p of orphanPolicies) {
      lines.push(`  "${p.name}" on ${p.table} ${p.command.toUpperCase()}${p.roles.length ? ` to ${p.roles.join(", ")}` : ""}`);
    }
    lines.push("");
  }

  for (const fn of functions) {
    lines.push(`FUNCTION ${fn.schema}.${fn.name}${fn.securityDefiner ? "  [SECURITY DEFINER]" : ""}${fn.language ? `  language ${fn.language}` : ""}`);
    if (fn.body) {
      const preview = fn.body.length > 400 ? fn.body.slice(0, 400) + " …" : fn.body;
      for (const bodyLine of preview.split("\n")) lines.push(`    ${bodyLine}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
