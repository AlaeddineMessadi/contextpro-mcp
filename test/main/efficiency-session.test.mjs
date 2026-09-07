import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDB, closeDB } from '../../build/core/db.js';
import { getEfficiencyReport } from '../../build/tools/efficiency-report.js';
import { estimateToolEfficiency } from '../../build/core/efficiency.js';
import { setToolSchemaTokens } from '../../build/core/runtime-session.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-session-test-'));
  try { await run(root, await getDB(root)); }
  finally { closeDB(root); await rm(root, { recursive: true, force: true }); setToolSchemaTokens(0); }
}
describe('honest session accounting', () => {
  it('isolates concurrent session totals and deducts schema and all traffic', async () => fixture(async (root, db) => {
    const now = Date.now();
    db.recordToolCall('search', 'ok', 10, now, { sourceTokens: 2000, inputTokens: 10, outputTokens: 90, savedTokens: 1900 }, 'A');
    db.recordToolCall('search', 'ok', 10, now, { sourceTokens: 99999, savedTokens: 99999 }, 'B');
    db.recordToolCall('search', 'ok', 10, now, { sourceTokens: 99999, savedTokens: 99999 });
    setToolSchemaTokens(100);
    const report = JSON.parse(await getEfficiencyReport({ rootDir: root, scope: 'session', sessionId: 'A', sessionStartedAt: now - 1, inputCostPerMillion: 5, contextproCostUsd: .001, format: 'json' }));
    assert.equal(report.calls.total, 1);
    assert.equal(report.estimate.savedTokens, 1800);
    assert.equal(report.hypotheticalInputCostAvoided.usd, .009);
    assert.equal(report.hypotheticalInputCostAvoided.netUsdAfterSuppliedCosts, .008);
    assert.equal(report.actualBillingSavingsUsd, null);
    assert.match(report.finalSummary, /estimate/);
  }));
  it('credits each file revision once and still counts repeated output overhead', async () => fixture(async (root, db) => {
    db.upsertFile('a.ts', 'hash1', 'a', 'typescript', 8000, 0); db.bumpIndexGeneration();
    const result = { content: [{ type: 'text', text: 'a.ts: export function a()' }] };
    const one = await estimateToolEfficiency(root, {}, result, true);
    const two = await estimateToolEfficiency(root, {}, result, true);
    assert.equal(one.sourceTokens, 2000);
    assert.equal(two.sourceTokens, 0);
    assert.ok(two.outputTokens > 0);
    db.upsertFile('a.ts', 'hash2', 'a', 'typescript', 9000, 0); db.bumpIndexGeneration();
    assert.equal((await estimateToolEfficiency(root, {}, result, true)).sourceTokens, 2250);
  }));
  it('does not claim money without pricing or positive token savings', async () => fixture(async (root, db) => {
    db.recordToolCall('search', 'ok', 5, Date.now(), { inputTokens: 100, outputTokens: 500, sourceTokens: 10 }, 'A');
    const options = { rootDir: root, scope: 'session', sessionId: 'A', sessionStartedAt: 0, format: 'json' };
    const report = JSON.parse(await getEfficiencyReport(options));
    assert.equal(report.estimate.savedTokens, 0);
    assert.ok(report.estimate.netTokensAvoided < 0);
    assert.equal(report.hypotheticalInputCostAvoided, null);
    assert.match(report.finalSummary, /unavailable/);
    await assert.rejects(getEfficiencyReport({ ...options, inputCostPerMillion: NaN }), /finite nonnegative/);
  }));
});
