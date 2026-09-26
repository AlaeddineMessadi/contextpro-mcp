import { it } from 'node:test';
import assert from 'node:assert/strict';
import { extractImports, analyzeContent } from '../../build/core/parser.js';

it('extracts multiline TS/JS imports, aliases, re-exports and dynamic imports without comment/string false positives', () => {
  const source = `// import { fake } from './comment';
const literal = "import { fake } from './string'";
import Default, {
  type Claims,
  verify as check,
} from './security';
import * as space from './namespace';
import './side-effect';
export {
  check as publicCheck,
} from './security';
export * from './all';
const load = () => import(
  './lazy'
);
`;
  for (const file of ['api.ts', 'api.tsx', 'api.mts', 'api.cts', 'api.js', 'api.mjs', 'api.cjs']) {
    const imports = extractImports(source, file);
    assert.deepEqual(imports.map(({source,specifiers,type,line}) => ({source,specifiers,type,line})), [
      {source:'./security',specifiers:['Default','Claims','verify'],type:'static',line:3},
      {source:'./namespace',specifiers:['space'],type:'static',line:7},
      {source:'./side-effect',specifiers:[],type:'static',line:8},
      {source:'./security',specifiers:['check'],type:'re-export',line:9},
      {source:'./all',specifiers:[],type:'re-export',line:12},
      {source:'./lazy',specifiers:[],type:'dynamic',line:13},
    ], file);
  }
});

it('does not label code/import continuations as a file header', async () => {
  const without = await analyzeContent('api.ts', 'import {\n  cleanText,\n  cookie,\n} from "./security";\nexport const ready = true;');
  assert.equal(without.header, '');
  const withDoc = await analyzeContent('api.ts', '/**\n * Security helpers\n * Used by routes\n */\nexport const ready = true;');
  assert.equal(withDoc.header, 'Security helpers | Used by routes');
});

it('does not include block-comment terminators in file headers', async () => {
  const oneLine = await analyzeContent('api.ts', '/*\n * Security helpers\n */\nexport const ready = true;');
  assert.equal(oneLine.header, 'Security helpers');
  const empty = await analyzeContent('api.ts', '/*\n */\nexport const ready = true;');
  assert.equal(empty.header, '');
});
