import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round-4 A+ items: read-through cache reuse for task_pack, artifact/restore-point GC, sizes in
// artifact_list. These pin the economic (not correctness) gap between A and A+.
let root = "";
const origHome = process.env.HOME;

async function indexFixture(dir) {
  const reindexMod = await import("../../build/tools/reindex.js");
  await reindexMod.reindex({ rootDir: dir, force: true });
}

describe("artifact cache + GC", () => {
  it("reads and lists stored artifacts through a different alias of the same root", async () => {
    const { persistArtifact, readArtifact, listArtifacts } = await import("../../build/core/artifacts.js");
    const artifact = await persistArtifact({rootDir:root,kind:"handoff",key:"alias",payload:{completed:"kept"},immutable:true});
    const alias = join(root,"alias");
    await symlink(root,alias,process.platform === "win32" ? "junction" : "dir");
    assert.equal((await readArtifact(alias,artifact.id)).payload.completed,"kept");
    assert.ok((await listArtifacts(alias)).find(item=>item.id===artifact.id).sizeBytes>0);
  });
  it("bounds long artifact keys in MCP discovery output", async () => {
    const { compactArtifactListKeys } = await import("../../build/tools/register-tools.js");
    const longKey = "x".repeat(15_000);
    const [artifact] = compactArtifactListKeys([{ id: "a", key: longKey }]);
    assert.equal(artifact.key.length, 240);
    assert.equal(artifact.keyTruncated, true);
    assert.equal(artifact.keyLength, longKey.length);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-cachegc-"));
    process.env.HOME = root;
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n");
    await writeFile(join(root, "src", "user.ts"), "export function getUser() { return {}; }\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "cachegc-fixture", type: "module" }) + "\n");
    await indexFixture(root);
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(root, { recursive: true, force: true });
  });

  it("task_pack serves a fresh cache hit without recomputing", async () => {
    const { buildTaskPack } = await import("../../build/tools/agentic-context.js");
    const first = await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });
    const second = await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });

    const p1 = JSON.parse(first);
    const p2 = JSON.parse(second);
    // Same ranked files both times.
    assert.deepEqual(p2.files.map((f) => f.path), p1.files.map((f) => f.path));
    // The second call is explicitly served from cache.
    const evidence = (p2.trust?.evidence ?? []).join(" ");
    assert.match(evidence, /served from artifact cache/, `2nd call should be a cache hit: ${evidence}`);
  });

  it("a new index generation invalidates the cache (recompute, not stale serve)", async () => {
    const { buildTaskPack } = await import("../../build/tools/agentic-context.js");
    await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });

    // Advance the index generation by reindexing.
    await indexFixture(root);

    const after = JSON.parse(await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" }));
    const evidence = (after.trust?.evidence ?? []).join(" ");
    assert.doesNotMatch(evidence, /served from artifact cache/, "a bumped generation must force recompute");
  });

  it("a STALE index (new file, not reindexed) forces recompute, never a stale cache serve", async () => {
    const { buildTaskPack } = await import("../../build/tools/agentic-context.js");
    // Prime the cache while fresh.
    await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });

    // Add a source file WITHOUT reindexing — generation is unchanged, but the index is now stale.
    await writeFile(join(root, "src", "payments.ts"), "export function charge() { return 0; }\n");

    const after = JSON.parse(await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" }));
    const evidence = (after.trust?.evidence ?? []).join(" ");
    assert.doesNotMatch(evidence, /served from artifact cache/, "a stale index must NOT serve a pre-change cached pack");
  });

  it("artifact_list reports sizeBytes for each artifact", async () => {
    const { buildTaskPack } = await import("../../build/tools/agentic-context.js");
    const { listArtifacts } = await import("../../build/core/artifacts.js");
    await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });

    const list = await listArtifacts(root, "task_pack", 20);
    assert.ok(list.length > 0, "expected at least one task_pack artifact");
    for (const ref of list) {
      assert.equal(typeof ref.sizeBytes, "number");
      assert.ok(ref.sizeBytes > 0, `sizeBytes should be positive, got ${ref.sizeBytes}`);
    }
  });

  it("garbageCollectArtifacts removes dead files but KEEPS valid (even LRU-evicted) artifacts", async () => {
    const { utimes } = await import("node:fs/promises");
    const { buildTaskPack } = await import("../../build/tools/agentic-context.js");
    const { garbageCollectArtifacts, readArtifact } = await import("../../build/core/artifacts.js");
    await buildTaskPack({ rootDir: root, task: "fix the login flow", format: "json" });

    const dir = join(root, ".contextpro", "artifacts", "task_pack");
    await mkdir(dir, { recursive: true });

    // (1) A genuinely DEAD file: corrupt JSON that can't parse as an artifact. Old mtime so it's
    //     past the GC grace window.
    const corruptPath = join(dir, "task_pack-corruptzzzzzz.json");
    await writeFile(corruptPath, "{ not valid json ");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(corruptPath, old, old);

    // (2) A VALID artifact that is NOT in the raw manifest (simulating an LRU-evicted but still-served
    //     artifact). It must SURVIVE GC because readArtifact serves it via the disk-scan fallback.
    const evictedId = "task_pack-evicteddddddd";
    const evictedPath = join(dir, `${evictedId}.json`);
    await writeFile(evictedPath, JSON.stringify({
      id: evictedId, kind: "task_pack", key: "{\"task\":\"evicted\"}", path: evictedPath,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      repoRoot: root, repoFingerprint: null, projectId: null, clientId: null, metadata: {}, payload: { files: [] },
    }));
    await utimes(evictedPath, old, old);

    const result = await garbageCollectArtifacts(root);

    // The corrupt/dead file is gone.
    assert.ok(result.deletedFiles >= 1, "should delete the dead corrupt file");
    await assert.rejects(readFile(corruptPath, "utf-8"), "corrupt file should be deleted");
    // The valid evicted artifact is KEPT (the HIGH-severity data-loss bug from the audit).
    const survived = await readArtifact(root, evictedId);
    assert.ok(survived, "a valid (disk-served) artifact must NOT be deleted by GC");
  });

  it("garbageCollectRestorePoints removes orphaned backup folders", async () => {
    const { createRestorePoint, garbageCollectRestorePoints } = await import("../../build/git/shadow.js");
    await writeFile(join(root, "src", "auth.ts"), "export function login() { return false; }\n");
    await createRestorePoint(root, ["src/auth.ts"], "snap");

    // Plant an orphan backup dir not present in the manifest, with an OLD mtime (past the grace window).
    const { utimes } = await import("node:fs/promises");
    const orphanBackup = join(root, ".contextpro", "backups", "backups", "rp-orphan-zzz");
    await mkdir(orphanBackup, { recursive: true });
    await writeFile(join(orphanBackup, "x.bak"), "y".repeat(300));
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(orphanBackup, old, old);

    const result = await garbageCollectRestorePoints(root);
    assert.ok(result.deletedPoints >= 1, "should delete the orphan backup dir");
    assert.ok(result.freedBytes > 0, "should report freed bytes");
    // Orphan dir should be gone.
    const remaining = await readdir(join(root, ".contextpro", "backups", "backups")).catch(() => []);
    assert.ok(!remaining.includes("rp-orphan-zzz"), "orphan backup dir should be removed");
  });
});
