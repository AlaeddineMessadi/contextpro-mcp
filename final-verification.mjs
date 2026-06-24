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
  // Line 840-846: Collect symbols from files in fileFrontier
  const newSymbols = new Set();
  for (const edge of graph.edges) {
    if (!fileFrontier.has(edge.source)) continue;
    if (edge.type !== "defines") continue;
    if (symbolFrontier.has(edge.target)) continue;
    symbolFrontier.add(edge.target);
    newSymbols.add(edge.target);
  }
  
  // Line 847-856: Collect edges and new dependent files
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

// Check if test/demo/parser.demo.mjs file was added to fileFrontier
const parserDemoFile = "file:test/demo/parser.demo.mjs";
console.log(`test/demo/parser.demo.mjs in fileFrontier: ${fileFrontier.has(parserDemoFile)}`);

// But its symbols are in symbolFrontier
const parserDemoSymbols = [...symbolFrontier].filter(id => id.includes("test/demo/parser.demo.mjs"));
console.log(`Symbols from test/demo/parser.demo.mjs in symbolFrontier: ${parserDemoSymbols.length}`);

// How did those symbols get there?
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines' && e.source === parserDemoFile);
console.log(`Defines edges from test/demo/parser.demo.mjs: ${symbolDefineEdges.length}`);
console.log(`\nThe file IS in the graph, but was never added to fileFrontier!`);
console.log(`So the symbols in symbolFrontier at line 861 include symbols from a file that won't be in nodeIds`);

