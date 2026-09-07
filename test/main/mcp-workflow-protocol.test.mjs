// Verify the public stdio path, including wrappers, sessions and zero-provider discovery.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
    assert.equal((await client.listTools()).tools.length, 13);
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
  } catch (error) {
    throw new Error(`${error.message}\nServer diagnostics: ${stderr}`, { cause: error });
  } finally {
    await client.close(); await transport.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
