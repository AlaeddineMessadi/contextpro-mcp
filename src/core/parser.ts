// Multi-language symbol extraction with tree-sitter AST + regex fallback
// Supports 36 languages via WASM grammars, regex fallback for unsupported

import { readFile } from "fs/promises";
import { extname } from "path";
import { parseWithTreeSitter, getSupportedExtensions } from "./tree-sitter.js";

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Method = "method",
  Enum = "enum",
  Interface = "interface",
  Struct = "struct",
  Type = "type",
  Trait = "trait",
  Const = "const",
  Variable = "variable",
  Export = "export",
}

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  children: CodeSymbol[];
}

export interface SymbolLocation {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
}

export interface FileAnalysis {
  path: string;
  header: string;
  symbols: CodeSymbol[];
  lineCount: number;
}

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".cs": "csharp",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".lua": "lua",
  ".zig": "zig",
};

const TS_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/,
  /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,
  /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s<>]+)?/,
  /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
  /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=/,
];

const PY_PATTERNS: RegExp[] = [
  /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?/,
  /^class\s+(\w+)(?:\(([^)]*)\))?/,
];

const RS_PATTERNS: RegExp[] = [
  /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^\n{]+))?/,
  /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?/,
  /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?/,
  /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?/,
  /^impl(?:<[^>]*>)?\s+(\w+)/,
];

const GO_PATTERNS: RegExp[] = [
  /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\w+)))?/,
  /^type\s+(\w+)\s+struct/,
  /^type\s+(\w+)\s+interface/,
];

const JAVA_PATTERNS: RegExp[] = [
  /^(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/,
  /^(?:public|private|protected)?\s*(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/,
  /^(?:public|private|protected)?\s*(?:abstract\s+)?interface\s+(\w+)/,
  /^(?:public|private|protected)?\s*enum\s+(\w+)/,
];

function detectLanguage(filePath: string): string | null {
  return LANG_MAP[extname(filePath).toLowerCase()] ?? null;
}

function extractHeader(lines: string[]): string {
  const headerLines: string[] = [];
  for (const line of lines.slice(0, 10)) {
    const stripped = line.replace(/^\/\/\s?|^#\s?|^--\s?|^\*\s?|^\/\*\*?\s?|\*\/$/g, "").trim();
    if (stripped && !stripped.startsWith("!") && !stripped.startsWith("use ") && !stripped.startsWith("import ")) {
      headerLines.push(stripped);
      if (headerLines.length >= 2) break;
    }
  }
  return headerLines.join(" | ");
}

function matchPatterns(line: string, patterns: RegExp[], kindMap: SymbolKind[]): CodeSymbol | null {
  for (let i = 0; i < patterns.length; i++) {
    const match = line.match(patterns[i]);
    if (match?.[1]) {
      return {
        name: match[1],
        kind: kindMap[i] ?? SymbolKind.Function,
        line: 0,
        endLine: 0,
        signature: line.trim().replace(/\s*\{?\s*$/, ""),
        children: [],
      };
    }
  }
  return null;
}

function findBraceBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let seenOpening = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        seenOpening = true;
      } else if (ch === "}" && seenOpening) {
        depth--;
        if (depth <= 0) return i + 1;
      }
    }
  }

  return startIndex + 1;
}

function findIndentBlockEnd(lines: string[], startIndex: number, baseIndent: number): number {
  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent <= baseIndent) return i;
  }
  return lines.length;
}

function parseTypeScript(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const kindMap = [SymbolKind.Function, SymbolKind.Class, SymbolKind.Enum, SymbolKind.Interface, SymbolKind.Type, SymbolKind.Const];
  let currentClass: CodeSymbol | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (indent === 0 || trimmed.startsWith("export ")) {
      const sym = matchPatterns(trimmed, TS_PATTERNS, kindMap);
      if (sym) {
        sym.line = i + 1;
        if ([SymbolKind.Function, SymbolKind.Class, SymbolKind.Interface, SymbolKind.Enum].includes(sym.kind)) {
          sym.endLine = findBraceBlockEnd(lines, i);
        } else {
          sym.endLine = i + 1;
        }
        if (sym.kind === SymbolKind.Class) currentClass = sym;
        else currentClass = null;
        symbols.push(sym);
        continue;
      }
    }

    if (currentClass && indent >= 2) {
      const methodMatch = trimmed.match(
        /^(?:public|private|protected|static|async|readonly|\s)*\s*(?:get|set\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/,
      );
      if (methodMatch?.[1] && !["if", "for", "while", "switch", "return", "throw", "new", "delete"].includes(methodMatch[1])) {
        currentClass.children.push({
          name: methodMatch[1],
          kind: SymbolKind.Method,
          line: i + 1,
          endLine: findBraceBlockEnd(lines, i),
          signature: trimmed.replace(/\s*\{?\s*$/, ""),
          children: [],
        });
      }
    }
  }
  return symbols;
}

function parsePython(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const kindMap = [SymbolKind.Function, SymbolKind.Class];
  let currentClass: CodeSymbol | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (indent === 0) {
      const sym = matchPatterns(trimmed, PY_PATTERNS, kindMap);
      if (sym) {
        sym.line = i + 1;
        sym.endLine = findIndentBlockEnd(lines, i, indent);
        if (sym.kind === SymbolKind.Class) currentClass = sym;
        else currentClass = null;
        symbols.push(sym);
      }
    } else if (currentClass && indent >= 4 && trimmed.startsWith("def ")) {
      const methodMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?/);
      if (methodMatch?.[1]) {
        currentClass.children.push({
          name: methodMatch[1],
          kind: SymbolKind.Method,
          line: i + 1,
          endLine: findIndentBlockEnd(lines, i, indent),
          signature: trimmed.replace(/\s*:\s*$/, ""),
          children: [],
        });
      }
    }
  }
  return symbols;
}

function parseRust(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const kindMap = [SymbolKind.Function, SymbolKind.Struct, SymbolKind.Enum, SymbolKind.Trait, SymbolKind.Class];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const sym = matchPatterns(trimmed, RS_PATTERNS, kindMap);
    if (sym) {
      sym.line = i + 1;
      sym.endLine = findBraceBlockEnd(lines, i);
      symbols.push(sym);
    }
  }
  return symbols;
}

function parseGo(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const kindMap = [SymbolKind.Function, SymbolKind.Struct, SymbolKind.Interface];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const sym = matchPatterns(trimmed, GO_PATTERNS, kindMap);
    if (sym) {
      sym.line = i + 1;
      sym.endLine = findBraceBlockEnd(lines, i);
      symbols.push(sym);
    }
  }
  return symbols;
}

function parseJava(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const kindMap = [SymbolKind.Method, SymbolKind.Class, SymbolKind.Interface, SymbolKind.Enum];
  let currentClass: CodeSymbol | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (indent <= 0) {
      const sym = matchPatterns(trimmed, JAVA_PATTERNS, kindMap);
      if (sym && (sym.kind === SymbolKind.Class || sym.kind === SymbolKind.Interface || sym.kind === SymbolKind.Enum)) {
        sym.line = i + 1;
        sym.endLine = findBraceBlockEnd(lines, i);
        currentClass = sym;
        symbols.push(sym);
      }
    } else if (currentClass && indent >= 2) {
      const sym = matchPatterns(trimmed, JAVA_PATTERNS, kindMap);
      if (sym && sym.kind === SymbolKind.Method) {
        sym.line = i + 1;
        sym.endLine = findBraceBlockEnd(lines, i);
        currentClass.children.push(sym);
      }
    }
  }
  return symbols;
}

function parseGeneric(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const genericPatterns = [
    /^(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:fn|func|function|def)\s+(\w+)/,
    /^(?:pub\s+)?(?:export\s+)?(?:class|struct)\s+(\w+)/,
    /^(?:pub\s+)?(?:export\s+)?(?:enum|interface|type|trait)\s+(\w+)/,
  ];
  const kindMap = [SymbolKind.Function, SymbolKind.Class, SymbolKind.Enum];

  for (let i = 0; i < lines.length; i++) {
    const sym = matchPatterns(lines[i].trimStart(), genericPatterns, kindMap);
    if (sym) {
      sym.line = i + 1;
      sym.endLine = findBraceBlockEnd(lines, i);
      symbols.push(sym);
    }
  }
  return symbols;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function findStatementEnd(lines: string[], startLine: number): number {
  for (let i = startLine - 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith(");") || trimmed === ");" || trimmed.endsWith(";")) {
      return i + 1;
    }
  }
  return startLine;
}

function addReactWrapperSymbols(content: string, lines: string[], symbols: CodeSymbol[]): CodeSymbol[] {
  const existing = new Set(symbols.map((symbol) => symbol.name));
  const additions: CodeSymbol[] = [];
  const patterns = [
    /(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/g,
    /export\s+default\s+(?:React\.)?(?:memo|forwardRef)\s*\(\s*function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (!name || existing.has(name)) continue;
      const line = lineNumberAt(content, match.index);
      const signature = lines[line - 1]?.trim().slice(0, 180) ?? name;
      additions.push({
        name,
        kind: SymbolKind.Function,
        line,
        endLine: findStatementEnd(lines, line),
        signature,
        children: [],
      });
      existing.add(name);
    }
  }

  return additions.length > 0
    ? [...symbols, ...additions].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name))
    : symbols;
}

function isConfigFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /\.(config|conf|settings)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
    || /(^|\/)(rsbuild|webpack|vite|rollup|next|nuxt|astro|svelte|tailwind|postcss|babel|eslint|jest|vitest|playwright|cypress)\.config\.[jt]sx?$/.test(lower);
}

const CONFIG_KEY_PATTERNS: RegExp[] = [
  /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*[{[]/,
  /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:true|false)\s*(?:[,}]|$)/,
  /^\s*"([a-zA-Z_$][a-zA-Z0-9_$ -]*)"\s*:\s*[{[]/,
];

const CONFIG_MAX_DEPTH = 6;

function extractConfigKeys(lines: string[]): CodeSymbol[] {
  const keys: CodeSymbol[] = [];
  const seenNames = new Set<string>();
  let depth = 0;
  let inExportDefault = false;
  let braceDepthAtExport = -1;
  let inBlockComment = false;
  let inString: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Lightweight string/comment state machine so we don't extract from comments or string contents.
    // Tracks per-character; we don't need a perfect tokenizer, just good-enough for typical configs.
    let lineHasCode = "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const next = line[c + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; c++; }
        continue;
      }
      if (inString) {
        lineHasCode += ch;
        if (ch === "\\") { lineHasCode += next ?? ""; c++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "/" && next === "/") break; // line comment
      if (ch === "/" && next === "*") { inBlockComment = true; c++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; lineHasCode += ch; continue; }
      lineHasCode += ch;
    }

    // Detect entry into an export default object literal — this is what we consider the "config root".
    if (!inExportDefault && /^(?:\s*export\s+default\s+|\s*module\.exports\s*=\s*|\s*export\s+const\s+\w+\s*[:=])/m.test(lineHasCode) && lineHasCode.includes("{")) {
      inExportDefault = true;
      braceDepthAtExport = depth;
    }

    // Track depth only on the in-code portion of the line so braces in strings/comments don't count.
    const opens = (lineHasCode.match(/[{[(]/g) ?? []).length;
    const closes = (lineHasCode.match(/[}\])]/g) ?? []).length;
    const startingDepth = depth;
    depth += opens - closes;
    if (depth < 0) depth = 0;

    if (inExportDefault && depth <= braceDepthAtExport) {
      // Closed the top-level object — leave the config root.
      inExportDefault = false;
      braceDepthAtExport = -1;
    }

    // Skip if we're not inside the config root, or too deep.
    if (!inExportDefault) continue;
    const relativeDepth = startingDepth - braceDepthAtExport;
    if (relativeDepth > CONFIG_MAX_DEPTH) continue;

    for (const pattern of CONFIG_KEY_PATTERNS) {
      const match = lineHasCode.match(pattern);
      if (match?.[1]) {
        const name = match[1].trim();
        if (name.length < 2 || name.length > 40) continue;
        if (CONFIG_KEY_RESERVED.has(name)) continue;
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        keys.push({
          name,
          kind: SymbolKind.Const,
          line: i + 1,
          endLine: i + 1,
          signature: line.trim().slice(0, 180),
          children: [],
        });
        break;
      }
    }
  }
  return keys;
}

const CONFIG_KEY_RESERVED = new Set([
  "default", "if", "for", "while", "return", "function", "class", "type", "const", "let",
  "var", "import", "export", "from", "as", "true", "false", "null", "undefined",
  "case", "switch", "throw", "new", "delete", "typeof", "instanceof", "in", "of",
]);

export async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const raw = await readFile(filePath, "utf-8");
  return analyzeContent(filePath, raw);
}

/**
 * Analyze already-loaded source text under a logical path. Same logic as
 * analyzeFile but without touching disk — lets callers parse content that isn't a
 * working-tree file (e.g. an old git blob for semantic_diff).
 */
export async function analyzeContent(filePath: string, raw: string): Promise<FileAnalysis> {
  const content = (raw.startsWith("﻿") ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const ext = extname(filePath).toLowerCase();

  let symbols: CodeSymbol[] | null = null;
  try {
    symbols = await parseWithTreeSitter(content, ext);
  } catch {
    symbols = null;
  }

  if (!symbols) {
    const lang = detectLanguage(filePath);
    const parsers: Record<string, (l: string[]) => CodeSymbol[]> = {
      typescript: parseTypeScript,
      javascript: parseTypeScript,
      python: parsePython,
      rust: parseRust,
      go: parseGo,
      java: parseJava,
      csharp: parseJava,
      kotlin: parseJava,
    };
    symbols = (parsers[lang ?? ""] ?? parseGeneric)(lines);
  }

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    symbols = addReactWrapperSymbols(content, lines, symbols);
  }

  if (isConfigFile(filePath)) {
    const existingNames = new Set(symbols.map((sym) => `${sym.name}@${sym.line}`));
    const configKeys = extractConfigKeys(lines).filter((key) => !existingNames.has(`${key.name}@${key.line}`));
    if (configKeys.length > 0) {
      symbols = [...symbols, ...configKeys].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
    }
  }

  return {
    path: filePath,
    header: extractHeader(lines),
    symbols,
    lineCount: lines.length,
  };
}

export function formatSymbol(sym: CodeSymbol, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const kindLabel = sym.kind === SymbolKind.Method ? "method" : sym.kind;
  const lineLabel = sym.endLine > sym.line ? `L${sym.line}-L${sym.endLine}` : `L${sym.line}`;
  let result = `${prefix}${kindLabel}: ${sym.name} (${lineLabel})`;

  if (sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method) {
    result = `${prefix}${kindLabel}: ${sym.signature} (${lineLabel})`;
  }

  for (const child of sym.children) {
    result += "\n" + formatSymbol(child, indent + 1);
  }
  return result;
}

export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (detectLanguage(filePath) !== null) return true;
  return getSupportedExtensions().includes(ext);
}

export interface ImportDeclaration {
  source: string;
  specifiers: string[];
  type: "static" | "dynamic" | "re-export";
  line: number;
}

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+["']([^"']+)["']/,
    /^import\s+["']([^"']+)["']/,
    /^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/,
    /import\(["']([^"']+)["']\)/,
  ],
  javascript: [
    /^import\s+(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+["']([^"']+)["']/,
    /^import\s+["']([^"']+)["']/,
    /^export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/,
    /require\(["']([^"']+)["']\)/,
    /import\(["']([^"']+)["']\)/,
  ],
  python: [
    /^from\s+([\w.]+)\s+import\s+(.+)/,
    /^import\s+([\w.]+)/,
  ],
  go: [
    /^\s*"([^"]+)"/,
    /^\s*(\w+)\s+"([^"]+)"/,
  ],
  rust: [
    /^use\s+([\w:]+(?:::\{[^}]+\})?)/,
    /^use\s+([\w:]+)\s+as\s+\w+/,
  ],
};

export function extractImports(content: string, filePath: string): ImportDeclaration[] {
  const ext = extname(filePath).toLowerCase();
  const lang = LANG_MAP[ext];
  if (!lang) return [];

  const langKey = (lang === "tsx" || lang === "typescript") ? "typescript"
    : (lang === "jsx" || lang === "javascript") ? "javascript"
    : lang;

  const patterns = IMPORT_PATTERNS[langKey];
  if (!patterns) return [];

  const imports: ImportDeclaration[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (langKey === "typescript" || langKey === "javascript") {
      const staticMatch = line.match(/^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+["']([^"']+)["']/);
      if (staticMatch) {
        const specParts = (staticMatch[1] || staticMatch[3] || "").split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        if (staticMatch[2]) specParts.unshift(staticMatch[2]);
        imports.push({ source: staticMatch[4], specifiers: specParts, type: "static", line: i + 1 });
        continue;
      }
      const sideEffectMatch = line.match(/^import\s+["']([^"']+)["']/);
      if (sideEffectMatch) {
        imports.push({ source: sideEffectMatch[1], specifiers: [], type: "static", line: i + 1 });
        continue;
      }
      const reExportMatch = line.match(/^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
      if (reExportMatch) {
        const specParts = reExportMatch[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        imports.push({ source: reExportMatch[2], specifiers: specParts, type: "re-export", line: i + 1 });
        continue;
      }
      const dynamicMatch = line.match(/import\(["']([^"']+)["']\)/);
      if (dynamicMatch) {
        imports.push({ source: dynamicMatch[1], specifiers: [], type: "dynamic", line: i + 1 });
        continue;
      }
    }

    if (langKey === "python") {
      const fromMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromMatch) {
        const specParts = fromMatch[2].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        imports.push({ source: fromMatch[1], specifiers: specParts, type: "static", line: i + 1 });
        continue;
      }
      const importMatch = line.match(/^import\s+([\w.]+)/);
      if (importMatch) {
        imports.push({ source: importMatch[1], specifiers: [], type: "static", line: i + 1 });
        continue;
      }
    }

    if (langKey === "go") {
      const goMatch = line.match(/^\s*"([^"]+)"/);
      if (goMatch) {
        imports.push({ source: goMatch[1], specifiers: [], type: "static", line: i + 1 });
        continue;
      }
    }

    if (langKey === "rust") {
      const useMatch = line.match(/^use\s+([\w:]+(?:::\{[^}]+\})?)/);
      if (useMatch) {
        imports.push({ source: useMatch[1], specifiers: [], type: "static", line: i + 1 });
        continue;
      }
    }
  }

  return imports;
}

export interface CallSite {
  callee: string;
  line: number;
  context: string;
}

const CALL_SITE_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "throw", "catch", "new", "delete", "typeof",
  "void", "yield", "await", "async", "function", "class", "do", "in", "of", "instanceof",
  "import", "export", "default", "from", "as", "case", "break", "continue", "let", "const",
  "var", "static", "public", "private", "protected", "true", "false", "null", "undefined",
  "this", "super", "with", "try", "finally", "else", "interface", "type", "enum", "extends",
  "implements", "abstract", "readonly", "declare", "namespace", "module", "package",
]);

const STDLIB_GLOBALS = new Set([
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "BigInt", "Error", "TypeError",
  "Reflect", "Proxy", "globalThis", "console", "process",
]);

export function extractCallSites(content: string): CallSite[] {
  const lines = content.split("\n");
  const sites: CallSite[] = [];
  const callPattern = /(?<![A-Za-z0-9_$.])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  const definitionPattern = /(?:function|class|interface|enum|type|const|let|var|def|fn|func|pub)\s+[a-zA-Z_$]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (definitionPattern.test(line)) continue;
    callPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = callPattern.exec(line)) !== null) {
      const callee = match[1];
      if (seen.has(callee)) continue;
      if (CALL_SITE_KEYWORDS.has(callee)) continue;
      if (STDLIB_GLOBALS.has(callee)) continue;
      if (callee.length < 2) continue;
      seen.add(callee);
      sites.push({ callee, line: i + 1, context: line.trim().substring(0, 120) });
    }
  }
  return sites;
}

export function flattenSymbols(symbols: CodeSymbol[], parentName?: string): SymbolLocation[] {
  const out: SymbolLocation[] = [];
  for (const sym of symbols) {
    out.push({
      name: sym.name,
      kind: sym.kind,
      line: sym.line,
      endLine: sym.endLine,
      signature: sym.signature,
      parentName,
    });
    if (sym.children.length > 0) {
      out.push(...flattenSymbols(sym.children, sym.name));
    }
  }
  return out;
}
