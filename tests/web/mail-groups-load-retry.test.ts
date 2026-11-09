/**
 * A grouped read that failed on a dropped link recovers by itself, with no click.
 *
 * The bug this pins (2026-11-09, the person: "why this is not reload correctly? automatically"): a
 * deploy restarted the server under an open Mail window, every group page in flight failed with
 * WebKit's bare "Load failed", and nothing read them again, so five groups sat on "Load failed Retry".
 *
 * Only the API layer is replaced. The class guard at the end fails on a new read in the grouped store
 * whose failure does not go through the retry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessageDto } from '../../web/src/api/mail';
import type { MailGroupsResponse } from '../../web/src/api/mail-groups';

const api = vi.hoisted(() => ({
  getMailGroups: vi.fn(),
  getMailGroupsSummary: vi.fn(),
  listMailMessages: vi.fn(),
}));

vi.mock('@/api/mail-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/api/mail-groups')>()),
  getMailGroups: api.getMailGroups,
  getMailGroupsSummary: api.getMailGroupsSummary,
}));
vi.mock('@/api/mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/api/mail')>()),
  listMailMessages: api.listMailMessages,
}));

import { ApiError } from '../../web/src/api/client';
import {
  loadGroupPage, loadGroupedRailBadge, loadGroups, pageState, railValue, resetMailGroupsStore, resetPage, viewState,
} from '../../web/src/apps/mail/mail-groups-store';
import { pageKey } from '../../web/src/apps/mail/mail-groups-pages';
import { RETRY_DELAYS_MS, retryNow, retryPending } from '../../web/src/apps/mail/mail-load-retry';

const SCOPE = { role: 'inbox' as const };
const KEY = pageKey('smart:inbox', 'ci', '');
const LOAD_FAILED = () => new TypeError('Load failed');

const row = { accountId: 'fixture:one', mailboxId: 'INBOX', messageId: 'INBOX:1:7', subject: 'Build passed', flags: [] } as unknown as MailMessageDto;
const groupsAnswer = (unread: number): MailGroupsResponse => ({
  rulesRev: 'r1', seq: 1, ai: { state: 'off', pending: 0 }, important: { total: 0, unread: 0 },
  cachedTotal: 1, cachedUnread: unread, providerTotal: 1, providerUnread: unread,
  groups: [{
    id: 'ci', label: 'CI notifications', unread, newestAt: 1, topSenders: [], unsubscribable: 0,
    markableUnread: unread, readOnlyAccounts: [], watermark: { at: 1, seq: 1 },
  }],
} as unknown as MailGroupsResponse);

/** Let the store's awaited reads settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMailGroupsStore();
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  resetMailGroupsStore();
  vi.useRealTimers();
});

describe('a grouped page read that failed on a dropped link', () => {
  it('says it is reconnecting, then reads again by itself and shows the mail', async () => {
    api.listMailMessages.mockRejectedValueOnce(LOAD_FAILED()).mockResolvedValue({ messages: [row] });
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    expect(pageState(KEY)).toMatchObject({ retrying: true, error: null, loaded: false });
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    await flush();
    expect(pageState(KEY)).toMatchObject({ retrying: false, error: null, loaded: true });
    expect(pageState(KEY).rows).toHaveLength(1);
    expect(retryPending(`page:${KEY}:first`)).toBe(false);
  });

  it('backs off while the server stays down and reads at once when the link comes back', async () => {
    api.listMailMessages.mockRejectedValue(LOAD_FAILED());
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + RETRY_DELAYS_MS[1]!);
    await flush();
    expect(api.listMailMessages).toHaveBeenCalledTimes(3);
    expect(pageState(KEY).retrying).toBe(true);
    api.listMailMessages.mockReset();
    api.listMailMessages.mockResolvedValue({ messages: [row] });
    retryNow(); // what a socket reconnect, a visible edge and `online` call (wired in the browser)
    await flush();
    expect(api.listMailMessages).toHaveBeenCalledTimes(1);
    expect(pageState(KEY)).toMatchObject({ retrying: false, loaded: true, error: null });
  });

  it('shows the reason and Retry once the series runs out, and a wake still reads it again', async () => {
    api.listMailMessages.mockRejectedValue(LOAD_FAILED());
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    for (const delay of RETRY_DELAYS_MS) { await vi.advanceTimersByTimeAsync(delay); await flush(); }
    expect(api.listMailMessages).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(pageState(KEY)).toMatchObject({ retrying: false, error: 'Walnut did not answer (Load failed).' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.listMailMessages).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    api.listMailMessages.mockResolvedValue({ messages: [row] });
    retryNow(); // what a socket reconnect, a visible edge and `online` call (wired in the browser)
    await flush();
    expect(pageState(KEY)).toMatchObject({ error: null, loaded: true });
  });

  it('shows a refusal at once and never repeats it', async () => {
    api.listMailMessages.mockRejectedValue(new ApiError(401, 'auth', { error: 'auth', message: 'Sign in to the account again' }));
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    expect(pageState(KEY)).toMatchObject({ retrying: false, error: 'Sign in to the account again' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.listMailMessages).toHaveBeenCalledTimes(1);
  });

  it('a page that failed is read again by the next /groups answer even when its group did not move', async () => {
    api.getMailGroups.mockResolvedValue(groupsAnswer(3));
    await loadGroups(SCOPE, true);
    api.listMailMessages.mockRejectedValueOnce(new ApiError(503, 'down', { error: 'db_unavailable', message: 'The mail cache is busy' }));
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    // Spend the series so only the /groups answer can bring it back.
    api.listMailMessages.mockRejectedValue(new ApiError(503, 'down', { error: 'db_unavailable', message: 'The mail cache is busy' }));
    for (const delay of RETRY_DELAYS_MS) { await vi.advanceTimersByTimeAsync(delay); await flush(); }
    expect(pageState(KEY).error).toBe('The mail cache is busy');
    api.listMailMessages.mockResolvedValue({ messages: [row] });
    await loadGroups(SCOPE, true);
    await flush();
    expect(pageState(KEY)).toMatchObject({ error: null, loaded: true });
  });
});

describe('the retry stays one read and knows what is not a lost link', () => {
  it('a wake that reaches a read its timer also started reads once', async () => {
    let answer: (value: { messages: MailMessageDto[] }) => void = () => {};
    api.listMailMessages.mockRejectedValueOnce(LOAD_FAILED())
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(api.listMailMessages).toHaveBeenCalledTimes(2);
    retryNow();
    retryNow();
    await flush();
    expect(api.listMailMessages).toHaveBeenCalledTimes(2);
    answer({ messages: [row] });
    await flush();
    expect(pageState(KEY)).toMatchObject({ loaded: true, retrying: false });
  });

  it('a read in flight when the store is reset neither writes nor retries', async () => {
    let fail: (error: unknown) => void = () => {};
    api.listMailMessages.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const reading = loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    await flush();
    resetMailGroupsStore();
    fail(LOAD_FAILED());
    await reading;
    expect(retryPending(`page:${KEY}:first`)).toBe(false);
    expect(pageState(KEY)).toMatchObject({ retrying: false, error: null, loaded: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.listMailMessages).toHaveBeenCalledTimes(1);
  });

  it('a bug in the code reading the answer is shown at once, not as a lost connection', async () => {
    api.listMailMessages.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'messages')"));
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    expect(pageState(KEY).retrying).toBe(false);
    expect(pageState(KEY).error).toContain('Cannot read properties');
  });

  it('a deadline is a lost link too', async () => {
    api.listMailMessages.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError')).mockResolvedValue({ messages: [row] });
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    expect(pageState(KEY).retrying).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    await flush();
    expect(pageState(KEY).loaded).toBe(true);
  });

  it('forgetting a page (the unread filter changed) drops its waiting read', async () => {
    api.listMailMessages.mockRejectedValueOnce(LOAD_FAILED()).mockResolvedValue({ messages: [row] });
    await loadGroupPage(SCOPE, 'ci', '', 'first', true, true, true);
    resetPage(SCOPE, 'ci');
    expect(retryPending(`page:${KEY}:first`)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.listMailMessages).toHaveBeenCalledTimes(1);
  });
});

describe('the other grouped reads recover the same way', () => {
  it('/groups', async () => {
    api.getMailGroups.mockRejectedValueOnce(LOAD_FAILED()).mockResolvedValue(groupsAnswer(1));
    await loadGroups(SCOPE, true);
    expect(viewState(SCOPE)).toMatchObject({ retrying: true, error: null, groups: null });
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    await flush();
    expect(viewState(SCOPE)).toMatchObject({ retrying: false, error: null });
    expect(viewState(SCOPE).groups?.groups).toHaveLength(1);
  });

  it('the rail badge summary', async () => {
    api.getMailGroupsSummary.mockRejectedValueOnce(LOAD_FAILED()).mockResolvedValue({ importantUnread: 4, sortedUnread: 0, pending: 0, rulesRev: 'r1' });
    await loadGroupedRailBadge();
    expect(railValue()).toBeNull();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    await flush();
    expect(railValue()).toBe(4);
  });
});

describe('the class: every read in the grouped store retries a dropped link', () => {
  it('each catch of a failed read goes through retryLater', () => {
    const file = path.join(process.cwd(), 'web/src/apps/mail/mail-groups-store.ts');
    const text = fs.readFileSync(file, 'utf8');
    // A catch ends at the closing brace on its own indentation; a bare `catch {` counts too.
    const catches = [...text.matchAll(/^( *)\} catch (?:\(\w+\) )?\{([\s\S]*?)\n\1\}/gm)];
    expect(catches.length).toBeGreaterThanOrEqual(3);
    expect(catches.length).toBe((text.match(/\bcatch\b/g) ?? []).length);
    for (const [whole, , body] of catches) expect(/\bretryLater\(/.test(body!), whole.slice(0, 120)).toBe(true);
  });
});
