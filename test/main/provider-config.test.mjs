import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProvider,
  getProvider,
  getChatProvider,
  getApiKey,
  getBaseUrl,
  getEmbedModelName,
  getChatModelName,
} from "../../build/core/provider-config.js";

// Every provider-config var we touch, so we can clear and restore around each test.
const PROVIDER_ENV_KEYS = [
  "CONTEXTPRO_PROVIDER",
  "CONTEXTPRO_API_KEY",
  "CONTEXTPRO_BASE_URL",
  "CONTEXTPRO_EMBED_MODEL",
  "CONTEXTPRO_CHAT_MODEL",
  "CONTEXTPRO_CHAT_PROVIDER",
  "CONTEXTPRO_EMBED_PROVIDER",
  "CONTEXTPRO_OPENAI_API_KEY",
  "CONTEXTPRO_OPENAI_BASE_URL",
  "CONTEXTPRO_OPENAI_EMBED_MODEL",
  "CONTEXTPRO_OPENAI_CHAT_MODEL",
  "CONTEXTPLUS_EMBED_PROVIDER",
  "CONTEXTPLUS_CHAT_PROVIDER",
  "CONTEXTPLUS_OPENAI_API_KEY",
  "CONTEXTPLUS_OPENAI_BASE_URL",
  "CONTEXTPLUS_OPENAI_EMBED_MODEL",
  "CONTEXTPLUS_OPENAI_CHAT_MODEL",
  "OLLAMA_EMBED_MODEL",
  "OLLAMA_CHAT_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_EMBED_MODEL",
  "OPENAI_CHAT_MODEL",
];

describe("provider-config", () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of PROVIDER_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROVIDER_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("normalizeProvider", () => {
    it("maps empty / unknown / ollama to ollama", () => {
      assert.equal(normalizeProvider(undefined), "ollama");
      assert.equal(normalizeProvider(""), "ollama");
      assert.equal(normalizeProvider("ollama"), "ollama");
      assert.equal(normalizeProvider("local"), "ollama");
      assert.equal(normalizeProvider("something-weird"), "ollama");
    });

    it("maps openai and every alias to openai", () => {
      for (const alias of [
        "openai", "openai-compatible", "compatible", "openrouter", "groq",
        "together", "deepinfra", "vllm", "lmstudio", "litellm", "anyscale",
        "fireworks", "mistral",
      ]) {
        assert.equal(normalizeProvider(alias), "openai", `${alias} should map to openai`);
        assert.equal(normalizeProvider(alias.toUpperCase()), "openai", `${alias} uppercase`);
        assert.equal(normalizeProvider(`  ${alias}  `), "openai", `${alias} trimmed`);
      }
    });
  });

  describe("defaults (no env set)", () => {
    it("is ollama with provider-default models and no key", () => {
      assert.equal(getProvider(), "ollama");
      assert.equal(getChatProvider(), "ollama");
      assert.equal(getApiKey(), "");
      assert.equal(getBaseUrl(), "https://api.openai.com/v1");
      assert.equal(getEmbedModelName(), "nomic-embed-text:latest");
      assert.equal(getChatModelName(), "gemma4:12b");
    });
  });

  describe("generic 5-key scheme", () => {
    it("resolves a full OpenRouter setup", () => {
      process.env.CONTEXTPRO_PROVIDER = "openrouter";
      process.env.CONTEXTPRO_API_KEY = "sk-or-xxx";
      process.env.CONTEXTPRO_BASE_URL = "https://openrouter.ai/api/v1";
      process.env.CONTEXTPRO_EMBED_MODEL = "text-embedding-3-small";
      process.env.CONTEXTPRO_CHAT_MODEL = "anthropic/claude-3.5-haiku";

      assert.equal(getProvider(), "openai");
      assert.equal(getChatProvider(), "openai");
      assert.equal(getApiKey(), "sk-or-xxx");
      assert.equal(getBaseUrl(), "https://openrouter.ai/api/v1");
      assert.equal(getEmbedModelName(), "text-embedding-3-small");
      assert.equal(getChatModelName(), "anthropic/claude-3.5-haiku");
    });
  });

  describe("backward compatibility", () => {
    it("honors plain OPENAI_API_KEY", () => {
      process.env.CONTEXTPRO_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-legacy";
      assert.equal(getProvider(), "openai");
      assert.equal(getApiKey(), "sk-legacy");
    });

    it("honors the old long CONTEXTPRO_OPENAI_* names", () => {
      process.env.CONTEXTPRO_EMBED_PROVIDER = "openai";
      process.env.CONTEXTPRO_OPENAI_API_KEY = "sk-old";
      process.env.CONTEXTPRO_OPENAI_CHAT_MODEL = "gpt-4o";
      assert.equal(getProvider(), "openai");
      assert.equal(getApiKey(), "sk-old");
      assert.equal(getChatModelName("openai"), "gpt-4o");
    });

    it("honors CONTEXTPLUS_* aliases", () => {
      process.env.CONTEXTPLUS_EMBED_PROVIDER = "groq";
      process.env.CONTEXTPLUS_OPENAI_API_KEY = "sk-plus";
      assert.equal(getProvider(), "openai");
      assert.equal(getApiKey(), "sk-plus");
    });
  });

  describe("precedence", () => {
    it("generic key beats provider-native", () => {
      process.env.CONTEXTPRO_PROVIDER = "ollama";
      process.env.CONTEXTPRO_EMBED_MODEL = "mxbai-embed-large";
      process.env.OLLAMA_EMBED_MODEL = "should-be-ignored";
      assert.equal(getEmbedModelName(), "mxbai-embed-large");
    });

    it("generic API key beats legacy and native", () => {
      process.env.CONTEXTPRO_API_KEY = "sk-generic";
      process.env.CONTEXTPRO_OPENAI_API_KEY = "sk-legacy";
      process.env.OPENAI_API_KEY = "sk-native";
      assert.equal(getApiKey(), "sk-generic");
    });

    it("blank generic value falls through to the next source", () => {
      process.env.CONTEXTPRO_API_KEY = "   ";
      process.env.OPENAI_API_KEY = "sk-native";
      assert.equal(getApiKey(), "sk-native");
    });
  });

  describe("independent chat provider", () => {
    it("embeds on ollama but routes chat to an openai-compatible backend", () => {
      process.env.CONTEXTPRO_PROVIDER = "ollama";
      process.env.CONTEXTPRO_CHAT_PROVIDER = "groq";
      assert.equal(getProvider(), "ollama");
      assert.equal(getChatProvider(), "openai");
    });
  });
});
