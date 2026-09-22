/**
 * A triage letter reaches the phone even with a Mac tab open (S15, item 7).
 *
 * This pins an EXISTING rule rather than adding one, because triage is the feature
 * that makes breaking it expensive: a run's whole output is letters, so if letters
 * ever went back behind the general notification gate — `maybePush`'s
 * `clientCount() > 0` in core/push-notification.ts, "is any browser WebSocket
 * open" — then every batch would be silently swallowed by a console tab the user
 * left open on their desk. That is the bug core/push/letter-push.ts exists to fix.
 *
 * Two halves, because either one alone can rot:
 *  - behaviour: with a browser WS open, a letter landing in the store still pushes,
 *    through the real bus and the real `initLetterPush` subscriber;
 *  - structure: the letter push path does not consult the WS count at all, and the
 *    general notification subscriber has NO case for the letter event (a case there
 *    would double every letter banner AND put it behind the gate).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-letter-push'));

const getConfig = vi.hoisted(() => vi.fn());
const updatePushTokens = vi.hoisted(() => vi.fn(async () => []));
const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})));
/** A console tab IS open — the condition that used to suppress every letter. */
const clientCount = vi.hoisted(() => vi.fn(() => 4));

vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }));
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}));
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount }));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: vi.fn(async () => {}),
}));

import { initLetterPush, resetLetterPushForTests } from '../../src/core/push/letter-push.js';
import { humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js';
import type { PushTokenEntry } from '../../src/core/types.js';

const APNS_TOKEN = 'c'.repeat(64);

function device(): PushTokenEntry {
  return { token: APNS_TOKEN, key_name: 'phone', platform: 'ios' } as PushTokenEntry;
}

function repoFile(relative: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '../../', relative), 'utf-8');
}

/**
 * The file with its comments removed. Both files EXPLAIN the old WS gate in prose,
 * so a plain substring search would match the explanation and never the code.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  sendApns.mockClear();
  clientCount.mockClear();
  getConfig.mockResolvedValue({ push_tokens: [device()] });
  resetLetterPushForTests();
});

describe('letter push is independent of the general notification switch', () => {
  it('a triage decision letter pushes while a browser WS is open', async () => {
    initLetterPush();
    await sendLetter({
      subject: 'Who owns the migration window?',
      type: 'action_required',
      markdown: 'Two messages on the platform list ask.',
      actions: [{ id: 'make-task', label: 'Make a task' }],
      text: 'Two messages on the platform list ask.',
      sender: {
        sessionId: 'sess-triage-run-now', host: 'local',
        taskId: 'task-triage-run-now', project: 'Ask Inbox Triage',
      },
    });

    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
    const [targets, payload, opts] = sendApns.mock.calls[0] as [
      Array<{ token: string }>, Record<string, any>, Record<string, unknown>,
    ];
    expect(targets.map((t) => t.token)).toEqual([APNS_TOKEN]);
    // A decision the human is blocked on is delivered now, not batched.
    expect(opts).toMatchObject({ priority: 10 });
    expect(payload.type ?? payload.data?.type).toBe('human_inbox_letter');
    // And the letter path never asked whether a browser was watching.
    expect(clientCount).not.toHaveBeenCalled();
  });

  it('the summary letter pushes too — the budget does not change delivery', async () => {
    initLetterPush();
    await sendLetter({
      subject: 'Triage · 14:10 · 16 items',
      type: 'review',
      markdown: 'Sixteen items; four mattered.',
      text: 'Sixteen items; four mattered.',
      sender: { sessionId: 'sess-triage-run-now', host: 'local', taskId: 'task-triage-run-now' },
    });
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
    expect((sendApns.mock.calls[0] as [unknown, unknown, { priority?: number }])[2]).toMatchObject({ priority: 5 });
  });
});

describe('the rule is structural, not incidental', () => {
  it('letter-push.ts never consults the browser WebSocket count', () => {
    const code = codeOf(repoFile('src/core/push/letter-push.ts'));
    expect(code).not.toMatch(/clientCount/);
    expect(code).not.toMatch(/ws\/handler/);
  });

  it('the general notification subscriber has no case for the letter event', () => {
    const source = repoFile('src/core/push-notification.ts');
    // The file explains the omission in a comment; what must not exist is a CASE,
    // which would both double the banner and put it behind maybePush's WS gate.
    expect(codeOf(source)).not.toMatch(/case\s+EventNames\.HUMAN_INBOX_LETTER/);
    expect(source).toMatch(/HUMAN_INBOX_LETTER is deliberately NOT handled here/);
  });
});
