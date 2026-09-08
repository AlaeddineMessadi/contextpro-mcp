import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrialPlan, createEventCollector, providerUsage, summarizeServerTrace, latencyDistribution } from '../../scripts/benchmark-evidence.mjs';

it('counterbalances each task/cache pair across repeats without mixing index states', () => {
  const plan = buildTrialPlan(['refs', 'flow'], 2, ['empty', 'seeded']);
  assert.equal(plan.length, 16);
  for (const taskId of ['refs', 'flow']) for (const indexState of ['empty', 'seeded']) {
    const pair = repeat => plan.filter(r => r.taskId === taskId && r.indexState === indexState && r.repeat === repeat);
    assert.deepEqual(pair(1).map(r => r.variant), pair(2).map(r => r.variant).reverse());
    assert.equal(pair(1)[0].pairId, pair(1)[1].pairId);
    assert.notEqual(pair(1)[0].pairId, pair(2)[0].pairId);
  }
  for (const count of [0, 1.5, NaN, 21]) assert.throws(() => buildTrialPlan(['refs'], count));
  assert.throws(() => buildTrialPlan(['refs'], 1, ['seeded', 'seeded']));
});

it('captures fragmented JSONL, tool arguments and observed latency without counting updates twice', () => {
  const collector = createEventCollector();
  const item = { id: 'one', type: 'mcp_tool_call', server: 'contextpro', tool: 'exact_references', arguments: { symbol_name: 'add' } };
  const first = JSON.stringify({ type: 'item.started', item });
  collector.push(first.slice(0, 15), 1); collector.push(first.slice(15) + '\n', 2);
  collector.push(JSON.stringify({ type: 'item.updated', item }) + '\ninvalid\n', 3);
  collector.push(JSON.stringify({ type: 'item.completed', item: { ...item, status: 'completed' } }), 7);
  collector.finish(8);
  assert.equal(collector.calls.size, 1);
  const call = [...collector.calls.values()][0];
  assert.equal(call.observedDurationMs, 6);
  assert.deepEqual(call.arguments, { symbol_name: 'add' });
});

it('keeps unknown provider usage unknown and cached input a subset of input', () => {
  const event = usage => ({ type: 'turn.completed', usage });
  assert.equal(providerUsage([]), null);
  assert.equal(providerUsage([event({ input_tokens: 20 })]), null);
  assert.equal(providerUsage([event({ input_tokens: 20, output_tokens: 4 }), event(undefined)]), null);
  const usage = providerUsage([event({ input_tokens: 20, cached_input_tokens: 8, output_tokens: 4 }), event({ input_tokens: 30, cached_input_tokens: 10, output_tokens: 6 })]);
  assert.deepEqual(usage, { input_tokens: 50, cached_input_tokens: 18, output_tokens: 10 });
  assert.equal(usage.input_tokens + usage.output_tokens, 60);
  assert.equal(providerUsage([event({ input_tokens: 20, output_tokens: 4 })]).cached_input_tokens, undefined);
  assert.throws(() => providerUsage([event({ input_tokens: 2, cached_input_tokens: 8, output_tokens: 4 })]));
});

it('unions overlapping server spans and identifies incomplete evidence', () => {
  const calls = ['a', 'b'].map(tool => ({ type: 'mcp_tool_call', server: 'contextpro', tool }));
  const trace = [{ version: 1, tool: 'a', startedAt: 100, durationMs: 30 }, { version: 1, tool: 'b', startedAt: 110, durationMs: 30 }];
  const result = summarizeServerTrace(trace, calls);
  assert.equal(result.serverBusyMs, 40); assert.equal(result.summedServerMs, 60); assert.equal(result.complete, true);
  assert.equal(summarizeServerTrace([], calls).serverBusyMs, null);
  assert.equal(summarizeServerTrace(trace.slice(0, 1), calls).complete, false);
  assert.equal(summarizeServerTrace([trace[0], trace[0]], calls).complete, false);
  assert.deepEqual(latencyDistribution([30, 10, 20, 100]), { samples: 4, medianMs: 25, minMs: 10, maxMs: 100 });
});
