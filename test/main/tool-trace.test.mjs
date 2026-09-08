import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withToolTrace } from '../../build/core/tool-trace.js';

it('records separate tool phases locally, bounds/redacts arguments and preserves errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-trace-'));
  const previous = process.env.CONTEXTPRO_TOOL_TRACE_PATH;
  const path = join(root, 'calls.jsonl');
  try {
    delete process.env.CONTEXTPRO_TOOL_TRACE_PATH;
    assert.equal(await withToolTrace('disabled', {}, async () => 1), 1);
    await assert.rejects(readFile(path), /ENOENT/);
    process.env.CONTEXTPRO_TOOL_TRACE_PATH = path;
    const response = { content: [{ type: 'text', text: 'answer' }] };
    assert.equal(await withToolTrace('exact_references', { symbol_name: 'add', token: 'not-a-credential', api_key: 'secret', nested: { password: 'secret' } }, async phase => {
      phase.rootResolved(root, true); phase.handlerStarted(); phase.handlerFinished(); return response;
    }), response);
    const original = new Error('original');
    await assert.rejects(withToolTrace('failed', {}, async phase => { phase.handlerStarted(); throw original; }), error => error === original);
    await withToolTrace('large', { query: 'x'.repeat(9000) }, async () => ({ isError: true }));
    const events = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.status), ['ok', 'error', 'error']);
    assert.equal(events[0].arguments.symbol_name, 'add');
    assert.equal(events[0].resolvedRoot, root);
    assert.equal(events[0].rootSelection, 'explicit');
    assert.equal(events[1].resolvedRoot, null, 'failed routing must not invent a resolved workspace');
    assert.equal(events[0].arguments.api_key, '[redacted]');
    assert.equal(events[0].arguments.nested.password, '[redacted]');
    assert.equal(events[2].arguments.omitted, true);
    assert.ok(events[2].arguments.sha256);
    const e = events[0];
    assert.ok(Math.abs(e.durationMs - e.preparationMs - e.handlerMs - e.postprocessingMs) < .001);
    assert.ok(events[1].handlerMs >= 0); assert.equal(events[1].postprocessingMs, null);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const target = join(root, 'target'); await writeFile(target, 'untouched');
    const link = join(root, 'link'); await symlink(target, link);
    process.env.CONTEXTPRO_TOOL_TRACE_PATH = link;
    assert.equal(await withToolTrace('unsafe-destination', {}, async () => 7), 7);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  } finally {
    if (previous === undefined) delete process.env.CONTEXTPRO_TOOL_TRACE_PATH; else process.env.CONTEXTPRO_TOOL_TRACE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
