import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

console.log("\n=== Analyzing full graph ===");

const graph = await buildProjectGraph(testDir);
console.log(`Total nodes: ${graph.nodes.length}`);
console.log(`Total edges: ${graph.edges.length}`);

// Count file and symbol nodes
const fileNodes = new Set(graph.nodes.filter(n => n.type === 'file').map(n => n.id));
const symbolNodes = new Set(graph.nodes.filter(n => n.type === 'symbol').map(n => n.id));

console.log(`File nodes: ${fileNodes.size}`);
console.log(`Symbol nodes: ${symbolNodes.size}`);

// Find symbols whose defining file is not in graph
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source); // symbol -> file
}

let orphanCount = 0;
const orphanExamples = [];
for (const symId of symbolNodes) {
  const fileId = symbolToFile.get(symId);
  if (!fileId || !fileNodes.has(fileId)) {
    orphanCount++;
    if (orphanExamples.length < 10) {
      const symNode = graph.nodes.find(n => n.id === symId);
      orphanExamples.push({ symId, path: symNode?.path, fileId });
    }
  }
}
console.log(`Total orphan symbols in full graph: ${orphanCount}`);
console.log("Examples:", orphanExamples);

// Check if defines edges have proper source/target
console.log("\n=== Analyzing defines edges ===");
const definesWithoutFileSource = symbolDefineEdges.filter(e => !fileNodes.has(e.source));
console.log(`Defines edges where source is NOT a file: ${definesWithoutFileSource.length}`);
if (definesWithoutFileSource.length > 0) {
  console.log("Examples:", definesWithoutFileSource.slice(0, 5));
}

// Check if target of defines is a symbol
const definesWithoutSymbolTarget = symbolDefineEdges.filter(e => {
  const target = graph.nodes.find(n => n.id === e.target);
  return !target || target.type !== 'symbol';
});
console.log(`Defines edges where target is NOT a symbol: ${definesWithoutSymbolTarget.length}`);
if (definesWithoutSymbolTarget.length > 0) {
  console.log("Examples:", definesWithoutSymbolTarget.slice(0, 5));
}

