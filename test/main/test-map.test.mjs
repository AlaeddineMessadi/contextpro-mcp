import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
let fixtureRoot = "";

describe("test-map", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextpro-test-map-"));
    await mkdir(join(fixtureRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    const dbMod = await import("../../build/core/db.js");
    dbMod.closeDB(fixtureRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("maps tests for the last commit when changed is requested on a clean tree", async () => {
    await writeFile(
      join(fixtureRoot, "src", "imageValidation.ts"),
      [
        "export function validateImageFile(file: File): boolean {",
        "  return file.size > 0;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "src", "imageValidation.test.ts"),
      [
        "import { validateImageFile } from './imageValidation';",
        "validateImageFile({ size: 1 } as File);",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["init"], { cwd: fixtureRoot });
    await execFileAsync("git", ["config", "user.email", "contextpro@example.com"], { cwd: fixtureRoot });
    await execFileAsync("git", ["config", "user.name", "ContextPro Test"], { cwd: fixtureRoot });
    await execFileAsync("git", ["add", "src/imageValidation.ts", "src/imageValidation.test.ts"], { cwd: fixtureRoot });
    await execFileAsync("git", ["commit", "-m", "add image validation"], { cwd: fixtureRoot });

    const testMapMod = await import("../../build/tools/test-map.js");
    const result = await testMapMod.getTestMap({
      rootDir: fixtureRoot,
      changed: true,
    });

    assert.match(result, /src\/imageValidation\.ts/);
    assert.match(result, /src\/imageValidation\.test\.ts/);
  });
});
