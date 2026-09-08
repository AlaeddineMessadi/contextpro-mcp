// Incremental TypeScript projects for reference queries. Imported lazily by the tool.
import * as ts from "typescript";
import { statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface TypedReference {
  file: string; line: number; column: number; context: string; isDefinition: boolean;
  kind: "definition" | "import" | "call" | "reference";
}
interface Snapshot { stamp: string; text: string; snapshot: ts.IScriptSnapshot; version: number }
interface Project {
  signature: string; files: string[]; snapshots: Map<string, Snapshot>;
  service: ts.LanguageService; touched: number;
}
const projects = new Map<string, Project>();
const MAX_PROJECTS = 3;
const IDLE_MS = 60_000;
let idleTimer: NodeJS.Timeout | undefined;

export function clearTypeScriptReferenceCache(): void {
  for (const project of projects.values()) project.service.dispose();
  projects.clear();
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function scheduleEviction(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(clearTypeScriptReferenceCache, IDLE_MS);
  idleTimer.unref();
}

function inRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

function findConfig(root: string, file: string, memo: Map<string, string | undefined>): string | undefined {
  const start = dirname(file);
  if (memo.has(start)) return memo.get(start);
  let dir = start;
  while (inRoot(root, dir)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(dir, name);
      if (ts.sys.fileExists(candidate)) { memo.set(start, candidate); return candidate; }
    }
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  memo.set(start, undefined);
  return undefined;
}

function snapshotFor(project: Project, file: string): Snapshot | undefined {
  try {
    const before = statSync(file);
    const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = project.snapshots.get(file);
    if (cached?.stamp === stamp) return cached;
    const text = ts.sys.readFile(file);
    if (text === undefined) { project.snapshots.delete(file); return undefined; }
    const after = statSync(file);
    if (stamp !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`) {
      throw new Error(`Source changed during reference lookup: ${file}`);
    }
    const value = { stamp, text, snapshot: ts.ScriptSnapshot.fromString(text), version: (cached?.version ?? 0) + 1 };
    project.snapshots.set(file, value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      project.snapshots.delete(file); return undefined;
    }
    throw error;
  }
}

function getProject(key: string, root: string, files: string[], options: ts.CompilerOptions, references?: readonly ts.ProjectReference[]): { project: Project; reused: boolean } {
  const signature = JSON.stringify({ options, references });
  let project = projects.get(key);
  const reused = project?.signature === signature;
  if (project && !reused) { project.service.dispose(); projects.delete(key); project = undefined; }
  if (!project) {
    while (projects.size >= MAX_PROJECTS) {
      const oldest = [...projects.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      oldest[1].service.dispose(); projects.delete(oldest[0]);
    }
    const state = { signature, files, snapshots: new Map<string, Snapshot>(), touched: Date.now() } as Project;
    // The source-redirect host hook is also used by tsserver; it lets source
    // workspaces resolve references before declaration outputs have been built.
    const host: ts.LanguageServiceHost & { useSourceOfProjectReferenceRedirect(): boolean } = {
      getScriptFileNames: () => state.files,
      getScriptVersion: file => String(snapshotFor(state, file)?.version ?? "missing"),
      getScriptSnapshot: file => snapshotFor(state, file)?.snapshot,
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getProjectReferences: () => references,
      useSourceOfProjectReferenceRedirect: () => true,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    state.service = ts.createLanguageService(host);
    project = state;
    projects.set(key, project);
  }
  project.files = files;
  project.touched = Date.now();
  scheduleEviction();
  return { project, reused };
}

function referenceKind(source: ts.SourceFile, position: number, definition: boolean): TypedReference["kind"] {
  if (definition) return "definition";
  let token: ts.Node = source;
  const descend = (node: ts.Node): void => {
    if (node.getStart(source) <= position && position < node.end) { token = node; ts.forEachChild(node, descend); }
  };
  descend(source);
  for (let node: ts.Node | undefined = token; node && node !== source; node = node.parent) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return "import";
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)
        || ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee) || ts.isSatisfiesExpression(callee)) callee = callee.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name
        : ts.isElementAccessExpression(callee) && (ts.isStringLiteralLike(callee.argumentExpression) || ts.isNumericLiteral(callee.argumentExpression)) ? callee.argumentExpression
          : ts.isIdentifier(callee) ? callee : undefined;
      // An identifier used inside a computed key or nested factory call is not
      // itself the callee, even though its span lies inside the outer expression.
      if (name && name.getStart(source) <= position && position < name.end) return "call";
    }
  }
  return "reference";
}

export function findTypeScriptReferences(input: { rootDir: string; files: string[]; file: string; line: number; symbol: string; limit?: number }) {
  const root = resolve(input.rootDir);
  const target = resolve(input.file);
  const allFiles = [...new Set([...input.files, target].map(file => resolve(file)))].sort();
  const allowed = new Set(allFiles);
  const configs = new Map<string, string[]>();
  const memo = new Map<string, string | undefined>();
  for (const file of allFiles) {
    const config = findConfig(root, file, memo) ?? "";
    const group = configs.get(config) ?? []; group.push(file); configs.set(config, group);
  }
  const warnings: string[] = [];
  if (input.files.length === 0) warnings.push("The source index is empty; only the explicit target is in scope. Run reindex before trusting reference completeness.");
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit!), 500)) : 100;
  // Exact totals require deduplicating every location across projects, but only
  // the bounded display window needs source context or an IPC payload.
  const locations = new Map<string, TypedReference["kind"]>();
  const results: TypedReference[] = [];
  const counts = { definition: 0, import: 0, call: 0, reference: 0 };
  const callsByFile = new Map<string, number>();
  const compare = (a: Pick<TypedReference, "file" | "line" | "column">, b: TypedReference) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
  const checkedFiles = new Set<string>();
  let reusedProjects = 0;
  let projectCount = 0;
  for (const [config, indexedFiles] of configs) {
    let options: ts.CompilerOptions = { allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs };
    let references: readonly ts.ProjectReference[] | undefined;
    let files = indexedFiles;
    if (config) {
      const loaded = ts.readConfigFile(config, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(loaded.config ?? {}, ts.sys, dirname(config), undefined, config);
      const errors = [loaded.error, ...parsed.errors].filter((error): error is ts.Diagnostic => !!error && error.code !== 18003);
      if (errors.length) {
        warnings.push(`Invalid configuration ${relative(root, config)}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, " ")}`);
        continue; // Do not pretend a guessed configuration resolved this project.
      }
      options = { allowJs: true, ...parsed.options };
      references = parsed.projectReferences;
      // Include indexed tests excluded by the production config, using their
      // nearest config. Never force every monorepo file into unrelated projects.
      files = [...new Set([...indexedFiles, ...parsed.fileNames.filter(file => allowed.has(file))])].sort();
    }
    const { project, reused } = getProject(`${root}\0${config}`, root, files, options, references);
    projectCount++; if (reused) reusedProjects++;
    const program = project.service.getProgram();
    if (!program) { warnings.push(`Could not load project ${config || root}`); continue; }
    for (const file of indexedFiles) if (program.getSourceFile(file)) checkedFiles.add(file);
    // References need binding resolution, not a complete semantic typecheck of
    // all dependencies. Check unresolved workspace imports without paying for
    // unrelated diagnostic work (React Native projects can load thousands of libs).
    const resolutionCache = ts.createModuleResolutionCache(root, file => file, options);
    let unresolved = 0;
    for (const file of indexedFiles) {
      for (const statement of program.getSourceFile(file)?.statements ?? []) {
        const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const name = specifier.text;
        const local = name.startsWith(".") || Object.keys(options.paths ?? {}).some(pattern => {
          const star = pattern.indexOf("*");
          return star < 0 ? name === pattern : name.startsWith(pattern.slice(0, star)) && name.endsWith(pattern.slice(star + 1));
        });
        if (local && !ts.resolveModuleName(name, file, options, ts.sys, resolutionCache).resolvedModule) unresolved++;
      }
    }
    if (unresolved) warnings.push(`${unresolved} unresolved workspace imports in ${config ? relative(root, config) : "inferred project"}; reference coverage may be incomplete.`);
    const source = program.getSourceFile(target);
    if (!source) continue;
    const starts = source.getLineStarts();
    if (!Number.isInteger(input.line) || input.line < 1 || input.line > starts.length) throw new Error("Reference target line is outside the source file.");
    const lineStart = starts[input.line - 1];
    const lineText = source.text.slice(lineStart, starts[input.line] ?? source.text.length);
    let symbolOffset = -1;
    const visit = (node: ts.Node): void => {
      if (node.end < lineStart || node.getStart(source) >= (starts[input.line] ?? source.text.length)) return;
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === input.symbol && symbolOffset < 0) symbolOffset = node.getStart(source);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (symbolOffset < 0) throw new Error(`Symbol ${input.symbol} is not present on target line ${input.line}: ${lineText.trim()}`);
    for (const group of project.service.findReferences(target, symbolOffset) ?? []) {
      for (const ref of group.references) {
        if (!allowed.has(ref.fileName)) continue;
        const refSource = program.getSourceFile(ref.fileName);
        if (!refSource) continue;
        const at = refSource.getLineAndCharacterOfPosition(ref.textSpan.start);
        const isDefinition = ref.isDefinition === true;
        const location = { file: relative(root, ref.fileName).split("\\").join("/"), line: at.line + 1, column: at.character + 1 };
        const key = `${location.file}:${location.line}:${location.column}`;
        const previous = locations.get(key);
        if (previous === "definition") continue;
        const kind = referenceKind(refSource, ref.textSpan.start, isDefinition);
        if (previous === kind) continue;
        if (previous) counts[previous]--;
        locations.set(key, kind);
        counts[kind]++;
        const fileCalls = (callsByFile.get(location.file) ?? 0) + Number(kind === "call") - Number(previous === "call");
        if (fileCalls) callsByFile.set(location.file, fileCalls);
        else callsByFile.delete(location.file);
        let low = 0, high = results.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compare(location, results[mid]) > 0) low = mid + 1;
          else high = mid;
        }
        if (low >= limit) continue;
        const lineStarts = refSource.getLineStarts();
        const item: TypedReference = { ...location, isDefinition, kind,
          context: refSource.text.slice(lineStarts[at.line], lineStarts[at.line + 1] ?? refSource.text.length).trim().slice(0, 160) };
        if (results[low] && compare(location, results[low]) === 0) results[low] = item;
        else {
          results.splice(low, 0, item);
          if (results.length > limit) results.pop();
        }
      }
    }
  }
  if (checkedFiles.size < allowed.size) warnings.push(`${allowed.size - checkedFiles.size} indexed TS/JS files could not be checked.`);
  return { references: results, total: locations.size, counts,
    callsByFile: [...callsByFile].sort(([a], [b]) => a.localeCompare(b)).slice(0, 50).map(([file, calls]) => ({ file, calls })),
    callFileCount: callsByFile.size,
    warnings: [...new Set(warnings)], scope: { kind: "indexed_ts_js_files", files: allowed.size, checkedFiles: checkedFiles.size,
      configs: [...configs.keys()].filter(Boolean).map(file => relative(root, file)), includesIndexedTests: true },
    projectCount, reusedProjects };
}
