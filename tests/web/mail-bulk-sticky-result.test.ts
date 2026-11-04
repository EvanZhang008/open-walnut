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

  // 2026-11-04 (CI): a second press on the same group took its slot, so the first line's Retry did
  // nothing and its Undo reverted the second job. Each line's buttons act on that line's own job.
  describe('after a second press on the same group', () => {
    async function twoPresses(): Promise<void> {
      await pressWithFailures();
      await vi.advanceTimersByTimeAsync(1_000);
      api.markMailGroupRead.mockResolvedValue({ jobId: 'job-4', total: 2 });
      await startBulkRead({ scope: SCOPE, groupId: 'g-1', groupLabel: 'Newsletters' }, { watermark: { at: 2, seq: 2 }, rulesRev: 'r1', total: 2 });
      finish('job-4', { changedCount: 2, failedCount: 0 });
    }
    const lineWith = (testId: string) => mailListStatusSnapshot(VIEW).filter((one) => one.actions?.some((a) => a.testId === testId));
    const firstLine = () => mailListStatusSnapshot(VIEW).find((one) => one.actions?.some((a) => a.testId === 'mail-bulk-retry'))!;

    it('the first line keeps its Retry, which retries the first job', async () => {
      await twoPresses();
      expect(lineWith('mail-bulk-undo')).toHaveLength(2);
      firstLine().actions!.find((a) => a.testId === 'mail-bulk-retry')!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.retryMailBulkJob).toHaveBeenCalledWith('job-1');
    });

    it("each line's Undo reverts its own job", async () => {
      await twoPresses();
      const second = mailListStatusSnapshot(VIEW).find((one) => !one.actions?.some((a) => a.testId === 'mail-bulk-retry'))!;
      firstLine().actions!.find((a) => a.testId === 'mail-bulk-undo')!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.undoMailBulkJob).toHaveBeenLastCalledWith('job-1');
      finish('job-3', { changedCount: 8, failedCount: 0 });
      mailListStatusSnapshot(VIEW).find((one) => one.id === second.id)!.actions!.find((a) => a.testId === 'mail-bulk-undo')!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.undoMailBulkJob).toHaveBeenLastCalledWith('job-4');
    });

    it('a line pressed while another job runs on the group starts nothing', async () => {
      await pressWithFailures();
      const retry = action('mail-bulk-retry')!;
      api.markMailGroupRead.mockResolvedValue({ jobId: 'job-4', total: 2 });
      await startBulkRead({ scope: SCOPE, groupId: 'g-1' }, { watermark: { at: 2, seq: 2 }, rulesRev: 'r1', total: 2 });
      retry.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.retryMailBulkJob).not.toHaveBeenCalled();
    });
  });
});
