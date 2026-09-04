// Lightweight source masking shared by reference and call-site scanners
// FEATURE: Preserve offsets while excluding comments and string literals from code matches

import { extname } from "path";

const HASH_COMMENT_EXTENSIONS = new Set([
  ".py", ".rb", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".pl", ".r",
]);

type MaskMode =
  | { kind: "code" }
  | { kind: "line-comment" }
  | { kind: "block-comment" }
  | { kind: "string"; delimiter: "'" | '"' }
  | { kind: "template" }
  | { kind: "template-expression"; braceDepth: number };

/**
 * Return a same-length mask whose true positions are comments or literal text.
 * Template literal text is masked, but `${...}` expressions stay executable code.
 */
export function sourceMaskFlags(content: string, filePath?: string): boolean[] {
  const masked = new Array<boolean>(content.length).fill(false);
  const hashComments = filePath ? HASH_COMMENT_EXTENSIONS.has(extname(filePath).toLowerCase()) : false;
  const modes: MaskMode[] = [{ kind: "code" }];
  const hide = (index: number) => { masked[index] = true; };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    const mode = modes[modes.length - 1];

    if (mode.kind === "line-comment") {
      hide(i);
      if (ch === "\n") modes.pop();
      continue;
    }
    if (mode.kind === "block-comment") {
      hide(i);
      if (ch === "*" && next === "/") {
        hide(i + 1);
        i++;
        modes.pop();
      }
      continue;
    }
    if (mode.kind === "string") {
      hide(i);
      if (ch === "\\") {
        if (next !== undefined) {
          hide(i + 1);
          i++;
        }
        continue;
      }
      if (ch === mode.delimiter) modes.pop();
      continue;
    }
    if (mode.kind === "template") {
      hide(i);
      if (ch === "\\") {
        if (next !== undefined) {
          hide(i + 1);
          i++;
        }
        continue;
      }
      if (ch === "$" && next === "{") {
        hide(i + 1);
        i++;
        modes.push({ kind: "template-expression", braceDepth: 1 });
        continue;
      }
      if (ch === "`") modes.pop();
      continue;
    }
    if (mode.kind === "template-expression") {
      if (ch === "{") {
        mode.braceDepth++;
        continue;
      }
      if (ch === "}") {
        hide(i);
        mode.braceDepth--;
        if (mode.braceDepth === 0) modes.pop();
        continue;
      }
    }

    // Root code and template-expression code share the same lexical rules.
    if (ch === "/" && next === "/") {
      hide(i);
      hide(i + 1);
      i++;
      modes.push({ kind: "line-comment" });
      continue;
    }
    if (ch === "/" && next === "*") {
      hide(i);
      hide(i + 1);
      i++;
      modes.push({ kind: "block-comment" });
      continue;
    }
    if (hashComments && ch === "#") {
      hide(i);
      modes.push({ kind: "line-comment" });
      continue;
    }
    if (ch === "\"" || ch === "'") {
      hide(i);
      modes.push({ kind: "string", delimiter: ch });
      continue;
    }
    if (ch === "`") {
      hide(i);
      modes.push({ kind: "template" });
    }
  }

  return masked;
}

/** Return same-length source with comments and literal text replaced by spaces. */
export function maskSourceText(content: string, filePath?: string): string {
  const flags = sourceMaskFlags(content, filePath);
  return content.split("").map((ch, index) => flags[index] && ch !== "\n" && ch !== "\r" ? " " : ch).join("");
}
