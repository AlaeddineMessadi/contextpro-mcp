import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

const startNode = graph.nodes.find(n => n.path === "src/core/db.ts" && n.type === 'file');
const fileFrontier = new Set([startNode.id]);
const symbolFrontier = new Set();
const collectedEdges = [];
const edgeBudget = 50;

const MAX_HOPS = 3;

for (let hop = 0; hop < MAX_HOPS && collectedEdges.length < edgeBudget; hop++) {
  console.log(`\n=== Hop ${hop} ===`);
  console.log(`fileFrontier size before: ${fileFrontier.size}`);
  
  const newSymbols = new Set();
  for (const edge of graph.edges) {
    if (!fileFrontier.has(edge.source)) continue;
    if (edge.type !== "defines") continue;
    if (symbolFrontier.has(edge.target)) continue;
    symbolFrontier.add(edge.target);
    newSymbols.add(edge.target);
  }
  console.log(`Added ${newSymbols.size} symbols, symbolFrontier now ${symbolFrontier.size}`);
  
  const newDependents = new Set();
  const edgesBefore = collectedEdges.length;
  for (const edge of graph.edges) {
    if (collectedEdges.length >= edgeBudget) {
      console.log(`Budget exhausted at edge ${collectedEdges.length}, breaking...`);
      break;
    }
    const targetsFile = fileFrontier.has(edge.target) && (edge.type === "imports" || edge.type === "tests");
    const targetsSymbol = symbolFrontier.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
    if (!targetsFile && !targetsSymbol) continue;
    if (fileFrontier.has(edge.source)) continue;
    collectedEdges.push(edge);
    newDependents.add(edge.source);
  }
  console.log(`Collected ${collectedEdges.length - edgesBefore} edges, ${newDependents.size} new dependents`);
  
  if (newDependents.size === 0) {
    console.log(`No new dependents, breaking...`);
    break;
  }
  
  for (const id of newDependents) fileFrontier.add(id);
  console.log(`fileFrontier size after: ${fileFrontier.size}`);
}

console.log(`\n=== After BFS ===`);
console.log(`fileFrontier size: ${fileFrontier.size}`);
console.log(`symbolFrontier size: ${symbolFrontier.size}`);

const nodeIds = new Set([...fileFrontier, ...symbolFrontier]);
const nodes = graph.nodes.filter(node => nodeIds.has(node.id));

console.log(`\nFiltered to ${nodes.length} nodes`);
const fileNodes = nodes.filter(n => n.type === 'file');
const symbolNodes = nodes.filter(n => n.type === 'symbol');
console.log(`File nodes: ${fileNodes.length}, Symbol nodes: ${symbolNodes.length}`);

// Check for orphans
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const resultFileIds = new Set(fileNodes.map(n => n.id));
let orphanCount = 0;
const orphansByFile = {};
for (const symNode of symbolNodes) {
  const fileId = symbolToFile.get(symNode.id);
  if (!fileId || !resultFileIds.has(fileId)) {
    orphanCount++;
    const filePath = symNode.path;
    orphansByFile[filePath] = (orphansByFile[filePath] || 0) + 1;
  }
}

console.log(`\nOrphan symbols: ${orphanCount}`);
console.log("By file:");
Object.entries(orphansByFile).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([file, count]) => {
  console.log(`  ${file}: ${count}`);
});

