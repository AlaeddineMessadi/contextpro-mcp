// Deterministic identity for the structural extraction runtime.
// FEATURE: Parser upgrades invalidate cached symbols/imports/call-sites automatically.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const EXTRACTOR_ABI = "contextpro-structural-v1";
let cachedStamp: string | null = null;

function firstReadable(paths: string[]): Buffer | null {
  for (const path of paths) {
    try {
      return readFileSync(path);
    } catch {
      // Source checkouts may execute .ts through a loader while packages execute .js.
    }
  }
  return null;
}

/**
 * Hash the code and dependency manifest that determine structural extraction.
 * The explicit ABI string is a manual escape hatch for behavior changes outside
 * these files. Returning a stable value even in unusual bundlers is safer than
 * silently disabling invalidation.
 */
export function getExtractorStamp(): string {
  if (cachedStamp) return cachedStamp;

  const here = dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256").update(EXTRACTOR_ABI);
  const inputs = [
    [resolve(here, "parser.js"), resolve(here, "parser.ts")],
    [resolve(here, "tree-sitter.js"), resolve(here, "tree-sitter.ts")],
    [resolve(here, "../../package.json")],
  ];

  for (const candidates of inputs) {
    const content = firstReadable(candidates);
    if (content) hash.update(content);
    else hash.update(`missing:${candidates.join("|")}`);
  }

  cachedStamp = `sha256:${hash.digest("hex").slice(0, 24)}`;
  return cachedStamp;
}

/** Test-only hook for exercising cache invalidation without mutating runtime files. */
export function clearExtractorStampCache(): void {
  cachedStamp = null;
}
