import { basename, relative } from "node:path";
import type { ContextPlusDB, FileRow } from "../core/db.js";
import { searchTerms } from "../core/embeddings.js";
import { isTestFile } from "./retrieval-helpers.js";

const BACKEND_DIRECTORY = /(?:^|\/)(?:api|backend|server|services?|workers?|scripts?)(?:\/|$)/i;

/** Keep explicit phrases and compound keys intact alongside prose keywords. */
export function queryLiterals(query: string): string[] {
  const quoted = [...query.matchAll(/(["'`])([^"'`\n]{2,200})\1/g)].map(match => match[2]);
  const keys = query.match(/\b[A-Za-z][\w$]*(?:[._][A-Za-z][\w$]*)+\b/g) ?? [];
  return [...new Set([...quoted, ...keys].map(text => text.normalize("NFC").toLowerCase()))].slice(0, 8);
}

/** Secondary evidence stays available, but must not crowd out implementations. */
export function discoveryPathWeight(query: string, path: string): number {
  if (query.toLowerCase().includes(path.toLowerCase())) return 1;
  if (isLockfile(path) && !wantsLockfile(query)) return .15;
  if ((isTestFile(path) || /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/i.test(path))
    && !/\b(?:tests?|testing|specs?|fixtures?|mocks?|regressions?|coverage|assert)\b/i.test(query)) return .2;
  const locale = /(?:^|\/)(?:locales?|translations?|messages)(?:\/|\.)/i.test(path) && /\.(?:json|ya?ml|[cm]?[jt]sx?)$/i.test(path);
  if (locale && !/\b(?:locales?|translations?|translate|i18n|l10n|locali[sz](?:ation|e)|wording|copy|strings?|messages?)\b/i.test(query)) return .2;
  // Known report locations can repeat implementation terms without containing
  // the implementation. An extension alone says nothing about that role: JSON
  // configuration, Markdown content and CSV data can be primary source evidence.
  const reportPath = /(?:^|\/)(?:reports|benchmark-results|test-results|coverage)\/|(?:^|\/)docs\/benchmarks\//i.test(path);
  if (/\b(?:implementation|code|pipeline|source)\b/i.test(query)
    && !/\b(?:report|reports|documentation|docs|results|dataset)\b/i.test(query)
    && reportPath
    && /\.(?:json|jsonl|md|csv)$/i.test(path)) return .35;
  return 1;
}

/** A broad visual task should find renderers before incidental service prose. */
export function facetPathWeight(query: string, term: string, path: string): number {
  const prior = discoveryPathWeight(query, path);
  const visualTerms = new Set(query.toLowerCase().match(/\b(?:visual|illustration|animation|layout|theme|accent|onboarding|ui)\b/g) ?? []);
  // Preserve direct path/topic matches, including non-UI theme/config modules.
  if (visualTerms.size >= 2 && !path.toLowerCase().includes(term) && /\.[jt]sx$/i.test(path)) return prior * 1.5;
  return prior;
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

/** Require both a UI scope and a broad navigation/orientation request. */
export function isUiOrientationQuery(query: string): boolean {
  const uiScope = /\b(?:ui|ux|frontend|front.end|user.facing|web app)\b/i.test(query);
  // Routes/navigation/audit alone also occur in narrow coding requests. Only
  // explicit overview language or a request to inventory product surfaces
  // authorizes structural previews ahead of the ranked implementation.
  const broad = /\b(?:orient|orientation|overview)\b/i.test(query)
    || /\b(?:map|survey)\s+(?:(?:out|the|our|this|all)\s+)*(?:ui|ux|frontend|front.end|app(?:lication)?|web app)\s+(?:structure|architecture|navigation|routes|screens|components)\b/i.test(query)
    || /\b(?:find|identify|list|show)\s+(?:(?:the|our|this)\s+)?(?:main|primary|key|all|product)\s+(?:(?:product|ui|ux|frontend|front.end|user.facing|web|app(?:lication)?|user)\s+)*(?:surfaces|screens|routes|components|journey)\b/i.test(query);
  return uiScope && broad;
}

export function isOrientationQuery(query: string): boolean {
  return isUiOrientationQuery(query) || /\b(?:orient(?:ation)?|overview|understand)\b.*\b(?:repo(?:sitory)?|project|codebase)\b|\b(?:repo(?:sitory)?|project|codebase)\s+(?:orientation|overview)\b/i.test(query);
}

export function orientationFiles(db: ContextPlusDB, files: FileRow[], query: string): string[] {
  if (isUiOrientationQuery(query)) return uiOrientationFiles(db, files, query);
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

/** UI structure supplies candidates even when translated labels do not repeat
 * English query terms. Import edges are heuristic, not resolved references. */
function uiOrientationFiles(db: ContextPlusDB, files: FileRow[], query: string): string[] {
  const imports = new Map(files.map(file => [file.id, db.getImportsFrom(file.id)]));
  let ui = files.filter(file => {
    if (discoveryPathWeight(query, file.path) < 1) return false;
    if (BACKEND_DIRECTORY.test(file.path) || /\.server\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file.path)) return false;
    if (/\.(?:[jt]sx|vue|svelte)$/.test(file.path)) return true;
    if (!/\.[cm]?[jt]s$/.test(file.path) || /\.d\.[cm]?ts$/.test(file.path)) return false;
    const modules = imports.get(file.id)!.map(row => row.target_path);
    const framework = modules.some(path => /^(?:@angular\/|react(?:-dom|-router(?:-dom)?)?(?:\/|$)|preact(?:\/|$)|lit(?:-element|-html)?(?:\/|$)|vue(?:\/|$)|svelte(?:\/|$)|solid-js(?:\/|$))/.test(path));
    const uiPath = /(?:^|\/)(?:components?|pages?|screens?|views?|layouts?|navigation|client|frontend)(?:\/|$)|\.component\.[cm]?[jt]s$/i.test(file.path);
    const entry = /^(?:app|main|router|routes|navigation)(?:\.[\w-]+)?\.[cm]?[jt]s$/i.test(basename(file.path));
    const backend = modules.some(path => /^(?:express|fastify|koa|node:http)(?:\/|$)/.test(path));
    return framework || uiPath || (entry && !backend);
  });
  const terms = new Set(searchTerms(query));
  const appScopes = new Map<string, { container: string; name: string }>();
  for (const file of files) {
    const match = file.path.match(/^(apps|packages)\/([^/]+)\//);
    if (match) appScopes.set(match[0], { container: match[1], name: match[2] });
  }
  const paths = (query.toLowerCase().match(/[\p{L}\p{N}_./@-]+/gu) ?? []).map(path => path.replace(/\.+$/, ""));
  const explicitScopes = [...appScopes.keys()].filter(scope => {
    const path = scope.toLowerCase(), bare = path.slice(0, -1);
    return paths.some(token => token === bare || token.startsWith(path) || token.endsWith(`/${bare}`) || token.includes(`/${path}`));
  });
  // Prefer matching app names over shared-package names. An unrelated apps/
  // entry must not prevent selecting a requested package-hosted application.
  // Explicit paths can still select any package.
  const genericNames = new Set(["ui", "ux", "shared", "common", "components"]);
  const namedScopes = [...appScopes].filter(([, scope]) => {
    // An unqualified "UI" request does not name a package called ui. Its
    // explicit path remains available through explicitScopes above.
    const words = searchTerms(scope.name).filter(word => !genericNames.has(word));
    return words.length > 0 && words.every(word => terms.has(word));
  }).map(([scope]) => scope);
  // "Product frontend ... billing" names product as the application and billing
  // as a feature. Prefer qualified application names over incidental topic words.
  const qualifiedScopes = namedScopes.filter(scope => {
    const name = searchTerms(appScopes.get(scope)!.name).filter(word => !genericNames.has(word))
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+");
    const qualifier = "(?:frontend|front[- ]end|ui|ux|web\\s+app|apps?|applications?)";
    return new RegExp(`(?<![\\p{L}\\p{N}_])${name}\\s+${qualifier}\\b|\\b(?:app|application)\\s+(?:(?:named|called)\\s+)?${name}(?![\\p{L}\\p{N}_])`, "iu").test(query);
  });
  const matchedScopes = qualifiedScopes.length ? qualifiedScopes : namedScopes;
  const namedApps = matchedScopes.filter(scope => appScopes.get(scope)!.container === "apps");
  const requestedScopes = explicitScopes.length ? explicitScopes : namedApps.length ? namedApps : matchedScopes;
  if (requestedScopes.length) ui = ui.filter(file => requestedScopes.some(scope => file.path.startsWith(scope)));
  const ids = new Set(ui.map(file => file.id));
  const incoming = new Map<number, number>();
  for (const file of ui) for (const row of imports.get(file.id)!) {
    if (row.target_file_id !== null) incoming.set(row.target_file_id, (incoming.get(row.target_file_id) ?? 0) + 1);
  }
  const overlap = (file: FileRow) => searchTerms(basename(file.path)).filter(term => terms.has(term)).length;
  // Prefer modules composing the UI. Ubiquitous leaf utilities/types can have
  // many callers without explaining a screen, so bound their popularity bonus.
  const rank = (file: FileRow) => (imports.get(file.id) ?? []).filter(row => ids.has(row.target_file_id!)).length * 2 + Math.min(4, incoming.get(file.id) ?? 0);
  const sorted = [...ui].sort((a,b) => rank(b)-rank(a) || a.path.localeCompare(b.path));
  const layouts = sorted.filter(file => /(?:^|\/)(?:_?layout|_app)\./i.test(file.path)).sort((a,b) => a.path.split("/").length-b.path.split("/").length || a.path.localeCompare(b.path)).slice(0,1);
  const routes = sorted.filter(file => /(?:^|\/)(?:page|index|app|main|router)\./i.test(file.path) && !layouts.includes(file)).slice(0,2);
  const navigation = sorted.filter(file => /(?:navigation|navbar|sidebar|app-shell)/i.test(basename(file.path))).slice(0,2);
  const hubs = sorted.filter(file => !layouts.includes(file) && !routes.includes(file)).slice(0,2);
  const topics: FileRow[] = [];
  // One popular feature must not occupy every feature slot. Prefer a direct
  // basename match for each requested topic, then use structural rank as a tie.
  for (const term of terms) {
    const matches = ui.filter(file => searchTerms(basename(file.path)).includes(term));
    matches.sort((a,b) => searchTerms(basename(a.path)).length-searchTerms(basename(b.path)).length || rank(b)-rank(a) || a.path.localeCompare(b.path));
    if (matches[0] && !topics.includes(matches[0])) topics.push(matches[0]);
  }
  // Reserve the entry/layout evidence before a long feature inventory fills
  // the bounded candidate list, including when the response budget is small.
  const selected = [...new Set([...layouts,...routes,...navigation,...hubs,...topics])].slice(0,11);
  if (/\b(?:styles?|tokens?|theme|css)\b/i.test(query)) {
    const imported = new Set(selected.flatMap(file => (imports.get(file.id) ?? []).map(row=>row.target_file_id)));
    const scope = (path: string) => path.match(/^(?:apps|packages)\/[^/]+\//)?.[0] ?? "";
    const scopes = new Set(selected.map(file => scope(file.path)));
    const proximity = (file: FileRow) => Math.max(0, ...selected.map(source => {
      const a = file.path.split("/"), b = source.path.split("/");
      let shared = 0;
      while (shared < Math.min(a.length, b.length) - 1 && a[shared] === b[shared]) shared++;
      return shared;
    }));
    const styles = files.filter(file => /\.(?:css|scss|sass|less)$/.test(file.path)
      && discoveryPathWeight(query, file.path) >= 1
      && !BACKEND_DIRECTORY.test(file.path)
      && (imported.has(file.id) || (scopes.has(scope(file.path))
        && (scope(file.path) !== "" || proximity(file) > 0
          || /^(?:(?:assets|styles?|public\/(?:assets|styles?))\/|(?:globals?|styles?|theme)\.)/i.test(file.path)))));
    styles.sort((a,b) => Number(imported.has(b.id))-Number(imported.has(a.id)) || proximity(b)-proximity(a) || overlap(b)-overlap(a) || a.path.localeCompare(b.path));
    if (styles[0]) selected.push(styles[0]);
  }
  return selected.map(file=>file.path);
}

/** Mixed documentation/control requests often put decisive topics after the
 * broad FTS query's token limit. Give each clause one bounded source candidate. */
export function documentTopicFiles(db: ContextPlusDB, query: string): Array<{file: string; terms: string[]}> {
  const generic = new Set("find main files file exact source ranges return include relevant code documentation docs and identify usage disclosures".split(" "));
  const clauses = query.split(/[,;:]|\.\s|\band\b/i).map(clause => searchTerms(clause).filter(term => !generic.has(term))).filter(terms => terms.length).slice(0,16);
  if (clauses.length < 2) return [];
  const files = db.getAllFiles().filter(file => discoveryPathWeight(query, file.path) >= 1);
  const selected = new Map<string, Set<string>>();
  for (const terms of clauses) {
    const hits = db.searchFileText(terms.join(" "), 32, false, true).filter(hit => discoveryPathWeight(query, hit.path) >= 1);
    // A partial basename match must never beat a complete multiword FTS hit.
    const exact = files.filter(file => terms.every(term => searchTerms(basename(file.path)).includes(term)))
      .sort((a,b) => a.path.localeCompare(b.path));
    const paths = [...new Set([...exact.slice(0,1).map(file=>file.path), ...hits.slice(0,terms.length > 1 ? 2 : 1).map(hit=>hit.path)])];
    for (const path of paths) {
      if (!selected.has(path) && selected.size >= 16) continue;
      const words = selected.get(path) ?? new Set<string>();
      terms.forEach(term=>words.add(term)); selected.set(path,words);
    }
  }
  return [...selected].map(([file,terms])=>({file,terms:[...terms]}));
}

export function isLockfile(path: string): boolean {
  return /(?:^|\/)(?:package-lock.json|npm-shrinkwrap.json|pnpm-lock.yaml|yarn.lock|bun.lockb?|Cargo.lock|poetry.lock|uv.lock|Gemfile.lock|go.sum)$/i.test(path);
}

export function wantsLockfile(query: string): boolean {
  return /lockfile|lock\s*file|package-lock|shrinkwrap|pnpm-lock|yarn\.lock|bun\.lock|cargo\.lock|poetry\.lock|uv\.lock|gemfile\.lock|go\.sum|\b(?:integrity|resolved|transitive|dependencies|dependency)\b/i.test(query);
}
