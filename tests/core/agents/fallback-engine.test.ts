/**
 * The fallback engine decision (src/core/agents/fallback-engine.ts): a new task that names no
 * engine starts on the fallback only while the default engine is out of usage on its host, read
 * through one seam (src/core/agents/engine-limit-source.ts): a session's own usage-limit stop (handed
 * in here as test data) or the host's Claude reading.
 */
import { describe, expect, it } from 'vitest';
import {
  claudeFamilyOf, engineLimitNow, explainFallbackLaunch, fallbackSetting, resolveFallbackLaunch, selfDecidesFallback, UNKNOWN_RESET_HOLD_MS, type FallbackDeps,
} from '../../../src/core/agents/fallback-engine.js';
import { fallbackBannerWords, fallbackStartWords } from '../../../src/core/agents/fallback-engine-words.js';
import { SESSION_MODEL_CLI_MAP, type SessionRecord } from '../../../src/core/types.js';
import {
  __setSessionLimitForTesting, blockedLimitOf, sessionLimitOf, type SessionLimitReading,
} from '../../../src/core/agents/engine-limit-source.js';
import type { HostLimitFrame } from '../../../src/core/sessions/subscription-limits.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

/** A session's usage-limit stop as test data (the seam's reading; engine and state only label it). */
type FakeLimit = SessionLimitReading & { engine?: string; state?: string };

function rec(over: Partial<SessionRecord> & { usageLimit?: FakeLimit } = {}): SessionRecord {
  return {
    claudeSessionId: `s-${Math.random().toString(36).slice(2)}`, taskId: 't1', project: '', cwd: '/w',
    process_status: 'stopped', ...over,
  } as SessionRecord;
}

function waiting(over: Partial<FakeLimit> = {}): FakeLimit {
  return { state: 'waiting', engine: 'claude', window: 'five_hour', since: iso(NOW - 10 * 60_000), resetsAt: iso(NOW + 2 * HOUR), resetsFrom: 'event', ...over };
}

function deps(over: Partial<FallbackDeps> & { sessions?: SessionRecord[]; frames?: Record<string, HostLimitFrame> } = {}): FallbackDeps {
  return {
    listSessions: async () => over.sessions ?? [],
    sessionLimit: over.sessionLimit ?? ((r) => (r as { usageLimit?: FakeLimit }).usageLimit),
    hostFrame: async (h) => over.frames?.[h],
    runnable: over.runnable ?? (async () => true),
    now: () => NOW,
  };
}

const CODEX = { defaults: { fallback_engine: { engine: 'codex', model: 'gpt-5.5' } } };

describe('fallbackSetting', () => {
  it('is off when absent, unknown or malformed, and drops an empty or Auto model', () => {
    expect(fallbackSetting(undefined)).toBeNull();
    expect(fallbackSetting({ defaults: {} })).toBeNull();
    expect(fallbackSetting({ defaults: { fallback_engine: { engine: 'nope' } } })).toBeNull();
    expect(fallbackSetting({ defaults: { fallback_engine: 'codex' } })).toBeNull();
    expect(fallbackSetting({ defaults: { fallback_engine: { engine: 'codex', model: 'default' } } })).toEqual({ engine: 'codex' });
    expect(fallbackSetting({ defaults: { fallback_engine: { engine: 'codex', model: '  ' } } })).toEqual({ engine: 'codex' });
    expect(fallbackSetting(CODEX)).toEqual({ engine: 'codex', model: 'gpt-5.5' });
    // The listed name rides with a model only.
    expect(fallbackSetting({ defaults: { fallback_engine: { engine: 'codex', model: 'gpt-5.5', model_label: ' GPT-5.5 ' } } })).toEqual({ engine: 'codex', model: 'gpt-5.5', model_label: 'GPT-5.5' });
    expect(fallbackSetting({ defaults: { fallback_engine: { engine: 'codex', model_label: 'GPT-5.5' } } })).toEqual({ engine: 'codex' });
  });
});

describe('claudeFamilyOf', () => {
  it('names the Claude family of an alias, a CLI form or a provider id; none for another provider', () => {
    expect(claudeFamilyOf('sonnet')).toBe('sonnet');
    expect(claudeFamilyOf('opus[1m]')).toBe('opus');
    expect(claudeFamilyOf('global.anthropic.claude-opus-5-5')).toBe('opus');
    expect(claudeFamilyOf('claude-haiku-5-5')).toBe('haiku');
    expect(claudeFamilyOf('gpt-6.1-sol')).toBeNull();
    expect(claudeFamilyOf(undefined)).toBeNull();
  });
});

describe('engineLimitNow', () => {
  it('reads a waiting session of that engine on that host, until its reset', async () => {
    const d = deps({ sessions: [rec({ usageLimit: waiting() })] });
    expect(await engineLimitNow('claude', undefined, d)).toEqual({ window: 'five_hour', resetsAt: NOW + 2 * HOUR, resetsFrom: 'event' });
    expect(await engineLimitNow('codex', undefined, d)).toBeNull();
    expect(await engineLimitNow('claude', 'clouddev', d)).toBeNull();
  });

  it('treats no host, "local" and __local__ as this machine', async () => {
    const d = deps({ sessions: [rec({ host: '__local__', usageLimit: waiting() })] });
    expect(await engineLimitNow('claude', 'local', d)).not.toBeNull();
    expect(await engineLimitNow('claude', undefined, d)).not.toBeNull();
  });

  it('a reset that passed, an archived session, or a session the reading lets go no longer holds', async () => {
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ usageLimit: waiting({ resetsAt: iso(NOW - 1) }) })] }))).toBeNull();
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ archived: true, usageLimit: waiting() } as never)] }))).toBeNull();
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ usageLimit: waiting() })], sessionLimit: () => undefined }))).toBeNull();
  });

  it('a wait the user turned off still holds the engine until its reset', async () => {
    const d = deps({ sessions: [rec({ usageLimit: waiting({ state: 'off', offAt: iso(NOW - 60_000) }) })] });
    expect(await engineLimitNow('claude', undefined, d)).toMatchObject({ resetsAt: NOW + 2 * HOUR });
  });

  it('a stop with no named reset holds for the first look after it, then lets go', async () => {
    const fresh = waiting({ resetsAt: undefined, resetsFrom: undefined, since: iso(NOW - 5 * 60_000), dueAt: undefined });
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ usageLimit: fresh })] }))).toEqual({ window: 'five_hour' });
    const old = waiting({ resetsAt: undefined, resetsFrom: undefined, since: iso(NOW - UNKNOWN_RESET_HOLD_MS - 1), dueAt: undefined });
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ usageLimit: old })] }))).toBeNull();
    // ...unless its next try is still ahead.
    const due = { ...old, dueAt: iso(NOW + HOUR) };
    expect(await engineLimitNow('claude', undefined, deps({ sessions: [rec({ usageLimit: due })] }))).toEqual({ window: 'five_hour' });
  });

  it('the latest named reset wins over an earlier one and over an unnamed stop', async () => {
    const d = deps({ sessions: [
      rec({ usageLimit: waiting({ resetsAt: undefined, resetsFrom: undefined }) }),
      rec({ usageLimit: waiting({ window: 'five_hour', resetsAt: iso(NOW + HOUR) }) }),
      rec({ usageLimit: waiting({ window: 'seven_day', resetsAt: iso(NOW + 30 * HOUR) }) }),
    ] });
    expect(await engineLimitNow('claude', undefined, d)).toMatchObject({ window: 'seven_day', resetsAt: NOW + 30 * HOUR });
  });

  it("reads the host's Claude reading: blocked with its reset ahead, and not while extra usage carries it", async () => {
    const frame = (over: Partial<HostLimitFrame> = {}): HostLimitFrame => ({
      host: '__local__', windows: {}, updatedAt: NOW, serverNow: NOW,
      current: { status: 'rejected', type: 'five_hour', resetsAt: NOW + HOUR, seenAt: NOW - 1000 }, ...over,
    });
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame() } })))
      .toEqual({ window: 'five_hour', resetsAt: NOW + HOUR, resetsFrom: 'host' });
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ overage: { status: 'allowed', seenAt: NOW } }) } }))).toBeNull();
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ current: { status: 'allowed_warning', resetsAt: NOW + HOUR, seenAt: NOW } }) } }))).toBeNull();
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ current: { status: 'rejected', resetsAt: NOW - 1, seenAt: NOW - HOUR } }) } }))).toBeNull();
    // A host signed in another way now (an API key, a cloud provider) keeps its old subscription
    // reading until the reset: it does not hold the engine.
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ signIn: { kind: 'other' } }) } }))).toBeNull()
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ signIn: { kind: 'subscription' } }) } }))).not.toBeNull()
    // One model's weekly window leaves the engine's other models running.
    expect(await engineLimitNow('claude', undefined, deps({ frames: { __local__: frame({ current: { status: 'rejected', type: 'seven_day_opus', resetsAt: NOW + HOUR, seenAt: NOW } }) } }))).toBeNull()
    // Codex has no host reading: only its sessions say.
    expect(await engineLimitNow('codex', undefined, deps({ frames: { __local__: frame() } }))).toBeNull();
  });
});

describe('resolveFallbackLaunch', () => {
  const limited = () => deps({ sessions: [rec({ usageLimit: waiting() })] });

  it('no setting: nothing changes, and the limit is not even read', async () => {
    let read = false;
    const d = { ...limited(), listSessions: async () => { read = true; return []; } };
    expect(await resolveFallbackLaunch({ defaults: {} }, 'claude', undefined, { deps: d, quiet: true })).toBeNull();
    expect(read).toBe(false);
  });

  it('the default engine is not limited: the default runs', async () => {
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: deps(), quiet: true })).toBeNull();
  });

  it('the default engine is limited: the fallback runs, with the note its task carries', async () => {
    const got = await resolveFallbackLaunch(CODEX, 'claude', 'clouddev', {
      deps: deps({ sessions: [rec({ host: 'clouddev', usageLimit: waiting() })] }), quiet: true,
    });
    expect(got).toEqual({
      engine: 'codex', model: 'gpt-5.5',
      note: { from: 'claude', to: 'codex', model: 'gpt-5.5', window: 'five_hour', resets_at: iso(NOW + 2 * HOUR), resets_from: 'event', host: 'clouddev', at: iso(NOW) },
    });
  });

  it('a fallback that cannot run on the host, or did not answer, keeps the default', async () => {
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: { ...limited(), runnable: async () => false }, quiet: true })).toBeNull();
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: { ...limited(), runnable: async () => undefined }, quiet: true })).toBeNull();
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: { ...limited(), runnable: async () => { throw new Error('down'); } }, quiet: true })).toBeNull();
  });

  it("one model's weekly window in a session does not hold the engine for another engine's fallback", async () => {
    const d = deps({ sessions: [rec({ usageLimit: waiting({ window: 'seven_day_opus', resetsAt: iso(NOW + 30 * HOUR) }) })] });
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: d, quiet: true })).toBeNull();
  });

  it('a Claude Code model the launch cannot take is no fallback', async () => {
    const bad = { defaults: { fallback_engine: { engine: 'claude', model: 'not a model' } } };
    expect(await resolveFallbackLaunch(bad, 'claude', undefined, { deps: limited(), quiet: true })).toBeNull();
  });

  it('a read for display does not dial an unlinked host; a launch does', async () => {
    const dials: Array<boolean | undefined> = [];
    const d = { ...limited(), runnable: async (_e: string, _h: string, dial?: boolean) => { dials.push(dial); return true; } };
    await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: d, quiet: true });
    await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: d, quiet: false });
    expect(dials).toEqual([false, true]);
  });

  it('reads the sessions once for both engines', async () => {
    let reads = 0;
    const d = { ...limited(), listSessions: async () => { reads++; return [rec({ usageLimit: waiting() })]; } };
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: d, quiet: true })).not.toBeNull();
    expect(reads).toBe(1);
  });

  it('a fallback engine that is out of usage too keeps the default', async () => {
    const d = deps({ sessions: [rec({ usageLimit: waiting() }), rec({ engine: 'codex', usageLimit: waiting({ engine: 'codex', window: undefined }) })] });
    expect(await resolveFallbackLaunch(CODEX, 'claude', undefined, { deps: d, quiet: true })).toBeNull();
  });

  it('another Claude model shares the 5-hour and weekly limits: no fallback, and why', async () => {
    const sonnet = { defaults: { fallback_engine: { engine: 'claude', model: 'sonnet' } } };
    expect(await explainFallbackLaunch(sonnet, 'claude', undefined, { deps: limited(), quiet: true }))
      .toMatchObject({ decision: null, skip: 'shares_limit', limit: { window: 'five_hour' } });
    const weekly = deps({ sessions: [rec({ usageLimit: waiting({ window: 'seven_day' }) })] });
    expect((await explainFallbackLaunch(sonnet, 'claude', undefined, { deps: weekly, quiet: true })).skip).toBe('shares_limit');
    // A stop that did not name its window may be any of them.
    const unnamed = deps({ sessions: [rec({ usageLimit: waiting({ window: undefined }) })] });
    expect((await explainFallbackLaunch(sonnet, 'claude', undefined, { deps: unnamed, quiet: true })).skip).toBe('shares_limit');
  });

  it("another Claude model takes new tasks under one model's own weekly window, from a session or the host", async () => {
    const sonnet = { defaults: { fallback_engine: { engine: 'claude', model: 'sonnet', model_label: 'Sonnet' } } };
    const opusWeek = deps({ sessions: [rec({ usageLimit: waiting({ window: 'seven_day_opus', resetsAt: iso(NOW + 30 * HOUR) }) })] });
    expect(await resolveFallbackLaunch(sonnet, 'claude', undefined, { deps: opusWeek, quiet: true }))
      .toMatchObject({ engine: 'claude', model: SESSION_MODEL_CLI_MAP.sonnet ?? 'sonnet', note: { model: 'sonnet', model_label: 'Sonnet', window: 'seven_day_opus' } });
    const frame: HostLimitFrame = { host: '__local__', windows: {}, updatedAt: NOW, serverNow: NOW,
      current: { status: 'rejected', type: 'seven_day_opus', resetsAt: NOW + 30 * HOUR, seenAt: NOW } };
    expect(await resolveFallbackLaunch(sonnet, 'claude', undefined, { deps: deps({ frames: { __local__: frame } }), quiet: true }))
      .toMatchObject({ note: { window: 'seven_day_opus', resets_from: 'host' } });
    // ...but not the window of its own family.
    const sonnetWeek = deps({ sessions: [rec({ usageLimit: waiting({ window: 'seven_day_sonnet' }) })] });
    expect((await explainFallbackLaunch(sonnet, 'claude', undefined, { deps: sonnetWeek, quiet: true })).skip).toBe('shares_limit');
  });

  it('a model of another provider behind Claude Code takes new tasks under any Claude limit', async () => {
    const sol = { defaults: { fallback_engine: { engine: 'claude', model: 'gpt-6.1-sol' } } };
    expect(await resolveFallbackLaunch(sol, 'claude', undefined, { deps: limited(), quiet: true }))
      .toMatchObject({ engine: 'claude', model: 'gpt-6.1-sol', note: { from: 'claude', to: 'claude', model: 'gpt-6.1-sol' } });
  });

  it('the same engine on its own default model is none, and says a model is needed', async () => {
    const bare = { defaults: { fallback_engine: { engine: 'claude' } } };
    expect(await resolveFallbackLaunch(bare, 'claude', undefined, { deps: limited(), quiet: true })).toBeNull();
    expect((await explainFallbackLaunch(bare, 'claude', undefined, { deps: limited(), quiet: true })).skip).toBe('needs_model');
    // Nothing limited: nothing to explain.
    expect(await explainFallbackLaunch(bare, 'claude', undefined, { deps: deps(), quiet: true })).toEqual({ decision: null, limit: null });
  });

  it('says why a fallback engine does not take the launch: not installed, or out of usage too', async () => {
    expect((await explainFallbackLaunch(CODEX, 'claude', undefined, { deps: { ...limited(), runnable: async () => false }, quiet: true })).skip).toBe('not_runnable');
    const both = deps({ sessions: [rec({ usageLimit: waiting() }), rec({ engine: 'codex', usageLimit: waiting({ engine: 'codex' }) })] });
    expect((await explainFallbackLaunch(CODEX, 'claude', undefined, { deps: both, quiet: true })).skip).toBe('limited_too');
  });

  it('a Claude fallback is not asked whether it runs (the native engine always does)', async () => {
    const toClaude = { defaults: { fallback_engine: { engine: 'claude' } } };
    const d = deps({ sessions: [rec({ engine: 'codex', usageLimit: waiting({ engine: 'codex' }) })], runnable: async () => false });
    expect(await resolveFallbackLaunch(toClaude, 'codex', undefined, { deps: d, quiet: true })).toMatchObject({ engine: 'claude' });
  });
});

describe('selfDecidesFallback', () => {
  it("only a routine's new task decides on its own; Walnut's own agents never", () => {
    expect(selfDecidesFallback('routine', false)).toBe(true);
    expect(selfDecidesFallback('routine-trigger', undefined)).toBe(true);
    expect(selfDecidesFallback('routine-watcher', false)).toBe(true);
    expect(selfDecidesFallback('routine-watcher', true)).toBe(false);
    for (const s of ['quick-start', 'mobile', 'notification-fix', 'workspace', 'subagent', 'routines-x']) expect(selfDecidesFallback(s, false)).toBe(false);
  });
});

describe('fallback words', () => {
  const note = { from: 'claude', to: 'codex', model: 'gpt-5.5', window: 'five_hour', resets_at: iso(NOW + 2 * HOUR), resets_from: 'event', at: iso(NOW) } as const;

  it('the banner names the engine it runs on, the limit, and the way back', () => {
    const w = fallbackBannerWords(note, NOW);
    expect(w.head).toBe('Started on Codex (gpt-5.5)');
    expect(w.why).toMatch(/^Claude 5-hour limit reached · resets\u00a0/);
    expect(w.action).toBe('Switch to Claude Code');
    expect(w.detail).toMatch(/^Claude Code was out of usage, so this task started on Codex, your fallback engine\. Switching back moves it to Claude Code/);
    expect(w.detail).toMatch(/with its conversation; it goes on there after the reset at .+\.$/);
  });

  it('past the reset it says the limit has reset', () => {
    const w = fallbackBannerWords(note, NOW + 3 * HOUR);
    expect(w.why).toBe('Claude 5-hour limit has reset');
    expect(w.detail).toMatch(/^Claude Code can run again: switch back/);
  });

  it('an estimated reset says about; an unknown one names no time', () => {
    expect(fallbackBannerWords({ ...note, resets_from: 'text' }, NOW).why).toMatch(/resets\u00a0about\u00a0/);
    const w = fallbackBannerWords({ ...note, resets_at: undefined, window: undefined, model: undefined }, NOW);
    expect(w.head).toBe('Started on Codex');
    expect(w.why).toBe('Claude usage limit reached');
    expect(w.detail).toMatch(/it goes on there after the reset\.$/);
  });

  it('names the model as Settings listed it, or a Claude model by its own name', () => {
    expect(fallbackBannerWords({ ...note, model: 'mock-gpt-fast', model_label: 'Mock GPT Fast' }, NOW).head).toBe('Started on Codex (Mock GPT Fast)');
    expect(fallbackBannerWords({ ...note, to: 'claude', model: 'sonnet' }, NOW).head).toBe('Started on Sonnet');
    expect(fallbackBannerWords({ ...note, to: 'claude', model: 'gpt-6.1-sol' }, NOW).head).toBe('Started on gpt-6.1-sol');
  });

  it('the same engine on another model offers the default model back, not an engine switch', () => {
    const same = { ...note, to: 'claude', model: 'sonnet' } as const;
    const w = fallbackBannerWords(same, NOW);
    expect(w.head).toBe('Started on Sonnet');
    expect(w.action).toBe('Use the default model');
    expect(w.detail).toMatch(/^Claude Code's default model was out of usage, so this task started on Sonnet/);
    expect(fallbackStartWords(same, NOW)).toMatch(/^It started on Sonnet, not Claude Code's default model: the Claude 5-hour limit is reached/);
    expect(fallbackStartWords(same, NOW)).not.toContain('task_switch_engine');
  });

  it("an agent's start answer names the engine, the limit and task_switch_engine", () => {
    const s = fallbackStartWords({ ...note, host: 'clouddev' }, NOW);
    expect(s).toMatch(/^It started on Codex \(gpt-5\.5\), not Claude Code: the Claude 5-hour limit is reached until .+ on clouddev/);
    expect(s).toContain('task_switch_engine with engine "claude"');
    expect(s).not.toMatch(/ /);
  });
});

describe('the limit seam (engine-limit-source.ts)', () => {
  it("reads the usage-limit wait's own record of a session, and a test can hand the server one", () => {
    // A session the limit stopped: the wait's record holds its engine; a resumed one whose turn ran
    // cleanly does not; a session with no limit of its own reads nothing.
    const stopped = rec({ usageLimit: { ...waiting(), state: 'waiting', engine: 'claude', resumes: 0, tries: 0 } as never });
    expect(sessionLimitOf(stopped, NOW)).toMatchObject({ window: 'five_hour', resetsFrom: 'event' });
    expect(sessionLimitOf(rec({ process_status: 'idle', usageLimit: { ...waiting(), state: 'resumed', engine: 'claude', resumes: 1, tries: 0 } as never }), NOW)).toBeUndefined();
    const plain = rec();
    expect(sessionLimitOf(plain, NOW)).toBeUndefined();
    __setSessionLimitForTesting((x) => (x === plain ? waiting() : undefined));
    try {
      expect(sessionLimitOf(plain, NOW)).toMatchObject({ window: 'five_hour' });
      expect(sessionLimitOf(stopped, NOW)).toBeUndefined();
    } finally {
      __setSessionLimitForTesting(null);
    }
    expect(sessionLimitOf(plain, NOW)).toBeUndefined();
  });

  it("the host's reading blocks only when rejected with no extra usage to go on", () => {
    expect(blockedLimitOf(null)).toBeNull();
    expect(blockedLimitOf({ status: 'allowed', rateLimitType: 'five_hour' })).toBe('allowed');
    expect(blockedLimitOf({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed' })).toBe('allowed');
    expect(blockedLimitOf({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true })).toBe('allowed');
    expect(blockedLimitOf({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: NOW + HOUR })).toEqual({ window: 'seven_day', resetsAt: NOW + HOUR });
  });
});
