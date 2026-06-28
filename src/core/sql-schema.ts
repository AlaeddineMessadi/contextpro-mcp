// SQL schema / RLS extractor for Postgres + Supabase migrations.
//
// FEATURE: Agents working on Supabase apps constantly need "what columns does X
// have / does role Y have a SELECT policy on Z / what's the body of function W" —
// today the only answer is dropping to psql. This parses migration SQL into
// tables (columns + types + CHECK), RLS state, policies (command/roles/predicate),
// and SECURITY DEFINER functions, so those questions are answerable from the index.
//
// A focused line/regex parser (not a full SQL grammar) keeps this dependency-free
// and covers the DDL constructs that matter for schema/RLS questions. It is
// deliberately lenient: unrecognized statements are skipped, never thrown.

export interface SqlColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  check: string | null;
}

export interface SqlTable {
  name: string;
  schema: string;
  columns: SqlColumn[];
  rlsEnabled: boolean;
  line: number;
}

export interface SqlPolicy {
  name: string;
  table: string;
  command: string; // select | insert | update | delete | all
  roles: string[];
  using: string | null;
  withCheck: string | null;
  line: number;
}

export interface SqlFunction {
  name: string;
  schema: string;
  securityDefiner: boolean;
  language: string | null;
  body: string;
  line: number;
}

export interface SqlSchema {
  path: string;
  tables: SqlTable[];
  policies: SqlPolicy[];
  functions: SqlFunction[];
}

function stripSchemaPrefix(qualified: string): { schema: string; name: string } {
  const cleaned = qualified.replace(/"/g, "").trim();
  const parts = cleaned.split(".");
  if (parts.length >= 2) return { schema: parts[0], name: parts[parts.length - 1] };
  return { schema: "public", name: cleaned };
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Split a parenthesized column list on top-level commas only (so `numeric(10,2)`
 * and `check (a > 0)` stay intact).
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const TABLE_LEVEL_KEYWORDS = /^(primary\s+key|foreign\s+key|unique|check|constraint|exclude|like)\b/i;

function parseColumn(raw: string): SqlColumn | null {
  const text = raw.trim();
  if (!text || TABLE_LEVEL_KEYWORDS.test(text)) return null;

  const nameMatch = text.match(/^("?[a-zA-Z_][\w]*"?)\s+(.+)$/s);
  if (!nameMatch) return null;
  const name = nameMatch[1].replace(/"/g, "");
  let rest = nameMatch[2].trim();

  // Type is the leading token(s), possibly with a (precision[, scale]) and array []/.
  const typeMatch = rest.match(/^([a-zA-Z_][\w]*(\s+[a-zA-Z]+)?(\s*\([^)]*\))?(\s*\[\])?)/);
  const type = typeMatch ? typeMatch[1].trim() : rest.split(/\s+/)[0];

  const notNull = /\bnot\s+null\b/i.test(rest);
  const defaultMatch = rest.match(/\bdefault\s+(.+?)(?=\s+(?:not\s+null|check|references|unique|primary)\b|$)/is);
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;
  const checkMatch = rest.match(/\bcheck\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/i);
  const check = checkMatch ? checkMatch[1].trim() : null;

  return { name, type, notNull, defaultValue, check };
}

function extractTables(source: string): SqlTable[] {
  const tables: SqlTable[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const { schema, name } = stripSchemaPrefix(match[1]);
    // Find the matching close paren for the column list.
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    const body = source.slice(start, i - 1);
    const columns = splitTopLevel(body)
      .map(parseColumn)
      .filter((c): c is SqlColumn => c !== null);
    tables.push({ name, schema, columns, rlsEnabled: false, line: lineOf(source, match.index) });
  }
  return tables;
}

function applyRlsFlags(source: string, tables: SqlTable[]): void {
  const re = /alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const { name } = stripSchemaPrefix(match[1]);
    const table = tables.find((t) => t.name === name);
    if (table) table.rlsEnabled = true;
  }
}

function extractPolicies(source: string): SqlPolicy[] {
  const policies: SqlPolicy[] = [];
  // Match through the optional clauses up to the statement terminator.
  const re = /create\s+policy\s+("([^"]+)"|[\w]+)\s+on\s+([\w."]+)([\s\S]*?);/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = (match[2] ?? match[1]).replace(/"/g, "");
    const { name: table } = stripSchemaPrefix(match[3]);
    const clause = match[4];

    const commandMatch = clause.match(/\bfor\s+(all|select|insert|update|delete)\b/i);
    const command = commandMatch ? commandMatch[1].toLowerCase() : "all";

    const rolesMatch = clause.match(/\bto\s+([\w\s,]+?)(?=\s+(?:using|with\s+check)\b|$)/i);
    const roles = rolesMatch
      ? rolesMatch[1].split(",").map((r) => r.trim()).filter(Boolean)
      : [];

    const usingMatch = clause.match(/\busing\s*\(([\s\S]*?)\)(?=\s*(?:with\s+check|$))/i);
    const withCheckMatch = clause.match(/\bwith\s+check\s*\(([\s\S]*?)\)\s*$/i);

    policies.push({
      name,
      table,
      command,
      roles,
      using: usingMatch ? usingMatch[1].trim() : null,
      withCheck: withCheckMatch ? withCheckMatch[1].trim() : null,
      line: lineOf(source, match.index),
    });
  }
  return policies;
}

function extractFunctions(source: string): SqlFunction[] {
  const functions: SqlFunction[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const { schema, name } = stripSchemaPrefix(match[1]);
    // The function definition runs until its dollar-quoted body closes, or to ';'.
    const afterParen = source.slice(match.index);
    const dollarTag = afterParen.match(/as\s+(\$[\w]*\$)/i);
    let body = "";
    let header = afterParen;
    if (dollarTag) {
      const tag = dollarTag[1];
      const openIdx = afterParen.indexOf(tag, dollarTag.index);
      const closeIdx = afterParen.indexOf(tag, openIdx + tag.length);
      if (openIdx !== -1 && closeIdx !== -1) {
        body = afterParen.slice(openIdx + tag.length, closeIdx).trim();
        header = afterParen.slice(0, openIdx);
      }
    }
    const securityDefiner = /\bsecurity\s+definer\b/i.test(header);
    const langMatch = header.match(/\blanguage\s+([\w]+)/i);

    functions.push({
      name,
      schema,
      securityDefiner,
      language: langMatch ? langMatch[1].toLowerCase() : null,
      body,
      line: lineOf(source, match.index),
    });
  }
  return functions;
}

export function extractSqlSchema(path: string, source: string): SqlSchema {
  const normalized = source.replace(/\r\n/g, "\n");
  const tables = extractTables(normalized);
  applyRlsFlags(normalized, tables);
  return {
    path,
    tables,
    policies: extractPolicies(normalized),
    functions: extractFunctions(normalized),
  };
}
