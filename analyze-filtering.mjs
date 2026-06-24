import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

const fileNodes = new Set(graph.nodes.filter(n => n.type === 'file').map(n => n.id));
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();

for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source); // symbol -> file
}

// Collect all file IDs referenced in defines edges
const referencedFileIds = new Set([...symbolToFile.values()]);

console.log(`File nodes in graph: ${fileNodes.size}`);
console.log(`Files referenced in defines edges: ${referencedFileIds.size}`);
console.log(`Files in defines edges but NOT in nodes: ${referencedFileIds.size - new Set([...referencedFileIds].filter(f => fileNodes.has(f))).size}`);

// Find the excluded files
const excludedFiles = [...referencedFileIds].filter(f => !fileNodes.has(f));
console.log("\nExcluded files (first 10):");
excludedFiles.slice(0, 10).forEach(f => {
  const pathMatch = f.match(/^file:(.+)$/);
  console.log(`  ${pathMatch ? pathMatch[1] : f}`);
});

// Check if there's a pattern - are they from specific directories?
const excludedPaths = excludedFiles.map(f => f.match(/^file:(.+)$/)?.[1] || f);
console.log("\nDirectory breakdown:");
const byDir = {};
excludedPaths.forEach(p => {
  const dir = p.split('/')[0];
  byDir[dir] = (byDir[dir] || 0) + 1;
});
Object.entries(byDir).sort((a, b) => b[1] - a[1]).forEach(([dir, count]) => {
  console.log(`  ${dir}: ${count}`);
});

