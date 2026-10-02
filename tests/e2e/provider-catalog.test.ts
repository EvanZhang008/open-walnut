/**
 * E2E test: Provider catalog + test-provider endpoint.
 * Starts an ephemeral server (port 0, temp data), configures API keys,
 * tests each provider connection via the test-provider endpoint,
 * and verifies model catalogs are up-to-date.
 *
 * API keys come from env vars — never hardcoded.
 * Set them before running:
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... OPENROUTER_API_KEY=... GEMINI_API_KEY=... npm test -- tests/e2e/provider-catalog.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer } from '../../src/web/server.js';
import { getModelsForProvider } from '../../src/model/providers/model-catalog.js';

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://localhost:${port}`;
}, 30_000);

afterAll(async () => {
  await stopServer();
}, 10_000);

// ── Helper ──
async function testProvider(name: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const resp = await fetch(`${base}/api/config/test-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_name: name }),
    signal: AbortSignal.timeout(30_000),
  });
  return resp.json();
}

async function getProviders() {
  const resp = await fetch(`${base}/api/config/providers`);
  return (await resp.json()).providers as Record<string, { status: string; models: { id: string; label: string }[] }>;
}

async function saveConfig(partial: Record<string, unknown>) {
  const resp = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  expect(resp.ok).toBe(true);
}

// ── Tests ──

describe('Provider catalog', () => {
  it('should return all known providers', async () => {
    const providers = await getProviders();
    expect(Object.keys(providers)).toEqual(
      expect.arrayContaining(['bedrock', 'anthropic', 'openai', 'openrouter', 'gemini', 'ollama']),
    );
  });

  it('Gemini catalog should have 3.x models only (no 2.x)', async () => {
    const providers = await getProviders();
    const gemini = providers.gemini;
    expect(gemini.models.length).toBeGreaterThanOrEqual(3);
    for (const m of gemini.models) {
      expect(m.id).not.toMatch(/gemini-2/);
      expect(m.id).toMatch(/gemini-3/);
    }
  });

  it('OpenAI catalog should have 5.x models only (no 4o)', async () => {
    const providers = await getProviders();
    const openai = providers.openai;
    // A fresh home has no config overrides, so this is the code catalog (three
    // GPT-5 models). The old ">= 4" only held while this test read the author's
    // own config, which added a model of its own.
    expect(openai.models.map((m) => m.id)).toEqual(getModelsForProvider('openai').map((m) => m.id));
    expect(openai.models.length).toBeGreaterThanOrEqual(3);
    for (const m of openai.models) {
      expect(m.id).not.toMatch(/gpt-4o/);
      expect(m.id).toMatch(/gpt-5/);
    }
  });

  it('OpenRouter catalog should have 35+ models', async () => {
    const providers = await getProviders();
    expect(providers.openrouter.models.length).toBeGreaterThanOrEqual(35);
  });

  it('Bedrock should be ready (env token)', async () => {
    const providers = await getProviders();
    // Bedrock auto-detects from AWS_BEARER_TOKEN_BEDROCK env
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      expect(providers.bedrock.status).toBe('ready');
    }
  });
});

describe('Provider connections (requires API keys)', () => {
  // Configure keys from env before testing
  beforeAll(async () => {
    const providers: Record<string, Record<string, string>> = {};
    if (process.env.ANTHROPIC_API_KEY) {
      providers.anthropic = { api: 'anthropic-messages', api_key: process.env.ANTHROPIC_API_KEY };
    }
    if (process.env.OPENAI_API_KEY) {
      providers.openai = { api: 'openai-chat', api_key: process.env.OPENAI_API_KEY };
    }
    if (process.env.OPENROUTER_API_KEY) {
      providers.openrouter = {
        api: 'openai-chat',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: process.env.OPENROUTER_API_KEY,
      };
    }
    if (process.env.GEMINI_API_KEY) {
      providers.gemini = { api: 'google-generative-ai', api_key: process.env.GEMINI_API_KEY };
    }
    if (Object.keys(providers).length > 0) {
      await saveConfig({ providers });
    }
  });

  it('Bedrock test-provider should succeed', async () => {
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) return; // skip if no token
    const result = await testProvider('bedrock');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeLessThan(10_000);
  }, 30_000);

  it('Anthropic test-provider should succeed', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    const result = await testProvider('anthropic');
    expect(result.ok).toBe(true);
  }, 30_000);

  it('OpenAI test-provider should succeed', async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const result = await testProvider('openai');
    expect(result.ok).toBe(true);
  }, 30_000);

  it('OpenRouter test-provider should succeed', async () => {
    if (!process.env.OPENROUTER_API_KEY) return;
    const result = await testProvider('openrouter');
    expect(result.ok).toBe(true);
  }, 30_000);

  it('Gemini test-provider should succeed', async () => {
    if (!process.env.GEMINI_API_KEY) return;
    const result = await testProvider('gemini');
    expect(result.ok).toBe(true);
  }, 30_000);
});
