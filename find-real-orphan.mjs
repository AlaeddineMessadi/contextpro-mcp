import { buildProjectGraph } from "./build/core/project-graph.js";
import { queryProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

const result = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 50
});

// Find a real orphan
const symbolDefineEdges = result.graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const resultFileIds = new Set(result.nodes.filter(n => n.type === 'file').map(n => n.id));
const resultSymbolIds = new Set(result.nodes.filter(n => n.type === 'symbol').map(n => n.id));

let foundOrphan = null;
for (const symId of resultSymbolIds) {
  const fileId = symbolToFile.get(symId);
  if (!fileId || !resultFileIds.has(fileId)) {
    foundOrphan = { symId, fileId, inResult: fileId && resultFileIds.has(fileId) };
    break;
  }
}

if (foundOrphan) {
  console.log(`Found orphan: ${foundOrphan.symId}`);
  console.log(`Defining file: ${foundOrphan.fileId}`);
  
  // Check if this file is in the full graph
  const fileNode = result.graph.nodes.find(n => n.id === foundOrphan.fileId);
  console.log(`File in graph.nodes: ${!!fileNode} (${fileNode?.path})`);
  
  // Find what targeted this symbol in collectedEdges
  const incomingInCollected = result.edges.filter(e => e.target === foundOrphan.symId);
  console.log(`Edges in result targeting this symbol: ${incomingInCollected.length}`);
  incomingInCollected.forEach(e => {
    console.log(`  From ${e.source} via ${e.type}`);
  });
} else {
  console.log("No orphans found in this result");
}

