import { analyzeFile, flattenSymbols } from './build/core/parser.js';
import { semanticIdentifierSearchResults } from './build/tools/semantic-identifiers.js';

const analysis = await analyzeFile('/tmp/closing_brace.ts');
const flat = flattenSymbols(analysis.symbols);

// Simulate the isIndexableSymbol check
const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);

const structuralRanges = flat
  .filter((symbol) => STRUCTURAL_KINDS.has(symbol.kind))
  .map((symbol) => ({ start: symbol.line, end: symbol.endLine }));

function isIndexableSymbol(symbol, structuralRanges) {
  if (STRUCTURAL_KINDS.has(symbol.kind)) return true;
  if (symbol.kind !== "const" && symbol.kind !== "variable") return false;
  const sig = symbol.signature ?? "";
  if (/^export\s/.test(sig)) return true;
  if (symbol.parentName) return false;
  for (const range of structuralRanges) {
    if (symbol.line > range.start && symbol.line <= range.end) return false;
  }
  if (symbol.name.length < 3) return false;
  return true;
}

console.log("=== FILTERING RESULTS ===");
for (const sym of flat) {
  const result = isIndexableSymbol(sym, structuralRanges) ? "INDEXED" : "FILTERED";
  console.log(`${result} | ${sym.name} (L${sym.line})`);
}
