import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import type { AdapterCallOptions, ProtocolAdapter } from '../../src/agent/providers/types.js';
import { EXTENDED_CACHE_TTL_BETA, BETA_CONTEXT_1M } from '../../src/agent/providers/defaults.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Capture the AdapterCallOptions that model.ts hands to the resolved adapter, so we
// can assert which beta headers resolveForCall() assembled for a given provider/model.
let lastOpts: AdapterCallOptions | undefined;

const capturingAdapter: ProtocolAdapter = {
  sendMessage: vi.fn(async (opts: AdapterCallOptions) => {
    lastOpts = opts;
    return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' } as never;
  }),
  sendMessageStream: vi.fn(async (opts: AdapterCallOptions) => {
    lastOpts = opts;
    return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' } as never;
  }),
  resetClient: vi.fn(),
};

// resolveForCall() is private; intercept at the registry seam it depends on.
vi.mock('../../src/agent/providers/registry.js', () => ({
  resolveProvider: vi.fn((providerName: string) => ({
    config: { api: providerName, region: 'us-east-1' },
    adapter: capturingAdapter,
  })),
  buildProviderMap: vi.fn(() => ({})),
  synthesizeFromLegacy: vi.fn(() => ({})),
  resetAllAdapters: vi.fn(),
}));

// Keep config minimal/deterministic.
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: {},
    agent: { main_provider: 'bedrock' },
    providers: { bedrock: { api: 'bedrock' } },
  })),
}));

import { sendMessage } from '../../src/agent/model.js';

beforeEach(() => {
  lastOpts = undefined;
  vi.clearAllMocks();
});

describe('beta header assembly (Thing 1: Bedrock 1h extended cache TTL)', () => {
  // ⚠️ REGRESSION GUARD: the extended-cache-ttl flag must NEVER be sent to Bedrock.
  // Real-Bedrock e2e (skill-e2e) returns `400 invalid beta flag` if we do. The 1h TTL
  // is GA and carried by cache_control alone — no header needed. These tests lock that in.
  it('does NOT send the extended-cache-ttl beta on Bedrock (it 400s there)', async () => {
    await sendMessage({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'bedrock', model: 'global.anthropic.claude-opus-4-8' },
    });
    expect(lastOpts?.betas ?? []).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('does NOT send the extended-cache-ttl beta on the anthropic provider either', async () => {
    await sendMessage({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(lastOpts?.betas ?? []).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('still sends the 1M-context beta for a 1M model, without the cache-ttl flag', async () => {
    await sendMessage({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'bedrock', model: 'global.anthropic.claude-opus-4-8-1m' },
    });
    expect(lastOpts?.betas).toContain(BETA_CONTEXT_1M);
    expect(lastOpts?.betas ?? []).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('does NOT send the 1M-context beta for natively-1M models (Opus 5)', async () => {
    await sendMessage({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'bedrock', model: 'global.anthropic.claude-opus-5' },
    });
    // Opus 5's 1M window is the default and only size — no beta header needed.
    expect(lastOpts?.betas ?? []).not.toContain(BETA_CONTEXT_1M);
    expect(lastOpts?.model).toBe('global.anthropic.claude-opus-5');
  });

  it('does NOT add the cache-ttl beta for non-Anthropic providers (e.g. openrouter)', async () => {
    await sendMessage({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'openrouter', model: 'some/model' },
    });
    expect(lastOpts?.betas ?? []).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });
});
