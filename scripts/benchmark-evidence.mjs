// Pure helpers for matched trials and observed evidence; no model/provider calls.
export function buildTrialPlan(taskIds, repeats = 3, indexStates = ['seeded']) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be an integer from 1 to 20');
  if (!indexStates.length || new Set(indexStates).size !== indexStates.length || indexStates.some(x => !['empty', 'seeded'].includes(x))) throw new Error('index states must be empty and/or seeded');
  return Array.from({ length: repeats }, (_, repeat) => taskIds.flatMap((taskId, taskIndex) => indexStates.flatMap((indexState, stateIndex) => {
    const order = (repeat + taskIndex + stateIndex) % 2 ? ['contextpro', 'baseline'] : ['baseline', 'contextpro'];
    return order.map((variant, orderIndex) => ({ taskId, pairId: `${repeat + 1}-${indexState}`, variant, indexState, repeat: repeat + 1, orderIndex }));
  }))).flat();
}

export function createEventCollector() {
  let pending = '';
  const events = [], timedEvents = [], started = new Map(), calls = new Map();
  function line(text, atMs) {
    let event;
    try { event = JSON.parse(text); } catch { return; }
    events.push(event); timedEvents.push({ atMs, event });
    const item = event.item;
    if (!item || !['mcp_tool_call', 'command_execution'].includes(item.type)) return;
    if (event.type === 'item.started') started.set(item.id, atMs);
    if (event.type === 'item.completed') calls.set(item.id, {
      id: item.id, type: item.type, server: item.server, tool: item.tool,
      arguments: item.arguments, command: item.command, status: item.status,
      isError: item.status === 'failed' || item.result?.isError === true || (Number.isInteger(item.exit_code) && item.exit_code !== 0),
      startedAtMs: started.get(item.id) ?? null, completedAtMs: atMs,
      observedDurationMs: started.has(item.id) ? atMs - started.get(item.id) : null,
    });
  }
  return { events, timedEvents, calls,
    push(chunk, atMs) { pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const text of lines) line(text, atMs); },
    finish(atMs) { if (pending) line(pending, atMs); pending = ''; },
  };
}

export function providerUsage(events) {
  const completed = events.filter(e => e.type === 'turn.completed');
  if (!completed.length || completed.some(e => !['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(e.usage?.[k]) && e.usage[k] >= 0))) return null;
  const usage = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens']) {
    if (completed.every(e => Number.isSafeInteger(e.usage[key]) && e.usage[key] >= 0)) usage[key] = completed.reduce((sum, e) => sum + e.usage[key], 0);
  }
  if (usage.cached_input_tokens !== undefined && usage.cached_input_tokens > usage.input_tokens) throw new Error('Cached input must be a subset of input tokens');
  return usage;
}

export function summarizeServerTrace(trace, calls) {
  const expected = calls.filter(c => c.type === 'mcp_tool_call' && c.server === 'contextpro');
  const valid = trace.filter(e => e.version === 1 && Number.isFinite(e.startedAt) && Number.isFinite(e.durationMs) && e.durationMs >= 0);
  const intervals = valid.map(e => [e.startedAt, e.startedAt + e.durationMs]).sort((a, b) => a[0] - b[0]);
  let end = -Infinity, busyMs = 0;
  for (const [start, stop] of intervals) { busyMs += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  const frequencies = rows => rows.reduce((map, row) => { map[row.tool] = (map[row.tool] ?? 0) + 1; return map; }, Object.create(null));
  const recorded = frequencies(valid), requested = frequencies(expected);
  const complete = expected.length > 0 && valid.length === trace.length && Object.keys({ ...recorded, ...requested }).every(tool => recorded[tool] === requested[tool]);
  return { expectedCalls: expected.length, recordedCalls: valid.length, complete,
    serverBusyMs: valid.length ? busyMs : null,
    summedServerMs: valid.length ? valid.reduce((sum, e) => sum + e.durationMs, 0) : null,
    note: 'Server spans exclude client/model time; summed spans may overlap. Missing trace is unavailable, never zero. Time outside server spans includes model, transport and scheduling.' };
}

export function latencyDistribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, medianMs: null, minMs: null, maxMs: null };
  const mid = Math.floor(sorted.length / 2);
  return { samples: sorted.length, medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, minMs: sorted[0], maxMs: sorted.at(-1) };
}

// Fingerprint executable JS, including sibling compiled modules, when a launcher
// names a local entry file. Package-runner commands may have no inspectable build.
export async function fingerprintLauncher(launcher) {
  if (!launcher) return null;
  const { readFile, readdir, stat } = await import('node:fs/promises');
  const { dirname, join, isAbsolute, relative } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const entry = launcher.args.find(arg => isAbsolute(arg) && /\.[cm]?js$/.test(arg));
  if (!entry) return null;
  if (!(await stat(entry)).isFile()) throw new Error('Launcher entry must be a regular file');
  const base = dirname(entry), hash = createHash('sha256');
  let files = 0, bytes = 0;
  async function walk(dir) {
    for (const child of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, child.name);
      if (child.isDirectory() && child.name !== 'node_modules') await walk(path);
      else if (child.isFile() && /\.[cm]?js$/.test(child.name)) {
        const content = await readFile(path); files++; bytes += content.length;
        if (files > 2000 || bytes > 32 * 1024 * 1024) throw new Error('Build fingerprint exceeds bounds; use an isolated build directory');
        hash.update(relative(base, path) + '\0' + content.length + '\0'); hash.update(content);
      }
    }
  }
  await walk(base);
  return { entry, files, sha256: hash.digest('hex') };
}
