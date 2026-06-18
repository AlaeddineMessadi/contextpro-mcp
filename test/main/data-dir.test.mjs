import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

describe("ContextPro data directory", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextpro-data-dir-"));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("migrates nested .contextplus data into .contextpro", async () => {
    const legacyDir = join(fixtureRoot, ".contextplus");
    await mkdir(join(legacyDir, "backups", "nested"), { recursive: true });
    await writeFile(join(legacyDir, "config.json"), "{\"provider\":\"ollama\"}\n");
    await writeFile(join(legacyDir, "backups", "nested", "state.json"), "{\"ok\":true}\n");

    const { ensureContextProDir } = await import("../../build/core/data-dir.js");
    const migratedFrom = await ensureContextProDir(fixtureRoot);

    assert.equal(migratedFrom, ".contextplus");
    assert.equal(await readFile(join(fixtureRoot, ".contextpro", "config.json"), "utf8"), "{\"provider\":\"ollama\"}\n");
    assert.equal(await readFile(join(fixtureRoot, ".contextpro", "backups", "nested", "state.json"), "utf8"), "{\"ok\":true}\n");
    await access(join(fixtureRoot, ".contextpro", "hubs"));
    await assert.rejects(access(legacyDir));
  });

  it("does not overwrite an existing .contextpro directory", async () => {
    await mkdir(join(fixtureRoot, ".contextplus"), { recursive: true });
    await mkdir(join(fixtureRoot, ".contextpro"), { recursive: true });
    await writeFile(join(fixtureRoot, ".contextplus", "config.json"), "legacy\n");
    await writeFile(join(fixtureRoot, ".contextpro", "config.json"), "current\n");

    const { ensureContextProDir } = await import("../../build/core/data-dir.js");
    assert.equal(await ensureContextProDir(fixtureRoot), null);
    assert.equal(await readFile(join(fixtureRoot, ".contextpro", "config.json"), "utf8"), "current\n");
  });
});
