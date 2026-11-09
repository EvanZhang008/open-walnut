/**
 * A group the person reads to zero under the pointer stays drawn until the pointer leaves the list.
 *
 * The bug this pins (2026-11-07, mail router receipts): a group that first showed up in a `/groups`
 * answer read while the pointer was AWAY from the list had no `held` row. The person moved onto the
 * list (`holdGroupOrder`), opened its only unread mail, and the optimistic read
 * (`applySeenToGroupedRows`) marked the group worked and moved its count to 0, but wrote no `held`
 * row, so `drawnGroups` dropped the group in that very frame: the row with its routing receipt
 * vanished from under the pointer while the reader still showed the same mail.
 *
 * Only the API layer is replaced (the two network calls the store makes). Every assertion reads the
 * real store through its exported API, never its internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessageDto, MailRouteDto } from '../../web/src/api/mail';
import type { MailGroupItem, MailGroupsResponse } from '../../web/src/api/mail-groups';

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

import {
  applySeenToGroupedRows, drawnGroups, groupedRowOf, holdGroupOrder, letGroupGo, loadGroupPage, loadGroups,
  releaseSpentGroups, resetMailGroupsStore, viewState,
} from '../../web/src/apps/mail/mail-groups-store';

const SCOPE = { role: 'inbox' as const };
const GROUP = 'newsletters';
const ACCOUNT = 'fixture:one';
const MESSAGE = { accountId: ACCOUNT, mailboxId: 'INBOX', messageId: 'INBOX:1:7' };

const RECEIPT: MailRouteDto = {
  at: 1_730_000_000_000, status: 'routed', areaId: 'personal', reason: 'Thread owner',
  taskId: 'task-receipt', target: { id: 'task-receipt', title: 'Dock schedule follow-up', kind: 'task', available: true },
} as MailRouteDto;

function groupRow(unread: number): MailGroupItem {
  return {
    id: GROUP, label: 'Newsletters', unread, newestAt: 1_730_000_000_000,
    topSenders: [{ key: 'news@example.invalid', label: 'News', unread }],
    unsubscribable: 0, markableUnread: unread, readOnlyAccounts: [],
    watermark: { at: 1_730_000_000_000, seq: 2 },
  };
}

function answer(groups: MailGroupItem[]): MailGroupsResponse {
  return {
    rulesRev: 'r1', seq: groups.length, ai: { state: 'off', pending: 0 },
    important: { total: 0, unread: 0 },
    cachedTotal: 1, cachedUnread: groups.reduce((sum, one) => sum + one.unread, 0),
    providerTotal: 1, providerUnread: groups.reduce((sum, one) => sum + one.unread, 0),
    groups,
  };
}

function mailRow(): MailMessageDto {
  return {
    ...MESSAGE,
    rfcMessageId: '<7@example.invalid>',
    from: { name: 'News', address: 'news@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: 'Dock schedule', snippet: 'The dock moves to Friday', sentAt: 1_730_000_000_000,
    flags: [], attachments: [], hasBody: true,
    sort: { group: GROUP, label: 'Newsletters', reason: 'rule', why: 'Bulk sender' },
    senderKey: 'news@example.invalid',
    route: RECEIPT,
  } as MailMessageDto;
}

const shown = () => drawnGroups(viewState(SCOPE)).map(({ group, unread }) => ({ id: group.id, unread }));

/**
 * The view as the bug found it: the first `/groups` answer had no group, the next one (read while
 * the pointer was away from the list) brought G with one unread, and G's open page holds that mail.
 */
async function groupArrivesAwayFromList(): Promise<void> {
  api.getMailGroups.mockResolvedValueOnce(answer([]));
  await loadGroups(SCOPE, true);
  expect(shown()).toEqual([]);
  api.getMailGroups.mockResolvedValueOnce(answer([groupRow(1)]));
  await loadGroups(SCOPE, true);
  api.listMailMessages.mockResolvedValueOnce({ messages: [mailRow()] });
  await loadGroupPage(SCOPE, GROUP, '', 'first', true, true, true);
  expect(shown()).toEqual([{ id: GROUP, unread: 1 }]);
  expect(groupedRowOf(MESSAGE)?.route).toEqual(RECEIPT);
}

beforeEach(() => {
  resetMailGroupsStore();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMailGroupsSummary.mockResolvedValue({ importantUnread: 0, sortedUnread: 0, pending: 0, rulesRev: 'r1' });
  // Any read the test did not plan for answers the same page, so a stray refresh cannot hang it.
  api.listMailMessages.mockResolvedValue({ messages: [mailRow()] });
});
afterEach(() => { resetMailGroupsStore(); });

describe('a group read to zero under the pointer', () => {
  it('stays drawn at 0 with the same receipt row while the pointer is over the list', async () => {
    await groupArrivesAwayFromList();
    holdGroupOrder(SCOPE, [GROUP]);
    applySeenToGroupedRows(MESSAGE, true);

    expect(shown()).toEqual([{ id: GROUP, unread: 0 }]);
    const row = groupedRowOf(MESSAGE);
    expect(row?.flags).toContain('\\Seen');
    expect(row?.route).toEqual(RECEIPT);
    expect(row?.sort?.group).toBe(GROUP);
  });

  it('stays drawn when a /groups answer without it lands while the pointer is still over the list', async () => {
    await groupArrivesAwayFromList();
    holdGroupOrder(SCOPE, [GROUP]);
    applySeenToGroupedRows(MESSAGE, true);
    api.getMailGroups.mockResolvedValueOnce(answer([]));
    await loadGroups(SCOPE, true);

    expect(shown()).toEqual([{ id: GROUP, unread: 0 }]);
    expect(groupedRowOf(MESSAGE)?.route).toEqual(RECEIPT);
  });

  it('leaves once the pointer leaves the list', async () => {
    await groupArrivesAwayFromList();
    holdGroupOrder(SCOPE, [GROUP]);
    applySeenToGroupedRows(MESSAGE, true);
    expect(shown()).toEqual([{ id: GROUP, unread: 0 }]);

    holdGroupOrder(SCOPE, null);
    releaseSpentGroups(SCOPE);
    expect(shown()).toEqual([]);
  });

  it('is not held when the pointer was never over the list', async () => {
    await groupArrivesAwayFromList();
    applySeenToGroupedRows(MESSAGE, true);
    expect(shown()).toEqual([]);
  });

  it('a group marked read as a whole is not brought back by a later read in it', async () => {
    await groupArrivesAwayFromList();
    holdGroupOrder(SCOPE, [GROUP]);
    letGroupGo(SCOPE, GROUP);
    applySeenToGroupedRows(MESSAGE, true);
    expect(shown()).toEqual([]);
  });

  it('a refused read puts the count back under the pointer', async () => {
    await groupArrivesAwayFromList();
    holdGroupOrder(SCOPE, [GROUP]);
    applySeenToGroupedRows(MESSAGE, true);
    expect(shown()).toEqual([{ id: GROUP, unread: 0 }]);

    applySeenToGroupedRows(MESSAGE, false);
    expect(shown()).toEqual([{ id: GROUP, unread: 1 }]);
    const row = groupedRowOf(MESSAGE);
    expect(row?.flags).not.toContain('\\Seen');
    expect(row?.route).toEqual(RECEIPT);
  });

  it('a refused read away from the list brings the group back with its count', async () => {
    await groupArrivesAwayFromList();
    applySeenToGroupedRows(MESSAGE, true);
    expect(shown()).toEqual([]);
    applySeenToGroupedRows(MESSAGE, false);
    expect(shown()).toEqual([{ id: GROUP, unread: 1 }]);
  });
});
