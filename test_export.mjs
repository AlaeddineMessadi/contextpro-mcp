import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/test_export.ts');
const flat = flattenSymbols(analysis.symbols);

for (const sym of flat) {
  console.log(`Name: ${sym.name}`);
  console.log(`Signature: "${sym.signature}"`);
  console.log(`Has export prefix: ${/^export\s/.test(sym.signature)}`);
}
