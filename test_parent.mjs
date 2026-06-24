import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/test_parent.ts');
const flat = flattenSymbols(analysis.symbols);

console.log("=== SYMBOLS WITH PARENT INFO ===");
for (const sym of flat) {
  console.log(`${sym.name.padEnd(12)} | parentName: ${sym.parentName ?? '(undefined)'}`);
}
