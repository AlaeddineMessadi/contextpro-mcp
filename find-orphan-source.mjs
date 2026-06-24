import { buildProjectGraph } from "./build/core/project-graph.js";

const testDir = "/path/to/contextpro-mcp";
const graph = await buildProjectGraph(testDir);

// Get a specific orphan symbol
const orphanSymId = "symbol:test/main/db.test.mjs:1:input";
const symbolDefineEdges = graph.edges.filter(e => e.type === 'defines');
const defineEdge = symbolDefineEdges.find(e => e.target === orphanSymId);

if (defineEdge) {
  const fileId = defineEdge.source;
  console.log(`Orphan symbol: ${orphanSymId}`);
  console.log(`Defining file ID: ${fileId}`);
  const fileNode = graph.nodes.find(n => n.id === fileId);
  console.log(`File node exists: ${!!fileNode}`);
  
  // Find what might have added this symbol to symbolFrontier
  const graphFileIds = new Set(graph.nodes.filter(n => n.type === 'file').map(n => n.id));
  console.log(`File in graph.nodes: ${graphFileIds.has(fileId)}`);
  
  // This symbol must have come from an edge that targeted it
  const incomingEdges = graph.edges.filter(e => e.target === orphanSymId && (e.type === 'calls' || e.type === 'references' || e.type === 'tests'));
  console.log(`\nIncoming edges targeting this symbol: ${incomingEdges.length}`);
  incomingEdges.slice(0, 3).forEach(e => {
    const sourceNode = graph.nodes.find(n => n.id === e.source);
    console.log(`  From: ${e.source} (${sourceNode?.path || 'NOT IN GRAPH'})`);
  });
}

