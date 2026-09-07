import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TypeScriptReferenceProcess } from "../../build/core/typescript-reference-process.js";

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
