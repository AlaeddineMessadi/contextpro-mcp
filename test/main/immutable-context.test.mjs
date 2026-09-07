import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistArtifact, readArtifact } from '../../build/core/artifacts.js';

it('publishes an immutable context once even under concurrent competing writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-immutable-'));
  try {
    const options = { rootDir: root, kind: 'task_context', key: 'shared', immutable: true };
    const refs = await Promise.all(Array.from({ length: 8 }, (_, n) => persistArtifact({ ...options, payload: { winner: n } })));
    assert.equal(new Set(refs.map(ref => ref.id)).size, 1);
    const first = await readArtifact(root, refs[0].id);
    await persistArtifact({ ...options, payload: { winner: 999 } });
    const last = await readArtifact(root, refs[0].id);
    assert.deepEqual(last, first);
    assert.ok(first.payload.winner >= 0 && first.payload.winner < 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
