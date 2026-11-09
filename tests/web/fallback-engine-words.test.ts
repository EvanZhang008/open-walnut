/**
 * The fallback engine's words in the web (Settings > Sessions "When it is out of usage", a new
 * task's draft): what the line under the row says for each answer of GET /api/engines/fallback,
 * the draft's line and model pill, and the save keeping the listed model name.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { fallbackNowLine } from '@/components/settings/sections/FallbackEngineRow';
import { fallbackSave } from '@/components/settings/sections/fallback-engine-select';
import { draftFallbackLine, draftFallbackPill, draftFallbackWords } from '@/components/sessions/DraftFallbackNotice';
import type { EngineFallbackNow } from '@/api/engine-fallback';
import { fallbackLaunchMeta } from '@/components/sessions/draft-ownership';
import { withDefaultModel } from '@/components/sessions/engine-default-model';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const RESET = new Date(NOW + 2 * 3600_000).toISOString();
const limit = { window: 'five_hour', resetsAt: RESET };

function answer(over: Partial<EngineFallbackNow>): EngineFallbackNow {
  return { host: '__local__', defaultEngine: 'claude', setting: null, fallback: null, ...over };
}

const codexNow = answer({
  setting: { engine: 'codex', model: 'mock-gpt-fast', model_label: 'Mock GPT Fast' },
  fallback: { engine: 'codex', model: 'mock-gpt-fast', note: { from: 'claude', to: 'codex', model: 'mock-gpt-fast', model_label: 'Mock GPT Fast', window: 'five_hour', resets_at: RESET, at: new Date(NOW).toISOString() } },
});

describe('the Settings line', () => {
  it('names the machine as "here" and the model by its listed name', () => {
    const line = fallbackNowLine(codexNow, NOW)!;
    expect(line).toMatch(/^The Claude 5-hour limit is reached here \(resets .+\): new tasks start on Codex \(Mock GPT Fast\) now\.$/);
    expect(line).not.toContain('Mac');
  });

  it('says the real reason a fallback that is set does not take new tasks', () => {
    const at = (over: Partial<EngineFallbackNow>) => fallbackNowLine(answer({ limit, ...over }), NOW)!;
    expect(at({ setting: { engine: 'claude' }, skip: 'needs_model' })).toMatch(/: pick a model below, or new tasks wait for the reset\.$/);
    expect(at({ setting: { engine: 'claude', model: 'sonnet' }, skip: 'shares_limit' })).toMatch(/, and it covers Sonnet too, so new tasks wait for the reset\.$/);
    expect(at({ setting: { engine: 'codex' }, skip: 'limited_too' })).toMatch(/, and Codex is out of usage too, so new tasks wait for the reset\.$/);
    expect(at({ setting: { engine: 'codex' }, skip: 'not_runnable' })).toMatch(/, and Codex is not installed here, so new tasks wait for the reset\.$/);
    expect(at({})).toMatch(/: new tasks wait for the reset\.$/);
  });

  it('says no Claude model helps when the limit covers them all and none behind a proxy is set up', () => {
    const line = fallbackNowLine(answer({ limit, setting: { engine: 'claude' }, skip: 'needs_model' }), NOW, { noClaudeModelHelps: true })!;
    expect(line).toMatch(/, and it covers every Claude model, so new tasks wait for the reset\.$/);
    expect(line).not.toContain('pick a model');
  });

  it('says nothing while nothing is limited', () => {
    expect(fallbackNowLine(answer({ setting: { engine: 'codex' } }), NOW)).toBeNull();
    expect(fallbackNowLine(null, NOW)).toBeNull();
  });
});

describe('the draft', () => {
  it('the line and the model pill name the fallback', () => {
    expect(draftFallbackWords(codexNow, NOW)).toMatch(/^The Claude 5-hour limit is reached here \(resets .+\): this task starts on Codex \(Mock GPT Fast\)\.$/);
    expect(draftFallbackPill(codexNow)).toBe('Codex (fallback)');
    const sol = answer({ fallback: { engine: 'claude', model: 'gpt-6.1-sol', note: { from: 'claude', to: 'claude', model: 'gpt-6.1-sol', model_label: 'Sol', at: new Date(NOW).toISOString() } } });
    expect(draftFallbackPill(sol)).toBe('Sol (fallback)');
  });

  it("a draft that names the default engine's model waits, and offers the fallback", () => {
    const line = draftFallbackLine(codexNow, NOW, 'Sonnet')!;
    expect(line).toMatchObject({ strong: 'Sonnet', waits: true, action: 'Start on Codex (Mock GPT Fast) instead' });
    expect(draftFallbackWords(codexNow, NOW, 'Sonnet')).toMatch(/: on Sonnet this task waits for the reset\.$/);
  });

  it('a fallback the limit blocks too: the draft says it waits, and why', () => {
    const shares = answer({ setting: { engine: 'claude', model: 'sonnet' }, limit, skip: 'shares_limit' });
    expect(draftFallbackLine(shares, NOW)).toMatchObject({ waits: true });
    expect(draftFallbackWords(shares, NOW)).toMatch(/, and it covers Sonnet too: this task waits for the reset\.$/);
    expect(draftFallbackWords(answer({ setting: { engine: 'codex' }, limit, skip: 'limited_too' }), NOW)).toMatch(/Codex is out of usage too: this task waits/);
    // No model picked for Claude Code: under a limit that covers every Claude model, a model would not help.
    expect(draftFallbackWords(answer({ setting: { engine: 'claude' }, limit, skip: 'needs_model' }), NOW))
      .toMatch(/, and it covers every Claude model: this task waits for the reset \(another engine, or a model of another provider, can take it: Settings > Sessions\)\.$/);
    expect(draftFallbackWords(answer({ setting: { engine: 'claude' }, limit: { window: 'seven_day_opus', resetsAt: RESET }, skip: 'needs_model' }), NOW))
      .toMatch(/: this task waits for the reset \(the fallback needs a model, Settings > Sessions\)\.$/);
    // A model named while the fallback is blocked: it still waits, with nothing to offer.
    expect(draftFallbackLine(shares, NOW, 'Opus')).toEqual({ before: expect.stringMatching(/reached here \(resets .+\): on $/), strong: 'Opus', after: ' this task waits for the reset.', waits: true });
    // Nothing limited: nothing to say about a named model.
    expect(draftFallbackLine(answer({ setting: { engine: 'codex' } }), NOW, 'Opus')).toBeNull();
  });

  it('no fallback: no line, and the pill keeps its own words', () => {
    expect(draftFallbackWords(answer({}), NOW)).toBeNull();
    expect(draftFallbackPill(answer({}))).toBeNull();
  });
});

describe('fallbackSave', () => {
  const cfg = { defaults: { priority: 'none', fallback_engine: { engine: 'codex' } } } as unknown as Config;

  it('keeps the listed name with the model, and the sibling defaults', () => {
    expect(fallbackSave(cfg, 'codex', 'mock-gpt-fast', 'Mock GPT Fast')).toEqual({ defaults: { priority: 'none', fallback_engine: { engine: 'codex', model: 'mock-gpt-fast', model_label: 'Mock GPT Fast' } } });
    // A name that is the id itself, or no model, carries no label.
    expect(fallbackSave(cfg, 'claude', 'gpt-6.1-sol', 'gpt-6.1-sol')).toEqual({ defaults: { priority: 'none', fallback_engine: { engine: 'claude', model: 'gpt-6.1-sol' } } });
    expect(fallbackSave(cfg, 'codex', undefined, 'Codex')).toEqual({ defaults: { priority: 'none', fallback_engine: { engine: 'codex' } } });
    expect(fallbackSave(cfg, 'off')).toEqual({ defaults: { priority: 'none' } });
  });
});

describe('fallbackLaunchMeta', () => {
  const meta = { model: 'sonnet' } as never as Parameters<typeof fallbackLaunchMeta>[1];

  it("drops a model the folder only remembered while a fallback would take the launch", () => {
    expect(fallbackLaunchMeta({ metaTouched: false }, meta, 'codex', false)).toMatchObject({ model: undefined });
  });

  it('keeps a model picked in this draft, a named engine, and everything when no fallback applies', () => {
    expect(fallbackLaunchMeta({ metaTouched: true }, meta, 'codex', false)).toBe(meta);
    expect(fallbackLaunchMeta({ metaTouched: false }, meta, 'codex', true)).toBe(meta);
    expect(fallbackLaunchMeta({ metaTouched: false }, meta, undefined, false)).toBe(meta);
    expect(fallbackLaunchMeta({ metaTouched: false, taskId: 't1' }, meta, 'codex', false)).toBe(meta);
  });
});

describe('withDefaultModel', () => {
  const note = { from: 'claude', to: 'codex', at: new Date(NOW).toISOString() } as const;

  it("names the engine's default model where the setting names none, as the picker does", () => {
    expect(withDefaultModel(note, { id: 'gpt-best', name: 'GPT Best' })).toMatchObject({ model: 'gpt-best', model_label: 'GPT Best' });
    expect(draftFallbackWords(answer({ setting: { engine: 'codex' }, fallback: { engine: 'codex', note: withDefaultModel({ ...note, window: 'five_hour', resets_at: RESET }, { id: 'gpt-best', name: 'GPT Best' }) } }), NOW))
      .toMatch(/: this task starts on Codex \(GPT Best\)\.$/);
  });

  it('keeps a model the setting named, and a note with no default known', () => {
    const named = { ...note, model: 'mock-gpt-fast', model_label: 'Mock GPT Fast' };
    expect(withDefaultModel(named, { id: 'gpt-best', name: 'GPT Best' })).toBe(named);
    expect(withDefaultModel(note, undefined)).toBe(note);
  });
});
