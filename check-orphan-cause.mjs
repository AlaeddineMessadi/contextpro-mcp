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
  const newSymbols = new Set();
  for (const edge of graph.edges) {
    if (!fileFrontier.has(edge.source)) continue;
    if (edge.type !== "defines") continue;
    if (symbolFrontier.has(edge.target)) continue;
    symbolFrontier.add(edge.target);
    newSymbols.add(edge.target);
  }
  
  const newDependents = new Set();
  for (const edge of graph.edges) {
    if (collectedEdges.length >= edgeBudget) break;
    const targetsFile = fileFrontier.has(edge.target) && (edge.type === "imports" || edge.type === "tests");
    const targetsSymbol = symbolFrontier.has(edge.target) && (edge.type === "calls" || edge.type === "references" || edge.type === "tests");
    if (!targetsFile && !targetsSymbol) continue;
    if (fileFrontier.has(edge.source)) continue;
    collectedEdges.push(edge);
    newDependents.add(edge.source);
  }
  
  if (newDependents.size === 0) break;
  for (const id of newDependents) fileFrontier.add(id);
}

// Check: which symbols have files that are NOT in fileFrontier?
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const graphFileIds = new Set(graph.nodes.filter(n => n.type === 'file').map(n => n.id));
let orphansFromFilesNotInGraph = 0;
let orphansFromFilesInGraphButNotFrontier = 0;

for (const symId of symbolFrontier) {
  const fileId = symbolToFile.get(symId);
  if (!fileId) {
    // Symbol has no defines edge
    continue;
  }
  if (!graphFileIds.has(fileId)) {
    orphansFromFilesNotInGraph++;
  } else if (!fileFrontier.has(fileId)) {
    orphansFromFilesInGraphButNotFrontier++;
  }
}

console.log(`Total symbols in symbolFrontier: ${symbolFrontier.size}`);
console.log(`Symbols with files NOT in graph: ${orphansFromFilesNotInGraph}`);
console.log(`Symbols with files in graph but NOT in fileFrontier: ${orphansFromFilesInGraphButNotFrontier}`);
console.log(`\nWhen we filter at line 862:`);
console.log(`nodeIds = [...fileFrontier (${fileFrontier.size}), ...symbolFrontier (${symbolFrontier.size})]`);
console.log(`Result would include ${orphansFromFilesNotInGraph + orphansFromFilesInGraphButNotFrontier} orphan symbols`);

