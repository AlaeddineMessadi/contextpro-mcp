// SQL schema / RLS extractor tests
// FEATURE: Parse Supabase/Postgres migrations into tables, columns, RLS policies,
// and SECURITY DEFINER functions so agents can answer schema/RLS questions without
// dropping to psql — the top real-user ask.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSqlSchema } from "../../build/core/sql-schema.js";

const MIGRATION = `
-- create the offers table
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.users(id),
  amount numeric(10,2) not null check (amount > 0),
  status text not null default 'pending',
  created_at timestamptz default now()
);

alter table public.offers enable row level security;

create policy "farmers can view their offers"
  on public.offers
  for select
  to authenticated
  using (buyer_id = auth.uid());

create policy offers_admin_all
  on public.offers
  for all
  to service_role
  using (true);

create or replace function public.thread_participant_user_ids(thread_id uuid)
  returns setof uuid
  language sql
  security definer
as $$
  select user_id from public.thread_participants where thread_id = $1;
$$;
`;

describe("extractSqlSchema", () => {
  it("extracts a table with its columns and types", () => {
    const schema = extractSqlSchema("supabase/migrations/0001_offers.sql", MIGRATION);
    const offers = schema.tables.find((t) => t.name === "offers");
    assert.ok(offers, "offers table should be extracted");
    const colNames = offers.columns.map((c) => c.name);
    assert.ok(colNames.includes("id"));
    assert.ok(colNames.includes("buyer_id"));
    assert.ok(colNames.includes("amount"));
    assert.ok(colNames.includes("status"));

    const amount = offers.columns.find((c) => c.name === "amount");
    assert.match(amount.type, /numeric/i, `amount type should be numeric, got ${amount.type}`);
  });

  it("captures a CHECK constraint on a column", () => {
    const schema = extractSqlSchema("m.sql", MIGRATION);
    const offers = schema.tables.find((t) => t.name === "offers");
    const amount = offers.columns.find((c) => c.name === "amount");
    assert.ok(amount.check && /amount > 0/.test(amount.check), `expected check on amount, got ${amount.check}`);
  });

  it("flags RLS-enabled tables", () => {
    const schema = extractSqlSchema("m.sql", MIGRATION);
    const offers = schema.tables.find((t) => t.name === "offers");
    assert.equal(offers.rlsEnabled, true, "offers should have RLS enabled");
  });

  it("extracts RLS policies with command, roles, and predicate", () => {
    const schema = extractSqlSchema("m.sql", MIGRATION);
    const policies = schema.policies.filter((p) => p.table === "offers");
    assert.ok(policies.length >= 2, `expected >=2 policies, got ${policies.length}`);

    const selectPolicy = policies.find((p) => p.name.includes("farmers"));
    assert.ok(selectPolicy);
    assert.match(selectPolicy.command, /select/i);
    assert.ok(selectPolicy.roles.includes("authenticated"));
    assert.match(selectPolicy.using ?? "", /auth\.uid\(\)/);

    const adminPolicy = policies.find((p) => p.name === "offers_admin_all");
    assert.ok(adminPolicy);
    assert.match(adminPolicy.command, /all/i);
  });

  it("extracts SECURITY DEFINER functions with their body", () => {
    const schema = extractSqlSchema("m.sql", MIGRATION);
    const fn = schema.functions.find((f) => f.name === "thread_participant_user_ids");
    assert.ok(fn, "function should be extracted");
    assert.equal(fn.securityDefiner, true, "should be flagged SECURITY DEFINER");
    assert.match(fn.body, /select user_id from public\.thread_participants/i);
  });

  it("returns empty structures for SQL with no DDL", () => {
    const schema = extractSqlSchema("m.sql", "SELECT 1;\n-- just a query\n");
    assert.deepEqual(schema.tables, []);
    assert.deepEqual(schema.policies, []);
    assert.deepEqual(schema.functions, []);
  });
});
