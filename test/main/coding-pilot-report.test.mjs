import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validatePilotResume } from '../../scripts/benchmark-evidence.mjs';

it('pilot resume preserves contracts, build identity and the completed prefix', () => {
  const plan = [{ taskId: 'a', variant: 'baseline', repeat: 0 }, { taskId: 'a', variant: 'candidate', repeat: 0 }];
  const saved = { contractHash: 'fixed', plan, config: { model: 'fixed' }, agentCommand: 'codex', agentVersion: '1', fingerprints: { candidate: 'abc' } };
  const rows = [{ ...plan[0], contractHash: 'fixed' }];
  assert.doesNotThrow(() => validatePilotResume(saved, structuredClone(saved), rows));
  for (const key of Object.keys(saved)) assert.throws(() => validatePilotResume(saved, { ...saved, [key]: null }, rows), /Cannot resume/);
  assert.throws(() => validatePilotResume(saved, saved, [{ ...rows[0], variant: 'candidate' }]), /plan prefix/);
  assert.throws(() => validatePilotResume(saved, saved, [...rows, ...rows, ...rows]), /too many/);
});

it('pilot reporting cannot hide a failed task behind passing-pair savings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-pilot-report-'));
  try {
    const rows = ['a', 'b'].flatMap(taskId => ['baseline', 'candidate'].map(variant => ({
      taskId, variant, repeat: 0, success: !(taskId === 'b' && variant === 'candidate'),
      timedOut: taskId === 'b' && variant === 'candidate', exitCode: 0,
      preparationMs: 10, agentMs: variant === 'candidate' ? 60 : 100,
      validation: { passed: !(taskId === 'b' && variant === 'candidate'), durationMs: 1 },
      wallTimeMs: variant === 'candidate' ? 61 : 101,
      usage: { input_tokens: variant === 'candidate' ? 60 : 100, cached_input_tokens: 50, output_tokens: 10 },
      toolCalls: [], nativeCommandCalls: 0, nativeReadCommandCandidates: 0, providerUsage: null,
    })));
    await writeFile(join(root, 'plan.json'), JSON.stringify({ plan: rows, config: {}, fingerprints: {} }));
    const run = async data => {
      await writeFile(join(root, 'runs.json'), JSON.stringify(data));
      await promisify(execFile)(process.execPath, ['scripts/report-coding-pilot.mjs', root, join(root, 'report.json')]);
      return JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    };
    const failed = await run(rows);
    assert.deepEqual(failed.correctnessRegressions, ['b:0']);
    assert.equal(failed.rolloutGate, 'not met');
    assert.equal(failed.failures[0].timedOut, true);
    assert.equal(failed.jointlyPassing, 1);
    assert.equal(failed.medianTokenRatio, 70 / 110); // Cache subset is not added twice.
    assert.equal(failed.trials[0].serverTrace.serverBusyMs, null);
    assert.equal((await run(rows.slice(0, 2))).rolloutGate, 'incomplete');
    assert.equal((await run(rows.map(row => ({ ...row, success: true, usage: null })))).rolloutGate, 'insufficient passing/usage evidence');
    const interrupted = await run(rows.map((row, i) => i ? row : { ...row, interrupted: true, success: false, agentMs: null, wallTimeMs: null, usage: null, toolCallsUnavailable: true }));
    assert.equal(interrupted.trials[0].mcpCalls, null);
    assert.equal(interrupted.trials[0].featureUse, null);
    assert.equal(interrupted.trials[0].wallTimeMs, null);
    assert.equal(interrupted.failures[0].interrupted, true);
    assert.equal(interrupted.complete, false);
    assert.equal(interrupted.fullyAccounted, true);
    assert.equal(interrupted.completed, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
