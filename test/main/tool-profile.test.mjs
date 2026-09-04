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
