import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round-4 audit: "Add a new fee model" flooded task_pack with feeds/ (websocket) files because the
// noun "fee" lexically matched the "feeds" directory (substring/prefix matching). The real fees/
// venue implementations got crowded out. This test pins the collision shut.
let root = "";
const origHome = process.env.HOME;

describe("directory-prior fee/feeds collision", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-feefeeds-"));
    process.env.HOME = root;
    await mkdir(join(root, "fees"), { recursive: true });
    await mkdir(join(root, "feeds"), { recursive: true });

    // The actual fee implementations the user wants to mirror.
    await writeFile(join(root, "fees", "base.py"), "class FeeModel:\n    def rate(self):\n        raise NotImplementedError\n");
    await writeFile(join(root, "fees", "flat.py"), "from .base import FeeModel\nclass FlatFee(FeeModel):\n    def rate(self):\n        return 0.01\n");
    await writeFile(join(root, "fees", "venue_a.py"), "from .base import FeeModel\nclass VenueAFee(FeeModel):\n    def rate(self):\n        return 0.02\n");

    // Unrelated websocket feed files that must NOT be boosted for a "fee model" task.
    await writeFile(join(root, "feeds", "websocket.py"), "class FeedSocket:\n    def connect(self):\n        return True\n");
    await writeFile(join(root, "feeds", "poller.py"), "class FeedPoller:\n    def poll(self):\n        return []\n");
    await writeFile(join(root, "feeds", "registry.py"), "class FeedRegistry:\n    def all(self):\n        return []\n");

    await writeFile(join(root, "package.json"), JSON.stringify({ name: "feefeeds-fixture", type: "module" }) + "\n");

    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: root, force: true });
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(root, { recursive: true, force: true });
  });

  it("boosts fees/ implementations and NOT feeds/ for an 'add a new fee model' task", async () => {
    const { findDirectoryPriorMatches } = await import("../../build/tools/directory-prior.js");
    const matches = await findDirectoryPriorMatches(root, "Add a new fee model for a venue");

    const paths = matches.map((m) => m.path);
    assert.ok(paths.length > 0, "expected fees/ files to be surfaced");
    assert.ok(paths.some((p) => p.startsWith("fees/")), `expected a fees/ match, got: ${paths.join(", ")}`);
    // The collision: NO feeds/ file may appear.
    assert.ok(
      paths.every((p) => !p.startsWith("feeds/")),
      `feeds/ leaked into a fee-model task: ${paths.filter((p) => p.startsWith("feeds/")).join(", ")}`,
    );
    // The base/Protocol file should be present and flagged.
    assert.ok(paths.includes("fees/base.py"), "fees/base.py (the Protocol to implement) should surface");
  });

  it("surfaces an existing impl as a copy template", async () => {
    const { findDirectoryPriorMatches } = await import("../../build/tools/directory-prior.js");
    const matches = await findDirectoryPriorMatches(root, "Add a new fee model");
    const sibling = matches.find((m) => m.path === "fees/flat.py" || m.path === "fees/venue_a.py");
    assert.ok(sibling, "an existing fee impl should be offered");
    assert.match(sibling.reason, /copy this as a template|template/i, `reason should frame it as a copy template: "${sibling.reason}"`);
  });
});
