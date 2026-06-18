import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT_A = join(process.cwd(), "test", "_project_a");
const ROOT_B = join(process.cwd(), "test", "_project_b");

let dbModule;

describe("project isolation", () => {
  before(async () => {
    await rm(ROOT_A, { recursive: true, force: true });
    await rm(ROOT_B, { recursive: true, force: true });
    await mkdir(join(ROOT_A, ".contextpro"), { recursive: true });
    await mkdir(join(ROOT_B, ".contextpro"), { recursive: true });
    dbModule = await import("../../build/core/db.js");
  });

  after(async () => {
    dbModule.closeDB();
    await rm(ROOT_A, { recursive: true, force: true });
    await rm(ROOT_B, { recursive: true, force: true });
  });

  it("returns distinct DB instances for distinct roots", async () => {
    const dbA = await dbModule.getDB(ROOT_A);
    const dbB = await dbModule.getDB(ROOT_B);

    assert.notEqual(dbA, dbB);

    dbA.upsertFile("src/a.ts", "hash-a", "A", "typescript", 1);
    dbB.upsertFile("src/b.ts", "hash-b", "B", "typescript", 1);

    assert.ok(dbA.getFile("src/a.ts"));
    assert.equal(dbA.getFile("src/b.ts"), null);
    assert.ok(dbB.getFile("src/b.ts"));
    assert.equal(dbB.getFile("src/a.ts"), null);
  });
});
