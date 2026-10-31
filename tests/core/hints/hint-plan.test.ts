/**
 * The hint registry, schedule and plan, driven send by send against a simulated
 * session record: which hints each message carries.
 */
import { describe, expect, it } from 'vitest';
import type { Config, SessionHintState, SessionOutputMode } from '../../../src/core/types.js';
import { effectiveHints, validateHintSettings, HintSettingsError } from '../../../src/core/hints/hint-registry.js';
import { dueReasons } from '../../../src/core/hints/hint-schedule.js';
import {
  advanceHintState, hintStateAtBoundary, hintTargetOf, hostReplyTail, planHints, type RequestedHints,
} from '../../../src/core/hints/hint-send.js';

type Rec = { claudeSessionId: string; output_mode?: SessionOutputMode; output_mode_injected?: SessionOutputMode; hintState?: SessionHintState; lastCompactUuid?: string; lastCompactAt?: string };

function cfg(session: NonNullable<Config['session']> = {}): Pick<Config, 'session'> {
  return { session } as Pick<Config, 'session'>;
}

/** Send `n` messages through the plan and the state advance, the way prepareHintedSend + commit do. */
function run(rec: Rec, config: Pick<Config, 'session'>, n: number, opts: { requested?: (i: number) => RequestedHints | undefined; target?: ReturnType<typeof hintTargetOf> } = {}) {
  const out: string[][] = [];
  let t = Date.parse('2026-11-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const plan = planHints({
      hints: effectiveHints(config), target: opts.target ?? { sessionId: rec.claudeSessionId }, record: rec, config,
      ...(opts.requested?.(i) ? { requested: opts.requested(i)! } : {}),
    });
    out.push(plan.carried.map((h) => (h.kind === 'rich-output' ? (h.text.includes('still on') ? 'rich-reminder' : h.text.includes('is off') ? 'rich-off' : 'rich-full') : h.kind)));
    rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: (t += 1000), sentBy: 'person' });
  }
  return out;
}

describe('default schedule', () => {
  it('rich: full at start, reminder every 5 messages; language once at start', () => {
    const rec: Rec = { claudeSessionId: 's1' };
    const sent = run(rec, cfg({ output_mode: 'rich', reply_language: 'Talk to the user in Chinese.' }), 11);
    expect(sent[0]).toEqual(['rich-full', 'reply-language']);
    expect(sent.slice(1, 5)).toEqual([[], [], [], []]);
    expect(sent[5]).toEqual(['rich-reminder']);
    expect(sent.slice(6, 10)).toEqual([[], [], [], []]);
    expect(sent[10]).toEqual(['rich-reminder']);
  });

  it('markdown session pays nothing; switching to rich sends the full text once, back sends OFF once', () => {
    const rec: Rec = { claudeSessionId: 's2', output_mode: 'markdown' };
    const config = cfg({});
    expect(run(rec, config, 3)).toEqual([[], [], []]);
    rec.output_mode = 'rich';
    expect(run(rec, config, 2)).toEqual([['rich-full'], []]);
    rec.output_mode = 'markdown';
    expect(run(rec, config, 2)).toEqual([['rich-off'], []]);
  });

  it('a compaction brings the full rich text and the language back once', () => {
    const rec: Rec = { claudeSessionId: 's3' };
    const config = cfg({ reply_language: 'Answer in Chinese.' });
    run(rec, config, 2);
    rec.lastCompactUuid = 'c1';
    expect(run(rec, config, 2)).toEqual([['rich-full', 'reply-language'], []]);
  });

  it('editing the language sends it again (on_change), clearing it sends nothing', () => {
    const rec: Rec = { claudeSessionId: 's4', output_mode: 'markdown' };
    run(rec, cfg({ reply_language: 'Answer in Chinese.' }), 1);
    expect(run(rec, cfg({ reply_language: 'Answer in Japanese.' }), 2)).toEqual([['reply-language'], []]);
    expect(run(rec, cfg({}), 1)).toEqual([[]]);
  });

  it('a drift mark sends the language on the next message only', () => {
    const rec: Rec = { claudeSessionId: 's5', output_mode: 'markdown' };
    const config = cfg({ reply_language: 'Answer in Chinese.' });
    run(rec, config, 2);
    rec.hintState = { ...rec.hintState!, drift: { 'reply-language': '2026-11-06T00:00:00Z' } };
    expect(run(rec, config, 2)).toEqual([['reply-language'], []]);
    expect(rec.hintState?.drift).toBeUndefined();
  });

  it('question and voice go only when asked, question before the text', () => {
    const rec: Rec = { claudeSessionId: 's6', output_mode: 'markdown' };
    const sent = run(rec, cfg({}), 3, { requested: (i) => (i === 1 ? { question: { arg: '7' }, 'voice-reply': {} } : undefined) });
    expect(sent).toEqual([[], ['question', 'voice-reply'], []]);
    const plan = planHints({ hints: effectiveHints(cfg({})), target: { sessionId: 's6' }, record: rec, config: cfg({}), requested: { question: { arg: '7' } } });
    expect(plan.before).toHaveLength(1);
    expect(plan.before[0]).toContain('Walnut (question 7): this message is question 7');
  });

  it('a session told rich before the registry is not told again', () => {
    const rec: Rec = { claudeSessionId: 's7', output_mode_injected: 'rich' };
    expect(run(rec, cfg({}), 5)[0]).toEqual([]);
  });
});

describe('user and agent settings', () => {
  it('every_turns and triggers override the default', () => {
    const rec: Rec = { claudeSessionId: 's8' };
    const config = cfg({ hints: { 'rich-output': { every_turns: 2 }, 'reply-language': { triggers: ['every_turn'] } }, reply_language: 'Chinese.' });
    const sent = run(rec, config, 5);
    expect(sent).toEqual([['rich-full', 'reply-language'], ['reply-language'], ['rich-reminder', 'reply-language'], ['reply-language'], ['rich-reminder', 'reply-language']]);
  });

  it('disabled hints are not sent', () => {
    const rec: Rec = { claudeSessionId: 's9' };
    expect(run(rec, cfg({ hints: { 'rich-output': { enabled: false } } }), 2)).toEqual([[], []]);
  });

  it('a custom hint is one config entry: sent at start and after an edit', () => {
    const rec: Rec = { claudeSessionId: 's10', output_mode: 'markdown' };
    expect(run(rec, cfg({ hints: { tone: { text: 'Be brief.' } } }), 2)).toEqual([['tone'], []]);
    expect(run(rec, cfg({ hints: { tone: { text: 'Be very brief.' } } }), 1)).toEqual([['tone']]);
  });

  it('audience by role and by session', () => {
    const config = cfg({ hints: { tone: { text: 'Hi.', audience: { roles: ['main'] } }, other: { text: 'Yo.', audience: { sessions: ['sX'] } } } });
    const main = run({ claudeSessionId: 'm', output_mode: 'markdown' }, config, 1, { target: { sessionId: 'm', role: 'main' } });
    const worker = run({ claudeSessionId: 'w', output_mode: 'markdown' }, config, 1, { target: { sessionId: 'w', role: 'worker' } });
    const sx = run({ claudeSessionId: 'sX', output_mode: 'markdown' }, config, 1, { target: { sessionId: 'sX' } });
    expect(main).toEqual([['tone']]);
    expect(worker).toEqual([[]]);
    expect(sx).toEqual([['other']]);
  });

  it('Main and the leads hear the reply language on every turn, the user\'s own included', () => {
    // 2026-10-29: leads answered Walnut notices in English in the chats the user reads.
    // 2026-10-30: the user typed English into a lead's chat, no hint rode it, and the lead answered in English.
    const config = cfg({ reply_language: 'Talk to the user in Chinese.' });
    const plan = (role: 'main' | 'lead' | 'worker', rec: Rec, sentBy?: 'person' | 'agent') => {
      const p = planHints({ hints: effectiveHints(config), target: { sessionId: rec.claudeSessionId, role }, record: rec, config, ...(sentBy ? { sentBy } : {}) });
      rec.hintState = advanceHintState(rec.hintState, rec, p.told, { now: Date.now(), ...(sentBy ? { sentBy } : {}) });
      return p.carried.map((h) => h.kind);
    };
    for (const role of ['main', 'lead'] as const) {
      const rec: Rec = { claudeSessionId: `org-${role}`, output_mode: 'markdown' };
      expect(plan(role, rec, 'person')).toEqual(['reply-language']);
      expect(plan(role, rec, 'person')).toEqual(['reply-language']);
      expect(plan(role, rec, 'person')).toEqual(['reply-language']);
      expect(plan(role, rec, 'agent')).toEqual(['reply-language']);
      expect(plan(role, rec, 'agent')).toEqual(['reply-language']);
      // A host's peer note says nobody wrote it: not a person.
      expect(plan(role, rec)).toEqual(['reply-language']);
    }
    const worker: Rec = { claudeSessionId: 'w-1', output_mode: 'markdown' };
    plan('worker', worker, 'agent');
    expect(plan('worker', worker, 'agent')).toEqual([]);
    // Set triggers decide alone; the host tail carries it for a lead.
    const set = cfg({ reply_language: 'Talk to the user in Chinese.', hints: { 'reply-language': { triggers: ['session_start'] } } });
    const lead: Rec = { claudeSessionId: 'l-2', output_mode: 'markdown' };
    planHints({ hints: effectiveHints(set), target: { sessionId: 'l-2', role: 'lead' }, record: lead, config: set, sentBy: 'agent' });
    lead.hintState = { sends: 1, told: { 'reply-language': { send: 1, hash: 'Talk to the user in Chinese.', at: '2026-11-01T00:00:00Z' } } };
    expect(planHints({ hints: effectiveHints(set), target: { sessionId: 'l-2', role: 'lead' }, record: lead, config: set, sentBy: 'agent' }).carried).toEqual([]);
    expect(hostReplyTail({ ...lead }, config, { org_role: 'lead' } as never)).toContain('Walnut (reply-language)');
    expect(hostReplyTail({ ...lead }, config, { parent_task_id: 'p' } as never)).toBeNull();
  });

  it('roles come from the task', () => {
    expect(hintTargetOf('a', { org_role: 'main' } as never).role).toBe('main');
    expect(hintTargetOf('a', { org_role: 'lead' } as never).role).toBe('lead');
    expect(hintTargetOf('a', { walnut_agent: true } as never).role).toBe('ask');
    expect(hintTargetOf('a', { parent_task_id: 'p' } as never).role).toBe('worker');
    expect(hintTargetOf('a', {} as never).role).toBe('other');
    expect(hintTargetOf('a', null).role).toBeUndefined();
  });

  it('validation refuses what cannot work', () => {
    expect(() => validateHintSettings('question', { triggers: ['every_turn'] })).toThrow(HintSettingsError);
    expect(() => validateHintSettings('rich-output', { text: 'x' })).toThrow(HintSettingsError);
    expect(() => validateHintSettings('new-one', { enabled: true })).toThrow(/needs its text/);
    expect(() => validateHintSettings('rich-output', { every_turns: 0 })).toThrow(HintSettingsError);
    expect(() => validateHintSettings('Bad', {})).toThrow(HintSettingsError);
    expect(validateHintSettings('rich-output', { every_turns: 3, placement: 'before', junk: 1 })).toEqual({ every_turns: 3, placement: 'before' });
  });
});

describe('schedule details', () => {
  it('every_n_turns counts from the last time it went out', () => {
    const told = { send: 3, hash: 'rich', at: '2026-11-01T00:00:00Z' };
    expect(dueReasons({ triggers: ['every_n_turns'], everyTurns: 5, told, send: 7, identity: 'rich', requested: false })).toEqual([]);
    expect(dueReasons({ triggers: ['every_n_turns'], everyTurns: 5, told, send: 8, identity: 'rich', requested: false })).toEqual(['every_n_turns']);
  });

  it('a drift older than the last telling does not count', () => {
    const told = { send: 3, hash: 'x', at: '2026-11-02T00:00:00Z' };
    expect(dueReasons({ triggers: ['on_drift'], told, send: 4, identity: 'x', driftAt: '2026-11-01T00:00:00Z', requested: false })).toEqual([]);
  });
});

describe('compaction hook and host tail', () => {
  it('the hook states every after-compaction hint and the boundary read later counts it told', () => {
    const rec: Rec = { claudeSessionId: 's11', lastCompactUuid: 'c0' };
    const config = cfg({ reply_language: 'Chinese.' });
    run(rec, config, 1);
    const plan = planHints({ hints: effectiveHints(config), target: { sessionId: 's11' }, record: rec, config, afterCompaction: true });
    expect(plan.carried.map((h) => h.kind)).toEqual(['rich-output', 'reply-language']);
    expect(plan.carried[0].text).toContain('rich output mode is on');
    const at = Date.parse('2026-11-07T00:00:00Z');
    rec.hintState = advanceHintState(rec.hintState, rec, plan.told, { now: at, byHook: true, count: false });
    // The server reads boundary c1 right after: the hook answered it.
    const moved = hintStateAtBoundary(rec.hintState, 'c1', (ms) => ms === at);
    expect(moved?.told['rich-output'].compact).toBe('c1');
    rec.hintState = moved;
    // notePlaceCompaction writes both, in the same guarded write.
    rec.lastCompactUuid = 'c1';
    rec.lastCompactAt = new Date(at + 2000).toISOString();
    expect(run(rec, config, 1)).toEqual([[]]);
  });

  it('the host tail is empty by default and carries an owed hint', () => {
    const rec: Rec = { claudeSessionId: 's12', output_mode: 'markdown' };
    const config = cfg({ reply_language: 'Chinese.' });
    run(rec, config, 1);
    expect(hostReplyTail(rec, config)).toBeNull();
    rec.hintState = { ...rec.hintState!, drift: { 'reply-language': '2026-12-01T00:00:00Z' } };
    // A reply that drifted is named first (reply-language-correction.test.ts).
    expect(hostReplyTail(rec, config)).toContain('Walnut (reply-language): Correction: your last reply the user read');
    expect(hostReplyTail(rec, config)).toContain('in English. Chinese.');
    expect(hostReplyTail(rec, cfg({ reply_language: 'Chinese.', hints: { tone: { text: 'Hi.', triggers: ['every_turn'] } } }))).toContain('Walnut (tone): Hi.');
  });
});

describe('a hand-edited config.yaml', () => {
  it('a malformed session.hints never throws; bad fields fall back to the defaults', () => {
    const bad = {
      session: {
        hints: {
          'rich-output': { triggers: 'every_turn', every_turns: 'x', placement: 'middle', audience: { roles: 'main' } },
          'reply-language': null,
          'my-note': { text: 42 },
          'ok-note': { text: 'Fine.', audience: 'everyone', triggers: ['every_turn', 7] },
        },
      },
    } as unknown as Pick<Config, 'session'>;
    const hints = effectiveHints(bad);
    const rich = hints.find((h) => h.kind === 'rich-output')!;
    expect(rich.triggers).toEqual([]);
    expect(rich.everyTurns).toBe(5);
    expect(rich.placement).toBe('after');
    expect(rich.audience.roles).toEqual([]);
    expect(hints.find((h) => h.kind === 'reply-language')?.overridden).toBe(false);
    expect(hints.find((h) => h.kind === 'my-note')).toBeUndefined();
    const ok = hints.find((h) => h.kind === 'ok-note')!;
    expect(ok.triggers).toEqual(['every_turn']);
    expect(ok.audience).toEqual({ roles: [], agents: [], sessions: [] });
    expect(() => effectiveHints({ session: { hints: 'nope' } } as unknown as Pick<Config, 'session'>)).not.toThrow();
  });
});
