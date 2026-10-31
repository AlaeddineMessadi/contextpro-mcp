import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("root guard", () => {
  it("prefers explicit --root over positional and cwd", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const selected = mod.selectRootDir("/tmp/cwd", ["/tmp/positional"], "/tmp/flag");
    assert.equal(selected.rootDir, "/tmp/flag");
    assert.equal(selected.source, "flag");
  });

  it("uses positional root when provided", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const selected = mod.selectRootDir("/tmp/cwd", ["/tmp/positional"]);
    assert.equal(selected.rootDir, "/tmp/positional");
    assert.equal(selected.source, "positional");
  });

  it("rejects unsafe cwd fallback at filesystem root", async () => {
    const mod = await import("../../build/core/root-guard.js");
    assert.throws(
      () => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }),
      /Unsafe project root/,
    );
  });

  it("rejects unsafe --root flag at filesystem root", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previous = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    assert.throws(
      () => mod.validateSelectedRoot({ rootDir: "/", source: "flag" }),
      /Unsafe project root/,
    );
    if (previous !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previous;
  });

  it("allows unsafe root when override env is set", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previousNew = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    const previousLegacy = process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = "true";
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }));
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "flag" }));
    if (previousNew === undefined) delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousNew;
    if (previousLegacy === undefined) delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = previousLegacy;
  });

  it("legacy CONTEXTPLUS_ALLOW_UNSAFE_ROOT still works", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previousNew = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    const previousLegacy = process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = "true";
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }));
    if (previousNew !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousNew;
    if (previousLegacy === undefined) delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = previousLegacy;
  });

  it("accepts a Git repository directly in the home folder but not a plain folder there", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const mod = await import("../../build/core/root-guard.js");
    const home = await mkdtemp(join(tmpdir(), "contextpro-home-"));
    const previousHome = process.env.HOME, previousAllow = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    process.env.HOME = home;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    try {
      await mkdir(join(home, "myapp", ".git"), { recursive: true });
      await mkdir(join(home, "Downloads"));
      assert.equal(mod.validateSelectedRoot({ rootDir: join(home, "myapp"), source: "flag" }).rootDir, join(home, "myapp"));
      assert.throws(() => mod.validateSelectedRoot({ rootDir: join(home, "Downloads"), source: "flag" }), /Unsafe project root/);
      assert.throws(() => mod.validateSelectedRoot({ rootDir: home, source: "cwd" }), /Unsafe project root/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousAllow !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousAllow;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses home, its ancestors and non-repo home children; accepts repos below home", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const mod = await import("../../build/core/root-guard.js");
    const base = await mkdtemp(join(tmpdir(), "contextpro-ancestor-"));
    const home = join(base, "users", "me");
    const previousHome = process.env.HOME, previousAllow = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    process.env.HOME = home;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    const check = (rootDir) => () => mod.validateSelectedRoot({ rootDir, source: "flag" });
    try {
      await mkdir(join(base, ".git"), { recursive: true });
      await mkdir(join(home, "proj", ".git"), { recursive: true });
      await mkdir(join(home, "Downloads"));
      await mkdir(join(home, "a", "b"), { recursive: true });
      const refused = [dirname(home), base, home, "/", join(home, "Downloads")];
      for (const rootDir of refused) assert.throws(check(rootDir), /a folder that contains your home folder/, rootDir);
      assert.doesNotThrow(check(join(home, "proj")));
      assert.doesNotThrow(check(join(home, "a", "b")));
      process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = "true";
      for (const rootDir of refused) assert.doesNotThrow(check(rootDir), rootDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousAllow === undefined) delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT; else process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousAllow;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("counts a child folder named ..foo as inside home", async () => {
    const { join } = await import("node:path");
    const mod = await import("../../build/core/root-guard.js");
    const previousHome = process.env.HOME;
    process.env.HOME = "/x/home";
    try {
      assert.equal(mod.isUnsafeRoot(join("/x/home", "..foo")), true, "a direct child is refused, not treated as outside");
      assert.equal(mod.isUnsafeRoot(join("/x/home", "..foo", "proj")), false);
      assert.equal(mod.isUnsafeRoot("/x/home2/proj"), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  it("does not treat the cwd as home when HOME is empty or relative", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const mod = await import("../../build/core/root-guard.js");
    const base = await mkdtemp(join(tmpdir(), "contextpro-emptyhome-"));
    const previousHome = process.env.HOME, previousCwd = process.cwd();
    try {
      await mkdir(join(base, "proj", "src"), { recursive: true });
      process.chdir(join(base, "proj", "src"));
      for (const home of ["", "."]) {
        process.env.HOME = home;
        assert.equal(mod.isUnsafeRoot(join(base, "proj")), false, `HOME=${JSON.stringify(home)}`);
      }
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("accepts a home-child repo whose drive letter case differs from homedir() (Windows paths)", { skip: process.platform === "win32" }, async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // Load root-guard with `path` mapped to path/win32; on Linux a win32 path is a plain file name in cwd, so ".git" is faked there.
    const cwd = await mkdtemp(join(tmpdir(), "contextpro-win32-"));
    await writeFile(join(cwd, "c:\\Users\\Alice\\proj\\.git"), "");
    const hook = `data:text/javascript,${encodeURIComponent('export const resolve = (s, c, next) => next(s === "path" ? "path/win32" : s, c);')}`;
    const register = `data:text/javascript,${encodeURIComponent(`import { register } from "node:module"; register(${JSON.stringify(hook)});`)}`;
    const check = "const m = await import(process.argv[1]); for (const rootDir of process.argv.slice(2)) { try { m.validateSelectedRoot({ rootDir, source: 'flag' }); console.log('ok'); } catch { console.log('refused'); } }";
    const env = { ...process.env, HOME: "C:\\Users\\Alice" };
    delete env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    try {
      const out = execFileSync(process.execPath, ["--import", register, "--input-type=module", "-e", check,
        new URL("../../build/core/root-guard.js", import.meta.url).href, "c:\\Users\\Alice\\proj", "c:\\Users\\Alice\\Downloads"], { cwd, env }).toString();
      assert.deepEqual(out.trim().split("\n"), ["ok", "refused"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores an unexpanded client variable passed as --root", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const selected = mod.selectRootDir("/tmp/cwd", [], "${workspaceFolder}");
    assert.equal(selected.rootDir, "/tmp/cwd");
    assert.equal(selected.source, "cwd");
  });
});
