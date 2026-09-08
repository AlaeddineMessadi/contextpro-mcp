// Shared chat-model access for local Ollama/OpenAI-assisted ranking and naming
// FEATURE: Optional LLM helpers for reranking and labeling without hard failure

import { readFile } from "fs/promises";
import { join } from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeProvider, getApiKey, getBaseUrl, getChatModelName } from "./provider-config.js";

type OllamaChatClient = { chat: (params: Record<string, unknown>) => Promise<{ message: { content: string } }> };

interface ContextPlusConfig {
  provider?: string;
  chatModel?: string;
}

let ollamaClient: OllamaChatClient | null = null;
const chatSignals = new AsyncLocalStorage<AbortSignal>();

async function getOllamaClient(): Promise<OllamaChatClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST,
      fetch: (input, init) => fetch(input, { ...init, signal: chatSignals.getStore() ?? init?.signal }),
    }) as unknown as OllamaChatClient;
  }
  return ollamaClient;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatOllamaChatError(error: unknown, model: string): string {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();
  const installHint = "Install Ollama from https://ollama.com/download, then run `ollama serve`.";
  const modelHint = `Run \`ollama pull ${model}\`, or set OLLAMA_CHAT_MODEL to any chat model shown by \`ollama list\`.`;

  if (
    lower.includes("econnrefused")
    || lower.includes("fetch failed")
    || lower.includes("connection refused")
    || lower.includes("connect")
  ) {
    return `Ollama is not reachable while loading the chat model "${model}". ${installHint} ${modelHint} Original error: ${message}`;
  }

  if (lower.includes("not found") || lower.includes("no such model") || lower.includes("model")) {
    return `Ollama chat model "${model}" is not available. ${modelHint} Original error: ${message}`;
  }

  return `Ollama chat model "${model}" failed. ${installHint} ${modelHint} Original error: ${message}`;
}

async function readContextPlusConfig(rootDir: string): Promise<ContextPlusConfig | null> {
  try {
    const raw = await readFile(join(rootDir, ".contextpro", "config.json"), "utf-8");
    return JSON.parse(raw) as ContextPlusConfig;
  } catch {
    return null;
  }
}

// Resolve the chat provider, honoring an explicit CONTEXTPRO_CHAT_PROVIDER, then the general
// provider keys, then a per-project .contextpro/config.json `provider`, then default ollama.
function resolveChatProvider(config: ContextPlusConfig | null): "ollama" | "openai" {
  const raw = process.env.CONTEXTPRO_CHAT_PROVIDER
    ?? process.env.CONTEXTPLUS_CHAT_PROVIDER
    ?? process.env.CONTEXTPRO_PROVIDER
    ?? process.env.CONTEXTPRO_EMBED_PROVIDER
    ?? process.env.CONTEXTPLUS_EMBED_PROVIDER
    ?? config?.provider
    ?? "ollama";
  return normalizeProvider(raw);
}

export async function hasConfiguredChatModel(rootDir: string): Promise<boolean> {
  const config = await readContextPlusConfig(rootDir);
  const provider = resolveChatProvider(config);
  if (provider === "openai") {
    return Boolean(getApiKey());
  }
  return Boolean(process.env.CONTEXTPRO_CHAT_MODEL ?? process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel);
}

export async function chatCompletion(rootDir: string, prompt: string, options: { timeoutMs?: number } = {}): Promise<string> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const config = await readContextPlusConfig(rootDir);
  const provider = resolveChatProvider(config);
  if (provider === "openai") {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("OpenAI-compatible chat requested but no API key is configured. Set CONTEXTPRO_API_KEY.");
    const response = await fetch(`${getBaseUrl().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getChatModelName("openai"),
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible chat API error ${response.status}: ${body}`);
    }
    const data = await response.json() as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }

  const model = process.env.CONTEXTPRO_CHAT_MODEL ?? process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel ?? getChatModelName("ollama");
  if (!model) throw new Error("No Ollama chat model is configured.");
  const client = await getOllamaClient();
  try {
    const response = await chatSignals.run(signal, () => client.chat({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }));
    return response.message.content;
  } catch (error) {
    throw new Error(formatOllamaChatError(error, model));
  }
}

export function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed;
  }
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : null;
}
