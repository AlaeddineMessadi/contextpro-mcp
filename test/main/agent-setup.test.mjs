import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeAgentInstructions, installAgentInstructions, mergeMcpConfig } from '../../build/core/agent-setup.js';

describe('agent setup preserves user configuration', () => {
  it('updates only one managed block, preserving surrounding rules', () => {
    const original = '# Project\n\nUse strict TypeScript.\n';
    const installed = mergeAgentInstructions(original);
    assert.ok(installed.startsWith(original));
    assert.equal(mergeAgentInstructions(installed), installed);
    assert.equal(installed.split('contextpro:begin').length, 2);
    assert.match(installed, /efficiency_report/);
    assert.match(installed, /Never invent money saved/);
    assert.throws(() => mergeAgentInstructions('<!-- contextpro:begin -->broken'), /Malformed/);
  });
  it('installs Claude and common instructions without erasing existing content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'contextpro-instructions-'));
    try {
      await writeFile(join(root, 'CLAUDE.md'), '# My conventions\n');
      await installAgentInstructions(root, 'claude');
      await installAgentInstructions(root, 'claude');
      assert.match(await readFile(join(root, 'CLAUDE.md'), 'utf8'), /^# My conventions/);
      assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /ContextPro repository workflow/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves other servers and an already customized ContextPro entry', () => {
    const prior = { setting: true, mcpServers: { other: { command: 'other' }, contextpro: { command: 'custom', env: { CUSTOM: 'yes' } } } };
    const generated = { mcpServers: { contextpro: { command: 'npx' } } };
    assert.deepEqual(mergeMcpConfig(prior, generated, 'claude'), prior);
    assert.throws(() => mergeMcpConfig([], generated, 'claude'), /JSON object/);
    assert.throws(() => mergeMcpConfig({ mcpServers: [] }, generated, 'claude'), /must be an object/);
  });
});
