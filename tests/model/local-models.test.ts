/**
 * Walnut on models the user hosts (Ollama, an OpenAI-compatible local server):
 * the pieces that must never assume a Claude catalog or a Claude Code install.
 *   - a micro agent's tier word is never sent as a model id (it was: Ollama got "sonnet");
 *   - which providers count as "local", and how their readiness is probed;
 *   - which engine AI task search picks.
 * The probe runs against a real HTTP server on a random port and a refused port.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tierModelFor } from '../../src/model/micro-agent.js';
import { isLocalModelProvider, localProviderProbeUrl, probeLocalProvider } from '../../src/model/providers/local-provider.js';
import { pickAgentSearchEngine } from '../../src/core/task-search-agent.js';
import { DEFAULT_MODEL } from '../../src/model/providers/defaults.js';
import type { Config } from '../../src/core/types.js';

const cfg = (agent: Record<string, string>): Config => ({ agent } as unknown as Config);

describe('tierModelFor: a provider with no catalog gets the user\'s own model', () => {
  it('ollama: main_model for sonnet, fast_model for haiku, main_model when no fast_model', () => {
    const config = cfg({ main_provider: 'ollama', main_model: 'qwen2.5:7b', fast_model: 'qwen2.5:0.5b' });
    expect(tierModelFor(config, 'sonnet', 'ollama')).toBe('qwen2.5:7b');
    expect(tierModelFor(config, 'haiku', 'ollama')).toBe('qwen2.5:0.5b');
    expect(tierModelFor(cfg({ main_model: 'llama3.2' }), 'haiku', 'ollama')).toBe('llama3.2');
  });

  it('never the bare tier word, even with nothing configured', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      expect(tierModelFor(cfg({}), tier, 'ollama')).not.toBe(tier);
      expect(tierModelFor(cfg({}), tier, 'my-lmstudio')).toBe(DEFAULT_MODEL);
    }
  });

  it('a provider with a catalog still gets its catalog id (unchanged)', () => {
    const id = tierModelFor(cfg({ main_model: 'x' }), 'sonnet', 'bedrock');
    expect(id.toLowerCase()).toContain('sonnet');
    expect(id.toLowerCase()).not.toContain('1m');
  });
});

describe('isLocalModelProvider', () => {
  it.each([
    [{ api: 'ollama' }, true],
    [{ api: 'ollama', base_url: 'http://gpu-box:11434' }, true],
    [{ api: 'openai-chat', base_url: 'http://localhost:1234/v1' }, true],
    // LM Studio users often set a placeholder key: the address decides.
    [{ api: 'openai-chat', base_url: 'http://localhost:1234/v1', api_key: 'lm-studio' }, true],
    [{ api: 'openai-chat', base_url: 'http://192.168.1.20:8000/v1' }, true],
    [{ api: 'openai-chat', base_url: 'http://172.20.0.5:8000/v1' }, true],
    [{ api: 'openai-chat', base_url: 'http://gpu-box:8000/v1' }, true],
    [{ api: 'openai-chat', base_url: 'http://vllm.lan:8000/v1' }, true],
    [{ api: 'openai-chat', base_url: 'http://[::1]:8000/v1' }, true],
    [{ api: 'openai-chat' }, false],
    [{ api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1' }, false],
    [{ api: 'openai-chat', base_url: 'https://api.example.com/v1' }, false],
    [{ api: 'openai-chat', base_url: 'http://172.40.0.5:8000/v1' }, false],
    [{ api: 'bedrock' }, false],
    [{ api: 'claude-cli' }, false],
    [undefined, false],
  ] as const)('%j -> %s', (prov, expected) => {
    expect(isLocalModelProvider(prov as never)).toBe(expected);
  });

  it('probe URLs', () => {
    expect(localProviderProbeUrl({ api: 'ollama' })).toBe('http://localhost:11434/api/tags');
    expect(localProviderProbeUrl({ api: 'ollama', base_url: 'http://h:1/' })).toBe('http://h:1/api/tags');
    expect(localProviderProbeUrl({ api: 'openai-chat', base_url: 'http://h:1234/v1' })).toBe('http://h:1234/v1/models');
  });
});

describe('probeLocalProvider (real sockets)', () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
      res.writeHead(401); res.end('no key');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('a server that answers is up, a 401 included', async () => {
    expect((await probeLocalProvider({ api: 'ollama', base_url: `http://127.0.0.1:${port}` })).ok).toBe(true);
    expect((await probeLocalProvider({ api: 'openai-chat', base_url: `http://127.0.0.1:${port}/v1` })).ok).toBe(true);
    expect(seen).toEqual(['/api/tags', '/v1/models']);
  });

  it('a refused port is down, with the reason, and never throws', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const dead = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const probe = await probeLocalProvider({ api: 'ollama', base_url: `http://127.0.0.1:${dead}` });
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeTruthy();
    expect((await probeLocalProvider({ api: 'openai-chat', base_url: 'not a url' })).ok).toBe(false);
  });
});

describe('pickAgentSearchEngine', () => {
  it.each([
    // Unchanged for every install with Claude Code and a cloud or CLI provider.
    [{ cliInstalled: true, mainProvider: 'claude_cli', mainProviderIsLocal: false }, 'cli'],
    [{ cliInstalled: true, mainProvider: 'bedrock', mainProviderIsLocal: false }, 'cli'],
    // A local-model setup stays local even with Claude Code installed.
    [{ cliInstalled: true, mainProvider: 'ollama', mainProviderIsLocal: true }, 'in-process'],
    [{ cliInstalled: false, mainProvider: 'ollama', mainProviderIsLocal: true }, 'in-process'],
    // No Claude Code: the configured provider, unless it IS Claude Code.
    [{ cliInstalled: false, mainProvider: 'bedrock', mainProviderIsLocal: false }, 'in-process'],
    [{ cliInstalled: false, mainProvider: 'claude_cli', mainProviderIsLocal: false }, 'none'],
  ] as const)('%j -> %s', (input, expected) => {
    expect(pickAgentSearchEngine(input)).toBe(expected);
  });
});
