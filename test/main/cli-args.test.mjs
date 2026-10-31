import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const cli = join(process.cwd(), "build", "index.js");
// A regression that starts the stdio server instead of exiting times out and fails.
const opts = (cwd) => ({ cwd, timeout: 10000 });

describe("cli flags", () => {
  it("--version and --help exit 0 without starting a server or creating directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextpro-cli-"));
    try {
      const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
      assert.equal((await run(process.execPath, [cli, "--version"], opts(cwd))).stdout.trim(), pkg.version);
      assert.match((await run(process.execPath, [cli, "--help"], opts(cwd))).stdout, /init[\s\S]*--root/);
      assert.match((await run(process.execPath, [cli, "init", "-h"], opts(cwd))).stdout, /Usage:/);
      assert.deepEqual(await readdir(cwd), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown options and missing roots without creating them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextpro-cli-"));
    try {
      await assert.rejects(run(process.execPath, [cli, "--bogus"], opts(cwd)), (e) => e.code === 1 && /Unknown option "--bogus"/.test(e.stderr) && !/\n\s+at /.test(e.stderr));
      await assert.rejects(run(process.execPath, [cli, "--root", join(cwd, "missing")], opts(cwd)), (e) => e.code === 1 && /does not exist/.test(e.stderr));
      await assert.rejects(run(process.execPath, [cli, "init", "notaclient"], opts(cwd)), (e) => e.code === 1 && /Unsupported coding agent/.test(e.stderr) && !/\n\s+at /.test(e.stderr));
      assert.deepEqual(await readdir(cwd), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a user-edited .contextpro/.gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextpro-cli-"));
    try {
      await mkdir(join(cwd, ".contextpro"));
      await writeFile(join(cwd, ".contextpro", ".gitignore"), "index.db\n");
      await run(process.execPath, [cli, "doctor", "--root", cwd], opts(cwd));
      assert.equal(await readFile(join(cwd, ".contextpro", ".gitignore"), "utf8"), "index.db\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
