/**
 * Inbox Triage's per-run letter budget (S15).
 *
 * The rule: ONE summary letter plus THREE `action_required` decisions per run, and
 * a run IS a session (every triage run mints a new task + a new session), so the
 * window resets by construction. What this file pins:
 *
 *  - the counts, and that the 4th decision is refused with a sentence that tells
 *    the model the next move ("fold the rest into the summary"), never a silent drop;
 *  - that the next run starts fresh;
 *  - that an `action_required` letter with no buttons is refused with the button
 *    vocabulary in the message;
 *  - that a letter the store REJECTS does not burn a slot (the commit is what counts);
 *  - that no other agent is touched — a sender with no task, an unstamped task, a
 *    plugin's `external` sender: no tally, no refusal, nothing;
 *  - that `assist` differs from `ask` only in what a run may do on its own, and that
 *    the budget and the "nothing leaves the machine without an approval" rule are
 *    identical in both.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-quota'));

/** The store behind the DEFAULT lookup (no `isTriageTask` injected). */
const getTask = vi.fn();
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  getTask,
}));

import {
  TRIAGE_DECISION_LETTERS_PER_RUN,
  TRIAGE_SUMMARY_LETTERS_PER_RUN,
  _resetTriageLetterQuotaForTesting,
  forgetTriageRun,
  guardTriageLetter,
  triageLetterKind,
  triageLetterTally,
  triageQuotaVerdict,
} from '../../src/core/human-inbox/triage-quota.js';
import {
  TRIAGE_APPROVAL_OPS,
  triageLetterBudgetText,
  triageModeText,
  triageRunRules,
} from '../../src/core/triage/letter-rules.js';
import type { TriageLetterDeps } from '../../src/core/human-inbox/triage-quota.js';
import type { LetterSender } from '../../src/core/human-inbox/types.js';

const TRIAGE_TASK = 'task-triage-run-1';
const OTHER_TASK = 'task-ordinary-dev-work';

/** The sender the route stamps for a triage run's session. */
function triageSender(sessionId: string, taskId = TRIAGE_TASK): LetterSender {
  return {
    sessionId,
    host: 'local',
    taskId,
    taskTitle: 'Triage · 14:10 · 16 items',
    project: 'Ask Inbox Triage',
  };
}

/** Only a triage run's task is stamped; everything else is somebody else's work. */
const stampedTriage = async (taskId: string): Promise<boolean> => taskId.startsWith('task-triage-run');
const isTriageTask = vi.fn(stampedTriage);

function summary(): { type: string } {
  return { type: 'review' };
}

function decision(): { type: string; actions: Array<{ id: string; label: string }> } {
  return { type: 'action_required', actions: [{ id: 'make-task', label: 'Make a task' }] };
}

/** Send one letter through the guard and commit it, as the route does. */
async function send(
  sender: LetterSender,
  input: Record<string, unknown>,
  letterId = `lt-${Math.random().toString(36).slice(2, 8)}`,
  deps: TriageLetterDeps = { isTriageTask },
): Promise<{ letterId: string }> {
  const charge = await guardTriageLetter(input, sender, deps);
  charge?.commit(letterId);
  return { letterId };
}

async function refusal(
  sender: LetterSender,
  input: Record<string, unknown>,
  deps: TriageLetterDeps = { isTriageTask },
): Promise<string> {
  try {
    await send(sender, input, undefined, deps);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the guard to refuse this letter');
}

beforeEach(() => {
  _resetTriageLetterQuotaForTesting();
  getTask.mockReset();
  // mockReset, not mockClear: one case below swaps the implementation, and a
  // leaked "everything is triage" stub would quietly make the next case vacuous.
  isTriageTask.mockReset();
  isTriageTask.mockImplementation(stampedTriage);
});

describe('the run that processed 16 items sends exactly one summary', () => {
  it('allows the first summary and refuses the second, pointing at the first', async () => {
    const sender = triageSender('sess-run-16-items');
    const first = await send(sender, summary(), 'lt-summary-0001');
    expect(triageLetterTally(sender.sessionId)).toEqual({
      summary: 1, decision: 0, summaryLetterId: 'lt-summary-0001',
    });

    const message = await refusal(sender, summary());
    expect(message).toContain('ONE summary letter per run');
    expect(message).toContain(first.letterId);
    expect(message).toContain('human_inbox_reply');
    // Still one: a refused letter must not be counted.
    expect(triageLetterTally(sender.sessionId).summary).toBe(TRIAGE_SUMMARY_LETTERS_PER_RUN);
  });

  it('counts completion and info as the summary too — the budget is documents, not type names', async () => {
    const sender = triageSender('sess-run-type-hole');
    await send(sender, { type: 'info' });
    expect(triageLetterKind('completion')).toBe('summary');
    const message = await refusal(sender, { type: 'completion' });
    expect(message).toContain('ONE summary letter per run');
  });
});

describe('seven decision-worthy items become three letters', () => {
  it('allows three and refuses the fourth with the fold-into-the-summary sentence', async () => {
    const sender = triageSender('sess-run-7-pending');
    await send(sender, summary(), 'lt-summary-0007');
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) {
      await send(sender, decision(), `lt-decision-000${i}`);
    }
    expect(triageLetterTally(sender.sessionId)).toEqual({
      summary: 1, decision: 3, summaryLetterId: 'lt-summary-0007',
    });

    const message = await refusal(sender, decision());
    expect(message).toContain('at most 3 decision letters');
    expect(message).toContain('fold the rest into the summary letter');
    expect(message).toContain('Do not retry');
    // It names the thread to continue, so the model has one concrete next call.
    expect(message).toContain('human_inbox_reply {"letter":"lt-summary-0007"}');
    expect(triageLetterTally(sender.sessionId).decision).toBe(TRIAGE_DECISION_LETTERS_PER_RUN);
  });

  it('tells a run that has not sent its summary yet to send it once, at the end', async () => {
    const sender = triageSender('sess-run-decisions-first');
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) await send(sender, decision());
    const message = await refusal(sender, decision());
    expect(message).toContain('Send the summary letter (type=review) once, at the end');
    // The summary itself is still available — the decision wall is not a full stop.
    await expect(send(sender, summary())).resolves.toBeTruthy();
  });
});

describe('the next run starts fresh', () => {
  it('a new session id has the full budget again', async () => {
    const first = triageSender('sess-run-a');
    await send(first, summary());
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) await send(first, decision());
    await refusal(first, decision());

    // A run is a new task AND a new session; the window is keyed on the session.
    const second = triageSender('sess-run-b', 'task-triage-run-2');
    expect(triageLetterTally(second.sessionId)).toEqual({ summary: 0, decision: 0 });
    await expect(send(second, summary())).resolves.toBeTruthy();
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) {
      await expect(send(second, decision())).resolves.toBeTruthy();
    }
    // The earlier run's wall is untouched by the new run's spending.
    await refusal(first, decision());
  });

  it('forgetTriageRun drops a finished run without affecting another', async () => {
    const a = triageSender('sess-forget-a');
    const b = triageSender('sess-forget-b');
    await send(a, summary());
    await send(b, summary());
    forgetTriageRun(a.sessionId);
    expect(triageLetterTally(a.sessionId)).toEqual({ summary: 0, decision: 0 });
    expect(triageLetterTally(b.sessionId).summary).toBe(1);
  });
});

describe('a decision letter with no buttons', () => {
  it('is refused with the vocabulary the run can use', async () => {
    const sender = triageSender('sess-run-no-buttons');
    const message = await refusal(sender, { type: 'action_required' });
    expect(message).toContain('needs at least one button in `actions`');
    expect(message).toContain('Make a task');
    expect(message).toContain('Reply for me');
    expect(message).toContain('review');
    // And it did not consume a decision slot.
    expect(triageLetterTally(sender.sessionId).decision).toBe(0);
  });

  it('an empty actions array is the same refusal', async () => {
    const sender = triageSender('sess-run-empty-buttons');
    const message = await refusal(sender, { type: 'action_required', actions: [] });
    expect(message).toContain('needs at least one button in `actions`');
  });
});

describe('only triage letters are counted', () => {
  it('a sender whose task is not stamped triage gets no guard at all', async () => {
    const sender: LetterSender = { sessionId: 'sess-dev-work', host: 'local', taskId: OTHER_TASK };
    for (let i = 0; i < 8; i++) {
      expect(await guardTriageLetter(decision(), sender, { isTriageTask })).toBeUndefined();
    }
    expect(triageLetterTally(sender.sessionId)).toEqual({ summary: 0, decision: 0 });
  });

  it('a sender with a triage task but no session id is not budgeted', async () => {
    const sender: LetterSender = { sessionId: '', host: 'local', taskId: TRIAGE_TASK };
    expect(await guardTriageLetter(decision(), sender, { isTriageTask })).toBeUndefined();
  });

  it('a plugin letter (external sender, no task) is never looked up', async () => {
    const sender: LetterSender = { sessionId: 'external', host: 'local', pluginId: 'mail' };
    expect(await guardTriageLetter(decision(), sender, { isTriageTask })).toBeUndefined();
    expect(isTriageTask).not.toHaveBeenCalled();
  });

  it('a task lookup that throws loses the backstop rather than refusing the letter', async () => {
    const sender = triageSender('sess-store-hiccup', 'task-unreadable');
    const boom = vi.fn(async () => { throw new Error('sqlite is busy'); });
    for (let i = 0; i < 6; i++) {
      expect(await guardTriageLetter(decision(), sender, { isTriageTask: boom })).toBeUndefined();
    }
    // Asked EVERY time: a failed read is not an answer, so there is nothing to
    // cache. Paying the read again per letter is the price of not remembering a
    // wrong verdict — see the next describe block for why.
    expect(boom).toHaveBeenCalledTimes(6);
  });
});

describe('a failed sender lookup is not remembered', () => {
  it('a real answer IS cached — one lookup per run, not one per letter', async () => {
    const sender = triageSender('sess-cache-hit');
    await send(sender, summary());
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) await send(sender, decision());
    await refusal(sender, decision());
    expect(isTriageTask).toHaveBeenCalledTimes(1);
  });

  it('a lookup that throws and then succeeds ends up enforcing the budget', async () => {
    const sender = triageSender('sess-store-flaky', 'task-triage-run-flaky');
    let calls = 0;
    const flaky = vi.fn(async (taskId: string) => {
      calls += 1;
      if (calls <= 2) throw new Error('sqlite is busy');
      return taskId.startsWith('task-triage-run');
    });
    // The two letters in hand go through — refusing one the human is waiting for
    // is worse than losing the backstop for it.
    for (let i = 0; i < 2; i++) {
      expect(await guardTriageLetter(decision(), sender, { isTriageTask: flaky })).toBeUndefined();
    }
    // Nothing was remembered, so the next letter asks again, gets a real answer,
    // and the run is budgeted from there on.
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) {
      await send(sender, decision(), `lt-flaky-000${i}`, { isTriageTask: flaky });
    }
    const message = await refusal(sender, decision(), { isTriageTask: flaky });
    expect(message).toContain('at most 3 decision letters');
    // Two failures, then ONE real answer that is cached for the rest of the run.
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('a lookup that TIMES OUT and then succeeds ends up enforcing the budget', async () => {
    vi.useFakeTimers();
    try {
      const sender = triageSender('sess-store-slow', 'task-triage-run-slow');
      let calls = 0;
      const slowThenFast = vi.fn(async (taskId: string) => {
        calls += 1;
        // The first read never comes back; the guard's 2s race gives up on it.
        if (calls === 1) return await new Promise<boolean>(() => {});
        return taskId.startsWith('task-triage-run');
      });
      const inFlight = guardTriageLetter(decision(), sender, { isTriageTask: slowThenFast });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await inFlight).toBeUndefined();

      // The timeout must NOT have switched the budget off for the whole run.
      for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) {
        const charge = await guardTriageLetter(decision(), sender, { isTriageTask: slowThenFast });
        expect(charge, `decision ${i}`).toBeTruthy();
        charge?.commit(`lt-slow-000${i}`);
      }
      await expect(guardTriageLetter(decision(), sender, { isTriageTask: slowThenFast }))
        .rejects.toThrow(/at most 3 decision letters/);
      // One timed-out read plus one real answer; only the real one is cached.
      expect(slowThenFast).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the DEFAULT lookup lets a store failure throw, so it is not cached either', async () => {
    // The production path (no isTriageTask injected). It reads the task itself
    // rather than going through stampedAgentId, which folds every failure into
    // `undefined` — indistinguishable from the real answer "not triage".
    const sender = triageSender('sess-default-path', 'task-triage-run-default');
    getTask.mockRejectedValue(new Error('tasks.json is locked'));
    expect(await guardTriageLetter(decision(), sender)).toBeUndefined();
    expect(await guardTriageLetter(decision(), sender)).toBeUndefined();
    expect(getTask).toHaveBeenCalledTimes(2);

    getTask.mockResolvedValue({ id: sender.taskId, agent_id: 'triage' });
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) {
      const charge = await guardTriageLetter(decision(), sender);
      expect(charge, `decision ${i}`).toBeTruthy();
      charge?.commit(`lt-default-000${i}`);
    }
    await expect(guardTriageLetter(decision(), sender))
      .rejects.toThrow(/at most 3 decision letters/);
  });

  it('the DEFAULT lookup calls a task that is not triage exactly what it is', async () => {
    const sender = triageSender('sess-default-other', 'task-ordinary-1');
    getTask.mockResolvedValue({ id: sender.taskId, agent_id: 'walnut' });
    for (let i = 0; i < 5; i++) {
      expect(await guardTriageLetter(decision(), sender)).toBeUndefined();
    }
    // A real answer, so it IS remembered: one read for the whole session.
    expect(getTask).toHaveBeenCalledTimes(1);
  });
});

describe('the slot is reserved, then committed or released', () => {
  it('a letter the store rejects gives its slot back', async () => {
    const sender = triageSender('sess-run-store-reject');
    // The route's shape: guard, then sendLetter, then commit — and release() on a
    // throw from sendLetter (an oversize body, a duplicate action id).
    for (let i = 0; i < 5; i++) {
      const charge = await guardTriageLetter(decision(), sender, { isTriageTask });
      expect(charge?.commit).toBeTypeOf('function');
      charge?.release();
    }
    expect(triageLetterTally(sender.sessionId).decision).toBe(0);
    for (let i = 0; i < TRIAGE_DECISION_LETTERS_PER_RUN; i++) await send(sender, decision());
    await refusal(sender, decision());
  });

  it('two parallel sends cannot both spend the last slot', async () => {
    const sender = triageSender('sess-run-parallel');
    await send(sender, decision());
    await send(sender, decision());
    // A model can issue parallel tool calls; the budget is taken at the CHECK, so
    // the second of two concurrent sends sees the first one's reservation.
    const both = await Promise.allSettled([
      guardTriageLetter(decision(), sender, { isTriageTask }),
      guardTriageLetter(decision(), sender, { isTriageTask }),
    ]);
    const allowed = both.filter((r) => r.status === 'fulfilled');
    const refused = both.filter((r) => r.status === 'rejected');
    expect(allowed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(triageLetterTally(sender.sessionId).decision).toBe(TRIAGE_DECISION_LETTERS_PER_RUN);
  });

  it('a released summary slot does not leave a letter id behind for the refusal to name', async () => {
    const sender = triageSender('sess-run-summary-release');
    const charge = await guardTriageLetter(summary(), sender, { isTriageTask });
    charge?.release();
    expect(triageLetterTally(sender.sessionId).summaryLetterId).toBeUndefined();
    await send(sender, summary(), 'lt-real-summary');
    expect(triageLetterTally(sender.sessionId).summaryLetterId).toBe('lt-real-summary');
  });
});

describe('triageQuotaVerdict is pure', () => {
  it('answers without any state, so the wording is gradable', () => {
    expect(triageQuotaVerdict({ summary: 0, decision: 0 }, summary())).toEqual({
      allowed: true, kind: 'summary',
    });
    expect(triageQuotaVerdict({ summary: 0, decision: 2 }, decision())).toEqual({
      allowed: true, kind: 'decision',
    });
    const spent = triageQuotaVerdict({ summary: 1, decision: 3 }, decision());
    expect(spent.allowed).toBe(false);
    expect(spent.allowed === false && spent.reason).toBe('decisions-spent');
  });
});

describe('assist differs from ask only in what a run may do on its own', () => {
  it('the letter budget text is identical in both modes', () => {
    const budget = triageLetterBudgetText();
    expect(triageRunRules('ask', false)).toContain(budget);
    expect(triageRunRules('assist', false)).toContain(budget);
    expect(triageRunRules('assist', true)).toContain(budget);
    expect(budget).toContain('at most 1 summary letter');
    expect(budget).toContain('at most 3 decision letters');
    expect(budget).toContain('refuses a fourth decision letter');
    expect(budget).toContain('Withdraw a decision letter an earlier');
  });

  it('both modes still route every outward action through the same approval ops', () => {
    for (const mode of ['ask', 'assist'] as const) {
      const text = triageModeText(mode, true);
      for (const op of TRIAGE_APPROVAL_OPS) expect(text).toContain(op);
      expect(text).toContain('posting to Slack');
      expect(text).toContain('marking Slack read');
    }
    expect(TRIAGE_APPROVAL_OPS).toEqual([
      'mail_request_send', 'slack_request_post', 'mail_unsubscribe_request',
    ]);
  });

  it('ask creates nothing on its own; assist may create and update tasks and notes', () => {
    const ask = triageModeText('ask', false);
    expect(ask).toContain('only read, update the triage and tracking notes, and ask a');
    expect(ask).toContain('creating or');
    expect(ask).toContain('editing a task');

    const assist = triageModeText('assist', false);
    expect(assist).toContain('create and update tasks');
    expect(assist).toContain('update the tracking notes');
    expect(assist).toContain('one-click unsubscribe');
    expect(assist).toContain('never what may leave this machine');
  });

  it('auto_mark_read is the one extra permission assist can be given', () => {
    expect(triageModeText('assist', false)).toContain('may NOT mark mail as read (auto_mark_read is off)');
    expect(triageModeText('assist', true)).toContain('mark the mail you triaged as read');
    // ask never gets it, whatever the flag says: the flag is documented as an
    // assist-only permission (core/triage/types.ts).
    expect(triageModeText('ask', true)).not.toContain('mark the mail you triaged as read');
  });
});
