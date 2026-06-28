// sql_schema tool integration — scans a migrations dir and answers queries
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";

describe("sql_schema tool", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-sqltool-"));
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });

    await writeFile(
      join(root, "supabase", "migrations", "0001_init.sql"),
      [
        "create table public.deliveries (",
        "  id uuid primary key,",
        "  worker_id uuid not null,",
        "  status text not null default 'queued'",
        ");",
        "alter table public.deliveries enable row level security;",
        'create policy "admin can select deliveries" on public.deliveries',
        "  for select to service_role using (true);",
      ].join("\n") + "\n",
    );
    // A later migration that adds RLS to a table created without it.
    await writeFile(
      join(root, "supabase", "migrations", "0002_more.sql"),
      [
        "create function public.is_admin() returns boolean language sql security definer as $$",
        "  select true;",
        "$$;",
      ].join("\n") + "\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("aggregates tables, policies, and functions across migration files", async () => {
    const { getSqlSchema } = await import("../../build/tools/sql-schema.js");
    const json = JSON.parse(await getSqlSchema({ rootDir: root, format: "json" }));

    const deliveries = json.tables.find((t) => t.name === "deliveries");
    assert.ok(deliveries, "deliveries table found");
    assert.equal(deliveries.rlsEnabled, true);
    assert.ok(deliveries.columns.some((c) => c.name === "worker_id"));

    assert.ok(json.policies.some((p) => p.table === "deliveries" && /select/i.test(p.command)));
    assert.ok(json.functions.some((f) => f.name === "is_admin" && f.securityDefiner));
    assert.ok(json.filesScanned >= 2);
  });

  it("filters by table name and renders text", async () => {
    const { getSqlSchema } = await import("../../build/tools/sql-schema.js");
    const text = await getSqlSchema({ rootDir: root, name: "deliveries" });
    assert.match(text, /TABLE public\.deliveries/);
    assert.match(text, /RLS enabled/);
    assert.match(text, /worker_id/);
    assert.doesNotMatch(text, /is_admin/, "function should be filtered out when querying a table");
  });
});
