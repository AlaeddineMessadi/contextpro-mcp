import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
// No build metadata in release tags: npm versions are immutable and build-only
// differences must not masquerade as a new registry release.
export function isReleaseVersion(value) {
  return typeof value === "string" && value.trim() === value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.test(value);
}

export function checkRelease(pkg, lock, tag) {
  if (!isReleaseVersion(pkg.version)) throw new Error("Package version is not a supported SemVer release.");
  if (pkg.name !== "contextpro-mcp" || lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) throw new Error("Root package names differ.");
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error("Root package and lockfile versions differ.");
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error("Release tag does not match package version.");
  return pkg.version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2];
  console.log(`Release metadata OK: ${checkRelease(read("package.json"), read("package-lock.json"), tag)}`);
}
