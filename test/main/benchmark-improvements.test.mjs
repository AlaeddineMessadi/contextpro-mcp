import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFileSkeleton } from '../../build/tools/file-skeleton.js';
import { reindex } from '../../build/tools/reindex.js';
import { unifiedSearch } from '../../build/tools/search.js';
import { closeDB } from '../../build/core/db.js';
import { explain } from '../../build/tools/explain.js';

it('preserves complete multiline contracts and local aliased exports without implementation bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-contract-'));
  try {
    await writeFile(join(root, 'api.ts'), `interface Options { limit: number; predicate(value: string): boolean; }
function create(options: Options): { directory: string; dependencies: Record<string, string>; } {
  throw new Error('implementation-must-not-appear');
}
function internal() { return 'private'; }
export { create as publicCreate, Options };
`);
    const output = await getFileSkeleton({ rootDir: root, filePath: 'api.ts', exportedOnly: true });
    assert.match(output, /dependencies: Record<string, string>/);
    assert.match(output, /predicate\(value: string\): boolean/);
    assert.doesNotMatch(output, /implementation-must-not-appear|\[function\].*internal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('shares one WASM grammar load across concurrent first-use parses', async () => {
  const { default: Parser } = await import('web-tree-sitter');
  await Parser.init();
  const original = Parser.Language.load;
  let loads = 0;
  Parser.Language.load = async function (...args) { loads++; return original.apply(this, args); };
  try {
    const { parseWithTreeSitter } = await import('../../build/core/tree-sitter-runtime.js');
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => parseWithTreeSitter(`package main\nfunc Action${index}() {}`, '.go')));
    assert.equal(loads, 1);
    for (let i = 0; i < results.length; i++) assert.ok(results[i]?.some(symbol => symbol.name === `Action${i}`));
  } finally { Parser.Language.load = original; }
});

it('compact search preserves rankings and excerpts, exposes bounded dependencies and numeric profiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-compact-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/guard.ts'), 'export function checkPath(path: string) { return path.startsWith("/"); }');
    await writeFile(join(root, 'src/write.ts'), 'import { checkPath } from "./guard.js";\nexport function writeSafely(path: string) { return checkPath(path); }');
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    const args = { rootDir: root, query: 'writeSafely', mode: 'file', preset: 'keyword_only', topK: 1, includeDependencies: true };
    const verbose = JSON.parse(await unifiedSearch({ ...args, format: 'json' }));
    const compact = JSON.parse(await unifiedSearch({ ...args, format: 'compact', profile: true }));
    assert.deepEqual(compact.files.map(f => f.path), verbose.files.results.map(f => f.path));
    assert.deepEqual(compact.files[0].code, verbose.files.results[0].inlineCode);
    assert.deepEqual(compact.freshness.indexState, verbose.freshness.indexState);
    assert.ok(compact.dependencies.some(f => f.path === 'src/guard.ts'));
    assert.ok(compact.dependencies.length <= 3);
    assert.ok(compact.timingsMs.total >= 0);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(verbose).length);
    const batch = await explain({rootDir:root,symbols:[{file:'src/guard.ts',symbol:'checkPath'},{file:'src/write.ts',symbol:'writeSafely'}],depth:0});
    assert.match(batch,/return path.startsWith/);
    assert.match(batch,/return checkPath/);
    await assert.rejects(explain({rootDir:root,symbol:'one',symbols:[{symbol:'two'}]}),/not both/);
    await writeFile(join(root,'src/large.ts'), `export function huge() { return '${'payload'.repeat(1000)}'; }`);
    const bounded = await explain({rootDir:root,symbols:[{file:'src/large.ts',symbol:'huge'}],maxTokens:512});
    assert.match(bounded,/Omitted to fit response budget/);
    assert.doesNotMatch(bounded,/payloadpayload/);
    assert.ok(Buffer.byteLength(bounded) <= 2048);
  } finally { closeDB(root); await rm(root, { recursive: true, force: true }); }
});
