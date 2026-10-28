import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getContext, collectSourceEvidence } from '../../build/tools/context.js';
import { reindex } from '../../build/tools/reindex.js';
import { unifiedSearchData } from '../../build/tools/search.js';
import { getStatusData } from '../../build/tools/status.js';
import { closeDB, getDB } from '../../build/core/db.js';
import { isOrientationQuery, isUiOrientationQuery, orientationFiles, documentTopicFiles, discoveryPathWeight, mentionedFiles, positiveDiscoveryQuery } from '../../build/tools/discovery-hints.js';
import { wantsDocuments, discoverDocuments } from '../../build/tools/discovery-documents.js';
import { retrieveEvidence } from '../../build/tools/evidence-retrieval.js';
import { isTestFile, findTestsForFiles } from '../../build/tools/retrieval-helpers.js';
import { getEmbedProvider, getEmbedModel } from '../../build/core/embeddings.js';

async function fixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-discovery-routing-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    await run(root);
  } finally { closeDB(root); await rm(root, { recursive: true, force: true }); }
}

it('keeps debug implementation ahead of incidental status journals without requiring symbol names', async () => {
  await fixture({
    'src/countdown.ts': 'export function remaining(revealAt: number, now: number) {\n  // Host event dashboard live status card capture closed countdown reveal time passed\n  return Math.max(0, revealAt - now);\n}\n',
    'docs/STATUS.md': '# Event dashboard status\n' + 'Host event dashboard live status card capture closed countdown reveal time passed: historical review notes.\n'.repeat(60),
    'docs/archive/status.md': '# Event dashboard history\nHost event dashboard live status card capture closed countdown reveal time passed.\n',
  }, async root => {
    for (const intent of ['debug', 'change', 'review']) {
      const packet = await collectSourceEvidence({rootDir: root, query: 'host event dashboard live status card capture closed countdown reveal time passed', intent, maxTokens: 800, retrievalPreset: 'keyword_only'});
      assert.equal(packet.ranges[0]?.file, 'src/countdown.ts', packet.text);
      assert.match(packet.text, /Math.max\(0, revealAt - now\)/);
      assert.ok(Buffer.byteLength(packet.text) <= 3200);
    }
    const doc = await collectSourceEvidence({rootDir: root, query: 'Read docs/STATUS.md', intent:'debug', maxTokens:800, retrievalPreset:'keyword_only'});
    assert.equal(doc.ranges[0]?.file, 'docs/STATUS.md');
  });
});

it('preserves explicitly requested documentation across change intents at the minimum budget', async () => {
  const documentation = 'createBooking requires a confirmed customer account before creating a booking.';
  await fixture({
    'src/booking.ts': 'export function createBooking(customer: string) {\n'
      + Array.from({length: 2}, (_, i) => `  const field${i} = customer.trim(); // booking validation field ${i}\n`).join('')
      + '  return { customer };\n}\n',
    'docs/booking.md': '# createBooking documentation\n\n' + documentation + '\n',
  }, async root => {
    for (const intent of ['review', 'debug', 'change']) for (const query of ['Review documentation for createBooking', 'Read docs for createBooking', 'Review API specification for createBooking', 'Read the readiness for createBooking']) {
      const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 512, retrievalPreset: 'keyword_only'});
      assert.equal(packet.ranges[0]?.file, 'docs/booking.md', packet.text);
      assert.ok(packet.text.includes(documentation), packet.text);
      assert.ok(Buffer.byteLength(packet.text) <= 2048);
    }
    const mixed = await collectSourceEvidence({rootDir: root, query: 'Review createBooking implementation and documentation', intent: 'review', maxTokens: 512, retrievalPreset: 'keyword_only'});
    assert.equal(mixed.ranges[0]?.file, 'src/booking.ts', mixed.text);
  });
});

it('distinguishes stale, skipped, failed, empty and weak semantic evidence in bounded discovery headers', async () => {
  await fixture({'src/countdown.ts': 'export const countdown = "host event reveal time";\n'}, async root => {
    const db = await getDB(root);
    const retrieved = await retrieveEvidence({rootDir:root,query:'host event reveal time',preset:'keyword_only'});
    retrieved.search.trust.ambiguities = ['file search is keyword-only'];
    const read = () => collectSourceEvidence({rootDir:root,query:'host event reveal time',intent:'debug',retrieved,maxTokens:512});
    db.setMeta('embeddings_stale','true');
    db.setMeta('embeddings_stale_reason','provider/model changed from ollama/nomic to ollama/bge');
    let packet = await read();
    assert.match(packet.text,/lexical fallback.*provider\/model changed from ollama\/nomic to ollama\/bge/);
    assert.match(packet.text,/no_embed:false/);
    assert.ok(packet.text.indexOf('Discovery used') < packet.text.indexOf('Source evidence'));
    db.clearEmbeddingsStaleFlag();
    packet = await read();
    assert.match(packet.text,/corpus embeddings were skipped/);
    db.setMeta('last_embed_skipped','false');
    db.setMeta('last_embed_error','provider unreachable');
    packet = await read();
    assert.match(packet.text,/last embedding build failed: provider unreachable/);
    db.setMeta('last_embed_error','');
    packet = await read();
    assert.match(packet.text,/no file vectors are stored/);
    db.upsertEmbedding('file_search_cache','src/countdown.ts',[1,0,0],'fixture');
    packet = await read();
    assert.match(packet.text,/no complete provider\/model identity/);
    assert.match(packet.text,/no_embed:false/);
    db.recordEmbeddingProvider(getEmbedProvider(),getEmbedModel());
    db.upsertEmbedding('file_search_cache','src/countdown.ts',[1,0,0],'fixture');
    db.clearEmbeddingsStaleFlag();
    packet = await read();
    assert.match(packet.text,/vectors exist.*weak or unavailable/);
    assert.doesNotMatch(packet.text,/no_embed:false|Reindex|reindex/);
    const keyword = await collectSourceEvidence({rootDir:root,query:'host event reveal time',retrieved,retrievalPreset:'keyword_only',maxTokens:512});
    assert.match(keyword.text,/requested keyword_only/);
    assert.doesNotMatch(keyword.text,/lexical fallback/);
    db.setMeta('embeddings_stale','true');
    db.setMeta('embeddings_stale_reason','模型'.repeat(1000));
    packet = await read();
    assert.ok(Buffer.byteLength(packet.text) <= 2048, packet.text);
  });
});

it('keeps explicitly named test helpers ahead of documents and labels their evidence', async () => {
  const source = 'export async function forceFailure(table, fn) {\n  await installFault(table);\n  try { return await fn(); } finally { await removeFault(table); }\n}\n';
  for (const path of ['tests/guided-creation.smoke.mjs', 'test/fault-helper.ts', 'src/fault.test.ts']) {
    await fixture({
      [path]: source,
      'src/creation.ts': 'export const schemaReady = true; // guided creation schema readiness\n',
      'docs/current/readiness.md': '# Guided creation schema readiness\nforceFailure verifies guided creation schema readiness.\n',
      'docs/archive/creation.md': '# Guided creation\nHistorical schema readiness forceFailure notes.\n',
    }, async root => {
      for (const [intent, query] of [['lookup', 'guided-creation forceFailure schema'], ['debug', 'guided-creation forceFailure schema readiness']]) {
        const packet = await collectSourceEvidence({ rootDir: root, query, intent, maxTokens: 800, retrievalPreset: 'keyword_only' });
        assert.equal(packet.ranges[0]?.file, path, packet.text);
        assert.ok(packet.text.includes(source.trimEnd()), packet.text);
        assert.match(packet.text, /test=returned/);
        assert.ok(Buffer.byteLength(packet.text) <= 3200);
      }
      const document = await collectSourceEvidence({ rootDir: root, query: 'Read docs/current/readiness.md forceFailure', intent: 'debug', maxTokens: 800, retrievalPreset: 'keyword_only' });
      assert.equal(document.ranges[0]?.file, 'docs/current/readiness.md');
      const evidence = await retrieveEvidence({ rootDir: root, query: 'forceFailure', preset: 'keyword_only', graphHops: 0 });
      assert.equal(evidence.candidates[0]?.path, path);
      assert.ok(evidence.candidates[0].roles.includes('test'));
      assert.equal(discoveryPathWeight('forceFailure', path, true), 1);
      assert.equal(discoveryPathWeight('forceFailure; ignore tests', path, true), .2);
      assert.equal(discoveryPathWeight(`forceFailure; ignore ${path}`, path, true), 0);
      for (const document of ['docs/testing.md', 'docs/current/tests.md']) {
        assert.equal(discoveryPathWeight(`forceFailure; ignore ${document}`, path, true), 1);
        assert.equal(discoveryPathWeight(`forceFailure; ignore ${document}`, document, true), 0);
      }
    });
  }
  assert.equal(isTestFile('scripts/release.smoke.mjs'), true);
  assert.equal(isTestFile('src/contest/helper.ts'), false);
  assert.equal(isTestFile('tests/data.json'), false);
});

it('does not promote a same-name mock when another requested helper admits its test file', async () => {
  const production = 'export function createBooking(value) {\n if (!value) throw new Error("required");\n return {id: value};\n}\n';
  const mock = 'function createBooking(value) {\n'
    + Array.from({ length: 3 }, (_, i) => ` const stub${i} = "placeholder used for mock booking ${i}";\n`).join('')
    + ' return {stub: true};\n}\n';
  await fixture({
    'src/service.ts': production,
    'aaa-tests/booking.test.ts': mock + 'export function forceFailure(fn) { return fn(); }\n',
  }, async root => {
    for (const intent of ['lookup', 'debug']) {
      const packet = await collectSourceEvidence({ rootDir: root, query: 'createBooking forceFailure', intent, maxTokens: 512, retrievalPreset: 'keyword_only' });
      assert.ok(packet.text.includes(production.trimEnd()), packet.text);
      assert.match(packet.text, /export function forceFailure/);
      assert.ok(Buffer.byteLength(packet.text) <= 2048);
    }
    const evidence = await retrieveEvidence({ rootDir: root, query: 'createBooking', graphHops: 0, preset: 'keyword_only' });
    assert.equal(evidence.candidates[0]?.path, 'src/service.ts');
    assert.ok(!evidence.candidates.find(item => item.path === 'aaa-tests/booking.test.ts')?.reason.includes('named definition'));
  });
});

it('traverses test-directory helpers to find executable tests', async () => {
  await fixture({
    'src/service.ts': 'export function createBooking() { return 1; }\n',
    'tests/helpers.ts': 'import { createBooking } from "../src/service.js";\nexport const fixture = () => createBooking();\n',
    'tests/integration.test.ts': 'import { fixture } from "./helpers.js";\nfixture();\n',
  }, async root => {
    for (const source of ['src/service.ts', 'tests/helpers.ts']) {
      const tests = await findTestsForFiles(root, [source]);
      assert.deepEqual(tests.map(item => item.path), ['tests/integration.test.ts']);
    }
    assert.equal(isTestFile('tests/helpers.ts'), false);
  });
});

it('keeps named implementation ahead of incidental history and still finds requested plans', async () => {
  const source = 'export function createListingAction(owner: string) {\n'
    + Array.from({length: 12}, (_, i) => `  const field${i} = owner.trim(); // listing submission validation field ${i}\n`).join('')
    + '  if (!owner) throw new Error("listing owner required");\n  return { saved: true };\n}\n';
  await fixture({
    'src/actions.ts': source,
    'README.md': '# Listing submission validation\ncreateListingAction validates the listing owner before submission.\n',
    'docs/plans/trader-sales.md': '# Trader sales specification\nCurrent task plan: assistance and trader routes require an actual seller.\n',
    ...Object.fromEntries(Array.from({length: 8}, (_, i) => [`docs/archive/trader-sales-${i}.md`, '# Trader sales listing submission validation\ncreateListingAction owner saved listing submission validation field history.\n' + 'Historical listing validation notes.\n'.repeat(30)])),
  }, async root => {
    for (const query of ['createListingAction listing submission validation', 'Find createListingAction; ignore task plans', 'Find createListingAction; do not include design specs', 'Find createListingAction; do not review task plans', 'Find createListingAction; do not inspect design specs', 'Find createListingAction; skip task plans', 'Find createListingAction; skipping task plans', 'Find createListingAction without task plans', 'Find createListingAction without README', 'Find createListingAction; do not read relevant docs', 'Find createListingAction; do not review existing task plans', 'Find createListingAction; do not read project instructions', 'Find createListingAction; do not review project overview', ...['omit task plans', 'omitting task plans', 'avoid design specifications', 'avoiding design specifications'].map(clause => `Find createListingAction; ${clause}`), ...['open', 'show', 'find', 'locate', 'search'].map(verb => `Find createListingAction; do not ${verb} task plans`)]) for (const intent of [undefined, 'lookup', 'change']) {
      const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 800, retrievalPreset: 'keyword_only'});
      assert.equal(packet.ranges[0]?.file, 'src/actions.ts');
      assert.ok(packet.text.includes(source.trimEnd()), packet.text);
      assert.ok(Buffer.byteLength(packet.text) <= 3200);
    }
    const query = 'trader-sales reviewed specification task plan assistance trader routes';
    assert.equal(wantsDocuments(query), true);
    const documents = await discoverDocuments(root, query);
    assert.equal(documents.files[0], 'docs/plans/trader-sales.md');
    const plan = await getContext({rootDir: root, query, maxTokens: 1200, retrievalPreset: 'keyword_only'});
    assert.match(plan, /Current task plan: assistance and trader routes require an actual seller/);
    const history = await getContext({rootDir: root, query: 'Read docs/archive/trader-sales-0.md', maxTokens: 1200, retrievalPreset: 'keyword_only'});
    assert.match(history, /Historical listing validation notes/);
    assert.equal(discoveryPathWeight('listing submission', 'src/lib/i18n.ts'), .2);
    assert.equal(discoveryPathWeight('listing i18n copy', 'src/lib/i18n.ts'), 1);
    assert.equal(discoveryPathWeight('getLocale', 'src/lib/i18n.ts'), 1);
    assert.equal(discoveryPathWeight('trader sales history', 'docs/archive/trader-sales-0.md'), 1);
  });
});

it('prioritizes named implementations in locale modules over their callers', async () => {
  const source = 'export function formatDate(value: Date) {\n  const iso = value.toISOString();\n  return iso.slice(0, 10);\n}\n';
  for (const module of ['i18n', 'l10n']) await fixture({
    [`src/${module}.ts`]: source,
    ...Object.fromEntries(Array.from({length: 16}, (_, i) => [`src/caller-${i}.ts`, `import { formatDate } from './${module}';\nexport function render${i}(value: Date) { return formatDate(value); }\n`])),
  }, async root => {
    const path = `src/${module}.ts`;
    for (const query of ['formatDate', 'Find formatDate']) {
      for (const intent of [undefined, 'lookup', 'change']) {
        const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 800, retrievalPreset: 'keyword_only'});
        assert.equal(packet.ranges[0]?.file, path, packet.text);
        assert.ok(packet.text.includes(source.trimEnd()), packet.text);
      }
      const evidence = await retrieveEvidence({rootDir: root, query, preset: 'keyword_only', graphHops: 0});
      assert.equal(evidence.candidates[0]?.path, path);
      assert.match(evidence.candidates[0].reason, /named definition/);
    }
    const excluded = await collectSourceEvidence({rootDir: root, query: `Find formatDate; ignore ${path}`, intent: 'change', maxTokens: 800, retrievalPreset: 'keyword_only'});
    assert.ok(!excluded.ranges.some(range => range.file === path), excluded.text);
    assert.equal(discoveryPathWeight('listing submission', path), .2);
  });
});

it('retains positive document clauses after exclusions in default discovery', async () => {
  const adaptive = process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
  process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = 'false';
  try {
    await fixture({
      'src/actions.ts': 'export function createListingAction() { return "saved"; }\n',
      'docs/guide.md': '# Documentation\nListing owner approval is required before publication.\n',
    }, async root => {
      for (const verb of ['read', 'find', 'open', 'show', 'locate', 'search', 'review', 'inspect']) {
        for (const boundary of [' and ', ' then ', ', ']) {
          const query = `Find createListingAction; skip task plans${boundary}${verb} documentation`;
          assert.equal(wantsDocuments(query), true, query);
          const packet = await collectSourceEvidence({rootDir: root, query, maxTokens: 1200, retrievalPreset: 'keyword_only'});
          assert.match(packet.text, /Listing owner approval is required before publication/, query);
        }
      }
      assert.equal(discoveryPathWeight('skip docs/guide.md and review documentation', 'docs/guide.md'), 0);
    });
  } finally {
    if (adaptive === undefined) delete process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
    else process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = adaptive;
  }
});

it('does not treat excluded document topics as positive discovery intent', () => {
  for (const excluded of ['ignore task plans', 'skip task plans', 'skipping task plans', 'omit task plans', 'omitting task plans', 'avoid design specifications', 'avoiding design specifications', 'do not include design specs', "don't read the specification", 'exclude docs/README.md', 'ignoring project overview', 'without relevant docs', 'avoid existing specifications', 'skip relevant task plans']) {
    assert.equal(wantsDocuments(`Find createListingAction; ${excluded}`), false, excluded);
  }
  for (const verb of ['read', 'include', 'open', 'show', 'find', 'locate', 'search', 'review', 'inspect']) for (const negation of ['do not', "don't"]) for (const qualifier of ['', 'relevant ', 'existing ']) {
    assert.equal(wantsDocuments(`Find createListingAction; ${negation} ${verb} ${qualifier}task plans`), false);
    assert.equal(discoveryPathWeight(`find listing; ${negation} ${verb} ${qualifier}docs/plans.md`, 'docs/plans.md'), 0);
    assert.equal(discoveryPathWeight(`find listing; ${negation} ${verb} ${qualifier}archived documents`, 'docs/archive/listing.md'), 0);
    assert.equal(wantsDocuments(`Find createListingAction; ${negation} ${verb} ${qualifier}task plans; read documentation`), true);
    const behavior = `Review documentation explaining why clients ${negation} ${verb} ${qualifier}connections`;
    assert.equal(positiveDiscoveryQuery(behavior), behavior);
  }
  for (const excluded of ['ignore history', 'do not include archived documents', 'exclude historical notes', 'omit history', 'omitting history', 'avoid historical notes', 'avoiding historical notes']) {
    assert.equal(discoveryPathWeight(`find listing validation; ${excluded}`, 'docs/archive/listing.md'), excluded === 'do not include archived documents' ? 0 : .25, excluded);
  }
  assert.equal(wantsDocuments('Find createListingAction; ignore task plans; read the specification'), true);
  assert.equal(discoveryPathWeight('find listing validation; ignore history; include history', 'docs/archive/listing.md'), 1);
  assert.equal(discoveryPathWeight('find listing validation; ignore docs/archive/listing.md', 'docs/archive/listing.md'), 0);
  for (const path of ['src/actions.test.ts', 'src/lib/i18n.ts', 'package-lock.json']) {
    assert.ok(discoveryPathWeight('find listing validation; ignore tests, translations and dependencies', path) < 1, path);
  }
});

it('aligns compound document exclusions with positive document intent', () => {
  const objects = [
    ...['product', 'project', 'repository', 'api', 'setup', 'developer', 'user', 'security', 'compliance'].map(scope => `${scope} docs`),
    ...['project', 'repository'].flatMap(scope => ['instructions', 'status'].map(topic => `${scope} ${topic}`)),
    ...['repo', 'repository', 'project', 'codebase'].flatMap(scope => ['orientation', 'overview'].map(topic => `${scope} ${topic}`)),
    ...['status', 'qa', 'audit'].flatMap(scope => ['document', 'documents', 'report', 'reports'].map(topic => `${scope} ${topic}`)),
    ...['implementation', 'task', 'design'].flatMap(scope => ['plan', 'plans', 'spec', 'specs'].map(topic => `${scope} ${topic}`)),
    'agent brief', 'overview of the project', 'orientation to the repository',
  ];
  for (const object of objects) {
    assert.equal(wantsDocuments(`read ${object}`), true, object);
    for (const action of ['do not read', "don't review", 'skip', 'omit', 'avoid', 'without']) {
      const query = `Find createListingAction; ${action} ${object}`;
      assert.equal(wantsDocuments(query), false, query);
      assert.equal(isOrientationQuery(query), false, query);
      assert.equal(isUiOrientationQuery(`frontend ${query}`), false, query);
      assert.equal(wantsDocuments(`${query}; read ${object}`), true, query);
    }
  }
  const behavior = 'Review documentation explaining why clients do not read project deadlines';
  assert.equal(positiveDiscoveryQuery(behavior), behavior);
});

it('retains penalties for negated secondary evidence classes', () => {
  for (const [category, path, weight] of [['tests', 'src/actions.test.ts', .2], ['translations', 'src/lib/i18n.ts', .2], ['dependencies', 'package-lock.json', .15]]) {
    for (const action of ['without', 'skip', 'skipping', 'omit', 'omitting', 'avoid', 'avoiding', 'do not read']) {
      const query = `Find listing validation; ${action} ${category}`;
      assert.equal(discoveryPathWeight(query, path), weight, query);
      assert.equal(discoveryPathWeight(`${query}; include ${category}`, path), 1);
    }
  }
});

it('filters excluded document categories from adaptive discovery', async () => {
  const plans = ['docs/plans/task.md', 'docs/proposal.md'];
  const specs = ['docs/specs/listing.md', 'docs/contract.md'];
  const documents = ['README.md', ...plans, ...specs];
  await fixture({
    'src/actions.ts': 'export function createListingAction() { return "listing validation"; }\n',
    'README.md': '# Guide\ncreateListingAction listing validation guide.\n',
    ...Object.fromEntries(plans.map(path => [path, '# Implementation plan\ncreateListingAction listing validation plan.\n'])),
    ...Object.fromEntries(specs.map(path => [path, '# Design specification\ncreateListingAction listing validation specification.\n'])),
  }, async root => {
    for (const [exclusion, excluded] of [['without documentation', documents], ['skip task plans', plans], ['avoid design specifications', specs], ['skip task plans; read documentation', plans]]) {
      const query = `Find createListingAction ${exclusion}`;
      for (const intent of ['lookup', 'change']) {
        const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 4000, retrievalPreset: 'keyword_only'});
        assert.ok(packet.ranges.some(range => range.file === 'src/actions.ts'), packet.text);
        assert.ok(!packet.ranges.some(range => excluded.includes(range.file)), `${query}: ${packet.text}`);
        if (excluded !== documents) assert.ok(packet.ranges.some(range => range.file === 'README.md'), packet.text);
      }
      const found = await discoverDocuments(root, query);
      assert.ok(!found.files.some(file => excluded.includes(file)), query);
    }
    for (const plan of plans) assert.ok((await discoverDocuments(root, 'Find createListingAction without documentation; read task plans')).files.includes(plan));
    assert.ok((await discoverDocuments(root, 'Find createListingAction skip task plans; read task plans')).files.includes(plans[0]));
    assert.equal(discoveryPathWeight('skip task plans; read docs/plans/task.md', plans[0]), 1);
    assert.equal(discoveryPathWeight('skip docs/plans/task.md; read task plans', plans[0]), 0);
  });
});

it('keeps requested archive basenames inside the bounded document candidate pool', async () => {
  const path = 'docs/archive/listing.md';
  const topic = 'listing owner seller status submission validation';
  await fixture({
    [path]: `# ${topic}\nHistorical listing contract.\n`,
    ...Object.fromEntries(Array.from({length: 64}, (_, i) => [`docs/${topic.replaceAll(' ', '-')}-${i}.md`, `# ${topic}\nCurrent listing contract.\n`])),
  }, async root => {
    const documents = await discoverDocuments(root, 'read listing.md owner seller status submission validation');
    assert.equal(documents.files[0], path);
    assert.equal(documents.limited, true);
    assert.equal(discoveryPathWeight('read listing.md', path), 1);
    for (const verb of ['ignore', 'skip', 'skipping', 'omit', 'omitting', 'avoid', 'avoiding']) {
      assert.equal(discoveryPathWeight(`find listing; ${verb} listing.md`, path), 0);
      assert.equal(discoveryPathWeight(`find listing; ${verb} blog posts`, 'blog/listing.md'), 0);
      assert.equal(discoveryPathWeight(`find listing; ${verb} listing.md; read listing.md`, path), 1);
    }
  });
});

it('retains behavioral topics after ambiguous exclusions in document discovery', async () => {
  await fixture({
    'README.md': '# Parser documentation\nReview of implementation details.\n',
    'docs/comments.md': '# Comments\nTrivia is discarded.\n',
    'docs/fields.md': '# Fields\nOptional entries are suppressed.\n',
    'docs/deadlocks.md': '# Deadlocks\nAcquire resources in a consistent order.\n',
    'docs/connections.md': '# Connections\nSockets remain closed until needed.\n',
  }, async root => {
    for (const [behavior, topic] of [
      ['why the parser must skip comments', 'comments'], ['the parser skipping comments', 'comments'],
      ['why the serializer must omit fields', 'fields'], ['the serializer omitting fields', 'fields'],
      ['how workers avoid deadlocks', 'deadlocks'], ['workers avoiding deadlocks', 'deadlocks'],
      ...['do not', "don't"].flatMap(negation => ['read', 'include', 'open', 'show', 'find', 'locate', 'search', 'review', 'inspect'].map(verb => [`why clients ${negation} ${verb} connections`, 'connections'])),
    ]) {
      const query = `Review documentation explaining ${behavior}`;
      const documents = await discoverDocuments(root, query);
      assert.ok(documents.files.includes(`docs/${topic}.md`), `${query}: ${documents.files}`);
      assert.equal(positiveDiscoveryQuery(query), query);
    }
  });
});

it('distinguishes without evidence from behavior without a feature', () => {
  for (const query of ['Find createListingAction without task plans', 'Find createListingAction without the design specification', 'Find createListingAction without any documentation']) {
    assert.equal(wantsDocuments(query), false, query);
  }
  assert.equal(discoveryPathWeight('find listing validation without historical notes', 'docs/archive/listing.md'), .25);
  assert.equal(discoveryPathWeight('find listing validation without docs/archive/listing.md', 'docs/archive/listing.md'), 0);
  assert.equal(wantsDocuments('Find createListingAction without task plans; read the specification'), true);
  assert.equal(discoveryPathWeight('find listing validation without historical notes; include history', 'docs/archive/listing.md'), 1);
  for (const query of ['find routes without authentication in src/api', 'read retry behavior without automatic retries in src/api/retry.ts']) {
    assert.equal(positiveDiscoveryQuery(query), query, query);
  }
});

it('keeps incidental specification mentions from displacing a named implementation', async () => {
  const source = 'export function parseUrl(value: string) {\n  return new URL(value);\n}\n';
  const adaptive = process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
  process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = 'false';
  try {
    await fixture({
      'src/url.ts': source,
      'docs/url.md': '# WHATWG URL specification\nparseUrl implementation matching the WHATWG specification.\n',
    }, async root => {
      for (const topic of ['specification', 'specifications']) {
        const query = `Find parseUrl implementation matching the WHATWG ${topic}`;
        for (const intent of [undefined, 'lookup', 'change']) {
          const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 512, retrievalPreset: 'keyword_only'});
          assert.equal(packet.ranges[0]?.file, 'src/url.ts', packet.text);
          assert.ok(packet.text.includes(source.trimEnd()), packet.text);
        }
        assert.equal(wantsDocuments(query), false, query);
        for (const action of ['read', 'find', 'open', 'show', 'locate', 'search', 'review', 'inspect', 'include']) {
          assert.equal(wantsDocuments(`${action} the ${topic}`), true);
          assert.equal(wantsDocuments(`${action} the API ${topic}`), true);
          assert.equal(wantsDocuments(`${action} the WHATWG ${topic}`), true);
        }
        assert.equal(wantsDocuments(`Find parseUrl; skip ${topic}; read the ${topic}`), true);
      }
    });
  } finally {
    if (adaptive === undefined) delete process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
    else process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = adaptive;
  }
});

it('finds plural specifications and downranks plural archives directories', async () => {
  const adaptive = process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
  process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = 'false';
  try {
    await fixture({
      'src/app.ts': 'export const app = 1;\n',
      'docs/specifications/api.md': '# API and design specifications\nCurrent contract requires an authenticated seller.\n',
      'docs/archives/api.md': '# API and design specifications\nHistorical contract allowed anonymous submissions.\n',
    }, async root => {
      for (const query of ['Read the API specifications', 'review the design specifications']) {
        assert.equal(wantsDocuments(query), true, query);
        const packet = await collectSourceEvidence({rootDir: root, query, maxTokens: 1000, retrievalPreset: 'keyword_only'});
        assert.equal(packet.ranges[0]?.file, 'docs/specifications/api.md');
        assert.match(packet.text, /Current contract requires an authenticated seller/);
      }
      assert.equal(wantsDocuments('Find app without the design specifications'), false);
      assert.equal(discoveryPathWeight('find listing validation', 'docs/archives/listing.md'), .25);
      assert.equal(discoveryPathWeight('read listing archives', 'docs/archives/listing.md'), 1);
      assert.equal(discoveryPathWeight('read docs/archives/listing.md', 'docs/archives/listing.md'), 1);
      assert.equal(discoveryPathWeight('find listing; ignore history', 'docs/archives/listing.md'), .25);
      assert.equal(discoveryPathWeight('find listing validation', 'src/archives/listing.ts'), 1);
    });
  } finally {
    if (adaptive === undefined) delete process.env.CONTEXTPRO_ADAPTIVE_CONTEXT;
    else process.env.CONTEXTPRO_ADAPTIVE_CONTEXT = adaptive;
  }
});

it('honors extensionless document exclusions and old-document intent', async () => {
  for (const title of ['README', 'roadmap', 'handoff', 'readiness']) {
    assert.equal(wantsDocuments(`Find createListingAction without ${title}`), false, title);
    assert.equal(wantsDocuments(`Find createListingAction without ${title}; read documentation`), true, title);
  }
  await fixture({
    'src/app.ts': 'export const app = 1;\n',
    'docs/archive/listing.md': '# Old listing documentation\nPrior listing contract used manual approval.\n',
    'docs/listing.md': '# Current listing documentation\nCurrent documentation uses automatic approval.\n',
  }, async root => {
    assert.equal(discoveryPathWeight('review old documentation', 'docs/archive/listing.md'), 1);
    assert.equal((await discoverDocuments(root, 'review old documentation')).files[0], 'docs/archive/listing.md');
    assert.equal(discoveryPathWeight('find listing; ignore old documentation', 'docs/archive/listing.md'), 0);
    assert.equal(discoveryPathWeight('find listing without old documentation', 'docs/archive/listing.md'), 0);
    assert.equal(discoveryPathWeight('fix old browser behavior', 'docs/archive/listing.md'), .25);
  });
});

it('finds explicitly requested old qualified plans, specifications and scoped docs', async () => {
  const scopes = ['product', 'project', 'repository', 'API', 'setup', 'developer', 'user', 'security', 'compliance'];
  await fixture({
    'docs/archive/plans.md': `# Old design specifications and task implementation plans\n## ${scopes.join(' ')} docs\nPrevious listing requirements.\n`,
    'docs/plans.md': `# Current design specifications and task implementation plans\n## ${scopes.join(' ')} docs\nCurrent listing requirements.\n`,
  }, async root => {
    for (const query of ['review old design specifications', 'read old task plans', 'review old implementation plans', ...scopes.map(scope => `review old ${scope} docs`)]) {
      assert.equal((await discoverDocuments(root, query)).files[0], 'docs/archive/plans.md', query);
      assert.equal(discoveryPathWeight(query, 'docs/archive/plans.md'), 1, query);
      assert.equal(discoveryPathWeight(`find listing; do not ${query}`, 'docs/archive/plans.md'), query.endsWith('plans') ? 0 : .25, query);
    }
    assert.equal(discoveryPathWeight('find listing without old design specifications', 'docs/archive/plans.md'), .25);
    for (const scope of ['design', ...scopes]) assert.equal(discoveryPathWeight(`fix old ${scope} behavior`, 'docs/archive/plans.md'), .25);
  });
});

it('removes excluded document stems from adaptive discovery packets', async () => {
  const documents = ['README.md', 'docs/roadmap.mdx', 'docs/HANDOFF.rst', 'docs/readiness.txt'];
  await fixture({
    'src/actions.ts': 'export function createListingAction() { return "saved"; }\n',
    ...Object.fromEntries(documents.map(file => [file, '# Listing submission\ncreateListingAction validates the listing owner before submission.\n'])),
  }, async root => {
    for (const intent of ['lookup', 'change']) {
      const packet = await collectSourceEvidence({rootDir: root, query: 'Find createListingAction without README, roadmap, handoff and readiness', intent, maxTokens: 4000, retrievalPreset: 'keyword_only'});
      assert.ok(packet.ranges.some(range => range.file === 'src/actions.ts'));
      assert.ok(!packet.ranges.some(range => documents.includes(range.file)), packet.text);
    }
    for (const [index, title] of ['readme', 'roadmap', 'handoff', 'readiness'].entries()) {
      const query = `Find createListingAction without ${title}`;
      assert.equal(discoveryPathWeight(query, documents[index]), 0, title);
      assert.ok(!(await discoverDocuments(root, query)).files.includes(documents[index]), title);
      assert.equal(discoveryPathWeight(`${query}; include ${title}`, documents[index]), 1, title);
      assert.equal(discoveryPathWeight(query, `src/${title}.ts`), 1, title);
      assert.equal(discoveryPathWeight(query, `docs/${title}-examples.md`), 1, title);
    }
  });
});

it('keeps explicit document exclusions when later prose repeats a generic stem', async () => {
  const query = 'ignore docs/status.md; report current status';
  await fixture({
    'src/status.ts': 'export const currentStatus = "active"; // report current status\n',
    'docs/status.md': '# Current status\nReport current status from this document.\n',
  }, async root => {
    for (const intent of ['lookup', 'change']) {
      const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 2000, retrievalPreset: 'keyword_only'});
      assert.ok(packet.ranges.some(range => range.file === 'src/status.ts'), packet.text);
      assert.ok(!packet.ranges.some(range => range.file === 'docs/status.md'), packet.text);
    }
    assert.equal(discoveryPathWeight(query, 'docs/status.md'), 0);
    assert.ok(!(await discoverDocuments(root, query)).files.includes('docs/status.md'));
    assert.equal(discoveryPathWeight(`${query}; include docs/status.md`, 'docs/status.md'), 1);
  });
});

it('keeps explicit exclusions before ordinary document-title words', async () => {
  const titles = ['readiness', 'roadmap', 'handoff', 'README'];
  await fixture({
    'src/release.ts': 'export const release = "ready";\n',
    ...Object.fromEntries(titles.map(title => [`docs/${title}.md`, `# Release ${title}\nRelease review evidence.\n`])),
  }, async root => {
    for (const title of titles) {
      const path = `docs/${title}.md`;
      const query = `ignore ${path}; assess release ${title}`;
      assert.equal(discoveryPathWeight(query, path), 0, query);
      assert.ok(!(await discoverDocuments(root, query)).files.includes(path), query);
      for (const intent of ['lookup', 'change']) {
        const packet = await collectSourceEvidence({rootDir: root, query, intent, maxTokens: 2000, retrievalPreset: 'keyword_only'});
        assert.ok(!packet.ranges.some(range => range.file === path), packet.text);
      }
      for (const verb of ['include', 'including', 'read', 'find', 'open', 'show', 'locate', 'search', 'review', 'inspect']) {
        assert.equal(discoveryPathWeight(`${query}; ${verb} the ${title}`, path), 1);
      }
      assert.equal(discoveryPathWeight(`${query}; read ${title}.md`, path), 1);
      assert.equal(discoveryPathWeight(`read ${title}; ignore ${path}`, path), 0);
    }
  });
});

it('reports unevaluated lookup roles as unclassified while preserving evaluated coverage', async () => {
  await fixture({
    'src/media.ts': '// Media caller authorization\nexport function requireMediaCaller(authorized: boolean) {\n  if (!authorized) throw new Error("media caller authorization required");\n  return true;\n}\n',
    'src/config.ts': 'export const quota = 3;\n',
  }, async root => {
    for (const intent of ['lookup','auto']) for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'requireMediaCaller',intent,connected,maxTokens:1500,retrievalPreset:'keyword_only'});
      assert.match(text,/export function requireMediaCaller/);
      assert.match(text,/implementation=unclassified/);
      assert.doesNotMatch(text,/implementation=unavailable|hybrid \+ structural relations/);
      assert.ok(Buffer.byteLength(text)<=6000);
    }
    const natural=await getContext({rootDir:root,query:'media caller authorization',intent:'lookup',connected:false,maxTokens:1500,retrievalPreset:'keyword_only'});
    assert.match(natural,/implementation=unclassified/);
    const config=await getContext({rootDir:root,query:'quota',intent:'lookup',connected:false,maxTokens:1500,retrievalPreset:'keyword_only'});
    assert.match(config,/configuration=returned/);
    const change=await getContext({rootDir:root,query:'requireMediaCaller',intent:'change',maxTokens:1500,retrievalPreset:'keyword_only'});
    assert.match(change,/implementation=returned/);
    assert.match(change,/caller=unavailable/);
    assert.match(change,/hybrid \+ structural relations/);
  });
});

it('adaptive context finds operational evidence without document trigger words and preserves bounded connected evidence', async () => {
  await fixture({
    'docs/HUMAN-PENDING.md': '# Pending actions\nGitHub Actions billing or spending limit blocked CI. Account owner must resolve payment.\n',
    'src/service.ts': 'import { quota } from "./config";\nexport function charge(n: number) { if (n > quota) throw new Error("quota"); return n; }\n',
    'src/config.ts': 'export const quota = 3;\n',
    'src/client.ts': 'import { charge } from "./service";\nexport const run = () => charge(2);\n',
    'src/service.test.ts': 'import { charge } from "./service";\nexport const test = () => charge(1);\n',
  }, async root => {
    const query = 'Find the humanpending entry recording GitHub Actions billing or spending limit blocked CI.';
    assert.equal(wantsDocuments(query), false);
    const text = await getContext({rootDir:root,query,intent:'auto',maxTokens:1500,retrievalPreset:'keyword_only'});
    assert.match(text, /HUMAN-PENDING.md:\d/);
    assert.match(text, /Account owner must resolve payment/);
    const word=await getContext({rootDir:root,query:'billing',intent:'lookup',maxTokens:1400,retrievalPreset:'keyword_only'});
    assert.match(word,/Account owner must resolve payment/);
    const absent=await getContext({rootDir:root,query:'nonexistent_zebra_468291',intent:'auto',maxTokens:1400,retrievalPreset:'keyword_only'});
    assert.doesNotMatch(absent,/Account owner must resolve payment|src\/service.ts:\d/);
    const change = await getContext({rootDir:root,query:'charge',intent:'change',maxTokens:3000,retrievalPreset:'keyword_only'});
    assert.match(change, /src\/client.ts:\d/);
    assert.match(change, /src\/service.test.ts:\d/);
    assert.match(change, /configuration=returned/);
    assert.match(change, /not compiler-resolved/);
    assert.ok(Buffer.byteLength(change) <= 12000);
    const bounded = await getContext({rootDir:root,query:'charge',intent:'change',maxTokens:512,retrievalPreset:'keyword_only'});
    assert.ok(Buffer.byteLength(bounded) <= 2048);
    await assert.rejects(getContext({rootDir:root,targets:[{file:'src/service.ts'}],intent:'change'}), /query discovery only/);
  });
});

it('adaptive retrieval prioritizes decisive operational paragraphs over headings and incidental CI mentions',async()=>{
  await fixture({
    'humanpending.md':'# Owner dependencies\n'+('Unrelated release detail.\n'.repeat(29))+'GitHub Actions availability: account payments failed or the spending limit must be increased. The owner must resolve runner billing before hosted CI can run. '+('Local checks do not prove hosted success. '.repeat(10))+'\n',
    'docs/ci.md':'# GitHub Actions CI\n'+('GitHub Actions workflow checks run tests.\n'.repeat(40)),
    'src/billing.ts':'export function billing() { return "GitHub"; }\n',
  },async root=>{
    for(const query of ['Find the humanpending entry recording GitHub Actions billing or spending limit blocked CI.','Why cannot hosted CI run when the account spending limit is reached?']) {
      const text=await getContext({rootDir:root,query,intent:'auto',maxTokens:1400,retrievalPreset:'keyword_only'});
      assert.match(text,/owner must resolve runner billing/);assert.ok(Buffer.byteLength(text)<=5600);
    }
  });
});

it('adaptive endpoint questions retain route source among client and workflow mentions', async () => {
  await fixture({
    'apps/web/api/download-batch/route.ts': `export async function POST(items: string[]) {
  // Mint signed URLs for a batch, validating every upstream receipt.
  let temporaryFailure = false;
  const urls: string[] = [];
  for (const item of items) {
    const receipt = await mint(item);
    if (!receipt.valid) temporaryFailure = true;
    else urls.push(receipt.url);
  }
  if (temporaryFailure) return { status: 503 };
  return { status: 200, urls };
}\n`,
    'apps/web/client/thumbnails.ts': '// The thumbnail client retries a transient signed batch failure after validation.\nexport const thumbnailRetry = true;\n',
    'apps/native/client/thumbnails.ts': '// Native thumbnails share the transient signed batch failure retry contract.\nexport const nativeRetry = true;\n',
    'docs/workflow.md': '# Web thumbnail workflow\nTransient signed thumbnail batch failure validation and whole-batch retry contract.\n',
    'apps/web/api/unrelated/route.ts': 'export const unrelatedEndpoint = "unrelated-marker";\n',
  }, async root => {
    for (const query of [
      'Locate the transient signed thumbnail batch failure validation and whole-batch retry contract in the web thumbnail route.',
      'Review the download batch endpoint validation failure response.',
    ]) {
      const text = await getContext({rootDir:root,query,intent:'auto',maxTokens:1600,retrievalPreset:'keyword_only'});
      assert.match(text, /apps\/web\/api\/download-batch\/route.ts:\d/);
      assert.match(text, /if \(temporaryFailure\) return \{ status: 503 \}/);
      assert.ok(text.indexOf("apps/web/api/download-batch/route.ts:") < text.indexOf("unrelated-marker") || !text.includes("unrelated-marker"), text);
      assert.ok(Buffer.byteLength(text) <= 6400);
    }
  });
});

it('keeps case-distinct schema and value definitions in a multi-name query', async () => {
  await fixture({
    'core/index.ts': `export const orderSchema = z.object({\n${'  filler: z.string(),\n'.repeat(80)}  items: z.array(z.object({ regionCodes: z.array(z.string()) })),\n});\nexport type NormalizedOrder = z.infer<typeof orderSchema>;\n`,
    'services/normalize.ts': 'export function normalizedOrder(input) { return input; }\n',
  }, async root => {
    const text = await getContext({rootDir:root, query:'NormalizedOrder normalizedOrder', maxTokens:3600, connected:false, retrievalPreset:'keyword_only'});
    assert.match(text, /export const orderSchema = z.object/);
    assert.match(text, /items: z.array/);
    assert.match(text, /export function normalizedOrder/);
  });
});

it('does not read a file mentioned only in an exclusion or use that read as a positive request', async () => {
  await fixture({
    'package.json': '{"scripts":{"build":"site-build"}}\n',
    'LAB-PROJECTS.md': '# Project roadmap\nUnwanted roadmap-marker and package build commands.\n',
    'docs/AGENTS.md': '# Primary instructions\nprimary-agent-marker\n',
    'other/AGENTS.md': '# Other instructions\nother-agent-marker\n',
    'content/blog/post.md': '# Homepage deployment configuration\nblog-post-marker\n',
  }, async root => {
    for (const query of ['Read package.json. Do not read LAB-PROJECTS.md.', 'Read package.json; ignore LAB-PROJECTS.md']) {
      const text = await getContext({rootDir:root, query, maxTokens:512, connected:false});
      assert.match(text, /site-build/);
      assert.doesNotMatch(text, /roadmap-marker|LAB-PROJECTS.md:\d/);
    }
    assert.match(await getContext({rootDir:root,query:'Read LAB-PROJECTS.md',maxTokens:512}), /roadmap-marker/);
    const peer = await getContext({rootDir:root,query:'Read docs/AGENTS.md; ignore other/AGENTS.md',maxTokens:512});
    assert.match(peer,/primary-agent-marker/); assert.doesNotMatch(peer,/other-agent-marker/);
    const focused = await getContext({rootDir:root,query:'Find package.json and deployment configuration. Do not read blog posts or LAB-PROJECTS.md.',maxTokens:512});
    assert.match(focused,/site-build/); assert.doesNotMatch(focused,/blog-post-marker|roadmap-marker/);
  });
});

it('orients a business website around its homepage rather than only marketing documents', async () => {
  const query = 'Orient me to this business website: AGENTS.md instructions, homepage and service/blog content, contact and SEO metadata. Identify actual files and include source evidence.';
  await fixture({
    'next-app/app/(site)/layout.tsx': 'export default function Layout({children}) { return <main>{children}</main>; }\n',
    'next-app/app/(site)/page.tsx': 'export default function Home() { return <h1>homepage-offer-marker</h1>; }\n',
    'AGENTS.md': '# Business website instructions\nInspect homepage services contact SEO metadata.\n',
    ...Object.fromEntries(Array.from({length:6},(_,i)=>[`blog/post-${i}.md`, `# Business website homepage services contact SEO metadata\n${(query+'\n').repeat(80)}`])),
  }, async root => {
    for (const connected of [false,true]) {
      const text = await getContext({rootDir:root,query,maxTokens:1500,connected,retrievalPreset:'keyword_only'});
      assert.match(text, /homepage-offer-marker/);
      const blogBytes = [...text.matchAll(/^blog\/[^\n]+:\d+-\d+\n([^]*?)(?=\n\n|$)/gm)].reduce((sum,match)=>sum+Buffer.byteLength(match[0]),0);
      assert.ok(blogBytes <= 1800, `unrequested blog source consumed ${blogBytes} bytes`);
      assert.ok(Buffer.byteLength(text)<=6000);
    }
  });
});

it('finds an explicitly named runbook without requiring its extension', async () => {
  await fixture({
    'docs/COMMERCIAL_RELEASE.md': '# Commercial release\n## Client journey\nBrowser recovery runbook-marker.\n',
    'src/auth.ts': 'export const commercial_release = "client journey browser recovery";\n',
  }, async root => {
    const text = await getContext({rootDir:root,query:'COMMERCIAL_RELEASE client journey discovery/browser recovery follow-up',maxTokens:512,connected:false});
    assert.match(text, /docs\/COMMERCIAL_RELEASE.md:/);
    assert.match(text, /runbook-marker/);
  });
});

it('retains a late loader predicate when a common literal fills the first candidate lane', async () => {
  await fixture({
    ...Object.fromEntries(Array.from({length:45},(_,i)=>[`src/history-${i}.ts`,'export const history = "created_at";\n'])),
    'services/application.ts': `export async function workspace() {\n${'  const timestamp = record.created_at;\n'.repeat(100)}  // load documents for this workspace\n  const documents = sql('select documents from workspace order by created_at desc limit 25');\n  return documents;\n}\n`,
  }, async root => {
    const text = await getContext({rootDir:root,query:'workspace documents order by created_at limit loadWorkspace',maxTokens:1500,connected:false,retrievalPreset:'keyword_only'});
    assert.match(text, /select documents from workspace order by created_at desc limit 25/);
  });
});

it('returns browser suite source for a coverage request despite incidental application prose', async () => {
  const query = 'Browser end to end coverage landing registration conversion settings billing invoices company profile document upload review discovery outcome collaboration export';
  await fixture({
    ...Object.fromEntries(Array.from({length:16},(_,i)=>[`src/client-${i}.ts`,`export const label = '${query}';\n`])),
    'tests/e2e/billing.spec.ts': "import {test,expect} from '@playwright/test';\ntest('billing invoices', async ({page}) => { await page.goto('/billing'); await expect(page.getByText('invoice')).toBeVisible(); });\n",
    'tests/e2e/upload.spec.ts': "import {test,expect} from '@playwright/test';\ntest('document upload review', async ({page}) => { await page.goto('/documents'); await expect(page.getByText('review')).toBeVisible(); });\n",
  }, async root => {
    const text = await getContext({rootDir:root,query,maxTokens:2600,connected:false,retrievalPreset:'keyword_only'});
    assert.match(text, /tests\/e2e\/(?:billing|upload).spec.ts:/);
    assert.match(text, /test\('/);
  });
});

it('reads an unambiguous indexed path suffix even when the body has no path terms', async () => {
  const files = [{path:'apps/web/src/app/api/commands/route.ts'}, {path:'apps/web/src/app/api/other/route.ts'}];
  assert.deepEqual(mentionedFiles('/repo', 'api/commands/route.ts', files), [files[0].path]);
  for (const query of ['route.ts', 'commands/route.ts', '../api/commands/route.ts', '/outside/api/commands/route.ts']) {
    const scope = query === 'commands/route.ts' ? [...files, {path:'apps/native/api/commands/route.ts'}] : files;
    assert.deepEqual(mentionedFiles('/repo', query, scope), [], query);
  }
  await fixture({
    [files[0].path]: 'export async function POST(request) { return dispatch(request); }\n',
    [files[1].path]: 'export const GET = () => null;\n',
  }, async root => {
    for (const connected of [false, true]) {
      const text = await getContext({rootDir:root, query:'api/commands/route.ts', maxTokens:512, connected, retrievalPreset:'keyword_only'});
      assert.match(text, /return dispatch\(request\)/);
      assert.ok(Buffer.byteLength(text) <= 2048);
    }
  });
});

it('retains object-property values for exact identifiers despite incidental callers', async () => {
  await fixture({
    'src/ui.tsx': 'export function Screen() { return messages.uploadFinalizationFailed; }\n',
    'src/lib/messages.ts': `export const messages = {\n${`  unrelated: "${'x'.repeat(400)}",\n`.repeat(100)}  uploadFinalizationFailed: "Upload finalization failed; please retry.",\n${`  unrelated: "${'x'.repeat(400)}",\n`.repeat(50)}};\n`,
  }, async root => {
    const text = await getContext({rootDir:root, query:'uploadFinalizationFailed', maxTokens:1700, connected:false});
    assert.match(text, /Upload finalization failed; please retry/);
    assert.ok(Buffer.byteLength(text) <= 6800);
  });
});

it('admits command schema evidence beyond the first literal caller', async () => {
  await fixture({
    ...Object.fromEntries(Array.from({length:6}, (_,i)=>[`client-${i}.ts`, 'export function upload() { return cmd("upload.begin", {filename:"file"}); }\n'])),
    ...Object.fromEntries(Array.from({length:14}, (_,i)=>[`noise-${i}.ts`, 'export const label = "z.string filename schema validation";\n'])),
    'services/application.ts': `export const commands = {\n${'  unrelated: {},\n'.repeat(500)}  "upload.begin": schema({filename: string().max(255)}),\n};\n`,
  }, async root => {
    const text = await getContext({rootDir:root, query:'upload.begin filename schema z.string validation', maxTokens:1500, connected:false, retrievalPreset:'keyword_only'});
    assert.match(text, /"upload.begin": schema\(\{filename: string\(\).max\(255\)\}\)/);
    assert.ok(Buffer.byteLength(text) <= 6000);
  });
});

it('limits source-query report penalties to report paths, preserving data-backed implementations', async () => {
  const query = 'theme route implementation';
  for (const path of ['config.json', 'content/theme.md', 'data/routes.csv', 'data/events.jsonl', 'src/report-config.json', 'docs/architecture.md']) {
    assert.equal(discoveryPathWeight(query, path), 1, path);
  }
  for (const path of ['reports/run.json', 'docs/benchmarks/run.md', 'benchmark-results/run.csv', 'coverage/summary.json']) {
    assert.ok(discoveryPathWeight(query, path) < 1, path);
    assert.equal(discoveryPathWeight(`${query} reports`, path), 1, path);
    assert.equal(discoveryPathWeight(`${query} ${path}`, path), 1, path);
  }
  await fixture({
    'config.json': '{"theme":"dark","route":"/home","implementation":"declarative"}',
    'src/logger.ts': 'export const message = "theme route";\n',
    'reports/run.json': '{"summary":"theme route implementation"}',
  }, async root => {
    const result = await unifiedSearchData({ rootDir: root, query, mode: 'file', preset: 'keyword_only', topK: 1 });
    assert.equal(result.files.results[0].path, 'config.json', JSON.stringify(result.files));
    for (const connected of [false, true]) {
      const text = await getContext({ rootDir: root, query, maxTokens: 512, connected });
      assert.match(text, /config.json:/);
      assert.match(text, /"implementation":"declarative"/);
      assert.ok(Buffer.byteLength(text) <= 2048);
    }
  });
});

it('keeps locale copies and test variables from crowding out implementation evidence', async () => {
  const terms = 'subscription Pro feature limits pricing paywall home progress insights';
  await fixture({
    ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`locales/language-${i}.json`, JSON.stringify({ title: terms, copy: `${terms} ${terms}` })])),
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`tests/entitlement${i}.test.ts`, `const pro = true;\nexport const fixture = "${terms}";\n`])),
    'src/entitlements.ts': 'export function entitled(subscription: boolean, feature: string) {\n  const limits = subscription ? 100 : 3;\n  return { feature, limits };\n}\n',
    'src/paywall.ts': 'export function paywall(pricing: number) { return { pricing, subscription: true }; }\n',
  }, async root => {
    const result = await unifiedSearchData({rootDir:root,query:terms,mode:'file',preset:'keyword_only',topK:2,inlineCode:'off'});
    assert.ok(result.files.results.some(item => item.path === 'src/entitlements.ts'), JSON.stringify(result.files));
    const text = await getContext({rootDir:root,query:terms,maxTokens:1000});
    assert.match(text, /subscription \? 100 : 3/);
    const locales = await unifiedSearchData({rootDir:root,query:`translations copy ${terms}`,mode:'file',preset:'keyword_only',topK:2});
    assert.ok(locales.files.results.some(item => item.path.startsWith('locales/')));
    const tests = await unifiedSearchData({rootDir:root,query:'tests pro fixture entitlement',mode:'file',preset:'keyword_only',topK:2});
    assert.ok(tests.files.results.some(item => item.path.startsWith('tests/')));
  });
});

it('preserves quoted command evidence within prose instead of generic schema boilerplate', async () => {
  await fixture({
    ...Object.fromEntries(Array.from({length:14},(_,i)=>[`src/noise-${i}.ts`, 'export const schema = z.object({ document: z.object({content: z.string(), apply: z.boolean()}) });\n'])),
    'src/application.ts': '// unrelated preamble\n'.repeat(250) + 'export const applyCommand = z.object({\n  action: z.literal("document.content.apply"),\n  documentId: z.string(),\n});\n',
    'tests/apply.test.ts': 'export const input = { action: "document.content.apply" };\n',
  }, async root => {
    const query = '"document.content.apply" schema z.object';
    const results = await unifiedSearchData({rootDir:root,query,mode:'file',preset:'keyword_only',topK:1});
    assert.equal(results.files.results[0].path,'src/application.ts');
    const text = await getContext({rootDir:root,query,maxTokens:512});
    assert.match(text, /action: z.literal\("document.content.apply"\)/);
    assert.ok(Buffer.byteLength(text) <= 2048);
    const db = await getDB(root);
    assert.deepEqual(db.searchFileText('document.never.present',10,true), []);
  });
});

it('keeps camelCase usage evidence ahead of prose lookalikes and same-name test helpers', async () => {
  const query = 'native gallery personal photos listOwnMedia revealed own album photo privacy';
  await fixture({
    'apps/native/gallery.tsx': 'export function Gallery() {\n  const photos = api.listOwnMedia();\n  return { photos, privacy: "personal", revealed: true, album: "own" };\n}\n',
    'packages/api/client.ts': 'export function listOwnMedia() { return request("media"); }\n',
    'apps/native/tests/queue.test.ts': 'export function listOwnMedia() { return []; }\n// native gallery personal photos revealed own album photo privacy\n',
    'design/prototype.html': '<p>native gallery personal photos list own media revealed own album photo privacy</p>\n',
  }, async root => {
    const results = await unifiedSearchData({ rootDir: root, query, mode: 'file', preset: 'keyword_only', topK: 4 });
    assert.equal(results.files.results[0].path, 'apps/native/gallery.tsx', JSON.stringify(results.files));
    const text = await getContext({ rootDir: root, query, maxTokens: 512 });
    assert.match(text, /apps\/native\/gallery.tsx:/);
    assert.match(text, /api.listOwnMedia\(\)/);
    const testSource = text.search(/apps\/native\/tests\/queue.test.ts:\d/);
    assert.ok(testSource < 0 || text.indexOf('apps/native/gallery.tsx:') < testSource, text);
    assert.ok(Buffer.byteLength(text) <= 2048);
    const tests = await unifiedSearchData({ rootDir: root, query: 'tests listOwnMedia', mode: 'file', preset: 'keyword_only', topK: 1 });
    assert.equal(tests.files.results[0].path, 'apps/native/tests/queue.test.ts');
  });
});

it('includes SQL mutation source in compound-key discovery and refreshes it after edits', async () => {
  await fixture({
    'src/application.ts': 'export const action = "document.text.repair";\n',
    ...Object.fromEntries(Array.from({length:8},(_,i)=>[`apps/client-${i}.ts`, 'export const action = "document.text.repair";\n'])),
    'migrations/repair.sql': '-- Schema\n'.repeat(60) + 'create table document_text_repairs (id uuid);\ninsert into document_text_repairs(id) values (gen_random_uuid());\n',
    'tests/repair.test.ts': 'export const input = "document.text.repair document_text_repairs";\n',
  }, async root => {
    const query = '"document.text.repair" document_text_repairs';
    const text = await getContext({rootDir:root,query,maxTokens:1200});
    assert.match(text, /src\/application.ts:/);
    assert.match(text, /migrations\/repair.sql:/);
    assert.match(text, /insert into document_text_repairs/);
    const db = await getDB(root);
    assert.equal(db.getFile('migrations/repair.sql').language, 'sql');
    assert.deepEqual(db.getSymbolsByFile(db.getFile('migrations/repair.sql').id), []);
    await writeFile(join(root, 'migrations/repair.sql'), 'select * from archived_document_repairs;\n');
    await getContext({rootDir:root,query:'document_text_repairs',maxTokens:512});
    assert.ok(!db.searchFileText('document_text_repairs',10,true).some(item => item.path === 'migrations/repair.sql'));
  });
});

it('preserves matching tails beyond an overlapping document introduction', async () => {
  const source = ['# Project readiness', ...Array.from({length:24}, (_, i) => `Introduction ${i}`),
    'The "launch.approved" check requires signoff.', ...Array.from({length:50}, (_, i) => `Detail ${i}`)].join('\n');
  await fixture({'docs/READINESS.md': source}, async root => {
    const text = await getContext({rootDir:root, query:'Project readiness "launch.approved"', maxTokens:1200});
    assert.match(text, /The "launch.approved" check requires signoff/);
    assert.equal(text.split('The "launch.approved"').length, 2, 'overlap must not duplicate source');
    assert.ok(Buffer.byteLength(text) <= 4800);
    for (const match of text.matchAll(/docs\/READINESS.md:(\d+)-(\d+)\n([^]*?)(?=\n\n|$)/g)) {
      assert.equal(match[3], source.split('\n').slice(+match[1]-1, +match[2]).join('\n'));
    }
  });
});

it('orients lexical-only repositories using the entry point, central modules, and their dependencies', async () => {
  await fixture({
    'package.json': '{"scripts":{"build":"tsc","test":"node --test"}}',
    'README.md': '# Example\nDocumentation for this repository.\n',
    'src/index.ts': 'import { client } from "./client.js";\nimport { app } from "./app.js";\nimport { queue } from "./queue.js";\napp(client, queue);\n',
    'src/app.ts': 'import { client } from "./client.js";\nimport { lifecycle } from "./lifecycle.js";\nimport { prompt } from "./prompts.js";\nimport { queue } from "./queue.js";\nexport const app = () => client();\n',
    'src/queue.ts': 'export const queue = () => "pending jobs";\n',
    'src/client.ts': 'import { lifecycle } from "./lifecycle.js";\nexport const client = () => lifecycle();\n',
    'src/lifecycle.ts': 'export const lifecycle = () => "running";\n',
    'src/prompts.ts': 'export const prompt = "Orient repository package scripts MCP tool implementation SDK integration tests documentation";\n',
    ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/tools/tool${i}.ts`, 'import { client } from "../client.js";\nexport const run = () => client();\n'])),
    'tests/client.test.ts': 'import { client } from "../src/client.js";\nclient();\n',
  }, async root => {
    for (const query of [
      'Orient repository: package scripts, MCP tool implementation, SDK integration, tests and documentation',
      'Repository overview purpose README package.json architecture MCP tools server tests CI documentation roadmap',
      'Repository overview: read package.json and explain the architecture and tests',
    ]) {
      const text = await getContext({ rootDir: root, query, maxTokens: 2000 });
      for (const path of ['package.json', 'README.md', 'src/index.ts', 'src/client.ts', 'src/lifecycle.ts', 'src/app.ts', 'src/queue.ts', 'tests/client.test.ts']) assert.ok(text.includes(`${path}:`), text);
      assert.ok(Buffer.byteLength(text) <= 8000);
      assert.match(text, /lexical fallback/);
    }
    const exact = await getContext({ rootDir: root, query: 'Repository overview', targets: [{file:'package.json'}], maxTokens:512 });
    assert.match(exact, /package.json:/);
    assert.doesNotMatch(exact, /README.md:|src\/index.ts:/);
    await writeFile(join(root, '.gitignore'), 'README.md\n');
    const ignored = await getContext({ rootDir: root, query: 'Repository overview', maxTokens: 2000 });
    assert.doesNotMatch(ignored, /README.md:/);
  });
});

it('reads explicitly named files before unrelated matches and preserves their full contents when they fit', async () => {
  const files = Object.fromEntries(['src/client.ts', 'src/tools/events.ts', 'tests/client.test.ts'].map((path, i) => [path,
    `export function implementation${i}() {\n${Array.from({length:70}, (_, j) => `  const step${j} = ${j};`).join('\n')}\n  return "end-${i}";\n}\n`]));
  await fixture({ ...files, 'src/noise.ts': 'export const keywords = "request retries event stream";\n' }, async root => {
    const text = await getContext({ rootDir: root, query: 'Read src/client.ts and src/tools/events.ts plus tests/client.test.ts relevant request retries event stream', maxTokens: 4000 });
    for (const source of Object.values(files)) assert.ok(text.includes(source.trimEnd()), text);
    assert.doesNotMatch(text, /src\/noise.ts:/);
    assert.ok(text.indexOf('src/client.ts:') < text.indexOf('tests/client.test.ts:'));
    assert.ok(Buffer.byteLength(text) <= 16000);
    const narrow = await getContext({ rootDir: root, query: 'Read src/client.ts and src/tools/events.ts plus tests/client.test.ts relevant request retries event stream', maxTokens: 512 });
    assert.ok(Buffer.byteLength(narrow) <= 2048);
    assert.match(narrow, /[Oo]mitted/);
  });
});

it('keeps release lookup focused on source but allows explicit lockfile inspection', async () => {
  await fixture({
    'package.json': '{"version":"1.11.0","name":"server"}',
    'src/index.ts': 'export const server = {version: "1.11.0"};\n',
    'package-lock.json': JSON.stringify({ version: '1.11.0', packages: Object.fromEntries(Array.from({length:100}, (_, i) => [`node_modules/server-release-${i}`, {version:'1.11.0'}])) }, null, 2),
  }, async root => {
    const text = await getContext({ rootDir: root, query: 'version 1.11.0 server package release', maxTokens: 3500 });
    assert.match(text, /package.json:/);
    assert.match(text, /src\/index.ts:/);
    assert.doesNotMatch(text, /package-lock.json:/);
    const locks = await getContext({ rootDir: root, targets: [{file:'package-lock.json', start:1, end:5}], maxTokens:512 });
    assert.match(locks, /package-lock.json:1-5/);
    const ranked = await unifiedSearchData({ rootDir: root, query: 'package-lock.json version 1.11.0', mode:'file', preset:'keyword_only', topK:3 });
    assert.ok(ranked.files.results.some(file => file.path === 'package-lock.json'));
  });
});

it('retains lockfile matches when they are the only evidence', async () => {
  await fixture({'package-lock.json': '{"name":"unique-release-marker"}'}, async root => {
    const text = await getContext({rootDir:root, query:'unique-release-marker', maxTokens:512});
    assert.match(text, /package-lock.json:/);
    assert.match(text, /unique-release-marker/);
  });
});

it('describes empty vectors truthfully after automatic structural discovery and exposes runtime identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-status-vectors-'));
  try {
    await writeFile(join(root, 'api.ts'), 'export const ready = true;\n');
    await getContext({ rootDir:root, query:'ready', maxTokens:512 });
    const status = await getStatusData({ rootDir:root });
    assert.equal(status.index.state, 'fresh');
    assert.equal(status.embeddings.fileSearch, 0);
    assert.match(status.warnings.join('\n'), /Search does not generate corpus embeddings/);
    assert.doesNotMatch(status.warnings.join('\n'), /populate lazily/);
    assert.equal(status.runtime.pid, process.pid);
    assert.ok(status.runtime.serverVersion);
    assert.ok(status.runtime.buildStamp);
  } finally { closeDB(root); await rm(root, {recursive:true, force:true}); }
});

it('discovers project status and readiness documents outside the structural index', async () => {
  await fixture({
    'package.json': '{"name":"sample"}',
    'README.md': '# Sample\nProject overview.\n',
    'docs/AGENT_BRIEF.md': '# Shared agent brief\n## Project status\nThe next step is browser validation.\n',
    'docs/LAUNCH_READINESS.md': '# Launch readiness\n## Current launch status\nExternal signoff is still pending.\n',
    'docs/protocol.md': '# Wire protocol\nUnrelated message format.\n',
    'src/prompt.ts': 'export const prompt = "Project status README roadmap next steps blockers package.json architecture tests recent handoff launch readiness QA reports product scope";\n',
  }, async root => {
    const status = await getContext({rootDir:root, query:'Project status README roadmap next steps blockers package.json architecture tests recent handoff', maxTokens:1500});
    assert.match(status, /docs\/AGENT_BRIEF.md:/);
    assert.match(status, /next step is browser validation/);
    assert.match(status, /README.md:/);
    const readiness = await getContext({rootDir:root, query:'Find project instructions and current launch readiness, blockers, QA reports, roadmap and product scope', maxTokens:1500});
    assert.match(readiness, /docs\/LAUNCH_READINESS.md:/);
    assert.match(readiness, /External signoff is still pending/);
    assert.ok(readiness.indexOf('docs/LAUNCH_READINESS.md:') < readiness.indexOf('src/prompt.ts:'));
    assert.ok(Buffer.byteLength(readiness) <= 6000);
    const named = await getContext({rootDir:root, query:'Read docs/protocol.md', maxTokens:512});
    assert.match(named, /Unrelated message format/);
    assert.doesNotMatch(named, /src\/prompt.ts:/);
    await writeFile(join(root, 'docs/.gitignore'), 'LAUNCH_READINESS.md\n');
    await writeFile(join(root, '.contextproignore'), 'docs/AGENT_BRIEF.md\n');
    await symlink(join(root,'README.md'), join(root,'docs/READINESS.md'));
    const ignored = await getContext({rootDir:root, query:'Project status readiness roadmap handoff', maxTokens:1500});
    assert.doesNotMatch(ignored, /docs\/(?:AGENT_BRIEF|LAUNCH_READINESS|READINESS).md:/);
  });
});

it('finds topic documentation when a query asks where it is documented', async () => {
  await fixture({
    'docs/IMPLEMENTATION_STATUS.md': '# Acquisition preparation status\nThe opportunity tracker is ready for review.\n',
    'docs/review.md': '# Acquisition review evidence\nTracker review passed.\n',
    'src/replies.ts': 'export const prompt = "acquisition preparation opportunity tracker status current paragraph review evidence";\n',
  }, async root => {
    const query = 'Where is acquisition preparation and opportunity tracker status documented? Need current acquisition status paragraph and review evidence.';
    for (const connected of [false, true]) {
      const text = await getContext({rootDir:root,query,maxTokens:2200,connected,retrievalPreset:'keyword_only'});
      assert.match(text, /docs\/IMPLEMENTATION_STATUS.md:/);
      assert.match(text, /The opportunity tracker is ready for review/);
      assert.match(text, /Tracker review passed/);
      assert.ok(Buffer.byteLength(text) <= 8800);
      const semantic = await getContext({rootDir:root,query,maxTokens:2200,connected,retrievalPreset:'semantic_only'});
      assert.doesNotMatch(semantic, /docs\/IMPLEMENTATION_STATUS.md:/);
    }
    assert.equal(wantsDocuments('Find document update handler'), false);
    assert.equal(wantsDocuments('Find documentedState in src/replies.ts'), false);
  });
});


it('orients web UI queries to routes, navigation, styles and feature components in both selectors', async () => {
  await fixture({
    'apps/web/src/app/page.tsx': 'import { Dashboard } from "../components/dashboard";\nexport default function Page() { return <Dashboard />; }\n',
    'apps/web/src/app/layout.tsx': 'import "./globals.css";\nexport default function Layout({children}) { return <main>{children}</main>; }\n',
    'apps/web/src/app/globals.css': ':root { --accent: blue; }\n',
    'apps/web/src/components/dashboard.tsx': 'import { Navigation } from "./navigation";\nimport { Billing } from "./billing";\nimport { Team } from "./team";\nexport function Dashboard() { return <><Navigation /><Billing /><Team /></>; }\n',
    'apps/web/src/components/navigation.tsx': 'export function Navigation() { return <nav>Home Team Billing</nav>; }\n',
    'apps/web/src/components/billing.tsx': 'export function Billing() { return <section>Subscription</section>; }\n',
    'apps/web/src/components/team.tsx': 'export function Team() { return <section>Members</section>; }\n',
    'docs/product.md': '# Product journey\nChoose a workspace before inviting members.\n',
    'python/orientation.py': '# Orient user facing web app main routes screens shared layout navigation design tokens styles key UI components product docs primary user journey audit\ndef orient():\n    return "PDF pages"\n',
  }, async root => {
    const query = 'Orient me to the user-facing web app: main routes/screens, shared layout/navigation, design tokens/styles, key UI components, and product docs. Identify primary user journey and files to inspect for a UI audit.';
    for (const connected of [false, true]) {
      const text = await getContext({rootDir:root, query, maxTokens:2500, connected});
      for (const file of ['app/page.tsx', 'app/layout.tsx', 'app/globals.css', 'components/dashboard.tsx', 'components/navigation.tsx', 'docs/product.md']) assert.ok(text.includes(file+':'), text);
      assert.match(text, /<nav>Home Team Billing/);
      assert.doesNotMatch(text, /Discovery index has freshness warnings/);
      assert.ok(Buffer.byteLength(text) <= 10000);
    }
    const targeted = await getContext({rootDir:root,query:'Find product UI surfaces for team and billing. Identify navigation decisions.',maxTokens:1600});
    for (const file of ['team.tsx', 'billing.tsx', 'navigation.tsx']) assert.ok(targeted.includes(file+':'),targeted);
    const semantic = await getContext({rootDir:root,query,maxTokens:1600,connected:true,retrievalPreset:'semantic_only'});
    assert.doesNotMatch(semantic,/^.+:\d+-\d+$/m, 'semantic-only must not add lexical orientation evidence');
    const pdf = await getContext({rootDir:root,query:'orient',maxTokens:512});
    assert.match(pdf,/python\/orientation.py:/);
    assert.doesNotMatch(pdf,/app\/layout.tsx:/);
  });
});

it('bounds document previews and retains late query topics alongside document evidence', async () => {
  await fixture({
    'docs/security.md': '# Security documentation\n'+('| Threat model privacy notice terms GDPR DSAR export deletion retention | '+ 'details '.repeat(180)+'|\n').repeat(25),
    'docs/operations.md': '# Operations\n## Retention\nPurge archived objects after the configured period.\n',
    'src/headers.ts': 'export const headers = {"Content-Security-Policy":"default-src none"};\n',
    'src/rate-limits.ts': 'export function rateLimits(count) { if (count > 10) throw new Error("rate limits"); }\n',
    'src/auth.ts': 'export function csrf(origin) { if (origin !== "trusted") throw new Error("CSRF"); }\n',
    'src/decoy.ts': 'export const text = "Find security compliance documentation threat model privacy notice terms GDPR DSAR export";\n',
  }, async root => {
    const query = 'Find security and compliance documentation: threat model, privacy notice, terms, GDPR DSAR/export/deletion/retention, AI usage disclosures, security headers, content security policy, rate limits, auth and CSRF. Return main files and exact source ranges.';
    for (const connected of [false, true]) {
      const text = await getContext({rootDir:root,query,maxTokens:2500,connected});
      for (const file of ['docs/security.md','src/headers.ts','src/rate-limits.ts','src/auth.ts']) assert.ok(text.includes(file+':'),text);
      assert.match(text,/Content-Security-Policy/);
      assert.match(text,/count > 10/);
      assert.match(text,/origin !== "trusted"/);
      assert.ok(Buffer.byteLength(text)<=10000);
    }
  });
});


it('keeps documentation budgets when source ranges describe the output format', async () => {
  const source = '# Compliance documentation\n' + Array.from({length:60},(_,i)=>
    `Retention requirement ${i}: archive records according to the retention schedule.`).join('\n');
  await fixture({'docs/compliance.md':source}, async root => {
    for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Find compliance documentation about retention; return exact source ranges',maxTokens:2000,connected});
      assert.match(text,/Retention requirement 59:/);
      assert.ok(Buffer.byteLength(text)<=8000);
    }
  });
});

it('does not cap documentation merely because its subject is authentication or frontend', async () => {
  const source='# Authentication frontend documentation\n'+Array.from({length:60},(_,i)=>
    `Authentication frontend requirement ${i}: document access and rendering behavior.`).join('\n');
  await fixture({'docs/authentication-frontend.md':source}, async root=>{
    for (const query of ['Find authentication documentation','Review frontend documentation']) for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:2000,connected});
      assert.match(text,/Authentication frontend requirement 59:/);
      assert.ok(Buffer.byteLength(text)<=8000);
    }
  });
});

it('prefers substantive topic evidence over an early setup declaration', async () => {
  await fixture({
    'docs/security.md':'# Security documentation\nReview current authentication behavior.\n',
    'src/auth.ts':'export function authClient() { return createClient(); }\n'+'\n'.repeat(45)+
      'export function authState() {\n  const client = authClient();\n  const session = client.auth.getSession();\n  if (!session) return null;\n'+
      Array.from({length:40},(_,i)=>`  const detail${i} = "Long diagnostic detail for a later unrelated validation step in the function";`).join('\n')+'\n  return session;\n}\n',
  },async root=>{
    for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Find security documentation and auth; return exact source ranges',maxTokens:512,connected});
      assert.match(text,/function authState/);
      assert.match(text,/if \(!session\) return null/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('does not substitute partial filename or OR matches for a requested document topic', async () => {
  await fixture({
    'src/proxy.ts':'export const headers = {"Content-Security-Policy":"default-src none"};\n',
    'src/security.ts':'export const scan = "security";\n',
    'src/model.ts':'export const model = "local";\n',
  }, async root => {
    const db = await getDB(root);
    assert.deepEqual(db.searchFileText('threat model',32,false,true),[]);
    assert.deepEqual(db.searchFileText('security '.repeat(12) + 'missingconstraint',32,false,true),[]);
    assert.ok(db.searchFileText('threat model',32).some(hit=>hit.path==='src/model.ts'));
    const topics = documentTopicFiles(db,'Find documentation: threat model, content security policy');
    assert.deepEqual(topics.map(item=>item.file),['src/proxy.ts']);
  });
});


it('includes plain TS/JS UI modules and excludes backend routing from UI orientation', async () => {
  const cases = [
    {'src/app/app.component.ts': 'import { Component } from "@angular/core";\nimport { routes } from "./app.routes";\nexport const component = {template:"<main>Workspace</main>", routes};\n',
     'src/app/app.routes.ts':'import { Routes } from "@angular/router";\nexport const routes: Routes = [{path:"home",component:"Home"}];\n'},
    {'src/widgets/panel.ts':'import { LitElement, html } from "lit";\nexport class Panel extends LitElement { render() { return html`<nav>Home</nav>`; } }\n'},
    {'src/route-config.ts':'import { createBrowserRouter } from "react-router-dom";\nexport const router = createBrowserRouter([{path:"/settings",element:"Settings"}]);\n'},
    {'client/router.js':'export const routes = [{path:"/settings", element:"Settings"}];\n',
     'client/navigation.js':'import { routes } from "./router.js";\nexport const navigation = routes;\n'},
  ];
  for (const source of cases) await fixture({
    ...source,
    'src/styles.css': ':root { --accent: blue; }\n',
    'server/router.ts': 'export const routes = ["user-facing web app overview navigation routes components styles"];\n',
    'apps/web/src/app/api/route.ts': 'export const GET = () => "routes";\n',
  }, async root => {
    const query = 'Overview of the frontend UI routes, navigation, components and styles';
    const db = await getDB(root);
    const selected = orientationFiles(db,db.getAllFiles(),query);
    for (const file of Object.keys(source)) assert.ok(selected.includes(file),JSON.stringify(selected));
    assert.ok(!selected.includes('server/router.ts'));
    assert.ok(!selected.includes('apps/web/src/app/api/route.ts'));
    for (const connected of [false,true]) {
      const text = await getContext({rootDir:root,query,maxTokens:2000,connected});
      for (const file of Object.keys(source)) assert.ok(text.includes(file+':'),text);
      assert.ok(Buffer.byteLength(text)<=8000);
    }
  });
});

it('keeps narrow UI fixes and whole-file requests out of broad orientation', async () => {
  for (const query of ['fix frontend navigation active state','audit UI routes authorization','Read client/navigation.ts for frontend navigation active state','fix frontend map rendering','debug UI survey submission','fix items.map in the frontend']) assert.equal(isUiOrientationQuery(query),false,query);
  for (const query of ['Overview of frontend routes','Orient me to the user-facing web app','Map the frontend routes and components','Survey the UI structure','Find product UI surfaces for team and billing. Identify navigation decisions.']) assert.equal(isUiOrientationQuery(query),true,query);
  const source='export function activeState(current, target) {\n  return current === target;\n}\n';
  await fixture({
    'client/navigation.ts':source,
    ...Object.fromEntries(Array.from({length:12},(_,i)=>[`src/components/view${i}.tsx`,'export const Page = () => <main>Frontend navigation routes styles audit</main>;\n'])),
  },async root=>{
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Read client/navigation.ts for frontend navigation active state',maxTokens:512,connected});
      assert.ok(text.includes(source.trimEnd()),text);
      assert.doesNotMatch(text,/src\/components\/view/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('selects fallback stylesheets from the selected UI application', async () => {
  await fixture({
    'apps/product/src/app.tsx': 'import { Page } from "./pages/home";\nexport const App = () => <Page/>;\n',
    'apps/product/src/pages/home.tsx': 'export const Page = () => <main>Home</main>;\n',
    'apps/product/src/styles.css': ':root { --accent: blue; }\n',
    'apps/admin/styles.css': ':root { --admin-only: red; }\n',
    'apps/product/src/tests/styles.css': ':root { --test-only: red; }\n',
    'apps/product/src/server/styles.css': ':root { --server-only: red; }\n',
    'apps/product/src/backend/styles.css': ':root { --backend-only: red; }\n',
  }, async root => {
    const query='Overview of the frontend UI routes and styles';
    const db=await getDB(root);
    const selected=orientationFiles(db,db.getAllFiles(),query);
    assert.ok(selected.includes('apps/product/src/styles.css'),JSON.stringify(selected));
    for (const wrong of ['apps/admin/styles.css','apps/product/src/tests/styles.css','apps/product/src/server/styles.css','apps/product/src/backend/styles.css']) assert.ok(!selected.includes(wrong),JSON.stringify(selected));
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:512,connected});
      assert.match(text,/apps\/product\/src\/styles.css:/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('requires document intent around docs identifiers', async () => {
  for(const query of ['fix frontend docs rendering','debug docs.map in the UI','Read src/docs.ts']) assert.equal(wantsDocuments(query),false,query);
  for(const query of ['Read the docs','Find product docs','Find product docs. Identify gaps.','Overview of the frontend UI and product docs','docs about deployment','Read docs/setup.md']) assert.equal(wantsDocuments(query),true,query);
  await fixture({
    'src/docs.ts':'export function renderDocs(docs) { return docs.map(item => item.title); }\n',
    ...Object.fromEntries(Array.from({length:6},(_,i)=>[`docs/frontend-${i}.md`,'# Frontend docs rendering\n'+('Frontend rendering guidelines.\n'.repeat(30))])),
  },async root=>{
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'fix frontend docs rendering renderDocs',maxTokens:512,connected});
      assert.match(text,/return docs.map/);
      assert.doesNotMatch(text,/Document discovery uses/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('retains routes and layouts when an overview requests many features', async () => {
  const topics=['discovery','offers','evidence','team','settings','billing','reports','profile','alerts','activity'];
  await fixture({
    'src/app/layout.tsx':'export default function Layout({children}) { return <main>{children}</main>; }\n',
    'src/app/page.tsx':'export default function Page() { return <article>Entry</article>; }\n',
    'src/components/navigation.tsx':'export const Navigation = () => <nav>Home</nav>;\n',
    'src/components/sidebar.tsx':'export const Sidebar = () => <aside>Home</aside>;\n',
    ...Object.fromEntries(topics.map(topic=>[`src/components/${topic}.tsx`,`export const Screen = () => <section>${topic}</section>;\n`])),
  },async root=>{
    const query=`Overview of frontend routes, layout, navigation and ${topics.join(', ')}`;
    const db=await getDB(root),selected=orientationFiles(db,db.getAllFiles(),query);
    for(const file of ['src/app/layout.tsx','src/app/page.tsx']) assert.ok(selected.includes(file),JSON.stringify(selected));
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:512,connected});
      for(const file of ['src/app/layout.tsx','src/app/page.tsx']) assert.ok(text.includes(file+':'),text);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('scopes UI structural candidates to the app named in a monorepo query', async () => {
  const sources = {
    'apps/admin/app/layout.tsx':'export default function Layout({children}) { return <main>Admin {children}</main>; }\n',
    'apps/admin/app/page.tsx':'import { Nav } from "../navigation";\nexport default function Page() { return <Nav/>; }\n',
    'apps/admin/navigation.tsx':'export const Nav = () => <nav>Admin</nav>;\n',
    'apps/admin/styles.css':':root { --admin: red; }\n',
    'apps/product/src/app/layout.tsx':'export default function Layout({children}) { return <main>Product {children}</main>; }\n',
    'apps/product/src/app/page.tsx':'export default function Page() { return <article>Product home</article>; }\n',
    'apps/product/src/styles.css':':root { --product: blue; }\n',
    'packages/ui/layout.tsx':'export default function Shared({children}) { return <div>{children}</div>; }\n',
  };
  for (const [container,otherContainer] of [['apps','apps'],['packages','packages'],['packages','apps']]) await fixture(
    Object.fromEntries(Object.entries(sources).map(([path,source])=>[path.replace(/^apps\//,(path.startsWith('apps/product/') ? container : otherContainer)+'/'),source])),async root=>{
    const db=await getDB(root),files=db.getAllFiles();
    for(const query of ['Overview of the product frontend UI routes and layout',`Overview of ${container}/product frontend UI routes, layout and styles`]) {
      const selected=orientationFiles(db,files,query);
      assert.ok(selected.includes(`${container}/product/src/app/layout.tsx`),JSON.stringify(selected));
      assert.ok(selected.includes(`${container}/product/src/app/page.tsx`),JSON.stringify(selected));
      assert.ok(selected.every(path=>path.startsWith(`${container}/product/`)),JSON.stringify(selected));
      for(const connected of [false,true]) {
        const text=await getContext({rootDir:root,query,maxTokens:512,connected});
        for(const file of ['layout','page']) assert.ok(text.includes(`${container}/product/src/app/${file}.tsx:`),text);
        assert.ok(Buffer.byteLength(text)<=2048);
      }
    }
    const broad=orientationFiles(db,files,'Overview of frontend UI routes and layout');
    assert.ok(broad.some(path=>path.startsWith(`${otherContainer}/admin/`)),JSON.stringify(broad));
    const admin=orientationFiles(db,files,'Overview of admin frontend UI routes and layout');
    assert.ok(admin.includes(`${otherContainer}/admin/app/layout.tsx`),JSON.stringify(admin));
    assert.ok(admin.every(path=>path.startsWith(`${otherContainer}/admin/`)),JSON.stringify(admin));
    const shared=orientationFiles(db,files,'Overview of packages/ui frontend UI layout');
    assert.deepEqual(shared,['packages/ui/layout.tsx']);
  });
});

it('excludes backend renderers before selecting structural UI layouts', async () => {
  for (const path of ['server/layout.tsx','backend/layout.tsx','api/layout.jsx','services/layout.vue','workers/layout.svelte','layout.server.tsx']) await fixture({
    [`apps/product/${path}`]:path.endsWith('.vue') ? '<template><aside><slot /></aside></template>\n' : path.endsWith('.svelte') ? '<aside><slot /></aside>\n' : 'export default function EmailLayout({children}) { return <aside>{children}</aside>; }\n',
    'apps/product/src/app/layout.tsx':'export default function ProductLayout({children}) { return <main>{children}</main>; }\n',
    'apps/product/src/app/page.tsx':'export default function ProductPage() { return <section>Product</section>; }\n',
  }, async root=>{
    const db=await getDB(root),query='Overview of the product frontend UI routes and layout';
    const selected=orientationFiles(db,db.getAllFiles(),query);
    assert.ok(selected.includes('apps/product/src/app/layout.tsx'),JSON.stringify(selected));
    assert.ok(!selected.includes(`apps/product/${path}`),JSON.stringify(selected));
    for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:512,connected});
      assert.match(text,/apps\/product\/src\/app\/layout.tsx:/);
      assert.match(text,/apps\/product\/src\/app\/page.tsx:/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('retains reasonably sized first lines in minimum-budget priority previews', async () => {
  const layout='export default function 布局({children}) { return <main aria-label="'+'本地化标题'.repeat(8)+'">{children}</main>; }\n';
  await fixture({
    'apps/product/src/app/layout.tsx':layout,
    'apps/product/src/app/page.tsx':'export default function 页面() { return <section>产品</section>; }\n',
    ...Object.fromEntries(['a','b','c','d'].map(name=>[`apps/product/src/components/${name}.tsx`,'export const 组件 = () => <p>项目</p>;\n'])),
  },async root=>{
    for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Overview of the product frontend UI routes and layout',maxTokens:512,connected});
      assert.match(text,/apps\/product\/src\/app\/layout.tsx:1-1/);
      assert.ok(text.includes(layout.trim()),text);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
  await fixture(Object.fromEntries(Array.from({length:6},(_,i)=>[`docs/product-${i}.md`,'# '+'产品说明'.repeat(22)+'\n'])),async root=>{
    for (const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Find product docs',maxTokens:512,connected});
      assert.match(text,/docs\/product-0.md:1-1/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('does not treat a requested feature as another explicitly named application', async () => {
  await fixture({
    'apps/billing/app/layout.tsx':'export default function BillingLayout({children}) { return <aside>{children}</aside>; }\n',
    'apps/billing/app/page.tsx':'export default function BillingPage() { return <section>Invoices</section>; }\n',
    'apps/product/src/app/layout.tsx':'export default function ProductLayout({children}) { return <main>{children}</main>; }\n',
    'apps/product/src/app/page.tsx':'export default function ProductPage() { return <section>Product</section>; }\n',
    'apps/product/src/components/billing.tsx':'export function Billing() { return <p>Upgrade product subscription</p>; }\n',
  }, async root=>{
    const db=await getDB(root),files=db.getAllFiles();
    for (const query of ['Overview of the product frontend UI routes and billing','Overview of frontend UI routes and billing in the product app']) {
      const selected=orientationFiles(db,files,query);
      assert.ok(selected.every(path=>path.startsWith('apps/product/')),JSON.stringify(selected));
      assert.ok(selected.includes('apps/product/src/components/billing.tsx'));
      for (const connected of [false,true]) {
        const text=await getContext({rootDir:root,query,maxTokens:512,connected});
        assert.match(text,/apps\/product\/src\/app\/layout.tsx:/);
        assert.match(text,/apps\/product\/src\/app\/page.tsx:/);
        assert.ok(Buffer.byteLength(text)<=2048);
      }
    }
    const billing=orientationFiles(db,files,'Overview of the billing frontend UI routes and product features');
    assert.ok(billing.every(path=>path.startsWith('apps/billing/')),JSON.stringify(billing));
    const both=orientationFiles(db,files,'Overview of apps/product and apps/billing frontend UI routes');
    assert.ok(both.some(path=>path.startsWith('apps/product/')));
    assert.ok(both.some(path=>path.startsWith('apps/billing/')));
  });
});

it('does not treat unrelated top-level CSS as a single-app stylesheet', async () => {
  await fixture({
    'src/App.tsx':'export const App = () => <main>Product</main>;\n',
    'admin/styles.css':':root { --admin: red; }\n',
    'assets/global.css':':root { --product: blue; }\n',
  },async root=>{
    const query='Overview of the frontend UI styles';
    const db=await getDB(root),selected=orientationFiles(db,db.getAllFiles(),query);
    assert.ok(selected.includes('assets/global.css'),JSON.stringify(selected));
    assert.ok(!selected.includes('admin/styles.css'),JSON.stringify(selected));
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:512,connected});
      assert.match(text,/assets\/global.css:/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('keeps composing screens ahead of widely imported UI leaf utilities', async () => {
  await fixture({
    'src/components/format.ts': 'export function label(value) { return String(value); }\n',
    'src/components/shell.tsx': 'import { Composer } from "./composer";\nimport { A } from "./leaf0";\nimport { B } from "./leaf1";\nexport const Shell = () => <><Composer/><A/><B/></>;\n',
    'src/components/composer.tsx': 'import { A } from "./leaf2";\nimport { B } from "./leaf3";\nimport { C } from "./leaf4";\nexport const Composer = () => <><A/><B/><C/></>;\n',
    ...Object.fromEntries(Array.from({length:20},(_,i)=>[`src/components/leaf${i}.tsx`,'import {label} from "./format";\nexport const Item = () => <p>{label("Hello")}</p>;\n'])),
  }, async root => {
    const query='Overview of the frontend UI';
    const db=await getDB(root);
    const selected=orientationFiles(db,db.getAllFiles(),query);
    assert.ok(selected.includes('src/components/shell.tsx'),JSON.stringify(selected));
    assert.ok(selected.includes('src/components/composer.tsx'),JSON.stringify(selected));
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query,maxTokens:512,connected});
      for(const name of ['shell','composer']) assert.ok(text.includes(`src/components/${name}.tsx:`),text);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});

it('discovers hidden Maestro and GitHub workflow source while honoring exclusions', async () => {
  await fixture({
    'apps/native/.maestro/run.sh': '#!/bin/sh\n# Dedicated native iOS simulator Maestro setup\nmaestro test .maestro/flows/awards.yaml\n',
    'apps/native/.maestro/flows/awards.yaml': 'appId: example.app\n---\n- assertVisible: Awards\n',
    'apps/native/.maestro/.env': 'PRIVATE_SENTINEL=never-index\n',
    'apps/native/.maestro/.gitignore': 'artifacts/\n',
    'apps/native/.maestro/artifacts/run.txt': 'PRIVATE_SENTINEL ignored output\n',
    '.github/workflows/ci.yml': 'name: Test awards\non: push\njobs: {}\n',
    '.github/.contextproignore': 'private/\n',
    '.github/private/token.txt': 'PRIVATE_SENTINEL ignored by ContextPro\n',
    '.private/source.ts': 'export const PRIVATE_SENTINEL = true;\n',
    '.git/hooks/test.ts': 'export const PRIVATE_SENTINEL = true;\n',
    'node_modules/.maestro/private.ts': 'export const PRIVATE_SENTINEL = true;\n',
  }, async root => {
    const db=await getDB(root), paths=db.getAllFiles().map(file=>file.path);
    for(const path of ['apps/native/.maestro/run.sh','apps/native/.maestro/flows/awards.yaml','.github/workflows/ci.yml']) assert.ok(paths.includes(path),JSON.stringify(paths));
    assert.ok(!paths.some(path=>path.includes('private') || path.endsWith('.env') || path.includes('artifacts') || path.startsWith('.git/')));
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Dedicated native iOS simulator Maestro setup run.sh awards test fixtures',maxTokens:1200,connected});
      assert.match(text,/apps\/native\/\.maestro\/run.sh:/);
      assert.doesNotMatch(text,/PRIVATE_SENTINEL/);
      assert.ok(Buffer.byteLength(text)<=4800);
    }
  });
});

it('discovers public well-known association JSON while honoring exclusions', async () => {
  await fixture({
    'apps/web/public/.well-known/assetlinks.json': '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"example.app","sha256_cert_fingerprints":["CERTIFICATE_PLACEHOLDER"]}}]\n',
    'apps/web/public/.well-known/.env': 'PRIVATE_SENTINEL=never-index\n',
    'apps/web/public/.well-known/.gitignore': 'ignored.json\n',
    'apps/web/public/.well-known/ignored.json': '{"PRIVATE_SENTINEL":"gitignored"}\n',
    'apps/web/public/.well-known/.contextproignore': 'private.json\n',
    'apps/web/public/.well-known/private.json': '{"PRIVATE_SENTINEL":"contextproignored"}\n',
    '.private/.well-known/config.json': '{"PRIVATE_SENTINEL":"hidden parent"}\n',
    'node_modules/.well-known/config.json': '{"PRIVATE_SENTINEL":"dependency"}\n',
  }, async root => {
    const paths=(await getDB(root)).getAllFiles().map(file=>file.path);
    assert.deepEqual(paths,['apps/web/public/.well-known/assetlinks.json']);
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'Android assetlinks well-known signing certificate fingerprint environment configuration',maxTokens:2000,connected,retrievalPreset:'keyword_only'});
      assert.match(text,/apps\/web\/public\/\.well-known\/assetlinks\.json:\d/);
      assert.match(text,/CERTIFICATE_PLACEHOLDER/);
      assert.doesNotMatch(text,/PRIVATE_SENTINEL/);
      assert.ok(Buffer.byteLength(text)<=8000);
    }
  });
});


it('counts documents from topic search outside the heading shortlist against the mixed budget', async () => {
  const topics = ['retention','privacy','consent','erasure','backups','security','limits','sessions','billing','notices'];
  const documents = Object.fromEntries(topics.map((topic,index) => [
    `docs/${topic}.${['md','mdx','rst','txt'][index % 4]}`,
    `# ${topic} documentation\n` + Array.from({length:16},(_,line) =>
      `${topic} policy ${line}: explain the current requirement and the supporting operational procedure.`).join('\n'),
  ]));
  await fixture({
    ...documents,
    'src/quota.ts':'export function enforceQuota(used, limit) {\n  if (used >= limit) throw new Error("quota");\n  return true;\n}\n',
  },async root => {
    const query=`Find documentation and implementation: ${topics.join(', ')}; enforce quota`;
    const db=await getDB(root);
    // Seed the alternate text-search lane explicitly: default structural reindex
    // does not index these extensions. Packing must honor the cap regardless of
    // which supported candidate lane supplied a document.
    for(const [path,content] of Object.entries(documents)) db.upsertFileSearchDocument({path,content});
    const shortlist=await discoverDocuments(root,query);
    assert.equal(shortlist.files.length,6);
    const outside=documentTopicFiles(db,query).filter(item=>Object.hasOwn(documents,item.file) && !shortlist.files.includes(item.file));
    assert.ok(outside.length >= 4,JSON.stringify(outside));
    for(const connected of [false,true]) {
      const packet=await collectSourceEvidence({rootDir:root,query,maxTokens:2000,connected});
      const documentBytes=packet.ranges.filter(part=>Object.hasOwn(documents,part.file)).reduce((sum,part)=>
        sum+Buffer.byteLength(`${part.file}:${part.start}-${part.end}\n${part.text}`)+2,0);
      assert.ok(documentBytes <= 2400,`document bytes: ${documentBytes}\n${packet.text}`);
      assert.match(packet.text,/used >= limit/);
      assert.ok(Buffer.byteLength(packet.text) <= 8000);
    }
  });
});

it('does not interpret separated inventory words in failure searches as a UI overview', async () => {
  const queries=['Find the main bug in frontend UI components','Identify the key error in frontend routes','Show all failing UI components in this test'];
  for(const query of queries) assert.equal(isUiOrientationQuery(query),false,query);
  for(const query of ['Find the main frontend UI components','Identify the primary user journey in the frontend','Show all UI components','List the key frontend routes']) assert.equal(isUiOrientationQuery(query),true,query);
  await fixture({
    'src/app/layout.tsx':'export const Layout = () => <main>Frontend UI</main>;\n',
    'src/app/page.tsx':'export const Page = () => <section>Components</section>;\n',
    'src/components/widget.tsx':'export function brokenWidget(value) {\n  if (!value) throw new Error("failing widget");\n  return <p>{value}</p>;\n}\n',
  },async root => {
    for(const query of queries) for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:`${query}: brokenWidget`,maxTokens:512,connected});
      assert.doesNotMatch(text,/Orientation includes/);
      assert.match(text,/if \(!value\) throw new Error/);
      assert.ok(Buffer.byteLength(text)<=2048);
    }
  });
});
