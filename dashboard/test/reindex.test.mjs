import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { getReindexState, startReindex } from "../src/lib/mcp.ts";

test("missing runtime build fails indexing visibly and permits another attempt", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "contextpro-dashboard-import-"));
  const previous = process.env.CONTEXTPRO_MCP_ROOT;
  process.env.CONTEXTPRO_MCP_ROOT = fixture;
  try {
    await assert.rejects(startReindex(fixture, false), /Cannot find module/);
    const state = getReindexState(fixture);
    assert.equal(state.running, false);
    assert.ok(state.finishedAt);
    assert.match(state.error, /Cannot find module/);
    await assert.rejects(startReindex(fixture, false), /Cannot find module/);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTPRO_MCP_ROOT;
    else process.env.CONTEXTPRO_MCP_ROOT = previous;
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a source-only indexing job reaches completion and a second run skips unchanged files", async () => {
  const fixture = await mkdtemp(
    join(tmpdir(), "contextpro-dashboard-reindex-"),
  );
  const previous = process.env.CONTEXTPRO_MCP_ROOT;
  const previousNoEmbed = process.env.CONTEXTPRO_REINDEX_NO_EMBED;
  process.env.CONTEXTPRO_MCP_ROOT = fileURLToPath(
    new URL("../../", import.meta.url),
  );
  process.env.CONTEXTPRO_REINDEX_NO_EMBED = "1";
  try {
    await writeFile(
      join(fixture, "example.ts"),
      "export const example = 42;\n",
    );
    assert.equal((await startReindex(fixture, false)).started, true);
    assert.equal((await startReindex(fixture, false)).alreadyRunning, true);
    async function finish() {
      const deadline = Date.now() + 10000;
      while (getReindexState(fixture)?.running && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      const state = getReindexState(fixture);
      assert.equal(state.running, false);
      assert.equal(state.error, undefined);
      assert.ok(state.finishedAt);
      return state;
    }
    assert.equal((await finish()).indexed, 1);
    assert.equal((await startReindex(fixture, false)).started, true);
    const second = await finish();
    assert.equal(second.indexed, 0);
    assert.equal(second.skipped, 1);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTPRO_MCP_ROOT;
    else process.env.CONTEXTPRO_MCP_ROOT = previous;
    if (previousNoEmbed === undefined)
      delete process.env.CONTEXTPRO_REINDEX_NO_EMBED;
    else process.env.CONTEXTPRO_REINDEX_NO_EMBED = previousNoEmbed;
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index lock refusal and partial repairs are never reported as completed zero-file runs", async () => {
  const { parseReindexResult } = await import("../src/lib/reindex-result.mjs");
  assert.throws(
    () =>
      parseReindexResult(
        "Reindex skipped: another reindex is already in progress.",
      ),
    /already in progress/,
  );
  assert.throws(
    () =>
      parseReindexResult(
        "Reindex complete in 10ms\n  Files: 2 total, 1 indexed, 0 skipped, 0 removed\n  Index repair required: 1 files failed to process",
      ),
    /repair required/,
  );
  assert.throws(
    () => parseReindexResult({ indexed: 0 }),
    /Unrecognized indexing result/,
  );
});
