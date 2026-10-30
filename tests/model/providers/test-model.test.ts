/**
 * Settings' "Test connection" model pick (src/model/providers/test-model.ts).
 * A model server the user hosts is tested on the model Walnut calls there, read
 * against what the server lists; a cloud catalog keeps its fixed cheap model.
 * The local cases run against a real HTTP server on a random port, and a port
 * nobody listens on.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOUD_TEST_MODELS, pickTestModel } from '../../../src/model/providers/test-model.js';
import { KNOWN_PROVIDERS } from '../../../src/model/providers/defaults.js';
import { isLocalModelProvider } from '../../../src/model/providers/local-provider.js';
import type { ProviderConfig } from '../../../src/model/providers/types.js';

let server: http.Server;
let base = '';
let tags: string[] = ['qwen3-coder:30b', 'llama3:latest'];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: tags.map((name) => ({ name })) })); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: tags.map((id) => ({ id })) })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A port that was just free: nothing answers there. */
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

describe('Ollama', () => {
  const ollama = (): ProviderConfig => ({ api: 'ollama', base_url: base });

  it('tests the configured main model when the server has it', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'ollama', main_model: 'qwen3-coder:30b' } });
    expect(pick).toEqual({ ok: true, model: 'qwen3-coder:30b' });
  });

  it('a name without a tag is :latest, as Ollama reads it', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'ollama', main_model: 'llama3' } });
    expect(pick).toEqual({ ok: true, model: 'llama3' });
  });

  it('names are case-insensitive, as Ollama reads them', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'ollama', main_model: 'Qwen3-Coder:30B' } });
    expect(pick.ok).toBe(true);
  });

  it('a Claude id as the main model (what an unset main_model reads as) says to set one, not to pull it', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'ollama', main_model: 'global.anthropic.claude-opus-5-5' } });
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.error).not.toContain('ollama pull');
    expect(pick.error).toContain('agent.main_model');
    expect(pick.error).toContain('qwen3-coder:30b');
  });

  it('a configured model the server lacks says how to pull it and lists what it has', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'ollama', main_model: 'qwen3:8b' } });
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.error).toContain('ollama pull qwen3:8b');
    expect(pick.error).toContain('qwen3-coder:30b');
  });

  it('with no model configured, the first one the server lists', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: {} });
    expect(pick).toEqual({ ok: true, model: 'qwen3-coder:30b' });
  });

  it('another main provider does not lend its model to the Ollama test', async () => {
    const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: { main_provider: 'bedrock', main_model: 'global.anthropic.claude-opus-5-5' } });
    expect(pick).toEqual({ ok: true, model: 'qwen3-coder:30b' });
  });

  it('a server with no models says to pull one', async () => {
    const saved = tags; tags = [];
    try {
      const pick = await pickTestModel({ providerName: 'ollama', prov: ollama(), agent: {} });
      expect(pick.ok).toBe(false);
      if (!pick.ok) expect(pick.error).toMatch(/lists no models.*ollama pull/);
    } finally { tags = saved; }
  });

  it('a server that is down is named with its address, fast', async () => {
    const url = await deadUrl();
    const t0 = Date.now();
    const pick = await pickTestModel({ providerName: 'ollama', prov: { api: 'ollama', base_url: url }, agent: { main_provider: 'ollama', main_model: 'qwen3-coder:30b' } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(pick.ok).toBe(false);
    if (!pick.ok) expect(pick.error).toBe(`Ollama is not answering at ${url}. Start it (\`ollama serve\`, or open the Ollama app) and test again.`);
  });
});

describe('an OpenAI-compatible server on this machine (LM Studio, vLLM)', () => {
  it('is read through its /models list', async () => {
    const prov: ProviderConfig = { api: 'openai-chat', base_url: `${base}/v1` };
    expect(await pickTestModel({ providerName: 'lmstudio', prov, agent: { main_provider: 'lmstudio', main_model: 'llama3:latest' } }))
      .toEqual({ ok: true, model: 'llama3:latest' });
    const missing = await pickTestModel({ providerName: 'lmstudio', prov, agent: { main_provider: 'lmstudio', main_model: 'nope' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).not.toContain('ollama pull');
  });
});

describe('cloud catalogs keep their fixed cheap model', () => {
  it.each([
    ['bedrock', { api: 'bedrock' }, 'global.anthropic.claude-haiku-5-5'],
    ['anthropic', { api: 'anthropic-messages' }, 'claude-haiku-5-5'],
    ['openai', { api: 'openai-chat' }, 'gpt-4o-mini'],
    ['claude_cli', { api: 'claude-cli' }, 'haiku'],
  ] as const)('%s', async (name, prov, model) => {
    // Even with a main model set: a Claude user's test is what it was.
    const pick = await pickTestModel({ providerName: name, prov: prov as ProviderConfig, agent: { main_provider: name, main_model: 'opus' } });
    expect(pick).toEqual({ ok: true, model });
  });

  it('a hosted OpenAI-compatible service with no entry of its own is tested on its configured model', async () => {
    const prov: ProviderConfig = { api: 'openai-chat', base_url: 'https://api.example.com/v1' };
    expect(await pickTestModel({ providerName: 'together', prov, agent: { main_provider: 'together', main_model: 'meta/llama-4' } }))
      .toEqual({ ok: true, model: 'meta/llama-4' });
  });

  it('a protocol with no fixed model and nothing configured says what to set', async () => {
    const pick = await pickTestModel({ providerName: 'plug', prov: { api: 'plugin-proto' as never }, agent: {} });
    expect(pick.ok).toBe(false);
  });
});

// Ratchet: every provider Walnut knows can be tested. A new known provider whose
// protocol has neither a fixed test model nor the local-server path fails here
// (2026-10-30: Ollama answered 'Testing not yet supported for protocol "ollama"').
describe('every known provider has a test path', () => {
  it.each(Object.entries(KNOWN_PROVIDERS))('%s', async (name, template) => {
    const prov = { ...template, ...(isLocalModelProvider(template as ProviderConfig) ? { base_url: base } : {}) } as ProviderConfig;
    const local = isLocalModelProvider(prov);
    expect(local || !!CLOUD_TEST_MODELS[prov.api]).toBe(true);
    const pick = await pickTestModel({ providerName: name, prov, agent: {} });
    expect(pick.ok).toBe(true);
  });
});
