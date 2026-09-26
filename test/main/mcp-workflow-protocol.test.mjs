// Verify the public stdio path, including wrappers, sessions and zero-provider discovery.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('delivers bounded offline task packs and isolated final reports over MCP', { timeout: 30000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'contextpro-wire-'));
  const root = join(scratch, 'project');
  await mkdir(root);
  const home = join(scratch, "home");
  await mkdir(home);
  await writeFile(join(root, 'auth.ts'), 'export function authenticate(token: string) { return token.length > 0; }\n');
  let providerCalls = 0;
  const provider = createServer((req, res) => { providerCalls++; res.writeHead(503); res.end(); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'workflow-integration', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'build/index.js'), '--root', root],
    env: { ...process.env, HOME: home, CONTEXTPRO_PROVIDER: 'ollama', OLLAMA_HOST: `http://127.0.0.1:${provider.address().port}`, CONTEXTPRO_TOOL_PROFILE: 'workflow', CONTEXTPRO_EMBED_TRACKER: 'lazy', CONTEXTPRO_NATIVE_AUTO_REPAIR: 'false', CONTEXTPRO_EFFICIENCY_FOOTER: 'true' },
    stderr: 'pipe',
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 14);
    const args = { task: 'fix authenticate ' + 'requirements '.repeat(400), preset: 'keyword_only', max_tokens: 512, include_memory: false, include_recent_diffs: false, format: 'json' };
    const result = await client.callTool({ name: 'task_pack', arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const text = result.content.find(c => c.type === 'text').text;
    const pack = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= 512 * 4, `wire response has ${Buffer.byteLength(text)} bytes`);
    assert.equal(providerCalls, 0, 'no provider calls from wrapper, tracker or retrieval');
    const invalidArgs = { file_path: '../outside.ts' };
    const failure = await client.callTool({ name: 'skeleton', arguments: invalidArgs });
    assert.equal(failure.isError, true);
    const reportResult = await client.callTool({ name: 'efficiency_report', arguments: { scope: 'session', history_limit: 0, input_cost_per_million: 5, format: 'json' } });
    const report = JSON.parse(reportResult.content.find(c => c.type === 'text').text);
    assert.deepEqual(report.recentSavings, []);
    assert.equal(report.calls.total, 2);
    assert.equal(report.calls.errors, 1);
    assert.ok(report.estimate.requestTokens >= Math.ceil(Buffer.byteLength(JSON.stringify(args))/4) + Math.ceil(Buffer.byteLength(JSON.stringify(invalidArgs))/4));
    assert.ok(report.sessionId);
    assert.match(report.finalSummary, /estimate/);
    assert.equal(report.actualBillingSavingsUsd, null);
    assert.ok(report.estimate.toolSchemaTokens > 0);
    assert.ok(pack.budget || pack.context || pack.files);
    await writeFile(join(root, 'nearby.ts'), 'before\nneedle\nafter\n');
    const nearby = await client.callTool({ name: 'grep', arguments: { root, pattern: 'needle', glob: '*.ts', context_lines: 1 } });
    assert.ok(!nearby.isError, JSON.stringify(nearby));
    assert.match(nearby.content[0].text, /L1-  before/);
    assert.match(nearby.content[0].text, /L2:1  needle/);
    assert.match(nearby.content[0].text, /L3-  after/);
    const overLimit = await client.callTool({ name: 'grep', arguments: { root, pattern: 'needle', context_chars: 900 } });
    assert.equal(overLimit.isError, true, 'reject oversized windows rather than silently ignoring them');
    assert.equal(providerCalls, 0, 'surrounding-line grep remains provider-free');
  } catch (error) {
    throw new Error(`${error.message}\nServer diagnostics: ${stderr}`, { cause: error });
  } finally {
    await client.close(); await transport.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});

it('answers references as the first lean call and records server timing without response metadata', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-lean-refs-'));
  const trace = join(root, 'trace.jsonl');
  await writeFile(join(root, 'api.ts'), '// Declaration below the header\nexport function add() { return 1; }\nadd();\n');
  const client = new Client({ name: 'lean-reference-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'build/index.js'), '--root', root],
    env: { ...process.env, CONTEXTPRO_TOOL_PROFILE: 'lean', CONTEXTPRO_REINDEX_NO_EMBED: 'true', CONTEXTPRO_TOOL_TRACE_PATH: trace }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const catalog = (await client.listTools()).tools;
    assert.deepEqual(catalog.map(t => t.name).sort(), ['context', 'discover_tools', 'exact_references']);
    const contextSchema = catalog.find(t => t.name === 'context').inputSchema.properties;
    assert.equal(contextSchema.max_tokens.minimum, 512);
    assert.equal(contextSchema.max_tokens.maximum, 12000);
    assert.match(contextSchema.max_tokens.description, /512.*12000/);
    assert.equal(contextSchema.targets.maxItems, 6);
    assert.match(contextSchema.targets.description, /1.*6/);
    assert.match(catalog.find(t => t.name === 'exact_references').inputSchema.properties.line.description, /infer.*declaration/);
    const result = await client.callTool({ name: 'exact_references', arguments: { root, symbol_name: 'add', file: 'api.ts', format: 'json' } });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.target.line, 2);
    assert.equal(data.counts.call, 1);
    assert.deepEqual(data.callsByFile, [{ file: 'api.ts', calls: 1 }]);
    assert.equal(data.durationMs, undefined);
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'exact_references');
    assert.equal(records[0].arguments.symbol_name, 'add');
    assert.ok(records[0].handlerMs > 0);
    assert.ok(records[0].preparationMs >= 0);
    assert.equal(records[0].status, 'ok');
    for (const arguments_ of [
      { root, targets: [{ file: 'api.ts', start: 1, end: 1 }], projectPath: '/does/not/exist', maxTokens: 512 },
      { root, targets: [{ file: 'api.ts', startLine: 1 }] },
    ]) {
      const invalid = await client.callTool({ name: 'context', arguments: arguments_ });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /Unrecognized key|unrecognized_keys/);
    }
    const enabled = await client.callTool({ name: 'discover_tools', arguments: { root, enable: ['skeleton', 'reindex', 'health'] } });
    const schemas = JSON.parse(enabled.content[0].text).schemas;
    assert.equal(schemas.find(s => s.name === 'skeleton').inputSchema.additionalProperties, false);
    const noEmbedHelp = schemas.find(s => s.name === 'reindex').inputSchema.properties.no_embed.description;
    assert.doesNotMatch(noEmbedHelp, /populate lazily/);
    assert.match(noEmbedHelp, /Search does not generate corpus embeddings/);
    assert.ok(schemas.every(s => s.callable));
    // Never refresh tools/list: simulate a client with a frozen tool catalog.
    const call = (name, arguments_ = {}, callRoot = root) => client.callTool({ name: 'discover_tools', arguments: { root: callRoot, call: { name, arguments: arguments_ } } });
    const second = join(root, 'second');
    await mkdir(second);
    await writeFile(join(second, 'api.ts'), 'export function distinct() { return 2; }');
    const dispatched = await call('skeleton', { file_path: 'api.ts' }, second);
    assert.ok(!dispatched.isError, JSON.stringify(dispatched));
    assert.match(dispatched.content[0].text, /distinct/);
    assert.doesNotMatch(dispatched.content[0].text, /function add/);
    const invalid = await call('skeleton', { file_path: 'api.ts', typo: true });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /typo/);
    for (const name of ['restore', 'replace_symbol_body', 'discover_tools', 'unknown']) assert.equal((await call(name)).isError, true);
    assert.equal((await call('skeleton', { root: second, file_path: 'api.ts' })).isError, true);
    assert.equal((await call('skeleton', { file_path: '../escape.ts' })).isError, true);
    const indexed = await call('reindex', { no_embed: true }, second);
    assert.ok(!indexed.isError, JSON.stringify(indexed));
    const health = await call('health', { format: 'json' }, second);
    assert.ok(!health.isError, JSON.stringify(health));
    assert.match(health.content[0].text, /second/);
    const laterRecords = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(laterRecords.filter(r => r.tool === 'discover_tools').length, 1, 'dispatch records the target once, not a second discovery call');
    assert.equal(laterRecords.filter(r => r.tool === 'reindex').length, 1);

  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});

it('serves exact source reads when config writes fail after initialization', { timeout: 30000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'contextpro-config-space-'));
  const root = join(scratch, 'project');
  await mkdir(root);
  await writeFile(join(root, 'api.ts'), 'export const ready = true;\n');
  const marker = join(scratch, 'deny-config-writes');
  const canonicalConfig = join(await realpath(root), '.contextpro', 'config.json');
  const preload = join(scratch, 'fault.mjs');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { existsSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalWrite = fs.writeFile, originalOpen = fs.open;
    const check = file => {
      if (existsSync(${JSON.stringify(marker)}) && (String(file).startsWith(${JSON.stringify(canonicalConfig)}) || String(file).startsWith(${JSON.stringify(join(root, '.contextpro', 'config.json'))}))) {
        throw Object.assign(new Error('injected config disk exhaustion'), {code:'ENOSPC'});
      }
    };
    fs.writeFile = async (file, ...args) => { check(file); return originalWrite(file, ...args); };
    fs.open = async (file, flags, ...args) => { if (String(flags).includes('w')) check(file); return originalOpen(file, flags, ...args); };
    syncBuiltinESMExports();
  `);
  const client = new Client({name:'config-storage-integration',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath, args:['--import',preload,join(process.cwd(),'build/index.js'),'--root',root],
    env:{...process.env,CONTEXTPRO_TOOL_PROFILE:'lean',CONTEXTPRO_REINDEX_NO_EMBED:'true'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  try {
    await client.connect(transport);
    const path = join(root,'.contextpro','config.json');
    const before = await readFile(path,'utf8');
    await writeFile(marker,'block config writes');
    const result = await client.callTool({name:'context',arguments:{root,targets:[{file:'api.ts'}],max_tokens:512}});
    assert.ok(!result.isError, JSON.stringify({result,config:JSON.parse(before)}));
    assert.match(result.content[0].text, /export const ready = true/);
    assert.equal(await readFile(path,'utf8'),before);
  } finally { await client.close(); await transport.close(); await rm(scratch,{recursive:true,force:true}); }
});

it('initializes an explicit cold root through lean context without provider calls', { timeout: 30000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'contextpro-cold-wire-'));
  const boot = join(scratch, 'boot'), target = join(scratch, 'target');
  await mkdir(boot); await mkdir(target);
  await writeFile(join(boot, 'boot.ts'), 'export function bootOnly() { return 0; }\n');
  for (let i=0;i<35;i++) await writeFile(join(target, `entry-${i}.ts`), `export function entry${i}() { return ${i}; }\n`);
  let providerCalls = 0;
  const provider = createServer((req, res) => { providerCalls++; res.writeHead(503); res.end(); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'cold-context-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'build/index.js'), '--root', boot],
    env: { ...process.env, CONTEXTPRO_TOOL_PROFILE: 'lean', CONTEXTPRO_EMBED_TRACKER: 'lazy', CONTEXTPRO_PROVIDER: 'ollama', OLLAMA_HOST: `http://127.0.0.1:${provider.address().port}` }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'context', arguments: { root: target, query: 'entry34', max_tokens: 512 } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(result.content[0].text, /function entry34/);
    assert.doesNotMatch(result.content[0].text, /remain stale|Discovery index: (empty|stale)|bootOnly/);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
    assert.equal(providerCalls, 0);
  } finally {
    await client.close(); await transport.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
