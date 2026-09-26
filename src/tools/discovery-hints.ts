import { basename, relative } from "node:path";
import type { ContextPlusDB, FileRow } from "../core/db.js";
import { isTestFile } from "./retrieval-helpers.js";

/** Keep explicit phrases and compound keys intact alongside prose keywords. */
export function queryLiterals(query: string): string[] {
  const quoted = [...query.matchAll(/(["'`])([^"'`\n]{2,200})\1/g)].map(match => match[2]);
  const keys = query.match(/\b[A-Za-z][\w$]*(?:[._][A-Za-z][\w$]*)+\b/g) ?? [];
  return [...new Set((quoted.length ? quoted : keys).map(text => text.normalize("NFC").toLowerCase()))].slice(0, 8);
}

/** Secondary evidence stays available, but must not crowd out implementations. */
export function discoveryPathWeight(query: string, path: string): number {
  if (query.toLowerCase().includes(path.toLowerCase())) return 1;
  if (isLockfile(path) && !wantsLockfile(query)) return .15;
  if ((isTestFile(path) || /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/i.test(path))
    && !/\b(?:tests?|testing|specs?|fixtures?|mocks?|regressions?|coverage|assert)\b/i.test(query)) return .2;
  const locale = /(?:^|\/)(?:locales?|translations?|messages)(?:\/|\.)/i.test(path) && /\.(?:json|ya?ml|[cm]?[jt]sx?)$/i.test(path);
  if (locale && !/\b(?:locales?|translations?|translate|i18n|l10n|locali[sz](?:ation|e)|wording|copy|strings?|messages?)\b/i.test(query)) return .2;
  return 1;
}

/** Hints select only known indexed paths; query text never becomes an unchecked read. */
export function mentionedFiles(root: string, query: string, files: Array<Pick<FileRow, "path">>): string[] {
  const tokens = new Set((query.match(/[\w@./-]+\.[A-Za-z][\w]*(?::\d+(?:-\d+)?)?/g) ?? [])
    .map(token => token.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "")));
  const paths = new Set(files.map(file => file.path));
  const names = new Map<string, string | null>();
  for (const file of files) {
    const name = basename(file.path);
    names.set(name, names.has(name) ? null : file.path);
  }
  return [...new Set([...tokens].flatMap(token => {
    const path = token.startsWith("/") ? relative(root, token) : token;
    const match = paths.has(path) ? path : names.get(token);
    return match ? [match] : [];
  }))];
}

export function isOrientationQuery(query: string): boolean {
  return /\b(?:orient(?:ation)?|overview|understand)\b.*\b(?:repo(?:sitory)?|project|codebase)\b|\b(?:repo(?:sitory)?|project|codebase)\s+(?:orientation|overview)\b/i.test(query);
}

export function orientationFiles(db: ContextPlusDB, files: FileRow[], query: string): string[] {
  const code = files.filter(file => /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|rb)$/.test(file.path) && !isTestFile(file.path));
  const imports = new Map(files.map(file => [file.id, db.getImportsFrom(file.id)]));
  const incoming = new Map<number, number>();
  for (const rows of imports.values()) for (const row of rows) {
    if (row.target_file_id !== null) incoming.set(row.target_file_id, (incoming.get(row.target_file_id) ?? 0) + 1);
  }
  const rank = (file: FileRow) => (incoming.get(file.id) ?? 0) * 2 + imports.get(file.id)!.length;
  const entry = code.filter(file => /(?:^|\/)(?:index|main|app|server|cli|__main__)\.[^/]+$/.test(file.path))
    // At equal depth, a bootstrap with no callers is a stronger entry candidate
    // than an imported app module, even if that module registers more imports.
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length
      || (incoming.get(a.id) ?? 0) - (incoming.get(b.id) ?? 0)
      || imports.get(b.id)!.length - imports.get(a.id)!.length || a.path.localeCompare(b.path))[0];
  const hubs = code.filter(file => file !== entry).sort((a, b) =>
    rank(b) - rank(a) || a.path.localeCompare(b.path));
  // Include the leading hub's dependencies, not only ubiquitous utilities.
  const hubDependencies = new Set(hubs[0] ? imports.get(hubs[0].id)!.map(row => row.target_file_id) : []);
  const core = [...new Set([...hubs.slice(0, 1), ...hubs.filter(file => hubDependencies.has(file.id)).slice(0, 2), ...hubs])].slice(0, 3);
  // The bootstrap also exposes architecture that shared utility rankings miss,
  // such as a job service constructed beside the main client.
  const entryDependencies = new Set(entry ? imports.get(entry.id)!.map(row => row.target_file_id) : []);
  core.push(...hubs.filter(file => entryDependencies.has(file.id) && !core.includes(file)).slice(0, 2));
  const selected = [
    ...files.filter(file => /^(?:package.json|pyproject.toml|Cargo.toml|go.mod)$/.test(file.path)).slice(0, 1),
    ...(entry ? [entry] : []), ...core,
  ];
  const ids = new Set(selected.map(file => file.id));
  if (/\btests?\b/i.test(query)) {
    const test = files.filter(file => isTestFile(file.path)).sort((a, b) =>
      imports.get(b.id)!.filter(imp => ids.has(imp.target_file_id!)).length - imports.get(a.id)!.filter(imp => ids.has(imp.target_file_id!)).length || a.path.localeCompare(b.path))[0];
    if (test) selected.push(test);
  }
  const readme = files.find(file => /^readme\.(?:md|txt|rst)$/i.test(file.path));
  if (readme) selected.push(readme);
  return [...new Set(selected.map(file => file.path))];
}

export function isLockfile(path: string): boolean {
  return /(?:^|\/)(?:package-lock.json|npm-shrinkwrap.json|pnpm-lock.yaml|yarn.lock|bun.lockb?|Cargo.lock|poetry.lock|uv.lock|Gemfile.lock|go.sum)$/i.test(path);
}

export function wantsLockfile(query: string): boolean {
  return /lockfile|lock\s*file|package-lock|shrinkwrap|pnpm-lock|yarn\.lock|bun\.lock|cargo\.lock|poetry\.lock|uv\.lock|gemfile\.lock|go\.sum|\b(?:integrity|resolved|transitive|dependencies|dependency)\b/i.test(query);
}
