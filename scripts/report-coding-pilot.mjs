#!/usr/bin/env node
// Read-only aggregation of an existing campaign. No agents/providers are run.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { latencyDistribution, summarizeServerTrace } from './benchmark-evidence.mjs';

const input = resolve(process.argv[2] ?? '.contextpro/productivity-pilot');
const destination = process.argv[3];
const plan = JSON.parse(await readFile(join(input, 'plan.json'), 'utf8'));
const rows = JSON.parse(await readFile(join(input, 'runs.json'), 'utf8'));
const trials = [];
for (const row of rows) {
  const label = `${row.taskId}-${row.repeat}-${row.variant}`;
  const trace = await readFile(join(input, `${label}.server.jsonl`), 'utf8')
    .then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse), () => []);
  trials.push({ task: row.taskId, variant: row.variant, repeat: row.repeat,
    success: row.success, timedOut: row.timedOut, exitCode: row.exitCode,
    preparationMs: row.preparationMs, agentMs: row.agentMs,
    validationMs: row.validation.durationMs, wallTimeMs: row.wallTimeMs,
    validationPassed: row.validation.passed, validationStage: row.validation.stage ?? 'acceptance',
    usage: row.usage, costUsd: null, retrievalProviderUsage: row.providerUsage,
    nativeCommandCalls: row.nativeCommandCalls,
    nativeReadCommandCandidates: row.nativeReadCommandCandidates,
    mcpCalls: row.toolCalls.filter(call => call.type === 'mcp_tool_call').length,
    serverTrace: summarizeServerTrace(trace, row.toolCalls),
  });
}
const keys = [...new Set(rows.map(row => `${row.taskId}:${row.repeat}`))];
const pairs = keys.map(key => {
  const selected = rows.filter(row => `${row.taskId}:${row.repeat}` === key);
  return { key, baseline: selected.find(row => row.variant === 'baseline'), candidate: selected.find(row => row.variant === 'candidate') };
});
const passing = pairs.filter(pair => pair.baseline?.success && pair.candidate?.success);
const ratios = passing.map(pair => {
  const tokens = row => row.usage ? row.usage.input_tokens + row.usage.output_tokens : null;
  const before = tokens(pair.baseline), after = tokens(pair.candidate);
  return { pair: pair.key, timeRatio: pair.candidate.wallTimeMs / pair.baseline.wallTimeMs,
    tokenRatio: before > 0 && after !== null ? after / before : null };
});
const medianTimeRatio = latencyDistribution(ratios.map(row => row.timeRatio)).medianMs;
const medianTokenRatio = latencyDistribution(ratios.map(row => row.tokenRatio)).medianMs;
const regressions = pairs.filter(pair => pair.baseline?.success && pair.candidate && !pair.candidate.success).map(pair => pair.key);
const complete = rows.length === plan.plan.length;
const observed = passing.length > 0 && ratios.every(row => row.tokenRatio !== null);
const gateMet = complete && observed && !regressions.length &&
  ((medianTimeRatio <= .8 && medianTokenRatio <= 1.1) || (medianTokenRatio <= .8 && medianTimeRatio <= 1.1));
const result = {
  contractHash: plan.contractHash, agent: { ...plan.config, version: plan.agentVersion },
  builds: Object.fromEntries(Object.entries(plan.fingerprints).map(([variant, value]) => [variant, { files: value.files, sha256: value.sha256 }])),
  dependencyPolicy: plan.dependencyPolicy, contextPolicy: plan.contextPolicy,
  completed: rows.length, planned: plan.plan.length, complete,
  passes: Object.fromEntries([...new Set(plan.plan.map(row => row.variant))].map(variant => [variant, rows.filter(row => row.variant === variant && row.success).length])),
  failures: trials.filter(row => !row.success).map(row => ({ task: row.task, variant: row.variant, repeat: row.repeat, timedOut: row.timedOut, exitCode: row.exitCode, validationStage: row.validationStage })),
  jointlyPassing: passing.length, correctnessRegressions: regressions, ratios,
  medianTimeRatio, medianTokenRatio, rolloutGate: !complete ? 'incomplete' : !observed ? 'insufficient passing/usage evidence' : gateMet ? 'met in this pilot only' : 'not met',
  trials,
  limitations: [
    'Single-run paired pilot, no confidence intervals or universal savings claim.',
    'Provider tokens count input plus output; cached input is already included once. Costs unavailable.',
    'Native read-command candidates are heuristic counts, not proven avoidable fallbacks.',
    'Setup and retrieval-provider usage are separate from coding-agent usage; missing usage remains unavailable.',
    'Strict historical acceptance contracts can reject alternative patches; inspect failure details before generalizing.',
  ],
};
if (destination) await writeFile(destination, JSON.stringify(result, null, 2) + '\n');
else console.log(JSON.stringify(result, null, 2));
