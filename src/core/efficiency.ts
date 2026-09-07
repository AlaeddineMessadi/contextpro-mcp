// Conservative token-efficiency estimates for MCP responses.
// FEATURE: Auditable savings footer and numeric-only history across sessions.

import { resolve } from "path";
import { getDB, type FileRow, type ToolCallEfficiency } from "./db.js";

export interface EfficiencyEstimate extends Required<ToolCallEfficiency> {
  method: "indexed-source-bytes-vs-response-chars";
}

const inventoryCache = new Map<string, { generation: number; files: FileRow[] }>();
const sessionSavings = new Map<string, number>();
const MAX_CACHED_ROOTS = 50;
// Ephemeral IDs only: never persist paths or content in efficiency history.
// When tracking fills up, under-count rather than crediting an unseen duplicate.
const creditedSources = new Map<string, Set<string>>();
const MAX_CREDITED_SOURCES = 100_000;

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function responseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "")
      .filter(Boolean);
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) {
      try {
        texts.push(JSON.stringify(structured));
      } catch {
        // Keep the plain text response when structured output is not serializable.
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function estimateResponseTokens(result: unknown): number {
  return estimateTokens(responseText(result));
}

function containsExplicitPath(text: string, path: string): boolean {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(path, offset);
    if (index < 0) return false;
    const preceding = text[index - 1];
    const following = text[index + path.length];
    // Require both sides to be path-token boundaries so `a.ts` does not match
    // `data.ts` or `src/a.ts`.
    if ((!preceding || !/[A-Za-z0-9_./-]/.test(preceding)) &&
        (!following || !/[A-Za-z0-9_./-]/.test(following))) return true;
    offset = index + path.length;
  }
  return false;
}

function pathVariants(rootDir: string, relativePath: string): string[] {
  const relative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = resolve(rootDir, relative).replace(/\\/g, "/");
  return [relative, `./${relative}`, absolute];
}

async function indexedFiles(rootDir: string): Promise<FileRow[]> {
  const normalizedRoot = resolve(rootDir);
  const db = await getDB(normalizedRoot);
  const generation = db.getIndexGeneration();
  const cached = inventoryCache.get(normalizedRoot);
  if (cached?.generation === generation) return cached.files;
  const files = db.getAllFiles();
  inventoryCache.delete(normalizedRoot);
  inventoryCache.set(normalizedRoot, { generation, files });
  while (inventoryCache.size > MAX_CACHED_ROOTS) {
    const oldest = inventoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    inventoryCache.delete(oldest);
  }
  return files;
}

/**
 * Estimate only what can be audited locally: indexed file paths explicitly
 * represented in the request/response, their recorded byte sizes, and the text
 * actually returned. It deliberately does not infer model billing or cache hits.
 */
export async function estimateToolEfficiency(rootDir: string, args: unknown, result: unknown, deduplicateSource: boolean = false): Promise<EfficiencyEstimate> {
  const output = responseText(result);
  let input = "";
  try {
    input = JSON.stringify(args) ?? "";
  } catch {
    input = String(args ?? "");
  }
  const searchable = `${input}\n${output}`.replace(/\\/g, "/");
  const files = await indexedFiles(rootDir);
  const root = resolve(rootDir);
  if (deduplicateSource && !creditedSources.has(root) && creditedSources.size < MAX_CACHED_ROOTS) creditedSources.set(root, new Set());
  const credited = creditedSources.get(root);
  let representedFiles = 0;
  let sourceTokens = 0;
  for (const file of files) {
    if (!pathVariants(rootDir, file.path).some((path) => containsExplicitPath(searchable, path))) continue;
    representedFiles++;
    if (deduplicateSource) {
      const key = `${file.path}\0${file.content_hash}`;
      if (!credited || credited.has(key) || credited.size >= MAX_CREDITED_SOURCES) continue;
      credited.add(key);
    }
    sourceTokens += Math.ceil(Math.max(0, file.file_size) / 4);
  }
  const outputTokens = estimateTokens(output);
  return {
    inputTokens: estimateTokens(input),
    outputTokens,
    sourceTokens,
    savedTokens: Math.max(0, sourceTokens - outputTokens - estimateTokens(input)),
    representedFiles,
    method: "indexed-source-bytes-vs-response-chars",
  };
}

export function addToSessionSavings(rootDir: string, estimate: EfficiencyEstimate): number {
  const normalizedRoot = resolve(rootDir);
  const total = (sessionSavings.get(normalizedRoot) ?? 0) + estimate.savedTokens;
  sessionSavings.delete(normalizedRoot);
  sessionSavings.set(normalizedRoot, total);
  while (sessionSavings.size > MAX_CACHED_ROOTS) {
    const oldest = sessionSavings.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionSavings.delete(oldest);
  }
  return total;
}

function footerEnabled(): boolean {
  const raw = (process.env.CONTEXTPRO_EFFICIENCY_FOOTER ?? process.env.CONTEXTPLUS_EFFICIENCY_FOOTER ?? "0").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/** Append a compact, clearly-labelled estimate to text MCP results. */
export function appendEfficiencyFooter<T>(result: T, estimate: EfficiencyEstimate, sessionSavedTokens: number = estimate.savedTokens): T {
  if (!footerEnabled() || estimate.savedTokens < 100 || !result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  const textItem = [...content].reverse().find((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") as { text: string } | undefined;
  if (!textItem) return result;
  try {
    JSON.parse(textItem.text);
    return result; // Preserve machine-readable tool responses as valid JSON.
  } catch {
    // Plain text response; safe to append a human-readable footer.
  }
  textItem.text += `\n\nContextPro estimated ~${estimate.savedTokens.toLocaleString("en-US")} source tokens avoided this call across ${estimate.representedFiles} file${estimate.representedFiles === 1 ? "" : "s"}, before this optional footer. Use efficiency_report for the net session estimate.`;
  return result;
}
