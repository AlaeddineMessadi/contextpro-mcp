import { queryProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

console.log("\n=== Testing impact query ===");

// Test with small limit
const result = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 5
});

console.log(`Edges collected: ${result.edges.length}`);
const fileNodes = result.nodes.filter(n => n.type === 'file');
const symbolNodes = result.nodes.filter(n => n.type === 'symbol');
console.log(`File nodes in result: ${fileNodes.length}`);
console.log(`Symbol nodes in result: ${symbolNodes.length}`);

// Build mapping of symbols to their defining files
const symbolDefineEdges = result.graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source); // symbol -> file
}

// Check for orphan symbols in the result
const resultFileIds = new Set(fileNodes.map(n => n.id));
let resultOrphans = 0;
const orphanExamples = [];
for (const symNode of symbolNodes) {
  const fileId = symbolToFile.get(symNode.id);
  if (!fileId || !resultFileIds.has(fileId)) {
    resultOrphans++;
    if (orphanExamples.length < 5) {
      orphanExamples.push({ symId: symNode.id, path: symNode.path, fileId });
    }
  }
}
console.log(`Orphan symbols in result: ${resultOrphans}`);
console.log("Examples:", orphanExamples);

// Test BUG 3: Incomplete frontier after budget exit
console.log("\n=== Testing BUG 3: Incomplete frontier after budget exit ===");
const resultLimit1 = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 1
});
console.log(`With limit=1: ${resultLimit1.edges.length} edges, ${resultLimit1.nodes.length} nodes`);

const resultLimit100 = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 100
});
console.log(`With limit=100: ${resultLimit100.edges.length} edges, ${resultLimit100.nodes.length} nodes`);

