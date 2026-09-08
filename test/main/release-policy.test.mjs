import test from "node:test";
import assert from "node:assert/strict";
import { checkRelease, isReleaseVersion } from "../../scripts/check-release.mjs";
import { checkPackageFiles } from "../../scripts/check-package.mjs";

test("release gate rejects divergent metadata and unsafe or ambiguous tags", () => {
  const pkg = { name: "contextpro-mcp", version: "1.3.0" };
  const lock = { ...pkg, packages: { "": pkg } };
  assert.equal(checkRelease(pkg, lock, "v1.3.0"), "1.3.0");
  assert.throws(() => checkRelease(pkg, lock, "main"));
  assert.throws(() => checkRelease(pkg, { ...lock, version: "1.2.0" }));
  assert.throws(() => checkRelease(pkg, { ...lock, packages: { "": { ...pkg, version: "1.4.0" } } }));
  for (const value of ["01.3.0", "1.3.0-01", "1.3.0+build", "--help", "v1.3.0", "1.3.0;echo bad", "1.3.0\n"]) assert.equal(isReleaseVersion(value), false, value);
  for (const value of ["0.0.1", "1.3.0", "2.0.0-rc.1", "1.3.0-alpha-1"]) assert.equal(isReleaseVersion(value), true, value);
});

test("package gate rejects missing notices and accidentally bundled private records", () => {
  const files = ["package.json", "build/index.js", "LICENSE", "NOTICE", "README.md", "INSTALL.md", "SECURITY.md", "agent-instructions.md", "agent-guide.md"].map(path => ({ path }));
  assert.equal(checkPackageFiles(files), files.length);
  assert.throws(() => checkPackageFiles(files.filter(f => f.path !== "NOTICE")));
  for (const path of ["docs/benchmarks/raw.json", ".contextpro/index.db", ".env.production", "dashboard/package.json", "build/traces.jsonl"]) {
    assert.throws(() => checkPackageFiles([...files, { path }]), path);
  }
});
