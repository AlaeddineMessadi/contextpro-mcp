import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);

it('rejects saved records from a different frozen campaign contract', async () => {
  const output = await mkdtemp(join(tmpdir(), 'contextpro-pilot-contract-'));
  const runner = new URL('../../scripts/benchmark-coding-pilot.mjs', import.meta.url).pathname;
  const run = (flag = '--plan') => exec(process.execPath, [runner, flag], { env: {
    ...process.env, CONTEXTPRO_PILOT_OUTPUT: output,
    // Exercise startup guards without starting archives or agent trials if a
    // regression accidentally lets an incompatible campaign through.
    CONTEXTPRO_PILOT_TASK: '__contract_guard_only__',
  }});
  try {
    await writeFile(join(output, 'repos.json'), '{}');
    const planned = JSON.parse((await run()).stdout);
    const hash = createHash('sha256')
      .update(await readFile(new URL('../../scripts/fixtures/coding-pilot.json', import.meta.url))).digest('hex');
    assert.equal(planned.contractHash, hash);
    // A prepared-only directory has no plan or run records yet. Check each
    // persisted contract independently so one cannot hide another missing guard.
    for (const name of ['preflight.json', 'plan.json', 'runs.json']) {
      const record = { contractHash: 'bogus-' + hash, discriminates: true };
      const saved = JSON.stringify(name === 'plan.json' ? record : [record]);
      await writeFile(join(output, name), saved);
      for (const flag of ['--recheck', '--prepare', '--run', '--resume']) {
        await assert.rejects(run(flag), /Frozen campaign uses a different validator contract/);
        assert.equal(await readFile(join(output, name), 'utf8'), saved);
        assert.deepEqual((await readdir(output)).sort(), [name, 'repos.json'].sort());
      }
      if (name === 'preflight.json') {
        const matching = JSON.stringify([{ contractHash: hash, discriminates: true }]);
        await writeFile(join(output, name), matching);
        await run('--recheck'); // The original contract can still requalify.
        assert.equal(await readFile(join(output, name), 'utf8'), matching);
      }
      await rm(join(output, name));
    }
  } finally { await rm(output, {recursive:true, force:true}); }
});
