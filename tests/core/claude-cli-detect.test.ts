import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isClaudeCliInstalled, hasClaudeSubscriptionAuth, detectClaudeCli,
  resolveClaudeCliExecutable,
} from '../../src/core/claude-cli-detect.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

  it('resolves the standard user install directory when PATH omits it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-claude-detect-'));
    tempDirs.push(home);
    const executable = path.join(home, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(resolveClaudeCliExecutable({
      HOME: home,
      PATH: path.join(home, 'empty-bin'),
    })).toBe(executable);
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
