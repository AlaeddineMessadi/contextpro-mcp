import { it } from 'node:test';
import assert from 'node:assert/strict';
import { maskSourceText } from '../../build/core/source-mask.js';
import { extractCallSites } from '../../build/core/parser.js';

it('masks JS regex literals without hiding subsequent code, division or template expressions', () => {
  const source = [
    'const pattern = /["\'`]/;',
    'const url = /https?:\\/\\/[^/]+/;',
    'const decoy = /afterRegexCall\\(\\)/;',
    'const ratio = numerator / denominator / 2;',
    'const mixed = `hiddenCall() ${visibleCall() + /[}`]/.test("}")}`;',
    'afterRegexCall();',
    '// afterRegexCall() is mentioned in a comment',
  ].join('\n');
  for (const path of ['api.ts', 'api.js', 'api.mjs', 'api.tsx']) {
    const masked = maskSourceText(source, path);
    assert.equal(masked.length, source.length);
    assert.deepEqual(masked.split('\n').map(line => line.length), source.split('\n').map(line => line.length));
    assert.match(masked, /numerator \/ denominator \/ 2/);
    assert.match(masked, /visibleCall\(\)/);
    assert.doesNotMatch(masked, /hiddenCall|https/);
    assert.equal(masked.indexOf('afterRegexCall'), source.indexOf('afterRegexCall();'));
    assert.equal((masked.match(/afterRegexCall/g) ?? []).length, 1);
    assert.ok(extractCallSites(source, path).some(call => call.callee === 'afterRegexCall' && call.line === 6));
    assert.equal(extractCallSites(source, path).filter(call => call.callee === 'afterRegexCall').length, 1);
  }
});
