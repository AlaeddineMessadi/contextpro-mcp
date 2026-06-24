import { queryProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";

const result = await queryProjectGraph(testDir, {
  kind: "impact",
  file: "src/core/db.ts",
  limit: 50
});

// Check if parser.demo.mjs IS in the result
const parserFile = "file:test/demo/parser.demo.mjs";
const inResult = result.nodes.find(n => n.id === parserFile);
console.log(`test/demo/parser.demo.mjs in result.nodes: ${!!inResult}`);

// Check the specific orphan again
const orphanSym = "symbol:test/demo/parser.demo.mjs:112:input";
const orphanNode = result.nodes.find(n => n.id === orphanSym);
console.log(`symbol:test/demo/parser.demo.mjs:112:input in result.nodes: ${!!orphanNode}`);

if (orphanNode && inResult) {
  console.log(`Both in result - not actually orphaned!`);
} else if (orphanNode && !inResult) {
  console.log(`Symbol in result but file NOT - THIS IS THE BUG`);
}

// Count again with ALL symbols
const fileNodes = result.nodes.filter(n => n.type === 'file');
const symbolNodes = result.nodes.filter(n => n.type === 'symbol');
const symbolDefineEdges = result.graph.edges.filter(e => e.type === 'defines');
const symbolToFile = new Map();
for (const edge of symbolDefineEdges) {
  symbolToFile.set(edge.target, edge.source);
}

const resultFileIds = new Set(fileNodes.map(n => n.id));
let orphans = 0;
for (const sym of symbolNodes) {
  const fileId = symbolToFile.get(sym.id);
  if (!fileId || !resultFileIds.has(fileId)) {
    orphans++;
  }
}

console.log(`\nTotal orphans in result: ${orphans}`);

