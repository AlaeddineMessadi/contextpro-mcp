import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const analysis = await analyzeFile('/tmp/exports_short.ts');
const flat = flattenSymbols(analysis.symbols);

const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);
const structuralRanges = [];

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

console.log("=== EXPORT FILTER TEST ===");
for (const sym of flat) {
  const sig = sym.signature ?? "";
  const hasExportPrefix = /^export\s/.test(sig);
  const result = isIndexableSymbol(sym, structuralRanges) ? "INDEXED" : "FILTERED";
  console.log(`${result.padEnd(10)} | ${sym.name.padEnd(10)} | export prefix: ${hasExportPrefix} | sig: "${sig}"`);
}
