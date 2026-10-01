import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TypeScriptReferenceProcess } from "../../build/core/typescript-reference-process.js";

it("uses the monorepo heap default, rejects invalid limits, and respects smaller explicit ceilings", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-heap-"));
  const worker = join(root, "worker.mjs");
  const previous = process.env.CONTEXTPRO_REFERENCE_HEAP_MB;
  await writeFile(worker, "process.on('message', m => process.send({id:m.id,result:{args:process.execArgv}}));");
  const input = { rootDir: root, files: [], file: join(root, 'value.ts'), line: 1, symbol: 'value' };
  try {
    for (const [env, override, expected] of [[undefined, undefined, 1024], ['invalid', undefined, 1024], ['0', undefined, 1024], ['4097', undefined, 1024], ['768', undefined, 768], ['2048', 512, 512]]) {
      if (env === undefined) delete process.env.CONTEXTPRO_REFERENCE_HEAP_MB;
      else process.env.CONTEXTPRO_REFERENCE_HEAP_MB = env;
      const pool = new TypeScriptReferenceProcess({ worker: pathToFileURL(worker), heapMb: override });
      try { assert.ok((await pool.query(input)).args.includes(`--max-old-space-size=${expected}`)); }
      finally { pool.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.CONTEXTPRO_REFERENCE_HEAP_MB;
    else process.env.CONTEXTPRO_REFERENCE_HEAP_MB = previous;
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(small.callsByFile, [{ file: "a-caller.ts", calls: 2000 }]);
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

it("bounds per-file call summaries without hiding aggregate totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-files-"));
  const target = join(root, "definition.ts");
  const pool = new TypeScriptReferenceProcess();
  try {
    await writeFile(target, "export function value() { return 1; }\n");
    const files = [target];
    for (let i = 0; i < 52; i++) {
      const file = join(root, `caller-${String(i).padStart(2, "0")}.ts`);
      await writeFile(file, "import { value } from './definition';\nvalue();\n");
      files.push(file);
    }
    const result = await pool.query({ rootDir: root, files, file: target, line: 1, symbol: "value", limit: 1 });
    assert.equal(result.references.length, 1);
    assert.equal(result.total, 105);
    assert.equal(result.counts.call, 52);
    assert.equal(result.callFileCount, 52);
    assert.equal(result.callsByFile.length, 50);
    assert.equal(result.callsByFile.at(-1).file, "caller-49.ts");
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

it("times out blocked compiler work without blocking the parent and recovers on the next request", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-worker-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, "process.on('message', () => { while (true) {} });\n");
  // The recovery request launches a new OS process. Allow scheduler/startup
  // latency under the full parallel suite while still timing out blocked work.
  const pool = new TypeScriptReferenceProcess({ worker: pathToFileURL(worker), timeoutMs: 2000 });
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

it("gives queued requests their own worker and deadline after an active timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-queue-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, "process.on('message', m => { if (m.input.symbol === 'blocked') { while (true) {} } process.send({id:m.id,result:{references:[],warnings:[]}}); });\n");
  const pool = new TypeScriptReferenceProcess({worker:pathToFileURL(worker), timeoutMs:2000});
  const input = {rootDir:root, files:[], file:join(root,'value.ts'), line:1, symbol:'blocked'};
  try {
    const results = await Promise.allSettled([pool.query(input), pool.query({...input, symbol:'value'})]);
    assert.equal(results[0].status, 'rejected');
    assert.match(results[0].reason.message, /time limit/);
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(results[1].value.references, []);
  } finally {pool.close(); await rm(root,{recursive:true,force:true});}
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

it("reports heap exhaustion without leaking worker stderr and recovers after a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-oom-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, `process.on('message', () => {
    process.stderr.write('private-worker-detail\\nFATAL ERROR: Allocation failed - JavaScript heap out of memory\\n', () => process.exit(1));
  });`);
  const pool = new TypeScriptReferenceProcess({worker: pathToFileURL(worker), heapMb: 768});
  const input = { rootDir: root, files: [], file: join(root, "value.ts"), line: 1, symbol: "value" };
  try {
    await assert.rejects(pool.query(input), error => {
      assert.match(error.message, /exhausted its 768 MB/);
      assert.match(error.message, /CONTEXTPRO_REFERENCE_HEAP_MB/);
      assert.doesNotMatch(error.message, /private-worker-detail/);
      return true;
    });
    await writeFile(worker, "process.on('message', m => process.send({id:m.id,result:{references:[],args:process.execArgv}}));");
    const result = await pool.query(input);
    assert.deepEqual(result.references, []);
    assert.ok(result.args.includes('--max-old-space-size=768'));
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

it("checks every project after releasing the previous compiler and avoids stale results on repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-reference-projects-"));
  const pool = new TypeScriptReferenceProcess();
  try {
    const target=join(root,'definition.ts');
    await writeFile(target, 'export function value() { return 1; }\n');
    const files=[target];
    for (const folder of ['frontend','backend','worker','tests']) {
      await mkdir(join(root,folder));
      await writeFile(join(root,folder,'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022'},include:['*.ts']}));
      const file=join(root,folder,'caller.ts');
      await writeFile(file, 'import {value} from "../definition";\nvalue();\n');
      files.push(file);
    }
    const input={rootDir:root,files,file:target,line:1,symbol:'value',limit:20};
    const first=await pool.query(input);
    assert.equal(first.counts.call,4);
    assert.equal(first.scope.checkedFiles,5);
    assert.equal(first.projectCount,5);
    await writeFile(files[1], 'import {value} from "../definition";\nvalue(); value();\n');
    const next=await pool.query(input);
    assert.equal(next.counts.call,5);
    assert.equal(next.scope.checkedFiles,5);
  } finally { pool.close(); await rm(root,{recursive:true,force:true}); }
});
