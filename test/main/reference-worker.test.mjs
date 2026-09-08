import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TypeScriptReferenceProcess } from "../../build/core/typescript-reference-process.js";

it("bounds the real worker's IPC result while preserving all occurrence counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-limit-"));
  const target = join(root, "z-definition.ts");
  const caller = join(root, "a-caller.ts");
  const pool = new TypeScriptReferenceProcess();
  try {
    await writeFile(target, "export function value() { return 1; }\n");
    await writeFile(caller, "import { value } from './z-definition';\n" + "value();\n".repeat(2000));
    const input = { rootDir: root, files: [target, caller], file: target, line: 1, symbol: "value" };
    const small = await pool.query({ ...input, limit: 3 });
    assert.equal(small.references.length, 3);
    assert.equal(small.total, 2002);
    assert.deepEqual(small.counts, { definition: 1, import: 1, call: 2000, reference: 0 });
    assert.deepEqual(small.references.map(ref => [ref.file, ref.line]), [
      ["a-caller.ts", 1], ["a-caller.ts", 2], ["a-caller.ts", 3],
    ]);
    assert.equal(small.references[1].context, "value();");
    const capped = await pool.query({ ...input, limit: 10000 });
    assert.equal(capped.references.length, 500);
    assert.deepEqual(capped.references.slice(0, 3), small.references);
    assert.equal(capped.total, small.total);
    assert.deepEqual(capped.counts, small.counts);
    assert.equal((await pool.query({ ...input, limit: 0 })).references.length, 1);
    assert.equal((await pool.query(input)).references.length, 100);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

it("times out blocked compiler work without blocking the parent and recovers on the next request", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-worker-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, "process.on('message', () => { while (true) {} });\n");
  const pool = new TypeScriptReferenceProcess({ worker: pathToFileURL(worker), timeoutMs: 250 });
  const input = { rootDir: root, files: [], file: join(root, "value.ts"), line: 1, symbol: "value" };
  let parentTicked = false;
  const timer = setTimeout(() => { parentTicked = true; }, 25);
  try {
    await assert.rejects(pool.query(input), /time limit/);
    assert.equal(parentTicked, true);
    await writeFile(worker, "process.on('message', m => process.send({id:m.id,result:{references:[],warnings:[]}}));\n");
    assert.deepEqual((await pool.query(input)).references, []);
  } finally { clearTimeout(timer); pool.close(); await rm(root, { recursive: true, force: true }); }
});

it("contains a compiler process crash and rejects queued requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-crash-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, "process.on('message', () => process.kill(process.pid, 'SIGKILL'));\n");
  const pool = new TypeScriptReferenceProcess({ worker: pathToFileURL(worker), timeoutMs: 2000 });
  const input = { rootDir: root, files: [], file: join(root, "value.ts"), line: 1, symbol: "value" };
  try {
    const results = await Promise.allSettled([pool.query(input), pool.query(input)]);
    assert.ok(results.every(result => result.status === "rejected" && /worker exited/.test(result.reason.message)));
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});
