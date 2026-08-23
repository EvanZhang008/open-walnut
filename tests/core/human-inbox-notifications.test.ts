/**
 * Human Inbox → notification center bridge (envelope), read mirroring, and push.
 *
 * Contract under test (docs/plan/human-inbox-todo.md → frozen contract, part C):
 *   - a 'human-inbox:letter' event becomes ONE envelope notification: kind
 *     'letter', dedupKey `letter:<id>`, title = subject, body = textPreview,
 *     severity 'info', plus the `letterId` pointer.
 *   - an agent reply flips that envelope unread and refreshes its preview; if the
 *     envelope is gone (dismissed / evicted) the reply re-creates it.
 *   - mark-ALL-read never touches a letter (a document is read by being opened),
 *     while an explicit id still does.
 *   - the letter store is canonical for read state; the envelope mirrors it.
 *   - letters have no lifecycle stamp: the recovery / expiry sweeps ignore them,
 *     and an error storm cannot evict a letter envelope out of the bounded feed.
 *   - the phone push carries subject + preview + letterId, and stays gated on
 *     "no WS clients connected".
 *
 * WALNUT_HOME is redirected to an isolated tmpdir, the WS layer and config are
 * stubbed, and the Expo HTTP call is stubbed at `fetch` — nothing leaves the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const clientCount = vi.hoisted(() => vi.fn(() => 0));
const broadcastEvent = vi.hoisted(() => vi.fn());
const getConfig = vi.hoisted(() => vi.fn());

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount, broadcastEvent }));
vi.mock('../../src/core/config-manager.js', () => ({ getConfig }));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { HumanInboxLetterEvent } from '../../src/core/event-types.js';
import {
  addNotification,
  dismissNotifications,
  expireErrorNotifications,
  expireKeylessErrorNotifications,
  listNotifications,
  markRead,
  recoverNotifications,
  type NotificationRecord,
} from '../../src/core/notifications/store.js';
import {
  ensureLetterBridge,
  mirrorLetterReadState,
  uninstallLetterBridge,
} from '../../src/core/notifications/letter-bridge.js';
import { agentReply, sendLetter, setRead } from '../../src/core/human-inbox/store.js';
import type { LetterSender } from '../../src/core/human-inbox/types.js';
import { initPushNotifications } from '../../src/core/push-notification.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

const SENDER: LetterSender = {
  sessionId: 'sess-abc123',
  sessionTitle: 'Sync freeze investigation',
  taskId: 'task-42',
  taskTitle: 'Fix the sync freeze',
  project: 'marina',
  host: 'workstation',
};

/** Unique per call so a fire-and-forget write from an earlier test can never be
 *  mistaken for this test's envelope. */
let letterSeq = 0;
function letterEvent(overrides: Partial<HumanInboxLetterEvent> = {}): HumanInboxLetterEvent {
  letterSeq += 1;
  return {
    letterId: `lt-test-${letterSeq}`,
    subject: 'Root cause of the sync freeze',
    type: 'review',
    textPreview: 'The rebase was orphaned. Recommended fix inside.',
    senderSessionId: SENDER.sessionId,
    senderTitle: SENDER.sessionTitle,
    host: SENDER.host,
    kind: 'new',
    ...overrides,
  };
}

function emit(data: HumanInboxLetterEvent): HumanInboxLetterEvent {
  bus.emit(EventNames.HUMAN_INBOX_LETTER, data, ['*'], { source: 'test' });
  return data;
}

/** The bridge persists async — poll until `pred` holds (or the deadline wins). */
async function feedWhen(
  pred: (feed: NotificationRecord[]) => boolean,
  timeoutMs = 4_000,
): Promise<NotificationRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { feed } = await listNotifications();
    if (pred(feed) || Date.now() > deadline) return feed;
    await new Promise(r => setTimeout(r, 20));
  }
}

const envelopeOf = (feed: NotificationRecord[], letterId: string): NotificationRecord | undefined =>
  feed.find(n => n.kind === 'letter' && n.letterId === letterId);

/** Wait for the envelope of `letterId` to satisfy `pred`. */
async function envelopeWhen(
  letterId: string,
  pred: (rec: NotificationRecord) => boolean = () => true,
): Promise<NotificationRecord | undefined> {
  const feed = await feedWhen((f) => {
    const rec = envelopeOf(f, letterId);
    return !!rec && pred(rec);
  });
  return envelopeOf(feed, letterId);
}

beforeEach(() => {
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), { force: true }); } catch { /* noop */ }
  bus.clear();
  broadcastEvent.mockClear();
  uninstallLetterBridge();
});

describe('letter → envelope notification', () => {
  beforeEach(() => { ensureLetterBridge(); });
  afterEach(() => { uninstallLetterBridge(); });

  it('a new letter becomes one envelope record pointing at the document', async () => {
    const data = emit(letterEvent());
    const rec = await envelopeWhen(data.letterId);

    expect(rec).toBeDefined();
    expect(rec!.kind).toBe('letter');
    expect(rec!.severity).toBe('info');
    expect(rec!.dedupKey).toBe(`letter:${data.letterId}`);
    expect(rec!.letterId).toBe(data.letterId);
    expect(rec!.title).toBe(data.subject);
    // The envelope carries the PREVIEW, never the document body.
    expect(rec!.body).toBe(data.textPreview);
    expect(rec!.read).toBe(false);
    expect(rec!.sessionId).toBe(SENDER.sessionId);
    expect(rec!.sessionTitle).toBe(SENDER.sessionTitle);
    expect(rec!.host).toBe(SENDER.host);
    // No lifecycle stamp: a letter ends only by human action.
    expect(rec!.recoveryKey).toBeUndefined();
    expect(rec!.resolved).toBeUndefined();
  });

  it('broadcasts the new record so the bell updates without a refresh', async () => {
    const data = emit(letterEvent());
    await envelopeWhen(data.letterId);

    const call = broadcastEvent.mock.calls.find(
      ([name, rec]) => name === 'notification:new'
        && (rec as NotificationRecord)?.letterId === data.letterId,
    );
    expect(call).toBeDefined();
  });

  it('an unresolvable sender leaves sessionId off (no dead deep link)', async () => {
    // A hand-started agent: the route stamps sender 'external'. A deep link into a
    // session that does not exist is worse than no deep link.
    const data = emit(letterEvent({ senderSessionId: 'external', senderTitle: undefined }));
    const rec = await envelopeWhen(data.letterId);

    expect(rec).toBeDefined();
    expect(rec!.sessionId).toBeUndefined();
    expect(rec!.host).toBe(SENDER.host);
  });

  it('a duplicate new event does not create a second envelope', async () => {
    const data = emit(letterEvent());
    await envelopeWhen(data.letterId);
    emit(data);
    await new Promise(r => setTimeout(r, 120));

    const { feed } = await listNotifications();
    expect(feed.filter(n => n.letterId === data.letterId)).toHaveLength(1);
  });

  it('an agent reply flips the envelope unread and refreshes the preview', async () => {
    const data = emit(letterEvent());
    const created = await envelopeWhen(data.letterId);
    await markRead([created!.id]);
    expect((await listNotifications()).feed.find(n => n.id === created!.id)?.read).toBe(true);

    emit({ ...data, kind: 'reply', textPreview: 'Yes — the Tuesday incident is the same bug.' });
    const rec = await envelopeWhen(data.letterId, r => r.read === false);

    expect(rec!.read).toBe(false);
    expect(rec!.body).toBe('Yes — the Tuesday incident is the same bug.');
    // Identity is stable (the UI addresses it by dedupKey) but it counts as recent.
    expect(rec!.id).toBe(created!.id);
    expect(rec!.lastTimestamp).toBeGreaterThan(0);
  });

  it('a reply re-creates an envelope that had been dismissed', async () => {
    const data = emit(letterEvent());
    await envelopeWhen(data.letterId);
    await dismissNotifications({ dedupKeys: [`letter:${data.letterId}`] });
    expect(envelopeOf((await listNotifications()).feed, data.letterId)).toBeUndefined();

    emit({ ...data, kind: 'reply', textPreview: 'Answered.' });
    const rec = await envelopeWhen(data.letterId);

    expect(rec).toBeDefined();
    expect(rec!.read).toBe(false);
  });

  it('never mints a record for an event with no letter id', async () => {
    emit(letterEvent({ letterId: '' }));
    await new Promise(r => setTimeout(r, 120));
    expect((await listNotifications()).feed.filter(n => n.kind === 'letter')).toHaveLength(0);
  });
});

describe('letter store → envelope (the bridge installs itself)', () => {
  // No ensureLetterBridge() here on purpose: sending a letter through the store
  // must install the bridge itself, since server.ts does not wire it.
  afterEach(() => { uninstallLetterBridge(); });

  it('sendLetter stamps an envelope, and agentReply flips it unread', async () => {
    const letter = await sendLetter({
      subject: 'Migration finished',
      type: 'completion',
      markdown: '42 files changed, all tests green.',
      text: 'A short envelope preview.',
      sender: SENDER,
    });

    const rec = await envelopeWhen(letter.id);
    expect(rec).toBeDefined();
    expect(rec!.title).toBe('Migration finished');
    expect(rec!.body).toBe('A short envelope preview.');

    await markRead([rec!.id]);
    await agentReply(letter.id, { text: 'One more detail: the index was rebuilt.' });
    const after = await envelopeWhen(letter.id, r => r.read === false);
    expect(after!.read).toBe(false);
    expect(after!.body).toContain('the index was rebuilt');
  });

  it('reading a letter in the store mirrors onto the envelope, both ways', async () => {
    const letter = await sendLetter({
      subject: 'Decision needed',
      type: 'action_required',
      markdown: 'Option A or B?',
      actions: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
      sender: SENDER,
    });
    await envelopeWhen(letter.id);

    await setRead(letter.id, true);
    expect((await envelopeWhen(letter.id, r => r.read))!.read).toBe(true);

    await setRead(letter.id, false);
    expect((await envelopeWhen(letter.id, r => !r.read))!.read).toBe(false);
  });

  it('mirrorLetterReadState on an unknown letter is a no-op, not a throw', async () => {
    await expect(mirrorLetterReadState('lt-does-not-exist', true)).resolves.toBeUndefined();
  });
});

describe('mark-all-read exemption', () => {
  beforeEach(() => { ensureLetterBridge(); });
  afterEach(() => { uninstallLetterBridge(); });

  it('markRead() with no ids retires events but leaves letters unread', async () => {
    await addNotification({
      kind: 'cron', severity: 'info', title: 'Morning routine finished', dedupKey: 'cron:morning',
    });
    const data = emit(letterEvent());
    await envelopeWhen(data.letterId);

    const { unreadCount } = await markRead();

    const { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'cron:morning')!.read).toBe(true);
    expect(envelopeOf(feed, data.letterId)!.read).toBe(false);
    // The bell keeps counting the letter — that is the point of the exemption.
    expect(unreadCount).toBe(1);
  });

  it('markRead([id]) does mark a letter read (what the reader uses)', async () => {
    const data = emit(letterEvent());
    const rec = await envelopeWhen(data.letterId);

    const { unreadCount } = await markRead([rec!.id]);

    expect(unreadCount).toBe(0);
    expect(envelopeOf((await listNotifications()).feed, data.letterId)!.read).toBe(true);
  });
});

describe('condition-system fit', () => {
  beforeEach(() => { ensureLetterBridge(); });
  afterEach(() => { uninstallLetterBridge(); });

  it('the recovery and expiry sweeps never touch a letter', async () => {
    const data = emit(letterEvent());
    // An old, keyless letter is exactly the shape the debris sweep hunts for —
    // it must still survive, because it is not an error.
    const rec = await envelopeWhen(data.letterId);
    expect(rec!.recoveryKey).toBeUndefined();

    await recoverNotifications([`letter:${data.letterId}`, 'git']);
    await expireErrorNotifications([`letter:${data.letterId}`]);
    await expireKeylessErrorNotifications(0, Date.now() + 60_000);

    const after = envelopeOf((await listNotifications()).feed, data.letterId);
    expect(after!.resolved).toBeUndefined();
    expect(after!.severity).toBe('info');
  });

  it('an error storm cannot evict a letter envelope from the bounded feed', async () => {
    const data = emit(letterEvent());
    await envelopeWhen(data.letterId);

    // 210 events > the 200 cap: with a flat tail-slice the letter (written first)
    // would be the first thing dropped.
    for (let i = 0; i < 210; i++) {
      await addNotification({
        kind: 'operation-error', severity: 'error', title: `boom ${i}`, dedupKey: `storm:${i}`,
      });
    }

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(200);
    expect(envelopeOf(feed, data.letterId)).toBeDefined();
    // The storm still lost its oldest entries, as a bounded feed must.
    expect(feed.some(n => n.dedupKey === 'storm:0')).toBe(false);
    expect(feed.some(n => n.dedupKey === 'storm:209')).toBe(true);
  });
});

describe('push on a new letter', () => {
  interface SentPush { title: string; body: string; data?: Record<string, unknown> }
  let sent: SentPush[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Emit and let the fire-and-forget push handler settle. */
  async function emitAndSettle(data: HumanInboxLetterEvent, expectSend = true): Promise<void> {
    const before = fetchMock.mock.calls.length;
    emit(data);
    const deadline = Date.now() + 4_000;
    while (expectSend && fetchMock.mock.calls.length === before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    let seen = -1;
    while (seen !== fetchMock.mock.calls.length && Date.now() < deadline) {
      seen = fetchMock.mock.calls.length;
      await new Promise(r => setTimeout(r, 15));
    }
  }

  beforeEach(() => {
    sent = [];
    clientCount.mockReturnValue(0);
    getConfig.mockResolvedValue({
      push_tokens: [{
        token: 'ExponentPushToken[test]',
        platform: 'ios',
        key_name: 'test',
        registered_at: new Date().toISOString(),
      }],
    });
    fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const messages = JSON.parse(init?.body ?? '[]') as SentPush[];
      sent.push(...messages);
      return { ok: true, json: async () => ({ data: messages.map(() => ({ status: 'ok' as const })) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    // Push only — the envelope bridge is not installed here, so these assertions
    // are about the push payload and nothing else.
    initPushNotifications();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('pushes the subject as title and the preview as body, with the letterId', async () => {
    const data = letterEvent();
    await emitAndSettle(data);

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe(`New letter: ${data.subject}`);
    expect(sent[0].body).toBe(data.textPreview);
    expect(sent[0].data).toMatchObject({
      type: 'human_inbox_letter', letterId: data.letterId, letterType: 'review', kind: 'new',
    });
  });

  it('an agent reply pushes under a Reply prefix', async () => {
    const data = letterEvent({ kind: 'reply', textPreview: 'Same bug, yes.' });
    await emitAndSettle(data);

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe(`Reply: ${data.subject}`);
    expect(sent[0].body).toBe('Same bug, yes.');
    expect(sent[0].data).toMatchObject({ kind: 'reply', letterId: data.letterId });
  });

  it('trims a very long subject rather than letting the OS elide it', async () => {
    await emitAndSettle(letterEvent({ subject: 'S'.repeat(300) }));
    expect(sent[0].title).toHaveLength(100);
  });

  it('a letter with an empty preview still pushes something readable', async () => {
    await emitAndSettle(letterEvent({ textPreview: '' }));
    expect(sent[0].body).toBe('Open Walnut to read it');
  });

  it('does not push while a WS client is connected (user is looking)', async () => {
    clientCount.mockReturnValue(1);
    await emitAndSettle(letterEvent(), false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
