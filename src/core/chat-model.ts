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
const OPENAI_BASE_URL = process.env.CONTEXTPLUS_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_CHAT_MODEL = process.env.CONTEXTPLUS_OPENAI_CHAT_MODEL ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

async function getOllamaClient(): Promise<OllamaChatClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaChatClient;
  }
  return ollamaClient;
}

async function readContextPlusConfig(rootDir: string): Promise<ContextPlusConfig | null> {
  try {
    const raw = await readFile(join(rootDir, ".contextplus", "config.json"), "utf-8");
    return JSON.parse(raw) as ContextPlusConfig;
  } catch {
    return null;
  }
}

export async function hasConfiguredChatModel(rootDir: string): Promise<boolean> {
  const config = await readContextPlusConfig(rootDir);
  const provider = (process.env.CONTEXTPLUS_CHAT_PROVIDER ?? process.env.CONTEXTPLUS_EMBED_PROVIDER ?? config?.provider ?? "ollama").toLowerCase();
  if (provider === "openai") {
    return Boolean(process.env.CONTEXTPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY);
  }
  return Boolean(process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel);
}

export async function chatCompletion(rootDir: string, prompt: string): Promise<string> {
  const config = await readContextPlusConfig(rootDir);
  const provider = (process.env.CONTEXTPLUS_CHAT_PROVIDER ?? process.env.CONTEXTPLUS_EMBED_PROVIDER ?? config?.provider ?? "ollama").toLowerCase();
  if (provider === "openai") {
    const apiKey = process.env.CONTEXTPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
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

  const model = process.env.OLLAMA_CHAT_MODEL ?? config?.chatModel;
  if (!model) throw new Error("No Ollama chat model is configured.");
  const client = await getOllamaClient();
  const response = await client.chat({
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  });
  return response.message.content;
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
