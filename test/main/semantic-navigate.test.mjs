// Semantic navigate structural tests without Ollama dependency
// Tests exports and function signatures of the navigate tool

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

describe("semantic-navigate", () => {
  it("exports semanticNavigate as a function", async () => {
    const mod = await import("../../build/tools/semantic-navigate.js");
    assert.equal(typeof mod.semanticNavigate, "function");
  });

  it("semanticNavigate takes single options argument", async () => {
    const mod = await import("../../build/tools/semantic-navigate.js");
    assert.equal(mod.semanticNavigate.length, 1);
  });

  it("skips data files and navigates source files", async () => {
    const { semanticNavigate } =
      await import("../../build/tools/semantic-navigate.js");
    const rootDir = await mkdtemp(
      join(tmpdir(), "contextplus-semantic-navigate-"),
    );
    const originalEmbed = Ollama.prototype.embed;
    const originalChat = Ollama.prototype.chat;
    const previousChatModel = process.env.CONTEXTPRO_CHAT_MODEL;
    const previousOllamaChatModel = process.env.OLLAMA_CHAT_MODEL;
    delete process.env.CONTEXTPRO_CHAT_MODEL;
    delete process.env.OLLAMA_CHAT_MODEL;
    let chatCalls = 0;

    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return { embeddings: batch.map(() => [1, 0, 0]) };
    };
    Ollama.prototype.chat = async function () {
      chatCalls++;
      return { message: { content: JSON.stringify(["Source file"]) } };
    };

    try {
      await writeFile(
        join(rootDir, "app.ts"),
        [
          "// Semantic navigate fixture header line one two three four",
          "// FEATURE: semantic navigate fixture for source-only clustering output",
          "export const meaning = 42;",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "data.json"),
        JSON.stringify({
          rows: Array.from({ length: 10000 }, (_, idx) => ({
            id: idx,
            value: `cell_${idx}`,
          })),
        }),
      );

      const result = await semanticNavigate({
        rootDir,
        maxDepth: 2,
        maxClusters: 5,
      });
      assert.match(result, /app\.ts/);
      assert.doesNotMatch(result, /data\.json/);
      assert.equal(chatCalls, 0, "an unset chat model must not receive source metadata");
    } finally {
      Ollama.prototype.embed = originalEmbed;
      Ollama.prototype.chat = originalChat;
      if (previousChatModel === undefined) delete process.env.CONTEXTPRO_CHAT_MODEL;
      else process.env.CONTEXTPRO_CHAT_MODEL = previousChatModel;
      if (previousOllamaChatModel === undefined) delete process.env.OLLAMA_CHAT_MODEL;
      else process.env.OLLAMA_CHAT_MODEL = previousOllamaChatModel;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses chat labels only when a chat model is explicitly configured", async () => {
    const { semanticNavigate } = await import("../../build/tools/semantic-navigate.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-semantic-navigate-chat-"));
    const originalEmbed = Ollama.prototype.embed;
    const originalChat = Ollama.prototype.chat;
    const previousChatModel = process.env.CONTEXTPRO_CHAT_MODEL;
    process.env.CONTEXTPRO_CHAT_MODEL = "test-chat-model";
    let chatCalls = 0;
    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return { embeddings: batch.map(() => [1, 0, 0]) };
    };
    Ollama.prototype.chat = async function () {
      chatCalls++;
      return { message: { content: JSON.stringify(["Explicit chat label"]) } };
    };

    try {
      await writeFile(join(rootDir, "app.ts"), "export const meaning = 42;\n");
      const result = await semanticNavigate({ rootDir, maxDepth: 2, maxClusters: 5 });
      assert.match(result, /Explicit chat label/);
      assert.equal(chatCalls, 1);
    } finally {
      Ollama.prototype.embed = originalEmbed;
      Ollama.prototype.chat = originalChat;
      if (previousChatModel === undefined) delete process.env.CONTEXTPRO_CHAT_MODEL;
      else process.env.CONTEXTPRO_CHAT_MODEL = previousChatModel;
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
