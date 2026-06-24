import { analyzeFile, flattenSymbols } from './build/core/parser.js';

const testFile = '/tmp/test_bugs.ts';

try {
  const analysis = await analyzeFile(testFile);
  const flat = flattenSymbols(analysis.symbols);
  
  console.log("=== PARSED SYMBOLS ===");
  for (const sym of flat) {
    console.log(`${sym.name} (${sym.kind}, L${sym.line}) - signature: "${sym.signature}"`);
  }
  
  // Build structural ranges (same as isIndexableSymbol does)
  const STRUCTURAL_KINDS = new Set(["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"]);
  const structuralRanges = flat
    .filter((symbol) => STRUCTURAL_KINDS.has(symbol.kind))
    .map((symbol) => ({ start: symbol.line, end: symbol.endLine }));
  
  console.log("\n=== STRUCTURAL RANGES ===");
  for (const range of structuralRanges) {
    console.log(`Range: L${range.start} - L${range.end}`);
  }
  
  // Test isIndexableSymbol logic
  console.log("\n=== TESTING FILTER LOGIC ===");
  for (const symbol of flat) {
    const sig = symbol.signature ?? "";
    const hasExportPrefix = /^export\s/.test(sig);
    const hasParent = !!symbol.parentName;
    const nameLen = symbol.name.length;
    
    // Check line containment
    let inRange = false;
    for (const range of structuralRanges) {
      if (symbol.line > range.start && symbol.line <= range.end) {
        inRange = true;
        break;
      }
    }
    
    let result = "FILTERED";
    if (["function", "method", "class", "interface", "enum", "type", "struct", "trait", "export"].includes(symbol.kind)) {
      result = "INDEXED (structural)";
    } else if (symbol.kind === "const" || symbol.kind === "variable") {
      if (hasExportPrefix) {
        result = "INDEXED (has export prefix)";
      } else if (hasParent) {
        result = "FILTERED (has parent)";
      } else if (inRange) {
        result = "FILTERED (in range)";
      } else if (nameLen < 3) {
        result = "FILTERED (name too short)";
      } else {
        result = "INDEXED";
      }
    }
    
    console.log(`${result.padEnd(35)} | ${symbol.name.padEnd(10)} | line ${symbol.line} | sig: "${sig}"`);
  }
  
} catch (err) {
  console.error("Error:", err);
}
