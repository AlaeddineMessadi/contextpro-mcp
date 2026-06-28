// Ignore-directory policy tests
// FEATURE: A comprehensive, framework-aware set of build/dependency/cache dirs to
// skip during indexing — the safety net when a project's .gitignore is absent or
// incomplete, so the index never wastes time/tokens on node_modules, target,
// .venv, .next, vendor, etc. .gitignore is still honored separately.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAlwaysIgnoredDir, ALWAYS_IGNORE_DIRS } from "../../build/core/ignore-dirs.js";

describe("isAlwaysIgnoredDir", () => {
  it("ignores common dependency and VCS dirs", () => {
    for (const d of ["node_modules", ".git", ".svn", ".hg", "vendor", "bower_components"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
  });

  it("ignores JS/TS framework build + cache dirs", () => {
    for (const d of [".next", ".nuxt", ".svelte-kit", ".astro", ".vercel", ".netlify", ".turbo", ".parcel-cache", "dist", ".cache", ".vite", ".angular"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
  });

  it("ignores Python build + env + cache dirs", () => {
    for (const d of ["__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".eggs"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
    assert.equal(isAlwaysIgnoredDir("mypackage.egg-info"), true, "*.egg-info suffix should match");
  });

  it("ignores JVM / Gradle / Maven build dirs", () => {
    for (const d of ["target", ".gradle", "build", ".idea"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
  });

  it("ignores other-language build/cache dirs", () => {
    // Go vendor, Rust target (covered), Elixir _build, Dart .dart_tool, etc.
    for (const d of ["_build", ".dart_tool", "Pods", ".terraform", "vendor"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
  });

  it("does NOT ignore ambiguous names that are often real source (bin/out/env/deps)", () => {
    // These are deliberately left to .gitignore — too often legitimate source dirs.
    for (const d of ["bin", "out", "env", "deps"]) {
      assert.equal(isAlwaysIgnoredDir(d), false, `${d} should NOT be hard-ignored`);
    }
  });

  it("ignores editor/OS/tooling junk", () => {
    for (const d of [".DS_Store", ".vscode-test", ".contextpro", ".contextplus", "coverage", ".nyc_output"]) {
      assert.equal(isAlwaysIgnoredDir(d), true, `${d} should be ignored`);
    }
  });

  it("does NOT ignore ordinary source directories", () => {
    for (const d of ["src", "lib", "app", "components", "core", "utils", "tests", "test", "server", "pages", "migrations"]) {
      assert.equal(isAlwaysIgnoredDir(d), false, `${d} should NOT be ignored`);
    }
  });

  it("matches *.egg-info / glob-style entries by suffix", () => {
    assert.equal(isAlwaysIgnoredDir("mypackage.egg-info"), true);
    assert.equal(isAlwaysIgnoredDir("notanegg"), false);
  });

  it("does NOT ignore checked-in source-controlled dirs (snapshots, Xcode bundles)", () => {
    // Jest snapshots are source-controlled test expectations, not build output.
    assert.equal(isAlwaysIgnoredDir("__snapshots__"), false, "__snapshots__ must stay indexable");
    // Xcode project/workspace bundles hold checked-in project config (project.pbxproj).
    assert.equal(isAlwaysIgnoredDir("MyApp.xcodeproj"), false, "*.xcodeproj must stay indexable");
    assert.equal(isAlwaysIgnoredDir("MyApp.xcworkspace"), false, "*.xcworkspace must stay indexable");
  });

  it("exposes the raw set for reuse", () => {
    assert.ok(ALWAYS_IGNORE_DIRS instanceof Set);
    assert.ok(ALWAYS_IGNORE_DIRS.has("node_modules"));
  });
});
