// Shared chat-model access for local Ollama/OpenAI-assisted ranking and naming
// FEATURE: Optional LLM helpers for reranking and labeling without hard failure

import { readFile } from "fs/promises";
import { join } from "path";

type OllamaChatClient = { chat: (params: Record<string, unknown>) => Promise<{ message: { content: string } }> };

interface ContextPlusConfig {
  provider?: string;
  chatModel?: string;
}

let ollamaClient: OllamaChatClient | null = null;
const DEFAULT_OLLAMA_CHAT_MODEL = "gemma4:12b";
const OPENAI_BASE_URL = process.env.CONTEXTPRO_OPENAI_BASE_URL ?? process.env.CONTEXTPLUS_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_CHAT_MODEL = process.env.CONTEXTPRO_OPENAI_CHAT_MODEL ?? process.env.CONTEXTPLUS_OPENAI_CHAT_MODEL ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

// Any provider speaking the OpenAI /chat/completions API maps to the "openai" path. Point
// CONTEXTPRO_OPENAI_BASE_URL at the endpoint (OpenRouter, Groq, Together, vLLM, LM Studio, …).
const OPENAI_COMPATIBLE_ALIASES = new Set(["openai", "openai-compatible", "openrouter", "groq", "together", "deepinfra", "vllm", "lmstudio", "litellm", "anyscale"]);
function normalizeChatProvider(raw: string): "ollama" | "openai" {
  const p = raw.trim().toLowerCase();
  if (OPENAI_COMPATIBLE_ALIASES.has(p)) return "openai";
  return "ollama";
}

async function getOllamaClient(): Promise<OllamaChatClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaChatClient;
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

export async function hasConfiguredChatModel(rootDir: string): Promise<boolean> {
  const config = await readContextPlusConfig(rootDir);
  const rawProvider = process.env.CONTEXTPRO_CHAT_PROVIDER ?? process.env.CONTEXTPLUS_CHAT_PROVIDER ?? config?.provider ?? "";
  const provider = normalizeChatProvider(rawProvider);
  if (provider === "openai") {
    return Boolean(process.env.CONTEXTPRO_OPENAI_API_KEY ?? process.env.CONTEXTPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY);
  }
  return Boolean(process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel);
}

export async function chatCompletion(rootDir: string, prompt: string): Promise<string> {
  const config = await readContextPlusConfig(rootDir);
  const rawProvider = process.env.CONTEXTPRO_CHAT_PROVIDER ?? process.env.CONTEXTPLUS_CHAT_PROVIDER ?? process.env.CONTEXTPRO_EMBED_PROVIDER ?? process.env.CONTEXTPLUS_EMBED_PROVIDER ?? config?.provider ?? "ollama";
  const provider = normalizeChatProvider(rawProvider);
  if (provider === "openai") {
    const apiKey = process.env.CONTEXTPRO_OPENAI_API_KEY ?? process.env.CONTEXTPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) throw new Error("OpenAI chat requested but no API key is configured.");
    const response = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI chat API error ${response.status}: ${body}`);
    }
    const data = await response.json() as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }

  const model = process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel ?? DEFAULT_OLLAMA_CHAT_MODEL;
  if (!model) throw new Error("No Ollama chat model is configured.");
  const client = await getOllamaClient();
  try {
    const response = await client.chat({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
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
