import { queryProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

const result = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 50
});

const symbolDefineEdges = result.graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const fileNodes = result.nodes.filter(n => n.type === 'file');
const symbolNodes = result.nodes.filter(n => n.type === 'symbol');
const resultFileIds = new Set(fileNodes.map(n => n.id));

// Find which files have orphan symbols
const missingFiles = {};
for (const sym of symbolNodes) {
  const fileId = symbolToFile.get(sym.id);
  if (!fileId || !resultFileIds.has(fileId)) {
    const filePath = sym.path;
    missingFiles[filePath] = (missingFiles[filePath] || 0) + 1;
  }
}

console.log("Files with orphan symbols:");
Object.entries(missingFiles).sort((a, b) => b[1] - a[1]).forEach(([file, count]) => {
  const fileId = `file:${file}`;
  const fileInResult = resultFileIds.has(fileId);
  const fileInGraph = result.graph.nodes.find(n => n.id === fileId);
  console.log(`  ${file}: ${count} orphans (in result: ${fileInResult}, in graph: ${!!fileInGraph})`);
});

