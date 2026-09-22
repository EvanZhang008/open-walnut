/**
 * The default-engine reader + the Ask-Walnut profile prefix.
 *
 * Two pure pieces of slice S0 ("every Walnut-initiated session inherits the
 * engine picked in Settings"), both of which can only be wrong silently:
 *   - resolveDefaultEngine decides what a launch that named no engine runs on.
 *     A typo in config.yaml must degrade to the shipped default, never throw on
 *     the launch path, and an ACP engine must not be inherited by a launch aimed
 *     at a remote host (the ACP worker is local-only — handleAcpStart THROWS for
 *     a non-local host, so inheriting one there would fail the whole launch).
 *   - buildAskProfilePrefix is the ONLY carrier an ACP ask has for its persona,
 *     since ACP engines have no system-prompt channel.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { resolveDefaultEngine } from '../../src/core/agents/default-engine.js';
import {
  ASK_PROFILE_BANNER_CLOSE,
  ASK_PROFILE_BANNER_OPEN,
  buildAskProfilePrefix,
} from '../../src/core/sessions/ask-profile-prefix.js';

/** A config shaped like the real one, with whatever `defaults.engine` holds. */
function config(engine?: unknown): Config {
  return {
    version: 1,
    user: {},
    defaults: { priority: 'none', platform: 'local', project: 'Walnut', ...(engine !== undefined ? { engine } : {}) },
    provider: { type: 'claude-code' },
  } as unknown as Config;
}

describe('resolveDefaultEngine', () => {
  it('answers claude whenever the config names nothing usable', () => {
    // No key at all — the overwhelming case, and the one that must stay claude.
    expect(resolveDefaultEngine(config())).toBe('claude');
    // A whole missing section, and no config at all (a caller with a partial read).
    expect(resolveDefaultEngine({})).toBe('claude');
    expect(resolveDefaultEngine(undefined)).toBe('claude');
    expect(resolveDefaultEngine(null)).toBe('claude');
    // Explicitly claude is still claude.
    expect(resolveDefaultEngine(config('claude'))).toBe('claude');
  });

  it('answers the configured engine when it is a registered one', () => {
    expect(resolveDefaultEngine(config('codex'))).toBe('codex');
    expect(resolveDefaultEngine(config('gemini'))).toBe('gemini');
    expect(resolveDefaultEngine(config('opencode'))).toBe('opencode');
  });

  it('falls back to claude on garbage instead of failing the launch', () => {
    // Hand-edited config.yaml: a typo, a wrong case, a YAML value that is not a
    // string at all. Every one of these used to be impossible to express; now
    // they reach a code path that runs on every single session start.
    expect(resolveDefaultEngine(config('codx'))).toBe('claude');
    expect(resolveDefaultEngine(config('CODEX'))).toBe('claude');
    expect(resolveDefaultEngine(config(''))).toBe('claude');
    expect(resolveDefaultEngine(config(null))).toBe('claude');
    expect(resolveDefaultEngine(config(42))).toBe('claude');
    expect(resolveDefaultEngine(config(true))).toBe('claude');
    expect(resolveDefaultEngine(config({ id: 'codex' }))).toBe('claude');
    expect(resolveDefaultEngine(config(['codex']))).toBe('claude');
  });

  it('does not inherit an ACP engine onto a remote host, and leaves a local launch alone', () => {
    expect(resolveDefaultEngine(config('codex'), { host: 'devbox' })).toBe('claude');
    expect(resolveDefaultEngine(config('gemini'), { host: 'devbox' })).toBe('claude');
    // The absence of a host, in each of the shapes callers actually pass —
    // including '__local__', the launcher's alias for this machine, which is NOT
    // a remote host and must not cost the user their engine.
    expect(resolveDefaultEngine(config('codex'), { host: undefined })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: null })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: '' })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: '__local__' })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), {})).toBe('codex');
    // The rule is about the ACP runtime, not about "not claude": a remote host
    // keeps the default engine, which is itself remote-capable.
    expect(resolveDefaultEngine(config('claude'), { host: 'devbox' })).toBe('claude');
  });
});

describe('buildAskProfilePrefix', () => {
  it('wraps the profile prompt in a closed banner and ends the block', () => {
    const prefix = buildAskProfilePrefix({ systemPrompt: 'You are Walnut.\n\n## Standing memory\n- likes tea' });
    expect(prefix.startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true);
    expect(prefix).toContain('You are Walnut.');
    expect(prefix).toContain('- likes tea');
    // The close banner must be present AND last — an unclosed block would let the
    // user's own message read as part of the persona.
    expect(prefix.trimEnd().endsWith(ASK_PROFILE_BANNER_CLOSE)).toBe(true);
    // Ends with a blank line so the user's message starts its own paragraph.
    expect(prefix.endsWith('\n\n')).toBe(true);
    // The block says what it is, so the model does not answer the configuration.
    expect(prefix).toContain('do not reply to it');
  });

  it('is empty when there is no prompt to carry', () => {
    expect(buildAskProfilePrefix(undefined)).toBe('');
    expect(buildAskProfilePrefix({})).toBe('');
    expect(buildAskProfilePrefix({ systemPrompt: '' })).toBe('');
    expect(buildAskProfilePrefix({ systemPrompt: '   \n\t ' })).toBe('');
  });

  it('prepends to the message without touching it', () => {
    const message = 'what do I have today?';
    const prefix = buildAskProfilePrefix({ systemPrompt: 'persona' });
    expect(`${prefix}${message}`.endsWith(message)).toBe(true);
    // One banner pair per launch — the prefix never nests.
    expect((`${prefix}${message}`.match(/\[Walnut agent profile\]/g) ?? []).length).toBe(1);
  });
});
