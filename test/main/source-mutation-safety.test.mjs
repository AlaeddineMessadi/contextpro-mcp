import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, stat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectPath } from "../../build/core/path-guard.js";
import { captureSource, publishSource, withSourceMutation } from "../../build/core/source-mutation.js";
import { replaceSymbolBody, insertAroundSymbol, renameSymbol, findSymbol } from "../../build/tools/symbolic-edit.js";
import { proposeCommit } from "../../build/tools/propose-commit.js";
import { createRestorePoint, restorePoint, listRestorePoints } from "../../build/git/shadow.js";
import { reindex } from "../../build/tools/reindex.js";
import { ensureContextProDir } from "../../build/core/data-dir.js";
import { persistArtifact, readArtifact } from "../../build/core/artifacts.js";
import { closeDB, getDB } from "../../build/core/db.js";

const exec = promisify(execFile);
let sandbox, root, outside;
const edit = (name, body) => ({ rootDir: root, relativePath: "code.ts", namePath: name, body });

describe("source mutation safety", () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "ctx-source-safety-"));
    root = join(sandbox, "root"); outside = join(sandbox, "outside");
    await mkdir(root); await mkdir(outside);
  });
  afterEach(async () => { closeDB(); await rm(sandbox, { recursive: true, force: true }); });

  it("blocks escaped file and directory symlinks, including new children", async () => {
    await writeFile(join(outside, "secret.ts"), "export const secret = 1;");
    await symlink(join(outside, "secret.ts"), join(root, "file.ts"));
    await symlink(outside, join(root, "dir"));
    assert.throws(() => resolveProjectPath(root, "file.ts"), /escapes project root/);
    assert.throws(() => resolveProjectPath(root, "dir/new/deep.ts"), /escapes project root/);
    await assert.rejects(proposeCommit({ rootDir: root, filePath: "dir/new.ts", newContent: "bad" }), /escapes project root/);
    assert.equal(await readFile(join(outside, "secret.ts"), "utf8"), "export const secret = 1;");
  });

  it("allows contained symlink reads but refuses source mutations through them", async () => {
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }");
    await symlink(join(root, "code.ts"), join(root, "alias.ts"));
    assert.equal(resolveProjectPath(root, "alias.ts"), join(root, "alias.ts"));
    await assert.rejects(proposeCommit({ rootDir: root, filePath: "alias.ts", newContent: "changed" }), /refuses symlink/);
  });

  it("refuses a backup directory that points outside the project", async () => {
    await mkdir(join(root, ".contextpro"));
    await symlink(outside, join(root, ".contextpro", "backups"));
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }");
    await assert.rejects(replaceSymbolBody(edit("alpha", "export function alpha() { return 2; }")), /escapes project root/);
    assert.deepEqual(await readdir(outside), []);
  });

  it("preserves independent concurrent symbol replacements and their backups", async () => {
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }\nexport function beta() { return 2; }\n");
    await Promise.all([
      replaceSymbolBody(edit("alpha", "export function alpha() { return 101; }")),
      replaceSymbolBody(edit("beta", "export function beta() { return 202; }")),
    ]);
    const after = await readFile(join(root, "code.ts"), "utf8");
    assert.match(after, /return 101/); assert.match(after, /return 202/);
    assert.equal((await listRestorePoints(root)).length, 2);
  });

  it("coordinates writes and backup manifests across separate processes", async () => {
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }\nexport function beta() { return 2; }\n");
    const module = pathToFileURL(resolve("build/tools/symbolic-edit.js")).href;
    const run = (name, value) => exec(process.execPath, ["--input-type=module", "-e", `
      const {replaceSymbolBody} = await import(${JSON.stringify(module)});
      await replaceSymbolBody(${JSON.stringify(edit(name, `export function ${name}() { return ${value}; }`))});
    `], { env: { ...process.env, CONTEXTPLUS_NATIVE_AUTO_REPAIR: "false" } });
    await Promise.all([run("alpha", 111), run("beta", 222)]);
    const after = await readFile(join(root, "code.ts"), "utf8");
    assert.match(after, /return 111/); assert.match(after, /return 222/);
    assert.equal((await listRestorePoints(root)).length, 2);
  });

  it("preserves a same-line sibling and Unicode/CRLF/BOM bytes", async () => {
    const prefix = "\uFEFF// 🦊 café\r\n";
    const sibling = " export function beta() { return '😀'; }\r\n";
    await writeFile(join(root, "code.ts"), prefix + "export function alpha() { return 1; }" + sibling);
    await replaceSymbolBody(edit("alpha", "export function alpha() { return 9; }"));
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), prefix + "export function alpha() { return 9; }" + sibling);
  });

  for (const declaration of [
    "export default\nfunction alpha() { return 1; }",
    "export function alpha() { return 1; }",
    "export default\nclass alpha { value = 1; }",
    "export const alpha = 1;",
    "export default function alpha() { return 1; }",
  ]) {
    it(`round-trips the exact exported body: ${declaration.split("\n")[0]}`, async () => {
      const prefix = "\uFEFF// 🦊 café\r\n";
      const body = declaration.replace(/\n/g, "\r\n");
      const suffix = " export function beta() { return 2; }\r\n";
      await writeFile(join(root, "code.ts"), prefix + body + suffix);
      const found = JSON.parse(await findSymbol({ rootDir: root, relativePath: "code.ts", namePathPattern: "alpha", includeBody: true, format: "json" }));
      const symbol = found.results[0];
      assert.equal(symbol.line, 2);
      assert.equal(symbol.endLine, 2 + declaration.split("\n").length - 1);
      assert.equal(symbol.body, body, "returned body must match the editable span without its sibling");
      await replaceSymbolBody({ ...edit("alpha", symbol.body.replace("1", "9")), expectedContentHash: symbol.contentHash });
      assert.equal(await readFile(join(root, "code.ts"), "utf8"), prefix + body.replace("1", "9") + suffix);
    });
  }

  it("preserves inline class members when replacing or inserting", async () => {
    await writeFile(join(root, "code.ts"), "export class A { alpha() { return 1; } beta() { return 2; } }\n");
    await replaceSymbolBody(edit("A/alpha", "alpha() { return 9; }"));
    await insertAroundSymbol({ ...edit("A/alpha", "gamma() { return 3; }"), position: "after" });
    const after = await readFile(join(root, "code.ts"), "utf8");
    assert.match(after, /class A/); assert.match(after, /alpha\(\) \{ return 9; \}/);
    assert.match(after, /beta\(\) \{ return 2; \}/); assert.match(after, /gamma\(\)/);
  });

  it("refuses replacing one binding of a shared declaration", async () => {
    const original = "export const alpha = 1, beta = 2;\n";
    await writeFile(join(root, "code.ts"), original);
    await assert.rejects(replaceSymbolBody(edit("alpha", "export const alpha = 9;")), /unambiguous exact source span/);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), original);
  });

  it("detects external writes and preserves executable permissions", async () => {
    await writeFile(join(root, "code.ts"), "old"); await chmod(join(root, "code.ts"), 0o751);
    await withSourceMutation(root, async () => {
      const snapshot = captureSource(root, "code.ts");
      await writeFile(join(root, "code.ts"), "external editor");
      await assert.rejects(publishSource(root, snapshot, "lost write"), /Source conflict/);
    });
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), "external editor");
    await proposeCommit({ rootDir: root, filePath: "code.ts", newContent: "export const x = 1;" });
    assert.equal((await stat(join(root, "code.ts"))).mode & 0o777, 0o751);
  });

  it("returns a usable content hash and rejects stale explicit revisions", async () => {
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }");
    const found = JSON.parse(await findSymbol({ rootDir: root, relativePath: "code.ts", namePathPattern: "alpha", format: "json" }));
    const expectedContentHash = found.results[0].contentHash;
    assert.match(expectedContentHash, /^[a-f0-9]{64}$/);
    await writeFile(join(root, "code.ts"), "export function alpha() { return 2; }");
    await assert.rejects(replaceSymbolBody({ ...edit("alpha", "export function alpha() { return 9; }"), expectedContentHash }), /Source conflict/);
  });

  it("rejects keyword rename before modifying any file or creating a backup", async () => {
    const original = "export function alpha() { return 1; }\n";
    await writeFile(join(root, "code.ts"), original);
    await assert.rejects(renameSymbol({ rootDir: root, relativePath: "code.ts", namePath: "alpha", newName: "for" }), /reserved keyword/);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), original);
    assert.deepEqual(await listRestorePoints(root), []);
  });

  it("validates all rename candidates before publishing the definition", async () => {
    const original = "export function alpha() { return 1; }\n";
    await writeFile(join(root, "code.ts"), original);
    await writeFile(join(root, "caller.ts"), "import { alpha } from './code';\nalpha();\n");
    await reindex({ rootDir: root, force: true, noEmbed: true });
    await writeFile(join(root, "caller.ts"), "import { alpha } from './code';\nalpha( ;\n");
    await assert.rejects(renameSymbol({ rootDir: root, relativePath: "code.ts", namePath: "alpha", newName: "beta" }), /caller.ts.*No files were modified/);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), original);
    assert.deepEqual(await listRestorePoints(root), []);
  });

  it("blocks restore when a captured source parent becomes an escaped symlink", async () => {
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "a.ts"), "original");
    const point = await createRestorePoint(root, ["src/a.ts"], "snapshot");
    await rm(join(root, "src"), { recursive: true }); await symlink(outside, join(root, "src"));
    await assert.rejects(restorePoint(root, point.id), /escapes project root/);
    assert.deepEqual(await readdir(outside), []);
  });
  it("blocks internal storage and SQLite sidecar symlinks outside the project", async () => {
    await symlink(outside, join(root, ".contextpro"));
    await assert.rejects(ensureContextProDir(root), /escapes project root/);
    await assert.rejects(persistArtifact({ rootDir: root, kind: "test", key: "key", payload: {} }), /escapes project root/);
    await unlink(join(root, ".contextpro"));
    await mkdir(join(root, ".contextpro"));
    await writeFile(join(outside, "wal"), "keep");
    await symlink(join(outside, "wal"), join(root, ".contextpro", "index.db-wal"));
    await assert.rejects(getDB(root), /escapes project root/);
    assert.equal(await readFile(join(outside, "wal"), "utf8"), "keep");
  });

  it("rejects an artifact manifest pointing outside the project", async () => {
    const base = join(root, ".contextpro", "artifacts");
    await mkdir(base, { recursive: true });
    const path = join(outside, "secret.json");
    await writeFile(path, JSON.stringify({ id: "poisoned", payload: "private" }));
    await writeFile(join(base, "manifest.json"), JSON.stringify({ artifacts: [{ id: "poisoned", kind: "test", key: "key", updatedAt: "2026", path }] }));
    await assert.rejects(readArtifact(root, "poisoned"), /escapes project root/);
  });

  it("recovers an abandoned process lock without losing concurrent updates", async () => {
    const { stdout } = await exec(process.execPath, ["-e", "console.log(process.pid)"]);
    const pid = Number(stdout.trim());
    const lock = join(root, ".contextpro", "source-mutation.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid, token: "abandoned" }));
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }\nexport function beta() { return 2; }\n");
    await Promise.all([
      replaceSymbolBody(edit("alpha", "export function alpha() { return 101; }")),
      replaceSymbolBody(edit("beta", "export function beta() { return 202; }")),
    ]);
    const after = await readFile(join(root, "code.ts"), "utf8");
    assert.match(after, /return 101/); assert.match(after, /return 202/);
  });

  it("migrates legacy data before a direct source edit creates its lock directory", async () => {
    await mkdir(join(root, ".contextplus"));
    await writeFile(join(root, ".contextplus", "existing-index.txt"), "legacy data");
    await writeFile(join(root, "code.ts"), "export function alpha() { return 1; }");
    await replaceSymbolBody(edit("alpha", "export function alpha() { return 2; }"));
    assert.equal(await readFile(join(root, ".contextpro", "existing-index.txt"), "utf8"), "legacy data");
    await assert.rejects(stat(join(root, ".contextplus")), /ENOENT/);
  });

});
