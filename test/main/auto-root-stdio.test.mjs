import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER = join(process.cwd(), 'build/index.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 8000 });
const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const targets = [{ file: 'api.ts', start: 1, end: 1 }];
// HOME/.contextpro also holds the global workspace registry; a project index is its config and database.
const hasProjectIndex = dir => ['config.json', 'index.db'].some(name => existsSync(join(dir, '.contextpro', name)));

let scratch, home;
const env = () => ({ ...process.env, HOME: home, CONTEXTPRO_TOOL_PROFILE: 'full', CONTEXTPRO_REINDEX_NO_EMBED: 'true', CONTEXTPRO_EMBED_TRACKER: 'lazy',
  CONTEXTPRO_ALLOW_UNSAFE_ROOT: '', GIT_CEILING_DIRECTORIES: '' });

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'api.ts'), `export const marker = '${dir}';\n`);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture');
  return dir;
}

// roots: undefined (no roots capability) or a function returning the URIs (or a promise) per roots/list request.
async function start({ cwd, args = [], roots }) {
  const client = new Client({ name: 'auto-root', version: '1' }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  const stats = { listRoots: 0 };
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => {
    stats.listRoots++;
    return { roots: (await roots()).map(dir => ({ uri: pathToFileURL(dir).href })) };
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], cwd, env: env(), stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  try { await client.connect(transport); } catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
  return {
    client, stats, diagnostics: () => diagnostics,
    call: (name, callArgs = {}) => client.callTool({ name, arguments: callArgs }),
    health: async (callArgs = {}) => {
      const result = await client.callTool({ name: 'health', arguments: { ...callArgs, format: 'json' } });
      assert.ok(!result.isError, `${text(result)}\n${diagnostics}`);
      return JSON.parse(text(result));
    },
    close: async () => { await client.close(); await transport.close(); },
  };
}

async function withServer(options, fn) {
  const server = await start(options);
  try { await fn(server); }
  catch (error) { throw new Error(`${error.message}\nServer diagnostics: ${server.diagnostics()}`, { cause: error }); }
  finally { await server.close(); }
}

const exitCode = (cwd, args) => spawnSync(process.execPath, [SERVER, ...args], { cwd, env: env(), input: '', timeout: 20000, encoding: 'utf8' });

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'contextpro-auto-root-')));
  home = join(scratch, 'home');
  await mkdir(home);
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('startup root is the Git toplevel', { timeout: 60000 }, () => {
  it('started in a subfolder, or with --root on one, binds the repository and writes no index there', async () => {
    const repo = await makeRepo(join(scratch, 'p03-repo'));
    const deep = join(repo, 'sub', 'deep');
    await mkdir(deep, { recursive: true });
    await withServer({ cwd: deep }, async ({ health, diagnostics }) => {
      assert.equal((await health()).rootDir, repo);
      assert.match(diagnostics(), new RegExp(`root: ${repo}\\n`));
    });
    await withServer({ cwd: scratch, args: ['--root', deep] }, async ({ health }) => {
      assert.equal((await health()).rootDir, repo);
    });
    assert.equal(existsSync(join(deep, '.contextpro')), false);
    assert.equal(existsSync(join(repo, 'sub', '.contextpro')), false);
  });

  it('started in a linked worktree subfolder, binds that worktree and still rejects calls without root', async () => {
    const repo = await makeRepo(join(scratch, 'p03-main'));
    const wt = join(scratch, 'p03-wt');
    git(repo, 'worktree', 'add', '-qb', 'child', wt);
    const sub = join(wt, 'sub');
    await mkdir(sub);
    await withServer({ cwd: sub }, async ({ call, health, diagnostics }) => {
      assert.match(diagnostics(), new RegExp(`root: ${wt}\\n`));
      const rejected = await call('health', {});
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /Ambiguous worktree/);
      assert.match(text(rejected), new RegExp(`would use ${wt}`));
      assert.equal((await health({ root: wt })).rootDir, wt);
    });
    assert.equal(existsSync(join(sub, '.contextpro')), false);
  });
});

describe('unbound start from an unsafe launch directory', { timeout: 90000 }, () => {
  it('stays up in HOME: health/status report unbound, rooted calls work, other calls need a root', async () => {
    const repo = await makeRepo(join(scratch, 'p11-repo'));
    await withServer({ cwd: home }, async ({ call, health, diagnostics }) => {
      assert.match(diagnostics(), /root: none \(started in/);
      const report = await health();
      assert.equal(report.status, 'unbound');
      assert.equal(report.rootDir, null);
      assert.equal(report.launchDir, home);
      assert.match(report.reason, /Unsafe project root/);
      assert.match(report.fix, /root:<absolute project path>/);
      const status = await call('status', {});
      assert.ok(!status.isError, text(status));
      assert.match(text(status), /unbound/);
      const discovered = await call('discover_tools', { query: 'rename', enable: ['rename_preview'] });
      assert.ok(!discovered.isError, text(discovered));
      assert.ok(JSON.parse(text(discovered)).matches.length > 0);
      const rejected = await call('context', { targets });
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), new RegExp(`No project root: the server started in ${home}, which ContextPro will not index`));
      // The call dispatcher keeps the target's own unbound behaviour.
      const dispatched = await call('discover_tools', { call: { name: 'context', arguments: { targets } } });
      assert.match(text(dispatched), /No project root/);
      assert.equal(hasProjectIndex(home), false);

      assert.equal((await health({ root: repo })).rootDir, repo);
      const rooted = await call('status', { root: repo });
      assert.ok(!rooted.isError, text(rooted));
      assert.doesNotMatch(text(rooted), /unbound/);
      const read = await call('context', { root: repo, targets });
      assert.ok(!read.isError, text(read));
      assert.match(text(read), /marker/);
    });
  });

  it('uses a single client root, and refuses to pick between several or an unsafe one', async () => {
    const repo = await makeRepo(join(scratch, 'p11-roots-a'));
    const other = await makeRepo(join(scratch, 'p11-roots-b'));
    await withServer({ cwd: home, roots: () => [repo] }, async ({ call, health }) => {
      assert.equal((await health()).rootDir, repo);
      const read = await call('context', { targets });
      assert.ok(!read.isError, text(read));
      assert.match(text(read), new RegExp(repo));
    });
    await withServer({ cwd: home, roots: () => [repo, other] }, async ({ call, health }) => {
      const rejected = await call('context', { targets });
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /No project root/);
      assert.equal((await health()).status, 'unbound');
    });
    // A client launched in HOME reports HOME as its root: that is no project either.
    await withServer({ cwd: home, roots: () => [home] }, async ({ call, health }) => {
      assert.equal((await health()).status, 'unbound');
      assert.match(text(await call('context', { targets })), /No project root/);
    });
    assert.equal(hasProjectIndex(home), false);
  });

  it('an ignored unexpanded --root stays up; an explicit unsafe root and subcommands still fail', async () => {
    await withServer({ cwd: home, args: ['--root', '${workspaceFolder}'] }, async ({ health }) => {
      assert.equal((await health()).status, 'unbound');
    });
    const explicit = exitCode(scratch, ['--root', home]);
    assert.equal(explicit.status, 1, explicit.stderr);
    assert.match(explicit.stderr, /Unsafe project root/);
    const init = exitCode(home, ['init']);
    assert.equal(init.status, 1, init.stderr);
    assert.match(init.stderr, /Unsafe project root/);
    assert.equal(existsSync(join(home, '.mcp.json')), false);
  });
});

describe('client roots versus an explicit --root', { timeout: 60000 }, () => {
  it('a non-Git client root does not override --root; a Git client root does; without --root it is used as before', async () => {
    const dev = join(scratch, 'p12-dev');
    const repo1 = await makeRepo(join(dev, 'repo1'));
    const repoB = await makeRepo(join(scratch, 'p12-b'));
    await withServer({ cwd: scratch, args: ['--root', repo1], roots: () => [dev] }, async ({ health }) => {
      assert.equal((await health()).rootDir, repo1);
      assert.equal((await health()).rootDir, repo1);
    });
    assert.equal(existsSync(join(dev, '.contextpro')), false);
    await withServer({ cwd: scratch, args: ['--root', repo1], roots: () => [repoB] }, async ({ health }) => {
      assert.equal((await health()).rootDir, repoB);
    });
    await withServer({ cwd: repo1, roots: () => [dev] }, async ({ health }) => {
      assert.equal((await health()).rootDir, dev);
    });
  });
});

describe('roots/list robustness', { timeout: 60000 }, () => {
  it('a client that never answers roots/list costs one ~2 s call, then the failure is cached', async () => {
    const repo = await makeRepo(join(scratch, 'p13-silent'));
    await withServer({ cwd: scratch, args: ['--root', repo], roots: () => new Promise(() => {}) }, async ({ health, stats }) => {
      let started = Date.now();
      assert.equal((await health()).rootDir, repo);
      const first = Date.now() - started;
      assert.ok(first >= 1500 && first < 10000, `first call took ${first} ms`);
      started = Date.now();
      assert.equal((await health()).rootDir, repo);
      const second = Date.now() - started;
      assert.ok(second < 1000, `second call took ${second} ms`);
      assert.equal(stats.listRoots, 1);
    });
  });

  it('shares one roots/list between parallel calls and re-lists after roots/list_changed', async () => {
    const repo = await makeRepo(join(scratch, 'p13-boot'));
    const repoB = await makeRepo(join(scratch, 'p13-b'));
    const repoC = await makeRepo(join(scratch, 'p13-c'));
    let current = repoB;
    const roots = () => new Promise(resolve => setTimeout(() => resolve([current]), 200));
    await withServer({ cwd: scratch, args: ['--root', repo], roots }, async ({ client, health, stats }) => {
      const reports = await Promise.all([1, 2, 3, 4].map(() => health()));
      assert.deepEqual(reports.map(r => r.rootDir), [repoB, repoB, repoB, repoB]);
      assert.equal(stats.listRoots, 1);
      current = repoC;
      await client.sendRootsListChanged();
      assert.equal((await health()).rootDir, repoC);
      assert.equal(stats.listRoots, 2);
    });
  });
});
