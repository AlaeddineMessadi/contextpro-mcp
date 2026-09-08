#!/usr/bin/env python3
"""Run with: uv run --with tiktoken python scripts/tokenize-live-benchmark.py RESULT_DIR.

Exact counts for named reference tokenizers; not provider usage or GPT-6 billing.
"""
import json
import statistics
import sys
from pathlib import Path
import tiktoken

directory = Path(sys.argv[1])
raw = json.loads((directory / 'raw.json').read_text())
encodings = {name: tiktoken.get_encoding(name) for name in ('o200k_base', 'cl100k_base')}
for capture in raw['captures']:
    capture['tokens'] = {name: len(enc.encode(capture['text'], disallowed_special=())) for name, enc in encodings.items()}
    capture['requestTokens'] = {name: len(enc.encode(json.dumps(capture['request'], separators=(',', ':')), disallowed_special=())) for name, enc in encodings.items()}

summaries = {}
for variant in dict.fromkeys(row['variant'] for row in raw['rows']):
    rows = [r for r in raw['rows'] if r['variant'] == variant]
    first = [r for r in rows if r['repetition'] == 0]
    summaries[variant] = {
        'runs': len(rows), 'errors': sum(bool(r['error']) for r in rows),
        'meanRecallAt5': statistics.mean(r['recallAt5'] for r in first),
        'meanWorkingSetRecall': statistics.mean(r.get('workingSetRecall',r['recallAt5']) for r in first),
        'completeFileSets': sum(r['complete'] for r in first),
        'totalTasks': len(first),
        'firstPassMs': sum(r['latencyMs'] for r in first),
        'medianMs': statistics.median(r['latencyMs'] for r in rows),
        'totalResponseTokensFirstPass': {name: sum(raw['captures'][r['capture']]['tokens'][name] for r in first) for name in encodings},
        'totalResponseTokensAllRuns': {name: sum(raw['captures'][r['capture']]['tokens'][name] for r in rows) for name in encodings},
    }
catalogs = {}
for profile in ('full', 'workflow'):
    content = (directory / f'catalog-{profile}.json').read_text()
    catalogs[profile] = {'tools': len(json.loads(content)), 'tokens': {name: len(enc.encode(content, disallowed_special=())) for name, enc in encodings.items()}}

per_task = []
for task in raw['tasks']:
    row = {'task': task['id'], 'variants': {}}
    for variant in summaries:
        runs = [r for r in raw['rows'] if r['task'] == task['id'] and r['variant'] == variant]
        first = runs[0]
        capture = raw['captures'][first['capture']]
        row['variants'][variant] = {'recall': first['recallAt5'], 'workingSetRecall':first.get('workingSetRecall'), 'dependencies':first.get('dependencyPaths',[]), 'paths': first['paths'], 'responseTokens': capture['tokens'], 'medianMs': statistics.median(r['latencyMs'] for r in runs)}
    per_task.append(row)

summary = {
    'method': {
        'scope': 'Six hand-authored file-discovery tasks on one frozen repository; three serial counterbalanced repeats per variant. Required-file coverage, not completed coding-task correctness.',
        'baseline': 'Scripted git/rg pipeline ranked by distinct manually supplied query keywords then line matches; three two-line-context windows per top-five file. This is a strong deterministic compact baseline; reasoning to select keywords is not measured.',
        'contextpro': 'Configured Node/Ollama/bge-m3 MCP over stdio; file search with top_k=5 and JSON crux output. keyword_only and balanced measured separately.',
        'tokens': 'Exact encoding counts of captured tool text in o200k_base and cl100k_base. Neither is asserted to be the GPT-6 or Claude billing tokenizer. JSON RPC envelopes, reasoning, client wrappers, history replay and caching excluded. Catalogs counted separately, not assumed to be billed on every request.',
        'latency': 'Wall time of sequential tool operations. First pass is not OS-cache/provider-cold; the configured local provider was already warm. Startup and index reconciliation recorded separately; seed-copy and prior embedding construction excluded. Not full agent completion time.',
        'repeats': 'Repeated output is not credited as extra task success or savings. Main totals use the first pass only.',
        'limits': 'Small convenience corpus, source-informed hand labels, no blind adjudicator or held-out repositories. File presence does not prove excerpt sufficiency. Baseline searches tracked text including docs/configs, excluding lockfiles; ContextPro applies its scanner rules.',
        'actualAgentTokensSaved': None, 'actualBillingSavingsUsd': None, 'actualAgentTimeSavedMs': None,
    },
    'generatedAt': raw['generatedAt'], 'runtime': raw['runtime'], 'snapshotCommit': raw['commit'],
    'startupMs': raw['startupMs'], 'preparationMs': raw.get('preparationMs'),
    'summary': summaries, 'catalogs': catalogs, 'perTask': per_task,
    'extraCaptures': [{k: v for k, v in c.items() if k != 'text'} for c in raw['captures'] if c['task'] not in [t['id'] for t in raw['tasks']]],
    'builtinEfficiency': json.loads(raw['efficiency']['content'][0]['text']),
}
(directory / 'tokenized-raw.json').write_text(json.dumps(raw, indent=2) + '\n')
(directory / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: summary[k] for k in ('summary', 'catalogs', 'extraCaptures', 'startupMs', 'preparationMs')}, indent=2))
