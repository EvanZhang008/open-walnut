/**
 * Pinning a letter has to be a SIGNAL, not a silent disk write.
 *
 * `setRead` and `setArchived` both mirror onto the letter's envelope notification,
 * which broadcasts `notification:updated` — the lane every letter list in the
 * console already refreshes on. `setPinned` was the one toggle with no outbound
 * signal at all, so a pin taken in the notification rail never reached a session
 * panel's Inbox tab: the row there kept showing "Pin", no glyph, and the old date
 * order (pinned sorts FIRST) until an unrelated letter event or a reload.
 *
 * The mirror carries the letter's own read state, and for an ARCHIVED letter the
 * same value `setArchived` mirrors — otherwise pinning something on the shelf
 * would re-badge the bell for a letter that has left the live feed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const clientCount = vi.hoisted(() => vi.fn(() => 0));
const broadcastEvent = vi.hoisted(() => vi.fn());

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount, broadcastEvent }));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { listNotifications, type NotificationRecord } from '../../src/core/notifications/store.js';
import { uninstallLetterBridge } from '../../src/core/notifications/letter-bridge.js';
import {
  sendLetter, setArchived, setPinned, setRead,
} from '../../src/core/human-inbox/store.js';
import type { LetterRecord, LetterSender } from '../../src/core/human-inbox/types.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

const SENDER: LetterSender = {
  sessionId: 'sess-pin-1',
  sessionTitle: 'Index rebuild',
  host: 'workstation',
};

async function seedLetter(subject = 'Pin me'): Promise<LetterRecord> {
  return sendLetter({
    subject, type: 'info', markdown: 'A letter worth keeping at the top.',
    text: 'A letter worth keeping at the top.', sender: SENDER,
  });
}

/** The bridge writes async — poll until the envelope satisfies `pred`. */
async function envelopeWhen(
  letterId: string,
  pred: (rec: NotificationRecord) => boolean = () => true,
  timeoutMs = 4_000,
): Promise<NotificationRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { feed } = await listNotifications();
    const rec = feed.find(n => n.kind === 'letter' && n.letterId === letterId);
    if ((rec && pred(rec)) || Date.now() > deadline) return rec;
    await new Promise(r => setTimeout(r, 20));
  }
}

/** Wait for a `notification:updated` broadcast naming this letter. */
async function updateBroadcast(letterId: string, timeoutMs = 4_000): Promise<NotificationRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = broadcastEvent.mock.calls.find(
      ([name, rec]) => name === 'notification:updated'
        && (rec as NotificationRecord | undefined)?.letterId === letterId,
    );
    if (call) return call[1] as NotificationRecord;
    if (Date.now() > deadline) return undefined;
    await new Promise(r => setTimeout(r, 20));
  }
}

beforeEach(() => {
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), { force: true }); } catch { /* noop */ }
  bus.clear();
  broadcastEvent.mockClear();
  uninstallLetterBridge();
});

afterEach(() => { uninstallLetterBridge(); });

describe('setPinned emits the way its siblings do', () => {
  it('broadcasts notification:updated so every other surface re-reads the list', async () => {
    const letter = await seedLetter();
    await envelopeWhen(letter.id);
    broadcastEvent.mockClear();

    const pinned = await setPinned(letter.id, true);
    expect(pinned.pinned).toBe(true);

    const pushed = await updateBroadcast(letter.id);
    expect(pushed, 'pinning must reach connected UIs — it had NO signal at all').toBeDefined();
    expect(pushed!.dedupKey).toBe(`letter:${letter.id}`);
  });

  it('unpinning emits too (the row has to fall back down everywhere)', async () => {
    const letter = await seedLetter('Unpin me');
    await setPinned(letter.id, true);
    await envelopeWhen(letter.id);
    broadcastEvent.mockClear();

    expect((await setPinned(letter.id, false)).pinned).toBe(false);
    expect(await updateBroadcast(letter.id)).toBeDefined();
  });

  it('carries the letter read state through unchanged (pinning is not reading)', async () => {
    const letter = await seedLetter('Still unread');
    await envelopeWhen(letter.id);

    await setPinned(letter.id, true);
    const pushed = await updateBroadcast(letter.id);
    expect(pushed!.read).toBe(false);
    expect((await envelopeWhen(letter.id))!.read).toBe(false);

    // …and a READ letter stays read: the mirror must not un-read the bell either.
    await setRead(letter.id, true);
    broadcastEvent.mockClear();
    await setPinned(letter.id, false);
    expect((await updateBroadcast(letter.id))!.read).toBe(true);
  });

  it('pinning an ARCHIVED letter does not re-badge the bell', async () => {
    const letter = await seedLetter('On the shelf');
    await envelopeWhen(letter.id);
    // Archiving mirrors read=true so an unread letter that left the live feed
    // stops badging the bell (nothing in the Inbox rail could clear it).
    await setArchived(letter.id, true);
    expect((await envelopeWhen(letter.id, r => r.read))!.read).toBe(true);
    broadcastEvent.mockClear();

    await setPinned(letter.id, true);

    const pushed = await updateBroadcast(letter.id);
    expect(pushed!.read, 'a pin on the shelf must not resurrect the bell badge').toBe(true);
    expect((await envelopeWhen(letter.id))!.read).toBe(true);
  });

  it('a letter with no envelope left still pins (the mirror is fire-and-forget)', async () => {
    const letter = await seedLetter('No envelope');
    await envelopeWhen(letter.id);
    fs.rmSync(NOTIFICATIONS_FILE, { force: true });

    // The pin itself must never fail on, or wait for, the notification store.
    expect((await setPinned(letter.id, true)).pinned).toBe(true);
  });
});
