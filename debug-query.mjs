import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

console.log("\n=== Manual trace through impact BFS ===");

// Find start file
const startNode = graph.nodes.find(n => n.path === "src/core/db.ts" && n.type === 'file');
const startIds = new Set([startNode.id]);

const MAX_HOPS = 3;
const fileFrontier = new Set(startIds);
const symbolFrontier = new Set();
const collectedEdges = [];
const edgeBudget = 50;

console.log(`Starting with: ${startNode.id}`);

for (let hop = 0; hop < MAX_HOPS && collectedEdges.length < edgeBudget; hop++) {
  console.log(`\n--- Hop ${hop} ---`);
  console.log(`fileFrontier.size = ${fileFrontier.size}`);
  
  // Collect symbols from current frontier
  const newSymbols = new Set();
  for (const edge of graph.edges) {
    if (!fileFrontier.has(edge.source)) continue;
    if (edge.type !== "defines") continue;
    if (symbolFrontier.has(edge.target)) continue;
    symbolFrontier.add(edge.target);
    newSymbols.add(edge.target);
  }
  console.log(`Added ${newSymbols.size} new symbols, symbolFrontier.size = ${symbolFrontier.size}`);
  
  // Collect dependent files
  const newDependents = new Set();
  let edgesBeforeBudget = collectedEdges.length;
  for (const edge of graph.edges) {
    if (collectedEdges.length >= edgeBudget) break;
    const targetsFile = fileFrontier.has(edge.target) && (edge.type === "imports" || edge.type === "tests");
    const targetsSymbol = symbolFrontier.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
    if (!targetsFile && !targetsSymbol) continue;
    if (fileFrontier.has(edge.source)) continue;
    collectedEdges.push(edge);
    newDependents.add(edge.source);
  }
  const edgesThisHop = collectedEdges.length - edgesBeforeBudget;
  console.log(`Collected ${edgesThisHop} edges, added ${newDependents.size} new dependents`);
  
  if (newDependents.size === 0) break;
  for (const id of newDependents) fileFrontier.add(id);
  
  if (hop === 2) {
    console.log(`After hop 2: fileFrontier.size=${fileFrontier.size}, symbolFrontier.size=${symbolFrontier.size}`);
  }
}

console.log(`\nFinal: fileFrontier.size = ${fileFrontier.size}, symbolFrontier.size = ${symbolFrontier.size}`);

// Check line 861 logic
const nodeIds = new Set([...fileFrontier, ...symbolFrontier]);
const resultNodes = graph.nodes.filter(node => nodeIds.has(node.id));
const fileNodesInResult = resultNodes.filter(n => n.type === 'file');
const symbolNodesInResult = resultNodes.filter(n => n.type === 'symbol');

console.log(`\nResult nodes: ${resultNodes.length}`);
console.log(`Result file nodes: ${fileNodesInResult.length}`);
console.log(`Result symbol nodes: ${symbolNodesInResult.length}`);

// Check for orphans
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const resultFileIds = new Set(fileNodesInResult.map(n => n.id));
let orphans = 0;
const orphanExamples = [];
for (const symNode of symbolNodesInResult) {
  const fileId = symbolToFile.get(symNode.id);
  if (!fileId || !resultFileIds.has(fileId)) {
    orphans++;
    if (orphanExamples.length < 5) {
      orphanExamples.push({ symId: symNode.id, fileId, fileInResult: fileId && resultFileIds.has(fileId) });
    }
  }
}

console.log(`\nOrphans: ${orphans}`);
console.log("Examples:", orphanExamples);

