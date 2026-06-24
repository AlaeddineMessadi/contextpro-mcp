import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/test_endline_edge.ts');
const flat = flattenSymbols(analysis.symbols);

console.log("=== SYMBOLS ===");
for (const sym of flat) {
  console.log(`${sym.name} (L${sym.line}-L${sym.endLine})`);
}

const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);
const structuralRanges = flat
  .filter((symbol) => STRUCTURAL_KINDS.has(symbol.kind))
  .map((symbol) => ({ start: symbol.line, end: symbol.endLine }));

console.log("\n=== RANGES ===");
for (const r of structuralRanges) {
  console.log(`Range: L${r.start} to L${r.end}`);
}

console.log("\n=== FILTERING BEHAVIOR ===");
for (const sym of flat) {
  for (const range of structuralRanges) {
    if (sym.line > range.start && sym.line <= range.end) {
      console.log(`${sym.name} (L${sym.line}) is IN range [L${range.start}-L${range.end}]`);
    }
  }
}
