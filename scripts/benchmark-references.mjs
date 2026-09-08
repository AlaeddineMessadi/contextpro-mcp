#!/usr/bin/env node
// Offline old/new compiler replay. No agent tokens, model calls or billing claims.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { latencyDistribution, fingerprintLauncher } from './benchmark-evidence.mjs';
const exec = promisify(execFile);
const option = name => process.argv[process.argv.indexOf(name) + 1];

async function worker(build, root, calls) {
  const load = path => import(pathToFileURL(join(build, path)).href);
  const { reindex } = await load('tools/reindex.js');
  const { exactReferencesTool } = await load('tools/exact-references.js');
  const { closeTypeScriptReferenceProcess } = await load('core/typescript-reference-process.js');
  const { closeDB } = await load('core/db.js');
  const rows = [];
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'src/guard.ts'), 'export function canEditItem() { return true; }\n');
    await writeFile(join(root, 'src/barrel.ts'), "export { canEditItem as canEdit } from './guard';\n");
    await writeFile(join(root, 'src/use.ts'), "import { canEdit } from './barrel';\n" + 'canEdit();\n'.repeat(calls));
    await writeFile(join(root, 'tests/guard.test.ts'), "import { canEditItem } from '../src/guard';\n" + 'canEditItem();\n'.repeat(9));
    await writeFile(join(root, 'src/unrelated.ts'), 'export function unrelated(canEditItem: () => boolean) { return canEditItem(); }\nexport const object = {canEditItem: () => false}; object.canEditItem();\n');
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    const options = { rootDir: root, symbolName: 'canEditItem', file: 'src/guard.ts', line: 1, limit: 100, format: 'json' };
    for (const state of ['cold_compiler', 'warm_compiler']) {
      const started = performance.now();
      const text = await exactReferencesTool(options);
      const latencyMs = performance.now() - started;
      const data = JSON.parse(text);
      assert.equal(data.counts.call, calls + 9);
      assert.equal(data.warnings.filter(w => !w.includes('Only the first results')).length, 0);
      assert.ok(data.references.every(ref => ref.file !== 'src/unrelated.ts'));
      if (calls === 4) {
        const actual = data.references.filter(ref => ref.kind === 'call').map(ref => `${ref.file}:${ref.line}`).sort();
        const expected = [...Array.from({ length: 4 }, (_, i) => `src/use.ts:${i + 2}`), ...Array.from({ length: 9 }, (_, i) => `tests/guard.test.ts:${i + 2}`)].sort();
        assert.deepEqual(actual, expected);
      }
      if (data.callsByFile) assert.deepEqual(data.callsByFile, [{ file: 'src/use.ts', calls }, { file: 'tests/guard.test.ts', calls: 9 }]);
      rows.push({ state, latencyMs, outputBytes: Buffer.byteLength(text), calls: data.counts.call, returned: data.returned, total: data.total, correctness: 'PASS' });
    }
    const text = await exactReferencesTool({ ...options, format: 'text' });
    return { rows, textBytes: Buffer.byteLength(text), hasCallLabels: /\[call\]/.test(text), hasFileCallTotals: text.includes('Calls by file') };
  } finally { closeTypeScriptReferenceProcess(); closeDB(root); }
}
if (process.argv.includes('--worker')) {
  console.log(JSON.stringify(await worker(resolve(option('--build')), resolve(option('--root')), Number(option('--calls')))));
} else {
  for (const name of ['--baseline-build', '--candidate-build', '--output']) if (!process.argv.includes(name)) throw new Error(`Required: ${name}`);
  const builds = { baseline: resolve(option('--baseline-build')), contextpro: resolve(option('--candidate-build')) };
  const repeats = process.argv.includes('--repeats') ? Number(option('--repeats')) : 3;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1..20');
  const output = resolve(option('--output'));
  try { await readFile(output); throw new Error('Refusing to replace an existing benchmark record'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const calls of [4, 2000]) {
      for (const variant of repeat % 2 ? ['contextpro', 'baseline'] : ['baseline', 'contextpro']) {
        const root = await mkdtemp(join(tmpdir(), 'contextpro-reference-bench-'));
        try {
          const result = await exec(process.execPath, [process.argv[1], '--worker', '--build', builds[variant], '--root', root, '--calls', String(calls)], { timeout: 60000, maxBuffer: 1024 * 1024 });
          records.push({ variant, repeat: repeat + 1, fixture: calls === 4 ? '13-calls-alias-shadow' : '2009-calls-truncated', ...JSON.parse(result.stdout) });
          console.log(`${variant} repeat ${repeat + 1} / ${calls + 9} calls: PASS`);
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  const summary = [];
  for (const fixture of [...new Set(records.map(r => r.fixture))]) for (const variant of Object.keys(builds)) for (const state of ['cold_compiler', 'warm_compiler']) {
    const rows = records.filter(r => r.fixture === fixture && r.variant === variant).flatMap(r => r.rows.filter(r => r.state === state));
    summary.push({ fixture, variant, state, ...latencyDistribution(rows.map(r => r.latencyMs)) });
  }
  const provenance = {};
  for (const [variant, build] of Object.entries(builds)) {
    provenance[variant] = { build, fingerprint: await fingerprintLauncher({ args: [join(build, 'index.js')] }), commit: (await exec('git', ['-C', resolve(build, '..'), 'rev-parse', 'HEAD'])).stdout.trim() };
  }
  await writeFile(output, JSON.stringify({ method: 'Alternating old/new isolated processes, identical generated corpus. Structural index prepared; cold/warm refers only to compiler reuse. OS caches are uncontrolled. Module load/indexing excluded. Bytes are not provider tokens or cost. No agent benchmark.', node: process.version, provenance, records, summary }, null, 2), { flag: 'wx' });
  console.log(`Saved ${output}`);
}
