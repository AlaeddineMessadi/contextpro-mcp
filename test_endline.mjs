import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/test_endline.ts');
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

console.log("\n=== FILTERING topLevel (line 4) ===");
const topLevelSym = flat.find(s => s.name === 'topLevel');
for (const range of structuralRanges) {
  console.log(`Checking: ${topLevelSym.line} > ${range.start} && ${topLevelSym.line} <= ${range.end}`);
  console.log(`         = ${topLevelSym.line > range.start} && ${topLevelSym.line <= range.end}`);
  console.log(`         = ${topLevelSym.line > range.start && topLevelSym.line <= range.end}`);
}
