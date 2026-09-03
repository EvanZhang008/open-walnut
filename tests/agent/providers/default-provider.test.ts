import { describe, expect, it } from 'vitest';
import {
  resolveMainProviderName, hasExplicitBedrockConfig, mainProviderIsImplicit,
} from '../../../src/agent/providers/default-provider.js';
import type { Config } from '../../../src/core/types.js';

// A fresh install with Claude Code on it used to default every background call to
// 'bedrock' and then ask for AWS keys it never needed. These pin the new precedence.

function cfg(over: Partial<Config> = {}): Config {
  return {
    version: 1, user: {}, defaults: { priority: 'none' },
    provider: { type: 'claude-code' },
    ...over,
  } as Config;
}

describe('resolveMainProviderName', () => {
  it('an explicit agent.main_provider always wins', () => {
    expect(resolveMainProviderName(cfg({ agent: { main_provider: 'openai' } }), true)).toBe('openai');
    expect(resolveMainProviderName(cfg({ agent: { main_provider: 'bedrock' } }), true)).toBe('bedrock');
  });

  it('Claude Code installed and nothing configured → claude_cli', () => {
    expect(resolveMainProviderName(cfg(), true)).toBe('claude_cli');
  });

  it('no Claude Code and nothing configured → the historical bedrock default', () => {
    expect(resolveMainProviderName(cfg(), false)).toBe('bedrock');
  });

  // The user's own machine: Bedrock credentials saved by an earlier onboarding, Claude
  // Code installed, no main_provider. "AI provider should be Claude Code, that is it."
  it('Bedrock auth saved in Walnut config does not outrank an installed Claude Code', () => {
    for (const bedrock of [
      { api: 'bedrock', bearer_token: 't' },
      { api: 'bedrock', aws_access_key_id: 'AKIA', aws_secret_access_key: 's' },
      { api: 'bedrock', aws_profile: 'dev' },
      { api: 'bedrock', aws_credential_export: 'some-credential-helper print' },
    ] as const) {
      const c = cfg({ providers: { bedrock } as Config['providers'] });
      expect(hasExplicitBedrockConfig(c)).toBe(true);
      expect(resolveMainProviderName(c, true)).toBe('claude_cli');
      expect(resolveMainProviderName(c, false)).toBe('bedrock');
    }
    const legacy = cfg({ provider: { type: 'bedrock', bedrock_bearer_token: 't' } });
    expect(hasExplicitBedrockConfig(legacy)).toBe(true);
    expect(resolveMainProviderName(legacy, true)).toBe('claude_cli');
  });

  it('a Bedrock block with only a region is not "configured auth" (env/~/.aws may or may not exist)', () => {
    const c = cfg({ providers: { bedrock: { api: 'bedrock', region: 'us-west-2' } } as Config['providers'] });
    expect(hasExplicitBedrockConfig(c)).toBe(false);
    expect(resolveMainProviderName(c, true)).toBe('claude_cli');
  });

  it('reports whether the choice was implicit, for the UI\'s "(default)" tag', () => {
    expect(mainProviderIsImplicit(cfg())).toBe(true);
    expect(mainProviderIsImplicit(cfg({ agent: { main_provider: 'claude_cli' } }))).toBe(false);
  });
});
