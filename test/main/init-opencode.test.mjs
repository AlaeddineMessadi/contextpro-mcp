import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
      assert.equal(cfg.mcp.contextpro.type, "local");
      assert.deepEqual(cfg.mcp.contextpro.command, [
        "npx",
        "-y",
        "contextpro-mcp",
      ]);
      assert.equal(cfg.mcp.contextpro.enabled, true);
      assert.equal(
        cfg.mcp.contextpro.environment.CONTEXTPRO_PROVIDER,
        "ollama",
      );
      assert.equal(
        cfg.mcp.contextpro.environment.CONTEXTPRO_EMBED_MODEL,
        "nomic-embed-text:latest",
      );
      assert.equal(Object.hasOwn(cfg.mcp.contextpro.environment, "CONTEXTPRO_CHAT_MODEL"), false);
      assert.equal(
        Object.hasOwn(cfg.mcp.contextpro.environment, "CONTEXTPRO_API_KEY"),
        false,
      );
      await access(join(cwd, ".contextpro", "config.json"));
      await assert.rejects(access(join(cwd, ".contextplus")));
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
      assert.deepEqual(cfg.mcp.contextpro.command, ["bunx", "contextpro-mcp"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('init preserves existing projects', () => {
  it('uses explicit root, migrates legacy data, and keeps customized servers on rerun', async () => {
    const { mkdir } = await import('node:fs/promises');
    const scratch = await mkdtemp(join(tmpdir(), 'contextpro-init-safe-'));
    const root = join(scratch, 'project');
    await mkdir(join(root, '.contextplus'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, '.contextplus', 'keep.txt'), 'legacy data');
    await writeFile(join(root, 'opencode.json'), JSON.stringify({ mcp: { other: { type: 'local', command: ['other'] }, contextpro: { type: 'local', command: ['custom'] } } }));
    await writeFile(join(root, 'AGENTS.md'), '# Existing user instructions\n');
    try {
      for (let i = 0; i < 2; i++) await execFileAsync(process.execPath, [join(process.cwd(), 'build/index.js'), 'init', 'opencode', '--root', root], { cwd: scratch });
      assert.equal(await readFile(join(root, '.contextpro', 'keep.txt'), 'utf8'), 'legacy data');
      const config = JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8'));
      assert.deepEqual(config.mcp.other.command, ['other']);
      assert.deepEqual(config.mcp.contextpro.command, ['custom']);
      const rules = await readFile(join(root, 'AGENTS.md'), 'utf8');
      assert.match(rules, /^# Existing user instructions/);
      assert.equal(rules.split('contextpro:begin').length, 2);
      await assert.rejects(access(join(scratch, 'opencode.json')));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
