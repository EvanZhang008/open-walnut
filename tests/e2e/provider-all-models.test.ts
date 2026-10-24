/**
 * E2E test: Verify EVERY model in the catalog returns a valid response.
 * Makes a real 1-token API call to each model.
 * API keys from env vars — never hardcoded.
 *
 * Run: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... OPENROUTER_API_KEY=... GEMINI_API_KEY=... \
 *      bun --bun vitest run tests/e2e/provider-all-models.test.ts --config vitest.e2e.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer } from '../../src/web/server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

interface ModelEntry { id: string; label: string; provider: string }
let providerData: Record<string, { status: string; models: ModelEntry[] }>;

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://localhost:${port}`;

  // Configure keys
  const providers: Record<string, Record<string, string>> = {};
  if (process.env.ANTHROPIC_API_KEY)
    providers.anthropic = { api: 'anthropic-messages', api_key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY)
    providers.openai = { api: 'openai-chat', api_key: process.env.OPENAI_API_KEY };
  if (process.env.OPENROUTER_API_KEY)
    providers.openrouter = { api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', api_key: process.env.OPENROUTER_API_KEY };
  if (process.env.GEMINI_API_KEY)
    providers.gemini = { api: 'google-generative-ai', api_key: process.env.GEMINI_API_KEY };

  if (Object.keys(providers).length > 0) {
    await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
  }

  // Fetch catalog
  const resp = await fetch(`${base}/api/config/providers`);
  providerData = (await resp.json()).providers;
}, 30_000);

afterAll(async () => { await stopServer(); }, 10_000);

// ── Direct API callers (1 token each) ──

async function testAnthropicModel(model: string, key: string) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, model: data.model, error: data.error?.message };
}

async function testBedrockModel(model: string, token: string, region = 'us-west-2') {
  const resp = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, model: data.model, error: data.message };
}

async function testOpenAIModel(model: string, key: string) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, max_completion_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, model: data.model, error: data.error?.message };
}

async function testGeminiModel(model: string, key: string) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json();
  const ok = resp.ok && !!data.candidates?.[0];
  return { ok, status: resp.status, error: data.error?.message };
}

async function testOpenRouterModel(model: string, key: string) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/nicepkg/walnut',
    },
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json();
  const ok = resp.ok && !!data.choices?.[0];
  return { ok, status: resp.status, model: data.model, error: data.error?.message };
}

// ── Tests ──

describe('Bedrock models', () => {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) { it.skip('no AWS_BEARER_TOKEN_BEDROCK', () => {}); return; }
  const models = [
    'global.anthropic.claude-opus-4-6-v1',
    'global.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ];
  for (const model of models) {
    it(`${model}`, async () => {
      const r = await testBedrockModel(model, token);
      expect(r.ok, `${r.status}: ${r.error}`).toBe(true);
    }, 20_000);
  }
});

describe('Anthropic models', () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { it.skip('no ANTHROPIC_API_KEY', () => {}); return; }
  const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  for (const model of models) {
    it(`${model}`, async () => {
      const r = await testAnthropicModel(model, key);
      expect(r.ok, `${r.status}: ${r.error}`).toBe(true);
    }, 20_000);
  }
});

describe('OpenAI models', () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { it.skip('no OPENAI_API_KEY', () => {}); return; }
  const models = ['gpt-5.4', 'gpt-5-mini-2025-08-07', 'gpt-5-nano-2025-08-07'];
  for (const model of models) {
    it(`${model}`, async () => {
      const r = await testOpenAIModel(model, key);
      expect(r.ok, `${r.status}: ${r.error}`).toBe(true);
    }, 20_000);
  }
});

describe('Gemini models', () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { it.skip('no GEMINI_API_KEY', () => {}); return; }
  const models = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'];
  for (const model of models) {
    it(`${model}`, async () => {
      const r = await testGeminiModel(model, key);
      expect(r.ok, `${r.status}: ${r.error}`).toBe(true);
    }, 20_000);
  }
});

describe('OpenRouter models', () => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { it.skip('no OPENROUTER_API_KEY', () => {}); return; }

  // All chat-capable models from catalog
  // Excluded: openai/gpt-audio* (requires audio modality), openai/gpt-5.*-codex (completions-only),
  //   minimax:free & liquid/* (data policy / offline issues)
  const models = [
    'anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6',
    'openai/gpt-5.2', 'openai/gpt-5.2-pro', 'openai/gpt-5.2-chat',
    'google/gemini-3.1-pro-preview', 'google/gemini-3-flash-preview',
    'qwen/qwen3.5-plus-02-15', 'qwen/qwen3.5-397b-a17b', 'qwen/qwen3-max-thinking', 'qwen/qwen3-coder-next',
    'minimax/minimax-m2.5', 'minimax/minimax-m2.1', 'minimax/minimax-m2-her',
    'z-ai/glm-5', 'z-ai/glm-4.7', 'z-ai/glm-4.7-flash',
    'moonshotai/kimi-k2.5', 'aion-labs/aion-2.0',
    'stepfun/step-3.5-flash', 'stepfun/step-3.5-flash:free',
    'bytedance-seed/seed-1.6', 'bytedance-seed/seed-1.6-flash',
    'xiaomi/mimo-v2-flash',
    'nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3-nano-30b-a3b:free',
    'writer/palmyra-x5', 'upstage/solar-pro-3',
    'mistralai/mistral-small-creative',
    'allenai/olmo-3.1-32b-instruct', 'allenai/olmo-3.1-32b-think', 'allenai/molmo-2-8b',
    'arcee-ai/trinity-large-preview:free',
  ];

  for (const model of models) {
    it(`${model}`, async () => {
      const r = await testOpenRouterModel(model, key);
      expect(r.ok, `${r.status}: ${r.error}`).toBe(true);
    }, 60_000);
  }
});
