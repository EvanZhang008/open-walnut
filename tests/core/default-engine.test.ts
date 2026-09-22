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
 *     An engine that is not INSTALLED degrades the same way: the client's
 *     cold-start catalog presets `installed: true`, so a user can pick an engine
 *     this machine does not have, and every Walnut-initiated session afterwards
 *     (Ask Walnut, the AI actions, routines, triage) would try to start a worker
 *     that is not there.
 *   - buildAskProfilePrefix is the ONLY carrier an ACP ask has for its persona,
 *     since ACP engines have no system-prompt channel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '../../src/core/types.js';
import {
  _resetDefaultEngineAvailabilityForTesting,
  refreshDefaultEngineAvailability,
  resolveDefaultEngine,
} from '../../src/core/agents/default-engine.js';
import {
  _resetEngineProbeCache,
  _seedEngineProbeCache,
} from '../../src/core/agents/engine-probe.js';
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

beforeEach(() => {
  _resetEngineProbeCache();
  _resetDefaultEngineAvailabilityForTesting();
});

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

  // ── Availability: a known engine id is not a usable engine ──

  it('degrades to the default when the configured engine is not installed on this machine', async () => {
    // The probe (engine-probe.ts) is the ONE source of "installed"; seeding its
    // cache is exactly what a machine without the codex CLI produces, and the
    // launch path reads that verdict rather than re-deciding it.
    _seedEngineProbeCache('codex', {
      installed: false,
      version: null,
      reason: 'Codex CLI not found: install `codex` on PATH or set WALNUT_CODEX_PATH',
    });
    await refreshDefaultEngineAvailability('codex');

    expect(resolveDefaultEngine(config('codex'))).toBe('claude');
    // One engine's verdict says nothing about another's: an unprobed gemini keeps
    // the user's choice instead of being swept up.
    expect(resolveDefaultEngine(config('gemini'))).toBe('gemini');
  });

  it('keeps the configured engine once the probe reports it installed', async () => {
    _seedEngineProbeCache('codex', { installed: true, version: 'codex 0.9.0', reason: null });
    await refreshDefaultEngineAvailability('codex');
    expect(resolveDefaultEngine(config('codex'))).toBe('codex');

    // Installing a CLI after the fact must give the engine back: the mirror is a
    // refreshable copy of the probe, not a one-time verdict.
    _seedEngineProbeCache('codex', { installed: false, version: null, reason: 'Codex CLI not found' });
    await refreshDefaultEngineAvailability('codex');
    expect(resolveDefaultEngine(config('codex'))).toBe('claude');
    _seedEngineProbeCache('codex', { installed: true, version: 'codex 0.9.0', reason: null });
    await refreshDefaultEngineAvailability('codex');
    expect(resolveDefaultEngine(config('codex'))).toBe('codex');
  });

  it('keeps the configured engine while nothing is known about it yet', () => {
    // Deliberate: demoting an engine the probe has not looked at would cost a
    // correctly configured user their engine, which is worse than the launch this
    // guard exists to catch. Nothing has been probed here, so codex survives.
    expect(resolveDefaultEngine(config('codex'))).toBe('codex');
  });

  it('never demotes the default engine itself, even with a negative verdict', async () => {
    // claude is walnut's own substrate AND the fallback, so it is never probed
    // from here — a bad verdict could only demote it to itself, and a launch that
    // really cannot spawn reports that far more precisely than a catalog flag.
    _seedEngineProbeCache('claude', { installed: false, version: null, reason: 'nonsense' });
    await refreshDefaultEngineAvailability('claude');
    expect(resolveDefaultEngine(config('claude'))).toBe('claude');
    expect(resolveDefaultEngine(config())).toBe('claude');
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
