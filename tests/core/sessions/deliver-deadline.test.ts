/**
 * deliverToSession's deadline is opt-in (src/lib/send-deadline.ts).
 *
 * Without `deadline` (every Walnut notice: status pushes, request answers, caller notices, org
 * notes), a slow send is never dropped: it is stored late and delivered. With it (a caller told
 * "retry", POST /api/v1/messages), a send that has not reached its store stores nothing and throws
 * 'delivery_failed'; one past its store is answered by its row, at once.
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

type SendOpts = { stillWanted?: () => boolean; onStored?: (m: { id: string }) => void };
const sendMock = vi.fn<(sid: string, text: string, opts: SendOpts) => Promise<{ id: string }>>();
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMessageToSession: (sid: string, text: string, opts: SendOpts) => sendMock(sid, text, opts),
}));

const { deliverToSession, SendError } = await import('../../../src/core/sessions/session-send-core.js');

const target = { claudeSessionId: 'sess-deadline' } as import('../../../src/core/types.js').SessionRecord;
const notice = { busText: 'n', enqueueText: 'n', source: 'walnut-notify' };
const later = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** A send whose steps before the store take `beforeMs`, its store `storeMs`, and the rest `afterMs`. */
function slowSend(beforeMs: number, storeMs = 0, afterMs = 0) {
  const seen: { wanted?: boolean } = {};
  sendMock.mockImplementation(async (_sid, _text, opts) => {
    await later(beforeMs);
    seen.wanted = opts.stillWanted ? opts.stillWanted() : true;
    if (!seen.wanted) throw new Error('send no longer wanted');
    await later(storeMs);
    opts.onStored?.({ id: 'qm-row' });
    await later(afterMs);
    return { id: 'qm-row' };
  });
  return seen;
}

// The send path's own module loads, once and on real timers: a fake clock then times the send alone.
beforeAll(async () => {
  sendMock.mockResolvedValue({ id: 'qm-warm' });
  await deliverToSession(target, notice);
  await deliverToSession(target, { ...notice, deadline: true });
}, 60_000);
beforeEach(() => { vi.useFakeTimers(); sendMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('deliverToSession deadline', () => {
  it('a notice with no deadline is delivered however slow its send', async () => {
    const seen = slowSend(20_000);
    const p = deliverToSession(target, notice);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ delivery: 'queued', messageId: 'qm-row' });
    expect(seen.wanted).toBe(true);
  });

  it('with a deadline, a send that had not reached its store stores nothing and says retry', async () => {
    const seen = slowSend(10_000);
    const p = deliverToSession(target, { ...notice, deadline: true });
    const failed = expect(p).rejects.toMatchObject({ code: 'delivery_failed', statusCode: 503 });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(seen.wanted).toBe(false);
    expect(SendError).toBeDefined();
  });

  it('with a deadline, a send past its store is answered by its row the moment it is stored', async () => {
    slowSend(0, 12_000, 60_000);
    const p = deliverToSession(target, { ...notice, deadline: true });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(p).resolves.toEqual({ delivery: 'queued', messageId: 'qm-row' });
  });

  it('with a deadline, a store that never ends is unconfirmed: never "retry"', async () => {
    slowSend(0, 10 * 60_000);
    const p = deliverToSession(target, { ...notice, deadline: true });
    const unsure = expect(p).rejects.toMatchObject({ code: 'delivery_unconfirmed' });
    await vi.advanceTimersByTimeAsync(8_000 + 90_000);
    await unsure;
  });
});
