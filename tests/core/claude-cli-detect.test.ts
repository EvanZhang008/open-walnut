import { describe, it, expect } from 'vitest';
import {
  isClaudeCliInstalled, hasClaudeSubscriptionAuth, detectClaudeCli,
} from '../../src/core/claude-cli-detect.js';

/**
 * These are environment-dependent boolean probes, so we assert on TYPE and
 * INTERNAL CONSISTENCY rather than a fixed value (CI may or may not have the
 * CLI / a subscription). The security-critical property — that we NEVER read a
 * token value — is guaranteed by construction (no `-w` on the keychain probe,
 * no file content read); see the module. Here we assert the API contract.
 */
describe('claude-cli-detect — boolean probes', () => {
  it('isClaudeCliInstalled returns a boolean and never throws', () => {
    expect(typeof isClaudeCliInstalled()).toBe('boolean');
  });

  it('hasClaudeSubscriptionAuth returns a boolean and never throws', () => {
    expect(typeof hasClaudeSubscriptionAuth()).toBe('boolean');
  });

  it('detectClaudeCli is internally consistent', () => {
    const caps = detectClaudeCli();
    expect(typeof caps.installed).toBe('boolean');
    expect(typeof caps.subscriptionAuth).toBe('boolean');
    expect(typeof caps.subscriptionReady).toBe('boolean');
    // subscriptionReady ⟺ installed AND subscriptionAuth
    expect(caps.subscriptionReady).toBe(caps.installed && caps.subscriptionAuth);
    // subscriptionAuth can only be true when installed (we short-circuit on install).
    if (caps.subscriptionAuth) expect(caps.installed).toBe(true);
  });
});
