/**
 * The default-engine reader + the Ask-Walnut profile prefix.
 *
 * Two pure pieces of slice S0 ("every Walnut-initiated session inherits the
 * engine picked in Settings"), both of which can only be wrong silently:
 *   - resolveDefaultEngine decides what a launch that named no engine runs on.
 *     A typo in config.yaml must degrade to the shipped default, never throw on
 *     the launch path, and on a remote host an inherited ACP engine runs there only
 *     when that host said it has it (no answer yet, as after a restart, is
 *     Claude Code); a local-only one always gives way.
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
  hostStartDefaultEngine,
  refreshDefaultEngineAvailability,
  resolveDefaultEngine,
} from '../../src/core/agents/default-engine.js';
import {
  _resetEngineProbeCache,
  _seedEngineProbeCache,
} from '../../src/core/agents/engine-probe.js';
import { _resetHostEngineCache, _seedHostEngineCache } from '../../src/core/agents/host-engines.js';
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
  _resetHostEngineCache();
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

  it('inherits an ACP engine onto a remote host only when that host said it runs it, and leaves a local launch alone', () => {
    // A host that said so keeps the engine, whatever the connection: an SSH host, a
    // host-network machine or the cloud box (each runs ACP engines through its daemon).
    for (const host of ['devbox', 'net-mac', '__cloudbox__']) {
      _seedHostEngineCache(host, { codex: { installed: true, version: '1', reason: null }, gemini: { installed: true, version: '1', reason: null } });
      expect(resolveDefaultEngine(config('codex'), { host }), host).toBe('codex');
      expect(resolveDefaultEngine(config('gemini'), { host }), host).toBe('gemini');
    }
    // Only an engine whose adapter command is this machine's own config stays here
    // (engineHostBlocker, the same rule a named pick meets), even with a positive answer.
    _seedHostEngineCache('devbox', { custom: { installed: true, version: '1', reason: null } });
    expect(resolveDefaultEngine(config('custom'), { host: 'devbox' })).toBe('claude');
    // The absence of a host, in each of the shapes callers actually pass —
    // including '__local__', the launcher's alias for this machine, which is NOT
    // a remote host and must not cost the user their engine.
    expect(resolveDefaultEngine(config('codex'), { host: undefined })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: null })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: '' })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: '__local__' })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), {})).toBe('codex');
    expect(resolveDefaultEngine(config('claude'), { host: 'devbox' })).toBe('claude');
  });

  it('after a restart (no host has answered yet) an inherited ACP engine on a remote host is Claude Code', () => {
    // The host-engine cache is empty after every restart: an automated start (a routine,
    // subagent_run, a trigger, an org start) must not start an engine the host may lack.
    for (const host of ['devbox', 'net-mac', '__cloudbox__']) {
      expect(resolveDefaultEngine(config('codex'), { host }), host).toBe('claude');
    }
    // This machine's own positive verdict says nothing about another host's.
    _seedEngineProbeCache('codex', { installed: true, version: 'codex 0.9.0', reason: null });
    expect(resolveDefaultEngine(config('codex'), { host: 'devbox' })).toBe('claude');
  });

  it('on a remote host, reads that host\'s own answer: only a positive one keeps the engine', () => {
    // This machine's verdict says nothing about the host's.
    _seedEngineProbeCache('codex', { installed: false, version: null, reason: 'Codex CLI not found' });
    _seedHostEngineCache('devbox', { codex: { installed: false, version: null, reason: 'codex is not on PATH' } });
    _seedHostEngineCache('net-mac', { codex: { installed: true, version: '1', reason: null } });
    _seedHostEngineCache('slow-box', { codex: { installed: false, version: null, reason: 'still checking availability' } });
    // A host that answered without naming the engine said nothing about it either.
    _seedHostEngineCache('quiet-box', { claude: { installed: true, version: null, reason: null } });
    expect(resolveDefaultEngine(config('codex'), { host: 'devbox' })).toBe('claude');
    expect(resolveDefaultEngine(config('codex'), { host: 'net-mac' })).toBe('codex');
    expect(resolveDefaultEngine(config('codex'), { host: 'slow-box' })).toBe('claude');
    expect(resolveDefaultEngine(config('codex'), { host: 'quiet-box' })).toBe('claude');
  });

  it('the start a host makes itself (hostStartDefaultEngine) is the same whatever the host answered', () => {
    const answers = [
      undefined,
      { codex: { installed: true, version: '1', reason: null } },
      { codex: { installed: false, version: null, reason: 'codex is not on PATH' } },
    ];
    for (const answer of answers) {
      _resetHostEngineCache();
      if (answer) _seedHostEngineCache('devbox', answer);
      expect(hostStartDefaultEngine(config('codex'), 'devbox'), JSON.stringify(answer)).toBe('claude');
      expect(hostStartDefaultEngine(config('claude'), 'devbox')).toBe('claude');
      expect(hostStartDefaultEngine(config(), 'devbox')).toBe('claude');
    }
    // A local start keeps the local rule.
    expect(hostStartDefaultEngine(config('codex'), '__local__')).toBe('codex');
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
