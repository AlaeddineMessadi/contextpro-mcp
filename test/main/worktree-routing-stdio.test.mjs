import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

it('rejects parent-root guessing and reads edited worktree bytes across reindex and parallel calls', { timeout: 45000 }, async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'contextpro-worktree-wire-')));
  const parent = join(scratch, 'parent'), child = join(scratch, 'child'), home = join(scratch, 'home');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 8000 });
  await mkdir(parent); await mkdir(home);
  git(parent, 'init', '-q', '-b', 'main');
  const source = marker => `export function marker() { return '${marker}'; }\n`;
  await writeFile(join(parent, 'api.ts'), source('PARENT_ONLY'));
  git(parent, 'add', '.');
  git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture');
  git(parent, 'worktree', 'add', '-qb', 'child', child);
  const trace = join(scratch, 'trace.jsonl');
  const client = new Client({ name: 'shared-parent-client', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(parent).href }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'build/index.js'), '--root', parent],
    cwd: parent, env: { ...process.env, HOME: home, CONTEXTPRO_TOOL_PROFILE: 'full', CONTEXTPRO_REINDEX_NO_EMBED: 'true', CONTEXTPRO_EMBED_TRACKER: 'lazy', CONTEXTPRO_TOOL_TRACE_PATH: trace }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const targets = [{ file: 'api.ts', start: 1, end: 1 }];
  try {
    await client.connect(transport);
    const guide = await client.readResource({ uri: 'contextpro://instructions' });
    assert.match(guide.contents[0].text, /absolute worktree root/);
    for (const [name, args] of [['health', {}], ['context', { targets }], ['reindex', { target_path: 'api.ts', force: true, no_embed: true }]]) {
      const rejected = await call(name, args);
      assert.equal(rejected.isError, true, text(rejected));
      assert.match(text(rejected), /root/i);
    }
    for (const root of [child, parent]) {
      const result = await call('health', { root, format: 'json' });
      assert.ok(!result.isError, text(result));
      const report = JSON.parse(text(result));
      assert.equal(report.rootDir, root);
      assert.equal(report.project.gitRoot, root);
    }
    for (let edit = 1; edit <= 5; edit++) {
      await writeFile(join(child, 'api.ts'), source(`CHILD_EDIT_${edit}`));
      const read = await call('context', { root: child, targets });
      assert.ok(!read.isError, text(read));
      assert.match(text(read), new RegExp(`CHILD_EDIT_${edit}`));
      assert.doesNotMatch(text(read), /PARENT_ONLY/);
    }
    for (const force of [false, true]) {
      const indexed = await call('reindex', { root: child, target_path: 'api.ts', force, no_embed: true, auto_hubs: false });
      assert.ok(!indexed.isError, text(indexed));
      for (const [name, args] of [
        ['explain', { symbol: 'marker', file: 'api.ts', depth: 0 }],
        ['grep', { pattern: 'CHILD_EDIT_5' }],
        ['search', { query: 'CHILD_EDIT_5', preset: 'keyword_only', mode: 'file', format: 'compact' }],
      ]) {
        const found = await call(name, { root: child, ...args });
        assert.ok(!found.isError, text(found));
        assert.match(text(found), /CHILD_EDIT_5/);
        assert.doesNotMatch(text(found), /PARENT_ONLY/);
      }
    }
    const results = await Promise.all([parent, child, parent, child].map(root => call('context', { root, targets })));
    results.forEach((result, index) => assert.match(text(result), index % 2 ? /CHILD_EDIT_5/ : /PARENT_ONLY/));
    assert.equal(await readFile(join(parent, 'api.ts'), 'utf8'), source('PARENT_ONLY'));
    // Diagnostic routing must still work when normal project validation cannot.
    const projectFile = join(child, '.contextpro', 'config.json');
    await rm(projectFile);
    await mkdir(projectFile);
    const degraded = await call('health', { root: child, format: 'json' });
    assert.ok(!degraded.isError, text(degraded));
    const report = JSON.parse(text(degraded));
    assert.equal(report.rootDir, child);
    assert.equal(report.status, 'degraded');
    assert.equal(report.project.ok, false);
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.resolvedRoot === child && event.rootSelection === 'explicit'));
    assert.ok(events.some(event => event.resolvedRoot === parent && event.rootSelection === 'explicit'));
  } catch (error) {
    throw new Error(`${error.message}\nServer diagnostics: ${diagnostics}`, { cause: error });
  } finally {
    await client.close(); await transport.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
