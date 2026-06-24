import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

const startNode = graph.nodes.find(n => n.path === "src/core/db.ts" && n.type === 'file');
const fileFrontier = new Set([startNode.id]);
const symbolFrontier = new Set();
const collectedEdges = [];
const edgeBudget = 50;

const MAX_HOPS = 3;
let filesFromHop1 = null;

for (let hop = 0; hop < MAX_HOPS && collectedEdges.length < edgeBudget; hop++) {
  const newSymbols = new Set();
  for (const edge of graph.edges) {
    if (!fileFrontier.has(edge.source)) continue;
    if (edge.type !== "defines") continue;
    if (symbolFrontier.has(edge.target)) continue;
    symbolFrontier.add(edge.target);
    newSymbols.add(edge.target);
  }
  
  if (hop === 0) {
    filesFromHop1 = new Set(fileFrontier);
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

// Check: are any of the symbolFrontier symbols from files that were added in hop 1?
// (i.e., files in fileFrontier but NOT in filesFromHop1)
const filesAddedInHop1 = new Set([...fileFrontier].filter(id => !filesFromHop1.has(id)));
console.log(`Files in fileFrontier after hop 1: ${fileFrontier.size}`);
console.log(`Files added in hop 1: ${filesAddedInHop1.size}`);

const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

// Symbols from files added in hop 1
let symbolsFromHop1Files = 0;
for (const symId of symbolFrontier) {
  const fileId = symbolToFile.get(symId);
  if (fileId && filesAddedInHop1.has(fileId)) {
    symbolsFromHop1Files++;
  }
}

console.log(`Symbols in frontier from files added in hop 1: ${symbolsFromHop1Files}`);
console.log(`\nThis is the bug: symbols from hop1 files are in symbolFrontier, but the loop exited early due to budget`);
console.log(`So edge-targeting those symbols was never fully explored!`);

// How many edges from hop1Files were actually explored?
const hop1FileEdges = graph.edges.filter(e => filesAddedInHop1.has(e.source) && (e.type === 'calls' || e.type === 'references' || e.type === 'tests'));
const hop1FileEdgesInCollected = collectedEdges.filter(e => filesAddedInHop1.has(e.source));
console.log(`\nEdges from hop1 files that target symbols: ${hop1FileEdges.length}`);
console.log(`Edges from hop1 files that were collected: ${hop1FileEdgesInCollected.length}`);

