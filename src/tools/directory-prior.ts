// Directory-purpose / Protocol-implementation prior for edit-planning rankers
// FEATURE: Recognizes "add a new X for Y" tasks and surfaces the implementation directory + base

import { getDB } from "../core/db.js";
import { basename, dirname } from "path";

export interface DirectoryPriorMatch {
  path: string;
  reason: string;
  // 0..1 boost contribution; the caller folds this into its own scoring.
  boost: number;
  symbols: string[];
}

interface QueryNoun {
  raw: string;
  singular: string;
}

const ADD_INTENT = /\b(add|create|implement|introduce|new|build|register|support)\b/i;

const GENERIC_NOUNS = new Set([
  "thing", "item", "object", "value", "data", "code", "file", "files", "feature",
  "function", "method", "class", "module", "test", "tests", "system", "service",
]);

function singularize(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (word.endsWith("y") && word.length > 1 && !"aeiou".includes(word[word.length - 2])) {
    return `${word.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function extractQueryNouns(query: string): QueryNoun[] {
  const tokens = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9]{2,}/g) ?? [];
  const nouns = new Map<string, QueryNoun>();
  for (const token of tokens) {
    if (GENERIC_NOUNS.has(token)) continue;
    if (ADD_INTENT.test(token)) continue;
    const singular = singularize(token);
    nouns.set(singular, { raw: token, singular });
  }
  return [...nouns.values()];
}

/**
 * Detects whether the task is an "add a new implementation" shape and, if so, finds the directory
 * that hosts sibling implementations matching a query noun. Boosts:
 *   - every source file in that directory (the existing implementations to mirror)
 *   - the file defining the base Protocol/ABC/interface (named like the directory or matching noun)
 *
 * Returns [] when the task isn't add-shaped or no implementation directory is found.
 */
export async function findDirectoryPriorMatches(rootDir: string, query: string): Promise<DirectoryPriorMatch[]> {
  if (!ADD_INTENT.test(query)) return [];
  const nouns = extractQueryNouns(query);
  if (nouns.length === 0) return [];

  const db = await getDB(rootDir);
  const allFiles = db.getAllFiles();
  if (allFiles.length === 0) return [];

  // Group source files by their immediate parent directory.
  const byDir = new Map<string, typeof allFiles>();
  for (const file of allFiles) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|kt|swift)$/.test(file.path)) continue;
    if (/(^|\/)(tests?|__tests__|spec)\//.test(file.path) || /\.(test|spec|demo)\./.test(file.path)) continue;
    const dir = dirname(file.path);
    const arr = byDir.get(dir) ?? [];
    arr.push(file);
    byDir.set(dir, arr);
  }

  const matches: DirectoryPriorMatch[] = [];
  const seenPaths = new Set<string>();

  for (const [dir, files] of byDir) {
    if (files.length < 2) continue;
    const dirName = basename(dir).toLowerCase();
    const dirSingular = singularize(dirName);

    // Does the directory name match a query noun? EXACT singular/plural equality only — NO substring
    // matching. `dirName.includes(noun.singular)` let "feeds" match the noun "fee" (and "feed" via
    // the reverse include), so a "fee model" task boosted every feeds/ websocket file and crowded out
    // the real fees/ implementations (Round-4 audit). Singularizing both sides handles fees↔fee.
    const nounMatch = nouns.find((noun) => {
      const nounSingular = singularize(noun.singular);
      return dirName === noun.singular
        || dirName === pluralize(noun.singular)
        || dirSingular === nounSingular;
    });
    if (!nounMatch) continue;

    // The directory is a feature folder matching the task noun. Gather its source files and look
    // for a base/protocol definition (base.py, <noun>.py, types.py, or a file defining a class
    // named like the singular noun + "Model"/"Base"/"Protocol"/"Interface").
    const dirFiles = files.slice(0, 12);
    // Exact-name base signals only — substring matching produced false positives like
    // "coinBASE" matching "base". A base file is named exactly base/protocol/types/<noun>.
    const baseSignals = new Set(["base", "protocol", "interface", "abc", "types", "__init__", dirSingular, nounMatch.singular]);

    for (const file of dirFiles) {
      if (seenPaths.has(file.path)) continue;
      seenPaths.add(file.path);
      const fileBase = basename(file.path).replace(/\.\w+$/, "").toLowerCase();
      const isBase = baseSignals.has(fileBase);
      const symbols = db.getSymbolsByFile(file.id).filter((s) => s.parent_symbol_id === null).map((s) => s.name).slice(0, 6);
      matches.push({
        path: file.path,
        reason: isBase
          ? `defines the base/Protocol in the "${basename(dir)}/" implementation directory matching task noun "${nounMatch.raw}" — implement this interface`
          : `existing implementation in "${basename(dir)}/" — copy this as a template for the new "${nounMatch.raw}"`,
        boost: isBase ? 0.45 : 0.32,
        symbols,
      });
    }
  }

  // Sort base/protocol files first, then by boost.
  return matches.sort((a, b) => b.boost - a.boost || a.path.localeCompare(b.path)).slice(0, 10);
}
