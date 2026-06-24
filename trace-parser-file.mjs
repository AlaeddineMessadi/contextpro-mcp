import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

const startNode = graph.nodes.find(n => n.path === "src/core/db.ts" && n.type === 'file');
const fileFrontier = new Set([startNode.id]);
const symbolFrontier = new Set();
const collectedEdges = [];
const edgeBudget = 50;

const parserDemoFile = "file:test/demo/parser.demo.mjs";
let addedInHop = null;

const MAX_HOPS = 3;
for (let hop = 0; hop < MAX_HOPS && collectedEdges.length < edgeBudget; hop++) {
  const hadParserBefore = fileFrontier.has(parserDemoFile);
  
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
  for (const id of newDependents) {
    if (id === parserDemoFile) {
      console.log(`ADDING parser.demo.mjs at hop ${hop}`);
      addedInHop = hop;
    }
    fileFrontier.add(id);
  }
  
  const hasParserNow = fileFrontier.has(parserDemoFile);
  if (!hadParserBefore && hasParserNow) {
    console.log(`parser.demo.mjs added in hop ${hop}`);
    addedInHop = hop;
  }
}

console.log(`parser.demo.mjs added in hop: ${addedInHop}`);

// But check the actual final nodeIds
const nodeIds = new Set([...fileFrontier, ...symbolFrontier]);
const parserSymbols = [...symbolFrontier].filter(id => id.includes("test/demo/parser.demo.mjs"));
console.log(`parser.demo symbols in symbolFrontier: ${parserSymbols.length}`);
console.log(`parser.demo file in fileFrontier: ${fileFrontier.has(parserDemoFile)}`);
console.log(`parser.demo file in nodeIds: ${nodeIds.has(parserDemoFile)}`);

// Wait - is the file SUPPOSED to be there?
if (addedInHop >= 1 && collectedEdges.length >= edgeBudget) {
  console.log(`\nAH! The file was added AFTER the budget was exhausted!`);
  console.log(`So at hop ${addedInHop}, we added 8 files to fileFrontier...`);
  console.log(`But we had already hit the budget in hop 1, so the loop condition will prevent hop 2`);
}

