/**
 * Two turns in a row the model's safeguards refused move the session to another model by itself.
 * 2026-11-11: one task got "API Error: Opus 5.5's safeguards flagged this message ... [reasoning_extraction]"
 * 19 times in 34 minutes and stayed stuck until the user typed /model; Sonnet 5.5 refused it too,
 * Fable answered.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { bus, EventNames } from '../../../src/core/event-bus.js';
import {
  modelFamilyOf, pickFallbackModel, resendNoteText, safeguardStopOfAcpStopReason, safeguardStopOfCliLine, safeguardStopOfResult,
  type ModelRow,
} from '../../../src/core/sessions/safeguard-stop.js';
import { startSafeguardSwitch, safeguardSwitchHolds, MAX_SWITCHES_PER_DAY, type SafeguardSwitchDeps } from '../../../src/core/sessions/safeguard-switch.js';
import { beginQuietTurn, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js';
import type { SessionRecord } from '../../../src/core/types.js';

/** The menu a Bedrock host serves (GET /api/v1/sessions/:id/model-options, 2026-11-11). */
const MENU: ModelRow[] = [
  { id: 'default', label: 'Default', resolvedModel: 'global.anthropic.claude-opus-5-5' },
  { id: 'sonnet', label: 'Sonnet 5.5', resolvedModel: 'global.anthropic.claude-sonnet-5-5' },
  { id: 'global.anthropic.claude-fable-5-2[1m]', label: 'Fable', resolvedModel: 'global.anthropic.claude-fable-5-2' },
  { id: 'opus', label: 'Opus 5.5', resolvedModel: 'global.anthropic.claude-opus-5-5' },
  { id: 'haiku', label: 'Haiku 5.5', resolvedModel: 'global.anthropic.claude-haiku-5-5' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', resolvedModel: 'gpt-6-astra' },
];

describe('reading a refusal from what the engine marks', () => {
  it('the transcript and stream-json forms of Claude Code\'s refusal reply', () => {
    // Transcript (camelCase), as ~/.claude/projects holds it.
    expect(safeguardStopOfCliLine({
      isApiErrorMessage: true, error: 'invalid_request',
      message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { category: 'reasoning_extraction' } },
    })).toEqual({ category: 'reasoning_extraction' });
    // Stream-json (snake_case), as a daemon stream file holds it.
    expect(safeguardStopOfCliLine({
      is_api_error_message: true, error: 'invalid_request',
      message: { model: '<synthetic>', stop_reason: 'refusal', stop_details: { category: 'cyber' } },
    })).toEqual({ category: 'cyber' });
  });

  it('not another error reply, and not the model\'s own partial refusal the CLI continues past', () => {
    expect(safeguardStopOfCliLine({ isApiErrorMessage: true, error: 'invalid_request', message: { model: '<synthetic>', stop_reason: 'stop_sequence' } })).toBeNull();
    expect(safeguardStopOfCliLine({ message: { model: 'claude-opus-5-5', stop_reason: 'refusal' } })).toBeNull();
    expect(safeguardStopOfResult({ is_error: true, stop_reason: 'refusal' })).toEqual({});
    expect(safeguardStopOfResult({ is_error: false, stop_reason: 'refusal' })).toBeNull();
    expect(safeguardStopOfResult({ is_error: true, stop_reason: 'end_turn' })).toBeNull();
    expect(safeguardStopOfAcpStopReason('refusal')).toEqual({});
    expect(safeguardStopOfAcpStopReason('end_turn')).toBeNull();
  });
});

describe('the model a refused session moves to', () => {
  it('families from ids, aliases and labels; other vendors and `default` have none', () => {
    expect(modelFamilyOf('global.anthropic.claude-opus-5-5[1m]')).toBe('opus');
    expect(modelFamilyOf('claude-fable-5-2')).toBe('fable');
    expect(modelFamilyOf('sonnet')).toBe('sonnet');
    expect(modelFamilyOf('Haiku 5.5')).toBe('haiku');
    expect(modelFamilyOf('gpt-6-astra')).toBeNull();
    expect(modelFamilyOf('default')).toBeNull();
  });

  it('Opus moves to Fable, Fable to Opus, Sonnet to Opus; never the current family or one tried', () => {
    expect(pickFallbackModel(MENU, { id: 'opus', family: 'opus' }, [])?.row.id).toBe('global.anthropic.claude-fable-5-2[1m]');
    expect(pickFallbackModel(MENU, { id: 'global.anthropic.claude-fable-5-2[1m]', family: 'fable' }, [])?.row.id).toBe('opus');
    expect(pickFallbackModel(MENU, { id: 'sonnet', family: 'sonnet' }, [])?.row.id).toBe('opus');
    expect(pickFallbackModel(MENU, { id: 'global.anthropic.claude-fable-5-2[1m]', family: 'fable' }, ['opus'])?.row.id).toBe('sonnet');
    // Every family tried: no move (Haiku and other vendors are never picked).
    expect(pickFallbackModel(MENU, { id: 'sonnet', family: 'sonnet' }, ['opus', 'fable'])).toBeNull();
    // A 1M session keeps a 1M row where the family has one.
    const wide: ModelRow[] = [{ id: 'opus', resolvedModel: 'claude-opus-5-5' }, { id: 'opus[1m]', resolvedModel: 'claude-opus-5-5' }];
    expect(pickFallbackModel(wide, { id: 'sonnet[1m]', family: 'sonnet' }, [])?.row.id).toBe('opus[1m]');
    expect(pickFallbackModel(wide, { id: 'sonnet', family: 'sonnet' }, [])?.row.id).toBe('opus');
  });

  it('the note names both models and hands back every message word for word, the latest kept first', () => {
    const text = resendNoteText('Opus 5.5', 'Fable', 2, 'reasoning_extraction', [
      { text: 'first ask', sentBy: 'person', at: '2026-11-11T06:02:00Z' },
      { text: 'second ask', sentBy: 'agent', at: '2026-11-11T06:03:00Z' },
    ]);
    expect(text).toContain('from Opus 5.5 to Fable');
    expect(text).toContain('[reasoning_extraction]');
    expect(text.indexOf('first ask')).toBeLessThan(text.indexOf('second ask'));
    expect(text).toContain('from the user');
    expect(resendNoteText('Opus 5.5', 'Fable', 2, undefined, [])).toContain('carry on');
  });
});

// ── The switch itself ───────────────────────────────────────────────────────

const SID = 'sg-switch-session';
let stops: Array<() => void> = [];
afterEach(() => { for (const s of stops) s(); stops = []; resetQuietTurnsForTest(); });

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) { if (done()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${what}`);
};
const pause = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

function harness(opts: { reject?: string[]; fail?: boolean; taskOpen?: boolean; sendFails?: boolean; menu?: ModelRow[] } = {}) {
  let rec = { claudeSessionId: SID, taskId: 't-sg', process_status: 'idle', cliModel: 'opus' } as SessionRecord;
  let current = 'opus';
  const sends: Array<{ text: string; source: string; messageId?: string }> = [];
  const applied: string[] = [];
  const notes: Array<{ message: string; variant: string }> = [];
  const lead: string[] = [];
  const gaveUp: string[] = [];
  let now = Date.parse('2026-11-11T06:00:00Z');
  const deps: Partial<SafeguardSwitchDeps> = {
    now: () => now,
    getSession: async () => rec,
    saveSession: async (_id, updates) => { rec = { ...rec, ...updates }; },
    modelOptions: async () => ({ models: opts.menu ?? MENU, current }),
    applyModel: async (_id, id) => {
      applied.push(id);
      if (opts.fail) return { rejected: true, failed: true };
      if (opts.reject?.includes(id)) return { rejected: true };
      current = id;
      return { rejected: false };
    },
    send: async (_id, text, o) => { if (opts.sendFails) throw new Error('queue refused'); sends.push({ text, source: o.source, messageId: o.messageId }); },
    stopFence: async () => null,
    taskOpen: async () => opts.taskOpen ?? true,
    deleteQueued: async () => true,
    emitNote: (_s, _t, message, variant) => { notes.push({ message, variant }); },
    tellLead: async (_r, line) => { lead.push(line); },
    gaveUp: async (_r, words) => { gaveUp.push(words); },
  };
  const handle = startSafeguardSwitch(deps);
  stops.push(handle.stop);
  let gen = 0;
  const queued = (id: string, text: string, sentBy: 'person' | 'agent' = 'person') => {
    bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID, messageId: id, message: text, rowText: text, sentBy, enqueuedAt: '2026-11-11T06:01:00Z' }, ['*'], { source: 'test' });
    bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: [id] }, ['*'], { source: 'test' });
  };
  const refused = (model?: string) => bus.emit(EventNames.SESSION_RESULT, {
    sessionId: SID, taskId: 't-sg', turnGen: ++gen, result: "API Error: Opus 5.5's safeguards flagged this message", isError: true,
    safeguardStop: { category: 'reasoning_extraction', ...(model ? { model } : {}) },
  }, ['*'], { source: 'session-runner' });
  /** The session took the resend note (the queue's delivery of its row). */
  const tookNote = (i: number) => bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: [sends[i]!.messageId] }, ['*'], { source: 'test' });
  const clean = (opts2: { noGen?: boolean } = {}) => bus.emit(EventNames.SESSION_RESULT, {
    sessionId: SID, taskId: 't-sg', ...(opts2.noGen ? {} : { turnGen: ++gen }), result: 'done', isError: false,
  }, ['*'], { source: 'session-runner' });
  /** An ACP or SDK refusal: no turn number on its result. */
  const refusedNoGen = () => bus.emit(EventNames.SESSION_RESULT, {
    sessionId: SID, taskId: 't-sg', result: 'refused', isError: false, stopReason: 'refusal', safeguardStop: {},
  }, ['*'], { source: 'session-runner' });
  return {
    handle, sends, applied, notes, lead, gaveUp, queued, refused, clean, tookNote, refusedNoGen,
    rec: () => rec, setNow: (ms: number) => { now = ms; }, gen: () => gen,
  };
}

describe('the safeguard switch', () => {
  it('one refusal switches nothing; the second moves Opus to Fable, resends both messages, tells the lead once', async () => {
    const h = harness();
    h.queued('m1', 'Please fix the flag registry');
    h.refused();
    await pause();
    expect(h.applied).toEqual([]);
    expect(h.rec().safeguardSwitch?.streak).toBe(1);
    h.queued('m2', 'continue', 'agent');
    h.refused();
    // Held from the moment the result is read, whatever the switch is doing.
    expect(safeguardSwitchHolds(SID, h.gen())).toBe(true);
    await until(() => h.sends.length === 1, 'the resend');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]']);
    expect(h.sends[0]!.source).toBe('safeguard-switch');
    expect(h.sends[0]!.text).toContain('from Opus 5.5 to Fable');
    expect(h.sends[0]!.text).toContain('Please fix the flag registry');
    expect(h.sends[0]!.text).toContain('continue');
    await until(() => h.lead.length === 1, 'the lead line');
    expect(h.lead[0]).toContain('from Opus 5.5 to Fable');
    expect(h.notes.filter((n) => n.variant === 'info')).toHaveLength(1);
    expect(h.rec().safeguardSwitch).toMatchObject({ streak: 0, tried: ['opus', 'fable'], switches: [{ from: 'Opus 5.5', to: 'Fable', resent: 2 }] });
    // The refused result still reads held until the session's next result.
    expect(safeguardSwitchHolds(SID, h.gen())).toBe(true);
    h.clean();
    expect(safeguardSwitchHolds(SID)).toBe(false);
    expect(h.gaveUp).toEqual([]);
  });

  it('the new model refusing the resend itself moves on at once, and the words stay owed until a clean turn', async () => {
    const h = harness();
    h.queued('m1', 'Please fix the flag registry');
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'first switch');
    h.tookNote(0);
    h.refused();
    await until(() => h.sends.length === 2, 'second switch on one refusal of the resend');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]', 'sonnet']);
    expect(h.sends[1]!.text).toContain('Please fix the flag registry');
    h.tookNote(1);
    h.clean();
    await pause();
    expect(h.rec().safeguardSwitch).toMatchObject({ streak: 0 });
    expect(h.rec().safeguardSwitch?.owed).toBeUndefined();
    expect(h.rec().safeguardSwitch?.tried).toBeUndefined();
  });

  it('a family that refused is never picked again, even when the menu named it current', async () => {
    const h = harness();
    // Both refusals came from Fable although the menu says Opus: Fable is tried, Opus is current.
    h.refused('global.anthropic.claude-fable-5-2'); h.refused('global.anthropic.claude-fable-5-2');
    await until(() => h.sends.length === 1, 'the resend');
    expect(h.applied).toEqual(['sonnet']);
  });

  it('a 1M session moves to a 1M row', async () => {
    const h = harness({ menu: [
      { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      { id: 'opus[1m]', label: 'Opus 5.5 (1M)', resolvedModel: 'claude-opus-5-5[1m]' },
      { id: 'fable', label: 'Fable', resolvedModel: 'claude-fable-5-2' },
      { id: 'fable[1m]', label: 'Fable (1M)', resolvedModel: 'claude-fable-5-2[1m]' },
    ] });
    await h.handle.instance['deps'].saveSession(SID, { modelMaxWindow: 1_000_000 });
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'the resend');
    expect(h.applied).toEqual(['fable[1m]']);
  });

  it('a session whose reported window is 200K moves to the plain row', async () => {
    const h = harness({ menu: [
      { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      { id: 'fable', label: 'Fable', resolvedModel: 'claude-fable-5-2' },
      { id: 'fable[1m]', label: 'Fable (1M)', resolvedModel: 'claude-fable-5-2[1m]' },
    ] });
    await h.handle.instance['deps'].saveSession(SID, { modelMaxWindow: 200_000, contextTokens: 40_000 });
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'the resend');
    expect(h.applied).toEqual(['fable']);
  });

  it('a switch a restart caught runs again with the words the record kept', async () => {
    const sends: string[] = [];
    const rec = {
      claudeSessionId: SID, taskId: 't-sg', process_status: 'idle', cliModel: 'opus',
      safeguardSwitch: { streak: 2, since: '2026-11-11T06:00:00Z', switchingAt: '2026-11-11T06:01:00Z', owed: [{ text: 'the owed ask', at: '2026-11-11T06:00:00Z', sentBy: 'person' }] },
    } as SessionRecord;
    let saved = rec;
    const again = startSafeguardSwitch({
      getSession: async () => saved, saveSession: async (_id, u) => { saved = { ...saved, ...u }; }, now: () => Date.parse('2026-11-11T06:10:00Z'),
      modelOptions: async () => ({ models: MENU, current: 'opus' }), applyModel: async () => ({ rejected: false }),
      send: async (_id, text) => { sends.push(text); }, stopFence: async () => null, taskOpen: async () => true,
      deleteQueued: async () => true, emitNote: () => {}, tellLead: async () => {}, gaveUp: async () => {},
    });
    stops.push(again.stop);
    again.instance.rerunDelayMs = 0;
    await again.instance.rebuild(async () => [rec]);
    await until(() => sends.length === 1, 'the rerun');
    expect(sends[0]).toContain('the owed ask');
    await until(() => !saved.safeguardSwitch?.switchingAt, 'the switch mark cleared');
  });

  it('a restart\'s rerun does nothing when the session worked again before it ran', async () => {
    const sends: string[] = [];
    const applied: string[] = [];
    const rec = {
      claudeSessionId: SID, taskId: 't-sg', process_status: 'idle', cliModel: 'opus',
      safeguardSwitch: { streak: 2, since: '2026-11-11T06:00:00Z', switchingAt: '2026-11-11T06:01:00Z' },
    } as SessionRecord;
    let saved = rec;
    const again = startSafeguardSwitch({
      getSession: async () => saved, saveSession: async (_id, u) => { saved = { ...saved, ...u }; }, now: () => Date.parse('2026-11-11T06:10:00Z'),
      modelOptions: async () => ({ models: MENU, current: 'opus' }), applyModel: async (_s, id) => { applied.push(id); return { rejected: false }; },
      send: async (_id, text) => { sends.push(text); }, stopFence: async () => null, taskOpen: async () => true,
      deleteQueued: async () => true, emitNote: () => {}, tellLead: async () => {}, gaveUp: async () => {},
    });
    stops.push(again.stop);
    again.instance.rerunDelayMs = 30;
    await again.instance.rebuild(async () => [rec]);
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 't-sg', result: 'done', isError: false }, ['*'], { source: 'session-runner' });
    await new Promise((r) => setTimeout(r, 120));
    expect(applied).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('a switch that succeeded drops its restart mark in the same write', async () => {
    const h = harness();
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'the resend');
    await h.handle.instance.settled(SID);
    expect(h.rec().safeguardSwitch?.switches).toHaveLength(1);
    expect(h.rec().safeguardSwitch?.switchingAt).toBeUndefined();
  });

  it('a switch stopped while the host applied the model puts the old model back and says nothing', async () => {
    const h = harness();
    const applied: string[] = [];
    let release: () => void = () => {};
    h.handle.instance['deps'].applyModel = async (_s: string, id: string) => {
      applied.push(id);
      if (applied.length === 1) await new Promise<void>((r) => { release = r; });
      return { rejected: false };
    };
    h.refused(); h.refused();
    await until(() => applied.length === 1, 'the apply');
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: SID }, ['*'], { source: 'test' });
    release();
    await until(() => applied.length === 2, 'the old model back');
    expect(applied[1]).toBe('opus');
    await pause();
    expect(h.sends).toEqual([]);
    expect(h.notes.filter((n) => n.variant === 'info')).toEqual([]);
    expect(h.rec().cliModel).toBe('opus');
  });

  it('an engine with no turn numbers (ACP): the new model\'s answer ends the hold', async () => {
    const h = harness();
    h.refusedNoGen(); h.refusedNoGen();
    expect(safeguardSwitchHolds(SID)).toBe(true);
    await until(() => h.lead.length === 1, 'the switch');
    expect(safeguardSwitchHolds(SID)).toBe(true);
    h.clean({ noGen: true });
    expect(safeguardSwitchHolds(SID)).toBe(false);
  });

  it('a host Walnut cannot reach blames no model: the error is the user\'s, and the next refusal tries again', async () => {
    const h = harness({ fail: true });
    h.refused(); h.refused();
    await until(() => h.gaveUp.length === 1, 'the hand-back');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]']);
    expect(h.rec().cliModel).toBe('opus');
    expect(h.rec().safeguardSwitch?.tried ?? []).not.toContain('fable');
    expect(safeguardSwitchHolds(SID, h.gen())).toBe(false);
    h.refused();
    await until(() => h.applied.length === 2, 'tried again');
  });

  it('a Stop after the switch, with its note still queued, lets the refused turn go', async () => {
    const h = harness();
    h.refused(); h.refused();
    await until(() => h.lead.length === 1, 'the switch');
    expect(safeguardSwitchHolds(SID)).toBe(true);
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: SID }, ['*'], { source: 'test' });
    expect(safeguardSwitchHolds(SID)).toBe(false);
  });

  it('a clean turn between two refusals starts the count again', async () => {
    const h = harness();
    h.refused();
    h.clean();
    h.refused();
    await pause();
    expect(h.applied).toEqual([]);
    expect(h.handle.instance.streakOf(SID)).toBe(1);
  });

  it('the new model refused twice moves on to the next family; with none left the error is the user\'s', async () => {
    const h = harness();
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'first switch');
    h.refused(); h.refused();
    await until(() => h.sends.length === 2, 'second switch');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]', 'sonnet']);
    h.refused(); h.refused();
    await until(() => h.gaveUp.length === 1, 'the give-up');
    expect(h.sends).toHaveLength(2);
    expect(h.gaveUp[0]).toContain('no other model');
    expect(h.notes.some((n) => n.variant === 'error')).toBe(true);
    // Given up: more refusals do not try again until the session works.
    h.refused(); h.refused();
    await pause();
    expect(h.gaveUp).toHaveLength(1);
  });

  it('a model the CLI refuses is skipped for the next family', async () => {
    const h = harness({ reject: ['global.anthropic.claude-fable-5-2[1m]'] });
    h.refused(); h.refused();
    await until(() => h.sends.length === 1, 'the resend');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]', 'sonnet']);
    expect(h.sends[0]!.text).toContain('to Sonnet 5.5');
  });

  it('nothing is switched for a completed task, and the held turn is not raised as an error', async () => {
    const h = harness({ taskOpen: false });
    h.refused(); h.refused();
    await pause();
    expect(h.applied).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.gaveUp).toEqual([]);
    // Let go at once: nothing holds the refused turn any more.
    expect(safeguardSwitchHolds(SID, h.gen())).toBe(false);
  });

  it('a Stop during the switch sends nothing', async () => {
    const h = harness();
    h.refused(); h.refused();
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: SID }, ['*'], { source: 'test' });
    await pause();
    expect(h.sends).toEqual([]);
  });

  it('a menu with no other family hands the error to the user at once', async () => {
    const h = harness({ menu: [{ id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' }] });
    h.refused(); h.refused();
    await until(() => h.gaveUp.length === 1, 'the give-up');
    expect(h.applied).toEqual([]);
    // The error edge tells the lead; the give-up itself does not.
    expect(h.lead).toEqual([]);
    expect(safeguardSwitchHolds(SID, h.gen())).toBe(false);
  });

  it('every model the CLI refuses: the record keeps the model it had, and the error is the user\'s', async () => {
    const h = harness({ reject: ['global.anthropic.claude-fable-5-2[1m]', 'sonnet'] });
    h.refused(); h.refused();
    await until(() => h.gaveUp.length === 1, 'the give-up');
    expect(h.applied).toEqual(['global.anthropic.claude-fable-5-2[1m]', 'sonnet']);
    expect(h.rec().cliModel).toBe('opus');
    expect(h.sends).toEqual([]);
  });

  it('a quiet turn (Walnut\'s own compaction) does not count', async () => {
    const h = harness();
    beginQuietTurn(SID, 'idle-compact', 'idle-compact', Date.now());
    h.refused(); h.refused();
    await pause();
    expect(h.handle.instance.streakOf(SID)).toBe(0);
  });

  it(`at most ${MAX_SWITCHES_PER_DAY} switches a day`, async () => {
    const h = harness();
    const at = '2026-11-11T05:00:00Z';
    await h.handle.instance['deps'].saveSession(SID, {
      safeguardSwitch: { streak: 0, switches: Array.from({ length: MAX_SWITCHES_PER_DAY }, () => ({ at, from: 'a', to: 'b', toId: 'b', resent: 0 })) },
    });
    h.refused(); h.refused();
    await until(() => h.gaveUp.length === 1, 'the give-up');
    expect(h.applied).toEqual([]);
  });

  it('the streak a record holds counts on after a restart', async () => {
    const h = harness();
    h.handle.stop();
    stops = [];
    const rec = { ...h.rec(), safeguardSwitch: { streak: 1, since: '2026-11-11T06:00:00Z' } } as SessionRecord;
    const sends: string[] = [];
    const again = startSafeguardSwitch({
      getSession: async () => rec, saveSession: async () => {}, now: () => Date.parse('2026-11-11T06:10:00Z'),
      modelOptions: async () => ({ models: MENU, current: 'opus' }), applyModel: async () => ({ rejected: false }),
      send: async (_id, text) => { sends.push(text); }, stopFence: async () => null, taskOpen: async () => true,
      deleteQueued: async () => true, emitNote: () => {}, tellLead: async () => {}, gaveUp: async () => {},
    });
    stops.push(again.stop);
    await again.instance.rebuild(async () => [rec]);
    h.refused();
    await until(() => sends.length === 1, 'the resend after a restart');
  });
});
