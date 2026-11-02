/**
 * A bulk result with failures stays on the status strip until it is pressed, so the job its Retry
 * and Undo name stays reachable as long as the line shows. The slot behind the line used to retire
 * a minute after the result, whatever the line did: from then on both buttons did nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  markMailGroupRead: vi.fn(),
  retryMailBulkJob: vi.fn(),
  undoMailBulkJob: vi.fn(),
  getMailBulkJob: vi.fn(),
  stopMailBulkJob: vi.fn(),
}));

vi.mock('@/api/mail-groups', () => api);
vi.mock('../../web/src/apps/mail/mail-groups-store', () => ({
  isGroupOpen: () => false, letGroupGo: vi.fn(), loadGroupPage: vi.fn(), loadGroups: vi.fn(async () => undefined),
  restyleRows: vi.fn(), peekView: () => undefined,
}));

import { finish, resetBulkForTests, startBulkRead } from '../../web/src/apps/mail/mail-bulk-read';
import { dismissMailListStatus, groupsViewKey, mailListStatusSnapshot } from '../../web/src/apps/mail/mail-groups-bus';

const SCOPE = { accountId: 'acct-1', mailboxId: 'INBOX' };
const VIEW = groupsViewKey(SCOPE);

beforeEach(() => {
  vi.useFakeTimers();
  resetBulkForTests();
  for (const one of mailListStatusSnapshot(VIEW)) dismissMailListStatus(one.id);
  for (const fn of Object.values(api)) fn.mockReset();
  api.markMailGroupRead.mockResolvedValue({ jobId: 'job-1', total: 10 });
  api.retryMailBulkJob.mockResolvedValue({ jobId: 'job-2', total: 2 });
  api.undoMailBulkJob.mockResolvedValue({ jobId: 'job-3', total: 8 });
});

afterEach(() => {
  resetBulkForTests();
  vi.useRealTimers();
});

async function pressWithFailures(): Promise<void> {
  await startBulkRead({ scope: SCOPE, groupId: 'g-1', groupLabel: 'Newsletters' }, { watermark: { at: 1, seq: 1 }, rulesRev: 'r1', total: 10 });
  finish('job-1', { changedCount: 8, failedCount: 2 }, 'The server refused it');
}

const action = (testId: string) => mailListStatusSnapshot(VIEW)[0]?.actions?.find((one) => one.testId === testId);

describe('a sticky bulk result', () => {
  it('keeps Retry working long after the slot timer of a passing result', async () => {
    await pressWithFailures();
    expect(action('mail-bulk-retry')?.label).toMatch(/^Retry 2/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    action('mail-bulk-retry')!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.retryMailBulkJob).toHaveBeenCalledWith('job-1');
  });

  it('keeps Undo working too', async () => {
    await pressWithFailures();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    action('mail-bulk-undo')!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.undoMailBulkJob).toHaveBeenCalledWith('job-1');
  });

  it('a result with no failures still lets its line and slot go', async () => {
    await startBulkRead({ scope: SCOPE, groupId: 'g-1' }, { watermark: { at: 1, seq: 1 }, rulesRev: 'r1', total: 10 });
    finish('job-1', { changedCount: 10, failedCount: 0 });
    expect(action('mail-bulk-undo')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mailListStatusSnapshot(VIEW)).toEqual([]);
  });
});
