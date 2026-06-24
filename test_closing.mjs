import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/closing_brace.ts');
const flat = flattenSymbols(analysis.symbols);

for (const sym of flat) {
  console.log(`${sym.name} (L${sym.line}-L${sym.endLine})`);
}
