// semantic_diff tests — AST-level symbol-change classification between revisions
// FEATURE: Report what *symbols* changed (added/removed/modified/moved) since a
// git ref, token-lean, ignoring pure reformatting — pairs with change_impact.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let root = "";

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

async function commitAll(message) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

describe("computeSemanticDiff", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "contextpro-semdiff-")));
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "t"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies added, removed, and modified symbols", async () => {
    await writeFile(join(root, "a.ts"), [
      "export function keep(): number { return 1; }",
      "export function willRemove(): void {}",
      "export function willChange(): number { return 1; }",
    ].join("\n") + "\n");
    await commitAll("base");

    await writeFile(join(root, "a.ts"), [
      "export function keep(): number { return 1; }",
      "export function added(): string { return 'x'; }",
      "export function willChange(): number { return 999; }", // body changed
    ].join("\n") + "\n");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });

    const file = result.files.find((f) => f.path === "a.ts");
    assert.ok(file, "a.ts should be in the diff");

    const names = (kind) => file.symbols.filter((s) => s.change === kind).map((s) => s.name).sort();
    assert.deepEqual(names("added"), ["added"]);
    assert.deepEqual(names("removed"), ["willRemove"]);
    assert.ok(names("modified").includes("willChange"), "willChange body changed → modified");
    assert.ok(!file.symbols.some((s) => s.name === "keep"), "unchanged symbol should not appear");
  });

  it("ignores pure reformatting (no semantic change)", async () => {
    await writeFile(join(root, "b.ts"), "export function f(){return 1;}\n");
    await commitAll("base");

    // Reformat only — same symbol, same body semantics.
    await writeFile(join(root, "b.ts"), "export function f() {\n  return 1;\n}\n");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "b.ts");
    // f moved line span but its body tokens are identical → should NOT be "modified".
    if (file) {
      assert.ok(!file.symbols.some((s) => s.name === "f" && s.change === "modified"),
        "reformat must not register as a modification");
    }
  });

  it("detects a brand-new file's symbols as added", async () => {
    await writeFile(join(root, "seed.ts"), "export const seed = 1;\n");
    await commitAll("base");

    await writeFile(join(root, "new.ts"), "export function fresh(): void {}\n");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "new.ts");
    assert.ok(file, "new.ts should appear");
    assert.ok(file.symbols.some((s) => s.name === "fresh" && s.change === "added"));
  });

  it("reports a deleted file's symbols as removed", async () => {
    await writeFile(join(root, "gone.ts"), "export function doomed(): void {}\n");
    await writeFile(join(root, "stay.ts"), "export const stay = 1;\n");
    await commitAll("base");

    await rm(join(root, "gone.ts"));

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "gone.ts");
    assert.ok(file, "deleted file should appear");
    assert.ok(file.symbols.every((s) => s.change === "removed"));
    assert.ok(file.symbols.some((s) => s.name === "doomed"));
  });

  it("reports a class METHOD change as a method change, not a coarse class change", async () => {
    await writeFile(join(root, "svc.ts"), [
      "export class Svc {",
      "  keep(): number { return 1; }",
      "  oldMethod(): void {}",
      "}",
    ].join("\n") + "\n");
    await commitAll("base");

    await writeFile(join(root, "svc.ts"), [
      "export class Svc {",
      "  keep(): number { return 1; }",
      "  newMethod(): void {}",
      "}",
    ].join("\n") + "\n");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "svc.ts");
    assert.ok(file);
    const names = file.symbols.map((s) => s.name);
    assert.ok(names.some((n) => /newMethod/.test(n)), `expected newMethod added, got ${JSON.stringify(names)}`);
    assert.ok(names.some((n) => /oldMethod/.test(n)), `expected oldMethod removed, got ${JSON.stringify(names)}`);
    // The unchanged method must not appear.
    assert.ok(!file.symbols.some((s) => /\bkeep\b/.test(s.name)), "unchanged method should not appear");
  });

  it("detects a change inside a string literal (meaningful whitespace not masked)", async () => {
    await writeFile(join(root, "msg.ts"), 'export function greet(): string { return "a b"; }\n');
    await commitAll("base");
    await writeFile(join(root, "msg.ts"), 'export function greet(): string { return "ab"; }\n');

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "msg.ts");
    assert.ok(file, "msg.ts should be in the diff");
    assert.ok(file.symbols.some((s) => s.name === "greet" && s.change === "modified"),
      "a string-content change must register as a modification");
  });

  it("detects a whitespace change INSIDE a string literal (a  b → a b)", async () => {
    await writeFile(join(root, "ws.ts"), 'export function g(): string { return "a  b"; }\n');
    await commitAll("base");
    await writeFile(join(root, "ws.ts"), 'export function g(): string { return "a b"; }\n');

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    const file = result.files.find((f) => f.path === "ws.ts");
    assert.ok(file && file.symbols.some((s) => s.name === "g" && s.change === "modified"),
      "collapsing double-space inside a string literal must NOT mask the change");
  });

  it("throws a clear error for an invalid baseline ref instead of reporting no changes", async () => {
    await writeFile(join(root, "x.ts"), "export const x = 1;\n");
    await commitAll("base");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    await assert.rejects(
      () => computeSemanticDiff(root, { since: "no-such-ref-mian" }),
      /could not diff against 'no-such-ref-mian'/,
      "an unresolvable ref must surface an error, not silently report no changes",
    );
  });

  it("produces a summary count of changes", async () => {
    await writeFile(join(root, "c.ts"), "export function a(): void {}\n");
    await commitAll("base");
    await writeFile(join(root, "c.ts"), "export function a(): void {}\nexport function b(): void {}\n");

    const { computeSemanticDiff } = await import("../../build/core/semantic-diff.js");
    const result = await computeSemanticDiff(root, { since: "HEAD" });
    assert.ok(result.summary.added >= 1, "summary should count the added symbol");
    assert.equal(typeof result.summary.modified, "number");
    assert.equal(typeof result.summary.removed, "number");
  });
});
