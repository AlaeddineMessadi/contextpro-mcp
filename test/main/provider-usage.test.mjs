import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../../build/core/provider-usage.js', import.meta.url).href;
function observedCall(path) {
  const code = `import {observeProviderCall, withProviderUsage} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await withProviderUsage(() => observeProviderCall(
      {kind:'chat',provider:'fixture',model:'fixture'}, async () => 'ok', () => ({input:7,output:2})))));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env:{...process.env, CONTEXTPRO_PROVIDER_TRACE_PATH:path}, encoding:'utf8', timeout:3000, killSignal:'SIGKILL',
  }));
}

it('keeps provider tracing best-effort for FIFOs and other unsafe destinations', {skip:process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-provider-trace-'));
  try {
    const pipe = join(root, 'trace.pipe');
    execFileSync('mkfifo', ['-m', '600', pipe]);
    const result = observedCall(pipe);
    assert.equal(result.value, 'ok');
    assert.equal(result.usage[0].inputTokens, 7);
    assert.ok((await stat(pipe)).isFIFO());
    const target = join(root, 'target');
    await writeFile(target, 'untouched', {mode:0o600});
    const link = join(root, 'link');
    await symlink(target, link);
    assert.equal(observedCall(link).value, 'ok');
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    assert.equal(observedCall(root).value, 'ok');
    const valid = join(root, 'trace.jsonl');
    assert.equal(observedCall(valid).value, 'ok');
    assert.equal(observedCall(valid).value, 'ok');
    assert.equal((await stat(valid)).mode & 0o077, 0);
    assert.equal((await readFile(valid, 'utf8')).trim().split('\n').length, 2);
  } finally { await rm(root, {recursive:true, force:true}); }
});
