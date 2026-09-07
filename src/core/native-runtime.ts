// Native dependencies live in a versioned, ABI-specific user cache, never rebuilt in place.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { join, resolve } from "path";

export interface NativeRuntimeIdentity {
  abi: string;
  platform: string;
  arch: string;
  libc: string;
}

export function nativeRuntimeIdentity(): NativeRuntimeIdentity {
  const header = process.platform === "linux" ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header : undefined;
  return {
    abi: process.versions.modules ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === "linux" ? (header?.glibcVersionRuntime ? "glibc" : "musl") : "none",
  };
}

export function getNativeRuntime(rootDir: string, identity = nativeRuntimeIdentity()): {
  directory: string; dependencies: Record<string, string>;
} {
  const root = resolve(rootDir);
  const requireFromRoot = createRequire(join(root, "package.json"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dependencies: Record<string, string> = {};
  for (const name of ["better-sqlite3", "sqlite-vec"]) {
    let version: string;
    try { version = requireFromRoot(`${name}/package.json`).version; }
    catch { version = String(pkg.dependencies?.[name] ?? "").replace(/^[~^]/, ""); }
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
      throw new Error(`Cannot determine an exact ${name} version for isolated native repair.`);
    }
    dependencies[name] = version;
  }
  const key = createHash("sha256").update(JSON.stringify({ identity, dependencies })).digest("hex").slice(0, 24);
  const base = process.env.CONTEXTPRO_NATIVE_CACHE_DIR || join(homedir(), ".cache", "contextpro", "native");
  return { directory: join(resolve(base), `v1-${key}`), dependencies };
}
