import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("tool profiles and MCP annotations", () => {
  it("defaults to full and recognizes the focused core profile", async () => {
    const { resolveToolProfile, isToolEnabled } = await import("../../build/core/tool-profile.js");
    assert.equal(resolveToolProfile(), "full");
    assert.equal(resolveToolProfile("CORE"), "core");
    assert.equal(resolveToolProfile("unexpected"), "full");
    assert.equal(isToolEnabled("search", "core"), true);
    assert.equal(isToolEnabled("graph_query", "core"), true);
    assert.equal(isToolEnabled("efficiency_report", "core"), true);
    assert.equal(isToolEnabled("memory_bulk", "core"), false);
    assert.equal(isToolEnabled("memory_bulk", "full"), true);
    assert.equal(isToolEnabled("unknown_future_tool", "full"), true);
  });

  it("marks reads, writes, and destructive source edits accurately", async () => {
    const { annotationsForTool } = await import("../../build/core/tool-profile.js");
    assert.deepEqual(annotationsForTool("search"), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(annotationsForTool("reindex"), {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(annotationsForTool("replace_symbol_body"), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("applies the core profile, annotations, and graph output schema at registration", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerTools } = await import("../../build/tools/register-tools.js");
    const previous = process.env.CONTEXTPRO_TOOL_PROFILE;
    process.env.CONTEXTPRO_TOOL_PROFILE = "core";
    try {
      const server = new McpServer({ name: "profile-test", version: "0.0.0" });
      registerTools(server, process.cwd(), (handler) => handler, () => {});
      const registered = server._registeredTools;
      assert.ok(registered.search);
      assert.ok(registered.graph_query);
      assert.equal(registered.memory_bulk, undefined);
      assert.equal(registered.search.annotations.readOnlyHint, true);
      assert.equal(registered.restore.annotations.destructiveHint, true);
      assert.ok(registered.graph_query.outputSchema, "graph_query should advertise structured output");
    } finally {
      if (previous === undefined) delete process.env.CONTEXTPRO_TOOL_PROFILE;
      else process.env.CONTEXTPRO_TOOL_PROFILE = previous;
    }
  });
});

describe('workflow profile budget', () => {
  it('exposes twelve useful tools and a substantially smaller protocol catalog', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { registerTools } = await import('../../build/tools/register-tools.js');
    const old = process.env.CONTEXTPRO_TOOL_PROFILE;
    const sizes = {};
    try {
      for (const profile of ['workflow', 'core', 'full']) {
        process.env.CONTEXTPRO_TOOL_PROFILE = profile;
        const server = new McpServer({ name: 'profile', version: '0' });
        registerTools(server, process.cwd(), handler => handler, () => {});
        const client = new Client({ name: 'test', version: '0' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const catalog = await client.listTools();
        sizes[profile] = Buffer.byteLength(JSON.stringify(catalog));
        if (profile === 'workflow') {
          assert.equal(catalog.tools.length, 12);
          for (const name of ['task_pack', 'efficiency_report', 'reindex', 'artifact_read']) assert.ok(catalog.tools.some(t => t.name === name));
          assert.ok(!catalog.tools.some(t => t.name === 'rename_symbol'));
        }
        await client.close(); await server.close();
      }
      assert.ok(sizes.workflow < sizes.core * .6);
      assert.ok(sizes.workflow < 24000, `catalog grew to ${sizes.workflow} bytes`);
    } finally {
      if (old === undefined) delete process.env.CONTEXTPRO_TOOL_PROFILE;
      else process.env.CONTEXTPRO_TOOL_PROFILE = old;
    }
  });
});
