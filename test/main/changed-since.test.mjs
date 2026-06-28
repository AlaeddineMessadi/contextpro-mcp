// changed_since pack tests — one call combining what-changed + tests + impact
// FEATURE: The per-PR review pack: semantic_diff (what symbols changed) +
// test_impact (which tests to run) + a blast-radius-style impact summary
// (which files depend on the changed ones), since a git ref.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let root = "";
function git(args) { execFileSync("git", args, { cwd: root, stdio: "pipe" }); }

describe("computeChangedSince", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "contextpro-changed-")));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "t"]);

    await writeFile(join(root, "src", "core.ts"), "export function core(): number { return 1; }\n");
    await writeFile(join(root, "src", "user.ts"), "import { core } from './core';\nexport function user(): number { return core(); }\n");
    await writeFile(join(root, "test", "core.test.ts"), "import { core } from '../src/core';\n// test\n");

    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({ rootDir: root, projectId: "changed-since-fixture", sessionSource: "codex" });
    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: root, force: true });

    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("combines symbol changes, impacted tests, and dependent files", async () => {
    await writeFile(join(root, "src", "core.ts"), "export function core(): number { return 2; }\n");

    const { computeChangedSince } = await import("../../build/core/changed-since.js");
    const result = await computeChangedSince(root, { since: "HEAD" });

    // semantic diff section
    assert.ok(result.changes.files.some((f) => f.path === "src/core.ts"), "core.ts should be in changes");
    // test impact section
    assert.ok(result.tests.tests.some((t) => t.path === "test/core.test.ts"), "core.test.ts impacted");
    // dependents (user.ts imports core.ts)
    assert.ok(
      result.dependents.some((d) => d.path === "src/core.ts" && d.importers.includes("src/user.ts")),
      `expected user.ts among core.ts dependents, got ${JSON.stringify(result.dependents)}`,
    );
  });

  it("renders a token-lean text pack", async () => {
    await writeFile(join(root, "src", "core.ts"), "export function core(): number { return 3; }\n");
    const { getChangedSince } = await import("../../build/tools/changed-since.js");
    const text = await getChangedSince({ rootDir: root, since: "HEAD" });
    assert.match(text, /Changed Since/);
    assert.match(text, /core\.ts/);
  });

  it("is empty when nothing changed", async () => {
    const { computeChangedSince } = await import("../../build/core/changed-since.js");
    const result = await computeChangedSince(root, { since: "HEAD" });
    assert.equal(result.changes.files.length, 0);
    assert.equal(result.tests.tests.length, 0);
  });
});
