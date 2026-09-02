/**
 * Server-composes → frontend-parses contract for session envelopes.
 *
 * tests/web/session-envelope.test.ts pins the parser against each BUILDER. This
 * file closes the remaining gap: `performSessionSend` is what actually assembles
 * a delivery (peer fence, then a reply trailer glued on outside it, then a reply
 * routed back to the asker), and the chat's provenance card has to parse THAT.
 *
 * So the real send core runs here with its collaborators mocked at the same seams
 * tests/core/session-send-core.test.ts uses, and the exact text the CLI would
 * read is fed to the shipped web parser. If the composition changes shape, the
 * chat stops carding these messages — this test is what says so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-envelope-render'));

const listSessions = vi.fn();
const getSessionByClaudeId = vi.fn();
const getSessionsForTask = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
  getSessionsForTask: (...args: unknown[]) => getSessionsForTask(...args),
  isEnvironmentSession: (s: { type?: string }) => s.type === 'triage' || s.type === 'hook' || s.type === 'cron',
}));

vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (handle: string) => { throw new Error(`No task found: ${handle}`); },
}));

const sendMessageToSession = vi.fn();
const enqueueMessage = vi.fn();
const getQueue = vi.fn();
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: (...args: unknown[]) => enqueueMessage(...args),
  getQueue: (...args: unknown[]) => getQueue(...args),
}));

import { performSessionSend } from '../../src/core/sessions/session-send-core.js';
import { REQUESTS_FILE, buildRequestNotification, getSessionRequest } from '../../src/core/session-requests.js';
import type { SessionRecord } from '../../src/core/types.js';
import {
  parseSessionEnvelopes,
  type SessionEnvelope,
} from '../../web/src/components/sessions/session-envelope.js';

const NOW = new Date().toISOString();
/** Longer than the 80 chars the envelope prints, so truncation is observable. */
const ASKER_TITLE = 'Asker session that coordinates the rollout across every host and then reports back to the human';
const PEER_TITLE = 'Mac side worker that pulls config, restarts the proxy and confirms the daemon version';

function rec(claudeSessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId,
    taskId: '',
    project: '',
    process_status: 'idle',
    mode: 'default',
    provider: 'cli',
    startedAt: NOW,
    lastActiveAt: NOW,
    messageCount: 0,
    ...overrides,
  } as SessionRecord;
}

let sessions: SessionRecord[] = [];

/** Exactly what the receiving CLI reads: the enqueue text, else the bus text. */
function deliveredText(n = 0): string {
  const [, busText, opts] = sendMessageToSession.mock.calls[n] as [string, string, Record<string, unknown>];
  return (opts?.enqueueMessage as string | undefined) ?? busText;
}

/** The single envelope the shipped parser finds in a delivery. */
function parsedEnvelope(text: string): SessionEnvelope {
  const segments = parseSessionEnvelopes(text);
  expect(segments, `the chat would NOT card this delivery:\n${text}`).not.toBeNull();
  const envelopes = segments!.filter((s) => s.kind === 'envelope');
  expect(envelopes, `expected one envelope in:\n${text}`).toHaveLength(1);
  return (envelopes[0] as { envelope: SessionEnvelope }).envelope;
}

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
  sessions = [
    rec('asker-1111-2222-3333', { title: ASKER_TITLE, taskId: 'task-asker-1' }),
    rec('peer-4444-5555-6666', { title: PEER_TITLE, taskId: 'task-peer-1', host: 'clouddev' }),
  ];
  listSessions.mockReset();
  getSessionByClaudeId.mockReset();
  getSessionsForTask.mockReset();
  sendMessageToSession.mockReset();
  enqueueMessage.mockReset();
  getQueue.mockReset();
  listSessions.mockImplementation(async () => sessions);
  getSessionByClaudeId.mockImplementation(async (sid: string) =>
    sessions.find((s) => s.claudeSessionId === sid) ?? null);
  getSessionsForTask.mockImplementation(async (taskId: string) =>
    sessions.filter((s) => s.taskId === taskId));
  sendMessageToSession.mockResolvedValue({ id: 'qm-dispatched' });
  enqueueMessage.mockResolvedValue({ id: 'qm-parked' });
  getQueue.mockResolvedValue([]);
});

describe('what performSessionSend delivers is what the card parses', () => {
  it('a session send with expect_reply is one peer-note card carrying the reply request', async () => {
    const result = await performSessionSend({
      to: 'peer-4444-5555-6666',
      text: 'Daemon is on 2.1.255 and the proxy restarted clean.',
      callerSid: 'asker-1111-2222-3333',
    });

    const envelope = parsedEnvelope(deliveredText());
    expect(envelope.kind).toBe('peer-note');
    expect(envelope.body).toBe('Daemon is on 2.1.255 and the proxy restarted clean.');
    expect(envelope.peer.shortId).toBe('asker-11');
    expect(envelope.peer.host).toBe('local');
    // The card must know the title is clipped, so it goes looking for the live one.
    expect(envelope.peer.title).toBe(`${ASKER_TITLE.slice(0, 80)}…`);
    expect(envelope.replyRequest?.requestId).toBe(result.requestId);
    expect(envelope.replyRequest?.command).toContain(`"in_reply_to":"${result.requestId}"`);
  });

  it('expect_reply:false delivers a peer-note card with no reply request', async () => {
    await performSessionSend({
      to: 'peer-4444-5555-6666',
      text: 'fyi only',
      expectReply: false,
      callerSid: 'asker-1111-2222-3333',
    });
    const envelope = parsedEnvelope(deliveredText());
    expect(envelope.kind).toBe('peer-note');
    expect(envelope.replyRequest).toBeUndefined();
    expect(envelope.body).toBe('fyi only');
  });

  it('an unidentified caller delivers an anonymous peer-note card with no session id', async () => {
    await performSessionSend({
      to: 'peer-4444-5555-6666',
      text: 'cron finished',
      callerSid: 'external',
      callerHost: 'devbox',
    });
    const envelope = parsedEnvelope(deliveredText());
    expect(envelope.kind).toBe('peer-note');
    expect(envelope.peer.anonymous).toBe(true);
    expect(envelope.peer.host).toBe('devbox');
    expect(envelope.peer.shortId).toBeUndefined();
    expect(envelope.body).toBe('cron finished');
  });

  it("the human's own send is NOT an envelope — it stays an ordinary bubble", async () => {
    await performSessionSend({ to: 'peer-4444-5555-6666', text: 'hey, status?' });
    expect(parseSessionEnvelopes(deliveredText())).toBeNull();
  });

  it('an in_reply_to send delivers a reply card to the asker', async () => {
    const sent = await performSessionSend({
      to: 'peer-4444-5555-6666',
      text: 'Confirm the daemon version, then restart the proxy.',
      callerSid: 'asker-1111-2222-3333',
    });
    expect(sent.requestId).toBeTruthy();

    await performSessionSend({
      inReplyTo: sent.requestId!,
      text: 'Both blockers cleared: CLI 2.1.255, proxy restarted.',
      callerSid: 'peer-4444-5555-6666',
    });
    expect(await getSessionRequest(sent.requestId!)).toMatchObject({ status: 'replied' });

    const envelope = parsedEnvelope(deliveredText(1));
    expect(envelope.kind).toBe('reply');
    expect(envelope.requestId).toBe(sent.requestId);
    expect(envelope.body).toBe('Both blockers cleared: CLI 2.1.255, proxy restarted.');
    // The REPLIER is the peer the card links to, on its own host.
    expect(envelope.peer.shortId).toBe('peer-444');
    expect(envelope.peer.host).toBe('clouddev');
    expect(envelope.peer.title).toBe(`${PEER_TITLE.slice(0, 80)}…`);
    expect(envelope.askedPreview).toBe('Confirm the daemon version, then restart the proxy.');
    expect(envelope.followUp).toContain(`"to":"peer-444"`);
  });

  it('the no-reply fallback notice parses as a notification card with both ids', async () => {
    const sent = await performSessionSend({
      to: 'peer-4444-5555-6666',
      text: 'ship it when green',
      callerSid: 'asker-1111-2222-3333',
    });
    const request = await getSessionRequest(sent.requestId!);
    const envelope = parsedEnvelope(buildRequestNotification(request!, 'timeout', {
      title: PEER_TITLE,
      sessionId: 'peer-4444-5555-6666',
      taskId: 'task-peer-1',
    }));
    expect(envelope.kind).toBe('notification');
    expect(envelope.requestId).toBe(sent.requestId);
    expect(envelope.peer.sessionId).toBe('peer-4444-5555-6666');
    expect(envelope.peer.taskId).toBe('task-peer-1');
    expect(envelope.statusLine).toContain('has not replied by your deadline');
  });

  it('a batched delivery of two peer sends cards each one separately', async () => {
    sessions.push(rec('third-7777-8888-9999', { title: 'Third session' }));
    await performSessionSend({
      to: 'peer-4444-5555-6666', text: 'first note', expectReply: false,
      callerSid: 'asker-1111-2222-3333',
    });
    await performSessionSend({
      to: 'peer-4444-5555-6666', text: 'second note', expectReply: false,
      callerSid: 'third-7777-8888-9999',
    });
    // The queue drain joins pending messages with a blank line before the CLI
    // reads them (claude-code-session.ts), so the card has to survive that join.
    const combined = `${deliveredText(0)}\n\n${deliveredText(1)}`;
    const segments = parseSessionEnvelopes(combined)!;
    const envelopes = segments.filter((s) => s.kind === 'envelope')
      .map((s) => (s as { envelope: SessionEnvelope }).envelope);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].peer.shortId).toBe('asker-11');
    expect(envelopes[0].body).toBe('first note');
    expect(envelopes[1].peer.shortId).toBe('third-77');
    expect(envelopes[1].body).toBe('second note');
  });
});
