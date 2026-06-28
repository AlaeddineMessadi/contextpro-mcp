// test_impact tests — select tests affected by changes since a git ref
// FEATURE: O(diff) reverse-dependency test selection so an agent runs only the
// tests its change can break, not the whole suite. The "covering tests" half of
// the per-PR review loop.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let root = "";

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

describe("computeTestImpact", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "contextpro-testimpact-")));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "t"]);

    await writeFile(join(root, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await writeFile(join(root, "src", "util.ts"), "import { add } from './math';\nexport function inc(n: number): number { return add(n, 1); }\n");
    await writeFile(join(root, "test", "math.test.ts"), "import { add } from '../src/math';\n// asserts add\n");
    await writeFile(join(root, "test", "util.test.ts"), "import { inc } from '../src/util';\n// asserts inc\n");

    // Index so the import graph exists.
    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({ rootDir: root, projectId: "test-impact-fixture", sessionSource: "codex" });
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

  it("selects the test that covers a changed source file", async () => {
    // Change math.ts → math.test.ts (direct) should be impacted.
    await writeFile(join(root, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b + 0; }\n");

    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });

    const paths = result.tests.map((t) => t.path);
    assert.ok(paths.includes("test/math.test.ts"), `expected math.test.ts in ${JSON.stringify(paths)}`);
  });

  it("includes transitively-affected tests via the import chain", async () => {
    // Changing math.ts also affects util.ts (imports math) → util.test.ts.
    await writeFile(join(root, "src", "math.ts"), "export function add(a: number, b: number): number { return b + a; }\n");

    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });
    const paths = result.tests.map((t) => t.path);
    assert.ok(paths.includes("test/util.test.ts"), `transitive test/util.test.ts expected in ${JSON.stringify(paths)}`);
  });

  it("includes a directly-edited test file itself", async () => {
    await writeFile(join(root, "test", "math.test.ts"), "import { add } from '../src/math';\n// asserts add twice\n");

    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });
    const paths = result.tests.map((t) => t.path);
    assert.ok(paths.includes("test/math.test.ts"), "an edited test file is itself impacted");
  });

  it("reports an empty selection when nothing changed", async () => {
    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });
    assert.equal(result.tests.length, 0);
    assert.equal(result.changedFiles.length, 0);
  });

  it("flags a full-run fallback when a config/lockfile changed", async () => {
    await writeFile(join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');

    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });
    assert.equal(result.runAll, true, "config change should force a run-all fallback");
  });

  it("forces run-all when the diff ref is invalid (does not silently skip)", async () => {
    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "no-such-ref-xyz" });
    assert.equal(result.runAll, true, "an unresolvable ref must force run-all, not 'no changes'");
    assert.match(result.runAllReason ?? "", /unknown ref|could not diff/i);
  });

  it("does not select a deleted test file as runnable", async () => {
    // Delete a test that exists in HEAD — it must NOT appear in the runnable set.
    await rm(join(root, "test", "math.test.ts"));

    const { computeTestImpact } = await import("../../build/core/test-impact.js");
    const result = await computeTestImpact(root, { since: "HEAD" });
    const paths = result.tests.map((t) => t.path);
    assert.ok(!paths.includes("test/math.test.ts"), `deleted test must not be selected, got ${JSON.stringify(paths)}`);
  });
});
