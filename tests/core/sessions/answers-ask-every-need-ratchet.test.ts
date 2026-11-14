/**
 * Every source of a line on the user's Needs you is settled by task_send answers_ask, or is named
 * here as no question with the reason (2026-11-13, Main: "凡是 Brief 列在 Needs you 里的问话，上级都能用
 * 同一个 answers_ask 答掉或撤掉"; a chat-only ask and a Board choice could not be). The sources are
 * read from the code (every `source: '...'` a status is built with in src/core/user-status.ts, and
 * the union of UserStatus.source): a new one fails here until it is placed.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { UserStatus } from '../../../src/core/user-status.js';

const respond = vi.fn(async () => ({ status: 'resolved' }));
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({ respondSessionPermission: respond }));
const sessions: unknown[] = [];
vi.mock('../../../src/core/session-tracker.js', async (orig) => ({ ...(await orig() as object), getSessionsForTask: vi.fn(async () => sessions) }));

const { openAskOf } = await import('../../../src/core/sessions/ask-answer.js');
const { settlerFor, SETTLED_WHERE } = await import('../../../src/core/sessions/ask-settle.js');
const { answeredAbove } = await import('../../../src/core/same-ask.js');
const { deriveUserStatus } = await import('../../../src/core/user-status.js');

/** Each source, where answers_ask settles it, or why it is no question. */
const SETTLED: Record<string, { where: string } | { notAQuestion: string }> = {
  session: { where: 'report' },
  choice: { where: 'choice' },
  prompt: { where: 'prompt' },
  letter: { where: 'letter' },
  error: { notAQuestion: 'a failure only the user can clear (a sign-in, a host): words cannot fix it; it leaves when the fact clears or the task is restarted' },
  thread: { notAQuestion: 'no longer made: a thread rides status.threads and is settled with thread_update' },
};

function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('every source of a Needs you line is settled by answers_ask, or named as no question', () => {
  it('lists every source a status is built with, and every one the type allows', () => {
    const src = code('src/core/user-status.ts');
    const built = new Set([...src.matchAll(/source: '(\w+)'/g)].map((m) => m[1]!));
    const union = src.match(/source\?: ((?:'\w+'\s*\|?\s*)+);/);
    const typed = new Set([...(union?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]!));
    expect(built.size).toBeGreaterThan(3);
    expect(typed.size).toBeGreaterThan(3);
    for (const s of [...built, ...typed]) expect(SETTLED[s], `source '${s}' feeds Needs you: settle it in ask-answer.ts openAskOf/ask-settle.ts, or name it here`).toBeDefined();
  });

  for (const [source, how] of Object.entries(SETTLED)) {
    it(`${source}: ${'where' in how ? `answered where it lives (${how.where})` : 'refused with its reason'}`, () => {
      const us = { state: 'needs', source, ask: 'Which host?', ...(source === 'choice' ? { choice: { board: 'b1', id: 'c1' } } : {}) } as UserStatus;
      const open = openAskOf({ user_status: us, status_report: undefined });
      if ('where' in how) expect(open).toMatchObject({ ask: 'Which host?', where: how.where });
      else if (source !== 'thread') expect(open).toMatchObject({ none: expect.stringMatching(/\w/) });
    });
  }

  it('every place an ask lives, but the report and the chat, has a settler', () => {
    const where = code('src/core/sessions/ask-answer.ts').match(/export type AskWhere = ((?:'\w+'\s*\|?\s*)+);/);
    const all = [...(where?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(all.length).toBeGreaterThan(3);
    for (const w of all) if (w !== 'report' && w !== 'chat') expect(SETTLED_WHERE.has(w as never), `${w} has no settler in ask-settle.ts`).toBe(true);
    const settle = code('src/core/sessions/ask-settle.ts');
    for (const w of SETTLED_WHERE) expect(settle).toContain(`input.where === '${w}'`);
  });

  // An org node's own Needs you folds into its chat (user-status.ts asOrgNode): each source is still settled where it lives.
  const NODE: Array<[string, Record<string, unknown>, string]> = [
    ['its report', { report: { state: 'needs', ask: 'Ship the beta?', at: new Date().toISOString() } }, 'chat'],
    ['a Board choice', { openChoice: 'Which host?', openChoiceRef: { board: 'b1', id: 'c1' } }, 'choice'],
    ['a decision letter', { openLetter: 'Pick a layout' }, 'letter'],
    ['a prompt', { pendingPermissionTool: 'AskUserQuestion' }, 'prompt'],
  ];
  for (const [what, facts, where] of NODE) {
    it(`an org node's question from ${what} is settled through answers_ask (${where})`, () => {
      const shown = deriveUserStatus({ phase: 'NEED_ACTION', status: 'todo', isLead: true, processStatus: 'idle', hasSession: true, ...facts } as never);
      expect(shown).toMatchObject({ state: 'waiting', kind: 'you' });
      const open = openAskOf({ user_status: shown, status_report: undefined });
      expect(open, JSON.stringify(shown)).toMatchObject({ where });
      if (where === 'choice') expect(open).toMatchObject({ choice: { board: 'b1', id: 'c1' } });
    });
  }

  it('an org node\'s question folded into its chat is answered, and its status leaves the user', () => {
    const shown = deriveUserStatus({ phase: 'NEED_ACTION', status: 'todo', isLead: true, processStatus: 'idle', hasSession: true,
      report: { state: 'needs', ask: 'Ship the beta?', at: new Date().toISOString() } } as never);
    expect(shown).toMatchObject({ state: 'waiting', kind: 'you', chatAsk: 'Ship the beta?' });
    expect(openAskOf({ user_status: shown, status_report: undefined })).toMatchObject({ where: 'chat', ask: 'Ship the beta?' });
    const answered = answeredAbove(shown, { key: 'ship the beta', ask: 'Ship the beta?', text: 'Yes', by: 'lead', byTitle: 'Lead', at: new Date().toISOString() } as never);
    expect(answered).toMatchObject({ state: 'waiting', kind: 'task' });
  });

  it('a result to read is no question: complete it instead', () => {
    expect(openAskOf({ user_status: { state: 'waiting', toRead: 'result', waitingOn: 'Read it' } as UserStatus, status_report: undefined }))
      .toMatchObject({ none: expect.stringContaining('task_complete') });
  });
});

describe('a prompt open in the session', () => {
  const target = { id: 't1', title: 'Asker' };
  const base = { where: 'prompt' as const, target, line: '[Walnut: Lead answers]', withdraw: false, byTitle: 'Lead', askMe: true };

  it('an AskUserQuestion is answered with the words, one per question', async () => {
    sessions.splice(0, sessions.length, { claudeSessionId: 's1', pendingPermission: { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which region?' }, { question: 'Which size?' }] }, receivedAt: '2026-11-13T00:00:00Z' } });
    respond.mockClear();
    const settle = await settlerFor({ ...base, text: 'us-west-2, small' });
    expect(await settle!()).toEqual({ via: 'question', sessionId: 's1' });
    expect(respond).toHaveBeenCalledWith('s1', 'r1', true, undefined, undefined, {
      'Which region?': 'us-west-2, small (answered by Lead for the user)', 'Which size?': 'us-west-2, small (answered by Lead for the user)',
    });
  });

  it('a question about a step only the user approves needs his words naming it', async () => {
    sessions.splice(0, sessions.length, { claudeSessionId: 's3', pendingPermission: { requestId: 'r3', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Should I pay the vendor invoice now?' }] }, receivedAt: '2026-11-13T00:00:00Z' } });
    await expect(settlerFor({ ...base, text: 'Yes' })).rejects.toMatchObject({ code: 'user_words' });
    await expect(settlerFor({ ...base, text: 'Yes', userWords: 'pay the invoice, I checked it' })).resolves.toBeTypeOf('function');
    // An outward step is no longer his with approvals off; spending still is.
    sessions.splice(0, sessions.length, { claudeSessionId: 's4', pendingPermission: { requestId: 'r4', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Send the update to the list?' }] }, receivedAt: '2026-11-13T00:00:00Z' } });
    await expect(settlerFor({ ...base, text: 'Yes, send it to them' })).rejects.toMatchObject({ code: 'user_words' });
    await expect(settlerFor({ ...base, askMe: false, text: 'Yes, send it to them' })).resolves.toBeTypeOf('function');
  });

  it('any other tool\'s prompt is denied with the answer as its reason: allowing a tool stays the person\'s', async () => {
    sessions.splice(0, sessions.length, { claudeSessionId: 's2', pendingPermission: { requestId: 'r2', toolName: 'Bash', input: { command: 'rm -rf build' }, receivedAt: '2026-11-13T00:00:00Z' } });
    respond.mockClear();
    const settle = await settlerFor({ ...base, text: 'Do not delete it; clean only dist.' });
    expect(await settle!()).toEqual({ via: 'prompt_denied', sessionId: 's2', tool: 'Bash' });
    expect(respond).toHaveBeenCalledWith('s2', 'r2', false, '[Walnut: Lead answers] Do not delete it; clean only dist.');
  });

  it('a report or chat ask has no settler: it goes as a message', async () => {
    expect(await settlerFor({ ...base, where: 'report', text: 'x' })).toBeUndefined();
    expect(await settlerFor({ ...base, where: 'chat', text: 'x' })).toBeUndefined();
  });
});
