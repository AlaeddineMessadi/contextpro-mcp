import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getContext } from '../../build/tools/context.js';
import { getDB, closeDB } from '../../build/core/db.js';
import { bindEvidence } from '../../build/core/evidence-state.js';
import { reindex } from '../../build/tools/reindex.js';

it('change context includes current risk provenance, invalidates memory deltas and excludes stale and superseded notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-context-risks-'));
  try {
    await writeFile(join(root, 'charge.ts'), 'export const charge = () => 1;\n');
    await reindex({rootDir:root, noEmbed:true, autoHubs:false});
    const db = await getDB(root), evidence = await bindEvidence(root, [{file:'charge.ts'}]);
    const metadata = {scope:'project', project_id:'', record_kind:'task', source_evidence:JSON.stringify(evidence)};
    const seed = (label, risk, extra = {}) => db.upsertMemoryNode({type:'note', label,
      content:`Task: charge\nOpen Risks: ${risk}`, metadata:{...metadata, open_risks:JSON.stringify([risk]), ...extra}});
    const id = seed('charge-risk', 'Payment retries may duplicate a charge.');
    seed('charge-legacy', 'Unverified risk sentinel', {source_evidence:''});
    const options = {rootDir:root, query:'charge', intent:'change', maxTokens:1800, retrievalPreset:'keyword_only'};
    const first = await getContext(options);
    assert.match(first, /Known risks \(textual task notes; source evidence current\)/);
    assert.ok(first.includes(`${id}: Payment retries may duplicate a charge.`));
    assert.doesNotMatch(first, /Unverified risk sentinel/);
    const contextId = first.match(/Context ID: (source_context-[a-f0-9]+)/)[1];
    const revised = seed('charge-risk', 'Payment retries require an idempotency key.');
    assert.equal(revised, id);
    const changed = await getContext({...options, previousContextId:contextId});
    assert.match(changed, /idempotency key/);
    assert.doesNotMatch(changed, /Source ranges unchanged|may duplicate a charge/);
    const tiny = await getContext({...options, maxTokens:512});
    assert.ok(Buffer.byteLength(tiny) <= 2048);
    assert.match(tiny, /Known risks|Omitted: response budget/);
    const lookup = await getContext({...options, intent:'lookup'});
    assert.doesNotMatch(lookup, /Known risks|idempotency key/);
    const successor = seed('charge-successor', 'Resolved note', {open_risks:'[]'});
    db.upsertMemoryEdge({source:id, target:successor, relation:'resolved_by', metadata:{relation_kind:'supersedes'}});
    assert.doesNotMatch(await getContext(options), /idempotency key|Resolved note/);
    seed('charge-current', 'Stale risk sentinel');
    await writeFile(join(root, 'charge.ts'), 'export const charge = () => 2;\n');
    const stale = await getContext(options);
    assert.match(stale, /Known risks: unavailable/);
    assert.doesNotMatch(stale, /Stale risk sentinel/);
  } finally {closeDB(root); await rm(root,{recursive:true,force:true});}
});
