import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

console.log("\n=== Tracing the bug ===");

// Start at src/core/db.ts
const startNode = graph.nodes.find(n => n.path === "src/core/db.ts" && n.type === 'file');
const fileFrontier = new Set([startNode.id]);
const symbolFrontier = new Set();
const collectedEdges = [];
const edgeBudget = 50;

// HOP 0: Collect symbols from src/core/db.ts
const hop0Symbols = new Set();
for (const edge of graph.edges) {
  if (!fileFrontier.has(edge.source)) continue;
  if (edge.type !== "defines") continue;
  symbolFrontier.add(edge.target);
  hop0Symbols.add(edge.target);
}
console.log(`Hop 0: ${hop0Symbols.size} symbols in src/core/db.ts`);

// HOP 0: Find edges targeting those symbols or the source file
const hop0Dependents = new Set();
for (const edge of graph.edges) {
  if (collectedEdges.length >= edgeBudget) break;
  const targetsFile = fileFrontier.has(edge.target) && (edge.type === "imports" || edge.type === "tests");
  const targetsSymbol = symbolFrontier.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
  if (!targetsFile && !targetsSymbol) continue;
  if (fileFrontier.has(edge.source)) continue;
  collectedEdges.push(edge);
  hop0Dependents.add(edge.source);
}
console.log(`Hop 0: ${hop0Dependents.size} dependent files found`);
for (const id of hop0Dependents) fileFrontier.add(id);

// HOP 1: Collect symbols from the NEW files
const hop1Symbols = new Set();
for (const edge of graph.edges) {
  if (fileFrontier.has(edge.source) && hop0Dependents.has(edge.source)) {
    // Only edges from hop0Dependents are NEW
    if (edge.type === "defines") {
      hop1Symbols.add(edge.target);
      symbolFrontier.add(edge.target);
    }
  } else if (!hop0Dependents.has(edge.source) && fileFrontier.has(edge.source) && edge.type === "defines") {
    // Edges from original file
    // Already processed
  }
}

console.log(`Hop 1: ${hop1Symbols.size} NEW symbols from ${hop0Dependents.size} new files`);
console.log(`Total symbolFrontier after hop 1: ${symbolFrontier.size}`);

// HOP 1: Find edges targeting the NEW symbols
const hop1DependentsFromNewSymbols = new Set();
for (const edge of graph.edges) {
  if (collectedEdges.length >= edgeBudget) break;
  // Check if this edge targets one of the NEW symbols
  const targetsNewSymbol = hop1Symbols.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
  if (!targetsNewSymbol) continue;
  if (fileFrontier.has(edge.source)) continue;
  collectedEdges.push(edge);
  hop1DependentsFromNewSymbols.add(edge.source);
}

console.log(`\nHop 1: ${hop1DependentsFromNewSymbols.size} NEW dependents found from new symbols`);
console.log(`These dependents are files like: ${[...hop1DependentsFromNewSymbols].slice(0, 3).map(id => graph.nodes.find(n => n.id === id)?.path)}`);

// Check: are these NEW dependent files themselves in fileFrontier? 
// If not, their symbols won't be filtered out at line 862
const newFilesNotInFrontier = [...hop1DependentsFromNewSymbols].filter(id => !fileFrontier.has(id));
console.log(`NEW dependent files NOT yet in fileFrontier: ${newFilesNotInFrontier.length}`);

if (newFilesNotInFrontier.length > 0) {
  console.log(`\nBUG FOUND: These files would be added to fileFrontier AFTER hop 1 completes`);
  console.log(`But their symbols might already be in symbolFrontier from edges targeting them`);
  console.log(`So when we filter at line 862, we include symbols but not their defining files!`);
}

