import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isClaudeCliInstalled, hasClaudeSubscriptionAuth, detectClaudeCli,
  resolveClaudeCliExecutable, describeClaudeCliAuth,
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
    // The provider is ready when the binary is here: its login (Bedrock, subscription,
    // a key) is the CLI's business, so a Bedrock-backed Claude Code must count too.
    expect(caps.ready).toBe(caps.installed);
    expect(typeof caps.auth.label).toBe('string');
    if (!caps.installed) expect(caps.auth.mode).toBe('unknown');
  });
});

describe('describeClaudeCliAuth — how the user\'s Claude Code signs in (flags only, no values)', () => {
  it('reads Bedrock from settings.json env the way the CLI does (settings win over process env)', () => {
    const hint = describeClaudeCliAuth({ CLAUDE_CODE_USE_BEDROCK: '' }, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' });
    expect(hint).toEqual({ mode: 'bedrock', label: 'Bedrock (us-west-2)' });
  });

  it('reads Bedrock from the process env when settings.json has no env block', () => {
    expect(describeClaudeCliAuth({ CLAUDE_CODE_USE_BEDROCK: '1' }, {}).mode).toBe('bedrock');
    expect(describeClaudeCliAuth({ CLAUDE_CODE_USE_BEDROCK: '1' }, {}).label).toBe('Bedrock');
  });

  it('treats "0" and "false" as off', () => {
    for (const v of ['0', 'false', 'FALSE']) {
      expect(describeClaudeCliAuth({ CLAUDE_CODE_USE_BEDROCK: v }, {}).mode).not.toBe('bedrock');
    }
  });

  it('names an API key without ever returning it', () => {
    const hint = describeClaudeCliAuth({ ANTHROPIC_API_KEY: 'sk-secret-value' }, {});
    expect(hint.mode).toBe('api-key');
    expect(JSON.stringify(hint)).not.toContain('sk-secret');
  });

  it('prefers Vertex over a stray key when the flag is on', () => {
    expect(describeClaudeCliAuth({ CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_API_KEY: 'x' }, {}).mode).toBe('vertex');
  });
});
