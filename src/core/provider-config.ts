// Single source of truth for LLM provider configuration (embeddings + chat).
// FEATURE: Generic, short env vars with full backward-compatibility to the older long names.
//
// Precedence for every setting (first non-empty wins):
//   1. Generic key            — CONTEXTPRO_PROVIDER / _API_KEY / _BASE_URL / _EMBED_MODEL / _CHAT_MODEL
//   2. Legacy CONTEXTPRO_*    — e.g. CONTEXTPRO_EMBED_PROVIDER, CONTEXTPRO_OPENAI_API_KEY
//   3. Legacy CONTEXTPLUS_*   — the pre-rename aliases
//   4. Provider-native        — OLLAMA_* / OPENAI_* (so `OPENAI_API_KEY` etc. just work)
//   5. Built-in default

export type ResolvedProvider = "ollama" | "openai";

// Any provider speaking the OpenAI /embeddings + /chat/completions API maps to the "openai" path.
// Aliases are purely for readability — they behave identically. Point CONTEXTPRO_BASE_URL at the
// endpoint (OpenRouter, Groq, Together, vLLM, LM Studio, …).
const OPENAI_COMPATIBLE_ALIASES = new Set([
  "openai", "openai-compatible", "compatible", "openrouter", "groq", "together",
  "deepinfra", "vllm", "lmstudio", "litellm", "anyscale", "fireworks", "mistral",
]);

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v !== undefined && v.trim().length > 0) return v;
  }
  return undefined;
}

export function normalizeProvider(raw: string | undefined): ResolvedProvider {
  const p = (raw ?? "").trim().toLowerCase();
  if (p === "ollama" || p === "local" || p === "") return p === "" ? "ollama" : "ollama";
  return OPENAI_COMPATIBLE_ALIASES.has(p) ? "openai" : "ollama";
}

const env = process.env;

/** The selected backend: `ollama` (local) or `openai` (any OpenAI-compatible endpoint). */
export function getProvider(): ResolvedProvider {
  return normalizeProvider(firstNonEmpty(
    env.CONTEXTPRO_PROVIDER,
    env.CONTEXTPRO_EMBED_PROVIDER,
    env.CONTEXTPLUS_EMBED_PROVIDER,
  ));
}

/** Chat backend — defaults to the embed provider unless overridden. */
export function getChatProvider(): ResolvedProvider {
  return normalizeProvider(firstNonEmpty(
    env.CONTEXTPRO_CHAT_PROVIDER,
    env.CONTEXTPLUS_CHAT_PROVIDER,
    env.CONTEXTPRO_PROVIDER,
    env.CONTEXTPRO_EMBED_PROVIDER,
    env.CONTEXTPLUS_EMBED_PROVIDER,
  ));
}

/** API key for the OpenAI-compatible path. */
export function getApiKey(): string {
  return firstNonEmpty(
    env.CONTEXTPRO_API_KEY,
    env.CONTEXTPRO_OPENAI_API_KEY,
    env.CONTEXTPLUS_OPENAI_API_KEY,
    env.OPENAI_API_KEY,
  ) ?? "";
}

/** Base URL for the OpenAI-compatible path. */
export function getBaseUrl(): string {
  return firstNonEmpty(
    env.CONTEXTPRO_BASE_URL,
    env.CONTEXTPRO_OPENAI_BASE_URL,
    env.CONTEXTPLUS_OPENAI_BASE_URL,
    env.OPENAI_BASE_URL,
  ) ?? "https://api.openai.com/v1";
}

/** Embedding model name. Provider-aware default. */
export function getEmbedModelName(provider: ResolvedProvider = getProvider()): string {
  const generic = firstNonEmpty(env.CONTEXTPRO_EMBED_MODEL);
  if (generic) return generic;
  if (provider === "openai") {
    return firstNonEmpty(
      env.CONTEXTPRO_OPENAI_EMBED_MODEL,
      env.CONTEXTPLUS_OPENAI_EMBED_MODEL,
      env.OPENAI_EMBED_MODEL,
    ) ?? "text-embedding-3-small";
  }
  return firstNonEmpty(env.OLLAMA_EMBED_MODEL) ?? "nomic-embed-text:latest";
}

/** Chat model name. Provider-aware default. */
export function getChatModelName(provider: ResolvedProvider = getChatProvider()): string {
  const generic = firstNonEmpty(env.CONTEXTPRO_CHAT_MODEL);
  if (generic) return generic;
  if (provider === "openai") {
    return firstNonEmpty(
      env.CONTEXTPRO_OPENAI_CHAT_MODEL,
      env.CONTEXTPLUS_OPENAI_CHAT_MODEL,
      env.OPENAI_CHAT_MODEL,
    ) ?? "gpt-4o-mini";
  }
  return firstNonEmpty(env.OLLAMA_CHAT_MODEL) ?? "gemma4:12b";
}
