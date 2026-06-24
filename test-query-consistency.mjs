import { queryProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

console.log("\n=== Testing impact query consistency ===");

// Test multiple queries
for (const limit of [1, 5, 10, 50, 100]) {
  const result = await queryProjectGraph(testDir, {
    kind: "impact",
    file: "src/core/db.ts",
    limit
  });

  const fileNodes = result.nodes.filter(n => n.type === 'file');
  const symbolNodes = result.nodes.filter(n => n.type === 'symbol');
  
  // Check consistency: every symbol in result should have a defining file in result
  const symbolDefineEdges = result.graph.edges.filter(e => e.type === 'defines');
  const symbolToFile = new Map();
  for (const edge of symbolDefineEdges) {
    symbolToFile.set(edge.target, edge.source);
  }
  
  const resultFileIds = new Set(fileNodes.map(n => n.id));
  let orphans = 0;
  for (const symNode of symbolNodes) {
    const fileId = symbolToFile.get(symNode.id);
    if (!fileId || !resultFileIds.has(fileId)) {
      orphans++;
    }
  }
  
  console.log(`limit=${limit}: edges=${result.edges.length}, files=${fileNodes.length}, symbols=${symbolNodes.length}, orphans=${orphans}`);
}

console.log("\n=== Testing query code logic ===");

// Manually trace through the logic
const result = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 5
});

console.log("Checking line 861 logic:");
console.log(`result.nodes.length (from line 862): ${result.nodes.length}`);
console.log(`File nodes: ${result.nodes.filter(n => n.type === 'file').length}`);
console.log(`Symbol nodes: ${result.nodes.filter(n => n.type === 'symbol').length}`);

