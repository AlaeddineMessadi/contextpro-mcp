import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getNativeRuntime, nativeRuntimeIdentity } from '../../build/core/native-runtime.js';
import { repairNativeDependencies } from '../../build/core/native-repair.js';
const exec = promisify(execFile);
let root, previousCache;

async function packageAt(directory, name, source) {
  const target = join(directory, 'node_modules', name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), JSON.stringify({ name, version: name === 'better-sqlite3' ? '12.10.0' : '0.1.9', main: 'index.js' }));
  await writeFile(join(target, 'index.js'), source);
}
async function readyRuntime(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"private":true}');
  await packageAt(directory, 'better-sqlite3', 'module.exports = class Database { prepare() { return { get() { return {ok: 1}; } }; } close() {} };');
  await packageAt(directory, 'sqlite-vec', 'module.exports = { load() {} };');
}

describe('isolated native runtimes', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'contextpro-native-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'better-sqlite3': '^12.10.0', 'sqlite-vec': '^0.1.9' } }));
    previousCache = process.env.CONTEXTPRO_NATIVE_CACHE_DIR;
    process.env.CONTEXTPRO_NATIVE_CACHE_DIR = join(root, 'cache');
  });
  afterEach(async () => {
    if (previousCache === undefined) delete process.env.CONTEXTPRO_NATIVE_CACHE_DIR;
    else process.env.CONTEXTPRO_NATIVE_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
  });

  it('separates ABIs, architectures, platforms, libc and dependency versions', async () => {
    const identity = { abi: '137', platform: 'linux', arch: 'arm64', libc: 'glibc' };
    const original = getNativeRuntime(root, identity).directory;
    for (const change of [{ abi: '147' }, { arch: 'x64' }, { platform: 'darwin' }, { libc: 'musl' }]) {
      assert.notEqual(getNativeRuntime(root, { ...identity, ...change }).directory, original);
    }
    assert.equal(getNativeRuntime(root, identity).directory, original);
    await packageAt(root, 'better-sqlite3', '');
    const path = join(root, 'node_modules/better-sqlite3/package.json');
    await writeFile(path, '{"name":"better-sqlite3","version":"12.11.0"}');
    assert.notEqual(getNativeRuntime(root, identity).directory, original);
  });

  it('records the actual process ABI and uses exact dependency versions', () => {
    assert.equal(nativeRuntimeIdentity().abi, process.versions.modules);
    assert.deepEqual(getNativeRuntime(root).dependencies, { 'better-sqlite3': '12.10.0', 'sqlite-vec': '0.1.9' });
  });

  it('reuses a validated cache concurrently without modifying the shared installation', async () => {
    const runtime = getNativeRuntime(root);
    await readyRuntime(runtime.directory);
    const original = await readFile(join(root, 'package.json'), 'utf8');
    const results = await Promise.all([repairNativeDependencies(root), repairNativeDependencies(root)]);
    for (const actions of results) {
      assert.equal(actions.length, 1);
      assert.equal(actions[0].label, 'verify-isolated-native-deps');
      assert.equal(actions[0].success, true);
    }
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original);
    await assert.rejects(readFile(join(root, 'node_modules/better-sqlite3/package.json')), { code: 'ENOENT' });
  });

  it('does not cache a constructor with an ABI failure and selects repaired bindings in the same process', async () => {
    const build = join(root, 'build/core');
    await mkdir(build, { recursive: true });
    for (const name of ['db-native', 'native-runtime', 'native-repair']) await cp(resolve(`build/core/${name}.js`), join(build, `${name}.js`));
    await packageAt(root, 'better-sqlite3', 'module.exports = class Database { constructor() { throw new Error("NODE_MODULE_VERSION 147, expected 137"); } };');
    await packageAt(root, 'sqlite-vec', 'module.exports = { load() {} };');
    const repaired = join(root, 'ready');
    await readyRuntime(repaired);
    const module = pathToFileURL(join(build, 'db-native.js')).href;
    const runtime = getNativeRuntime(root).directory;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { cp } from 'node:fs/promises';
      const mod = await import(${JSON.stringify(module)});
      const before = mod.probeNativeStorage();
      await cp(${JSON.stringify(repaired)}, ${JSON.stringify(runtime)}, {recursive: true});
      const after = mod.probeNativeStorage();
      console.log(JSON.stringify({before, after}));
    `], { env: { ...process.env, CONTEXTPRO_NATIVE_AUTO_REPAIR: 'false' } });
    const { before, after } = JSON.parse(stdout);
    assert.equal(before.ok, false);
    assert.equal(before.diagnostic.code, 'native_module_abi_mismatch');
    assert.equal(after.ok, true);
  });
});
