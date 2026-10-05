import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects } from "../src/lib/projects.ts";

test("an explicit unindexed workspace is available for its first Create index", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextpro-dashboard-project-"));
  const previous = process.env.CONTEXTPRO_DASHBOARD_ROOT;
  process.env.CONTEXTPRO_DASHBOARD_ROOT = root;
  try {
    const project = (await listProjects()).find((p) => p.root === root);
    assert.equal(project?.hasIndex, false);
    assert.equal(project?.available, true);
    await rm(root, { recursive: true, force: true });
    assert.equal(
      (await listProjects()).find((p) => p.root === root)?.available,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.CONTEXTPRO_DASHBOARD_ROOT;
    else process.env.CONTEXTPRO_DASHBOARD_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
