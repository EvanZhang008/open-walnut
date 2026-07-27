import { describe, it, expect } from 'vitest';
import { buildProviderMap } from '../../../src/agent/providers/registry.js';
import type { ProviderConfig } from '../../../src/agent/providers/types.js';

/**
 * buildProviderMap merges explicit `providers.*` config over env-auto-detected
 * templates. The overlay MUST be field-by-field: a hand-written block that only
 * carries auth/region is normal, and if it wipes the template's `api` the whole
 * agent dies at adapter lookup with "Unknown protocol: undefined" (2026-07-26).
 */
describe('buildProviderMap — explicit config merges onto known templates', () => {
  it('keeps the template `api` when an explicit block sets only auth + region', () => {
    const explicit: Record<string, ProviderConfig> = {
      // Deliberately NO `api` — this is the shape a user hand-writes to fix auth.
      bedrock: { region: 'us-west-2', aws_credential_export: 'echo hi' } as unknown as ProviderConfig,
    };
    const map = buildProviderMap(explicit);
    expect(map.bedrock.api).toBe('bedrock');
    expect(map.bedrock.region).toBe('us-west-2');
    expect(map.bedrock.aws_credential_export).toBe('echo hi');
  });

  it('lets explicit fields win field-by-field over the template', () => {
    const explicit: Record<string, ProviderConfig> = {
      openrouter: { base_url: 'https://example.invalid/v1' } as unknown as ProviderConfig,
    };
    const map = buildProviderMap(explicit);
    expect(map.openrouter.api).toBe('openai-chat');            // from template
    expect(map.openrouter.base_url).toBe('https://example.invalid/v1'); // overridden
  });

  it('skips an unknown provider with no `api` instead of poisoning the map', () => {
    const explicit: Record<string, ProviderConfig> = {
      mystery: { region: 'us-west-2' } as unknown as ProviderConfig,
    };
    const map = buildProviderMap(explicit);
    expect(map.mystery).toBeUndefined();
    // The rest of the map must still be usable — one bad block ≠ dead agent.
    expect(map.bedrock?.api).toBe('bedrock');
  });

  it('honors an explicit `api` that differs from the template', () => {
    const explicit: Record<string, ProviderConfig> = {
      bedrock: { api: 'anthropic-messages', api_key: 'k' } as ProviderConfig,
    };
    const map = buildProviderMap(explicit);
    expect(map.bedrock.api).toBe('anthropic-messages');
  });
});
