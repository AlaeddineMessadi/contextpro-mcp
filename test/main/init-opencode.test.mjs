import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

describe("init-opencode", () => {
  it("writes valid opencode.json for npx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-opencode-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "opencode",
          "--runner=npx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, "opencode.json"), "utf8");
      const cfg = JSON.parse(raw);
      assert.equal(cfg.$schema, "https://opencode.ai/config.json");
      assert.equal(cfg.mcp.contextplus.type, "local");
      assert.deepEqual(cfg.mcp.contextplus.command, [
        "npx",
        "-y",
        "contextplus",
      ]);
      assert.equal(cfg.mcp.contextplus.enabled, true);
      assert.equal(
        cfg.mcp.contextplus.environment.OLLAMA_EMBED_MODEL,
        "nomic-embed-text",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes valid opencode.json for bunx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-opencode-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "opencode",
          "--runner=bunx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, "opencode.json"), "utf8");
      const cfg = JSON.parse(raw);
      assert.deepEqual(cfg.mcp.contextplus.command, ["bunx", "contextplus"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
