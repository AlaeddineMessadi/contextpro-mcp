// WASM parsing runs in a disposable process: a fatal V8 error must not kill MCP.
import type { CodeSymbol } from "./parser.js";
import { getGrammarName, type SyntaxValidationResult } from "./tree-sitter-runtime.js";
import { IsolatedParser } from "./parser-process.js";
export { getGrammarName, getSupportedExtensions, type SyntaxValidationResult } from "./tree-sitter-runtime.js";

const parser = new IsolatedParser();

export async function parseWithTreeSitter(content: string, ext: string): Promise<CodeSymbol[] | null> {
  if (!getGrammarName(ext)) return null;
  try { return await parser.request("parse", content, ext) as CodeSymbol[] | null; }
  catch { return null; } // analyzeContent uses its structural regex fallback.
}

export async function validateSyntax(content: string, ext: string): Promise<SyntaxValidationResult> {
  if (!getGrammarName(ext)) return { ok: true, checked: false, firstError: null };
  // A crashed parser is not evidence that an edit is valid. Fail closed.
  const result = await parser.request("validate", content, ext) as SyntaxValidationResult;
  if (!result.checked) throw new Error("Syntax validation unavailable: parser could not check the source. Retry or validate with a native language tool.");
  return result;
}
