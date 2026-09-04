import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProviderMap } from '../../../src/agent/providers/registry.js';
import { _resetDefaultProviderCacheForTesting } from '../../../src/agent/providers/default-provider.js';
import * as cliDetect from '../../../src/core/claude-cli-detect.js';
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

/**
 * `claude_cli` is the DEFAULT provider whenever the binary is installed, and it is
 * KEYLESS by design (it rides the CLI's own login). Leaving it out of the map made
 * every background model call on such a machine die with
 * `Provider "claude_cli" not found in config. Available: bedrock, ollama` — observed
 * on prod for both the side-thread title and the session auto-title fallback, on both
 * retries. Its readiness test is the binary, not an api key.
 */
describe('buildProviderMap — the keyless default provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetDefaultProviderCacheForTesting();
  });

  it('includes claude_cli when the binary is installed', () => {
    vi.spyOn(cliDetect, 'isClaudeCliInstalled').mockReturnValue(true);
    _resetDefaultProviderCacheForTesting();
    const map = buildProviderMap();
    expect(map.claude_cli?.api).toBe('claude-cli');
  });

  it('leaves it out when there is no binary to ride', () => {
    vi.spyOn(cliDetect, 'isClaudeCliInstalled').mockReturnValue(false);
    _resetDefaultProviderCacheForTesting();
    const map = buildProviderMap();
    expect(map.claude_cli).toBeUndefined();
    // The keyless pair that was always there stays there.
    expect(map.bedrock?.api).toBe('bedrock');
    expect(map.ollama?.api).toBe('ollama');
  });
});
