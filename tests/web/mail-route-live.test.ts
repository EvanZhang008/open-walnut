import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessageDto, MailRouteDto } from '../../web/src/api/mail.js';
import { onMailRouteChanged } from '../../web/src/apps/mail/mail-route-live.js';
import { __resetMailStore, getMailSnapshot, patch } from '../../web/src/apps/mail/mail-store.js';
import { groupedRows, loadGroupPage, resetMailGroupsStore } from '../../web/src/apps/mail/mail-groups-store.js';

const message = (accountId = 'fixture:one', messageId = 'INBOX:1:1'): MailMessageDto => ({ accountId, messageId,
  subject: 'Dock schedule', flags: ['\\Seen'], attachments: [], hasBody: true } as MailMessageDto);
const receipt = (at: number, status: MailRouteDto['status'] = 'routing'): MailRouteDto => ({ at, status, areaId: 'personal', reason: 'Thread owner' });
const event = (route: MailRouteDto, account = 'fixture:one', id = 'INBOX:1:1', version?: string) =>
  ({ source: { kind: 'mail', account, message: id, ...(version !== undefined ? { version } : {}) }, route });
// One conversation handle the provider reused: the old message, then a new reply under the same id.
const OLD = 'v-1730000000000';
const NEW = 'v-1730000600000';
const delivery = (deliveryVersion: string): MailMessageDto => ({ ...message(), deliveryVersion });

beforeEach(() => {
  __resetMailStore();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('A route event must not read or write mail'); }));
});
afterEach(() => { vi.unstubAllGlobals(); __resetMailStore(); resetMailGroupsStore(); });

describe('mail route event', () => {
  it('patches the same exact item in the list, search and reader without touching its body or flags', () => {
    const row = { ...message(), routingUnavailable: true };
    const sibling = message('fixture:two');
    const body = { format: 'text' as const, text: 'Cached original', bytes: 15, truncated: false };
    patch({ messages: [row, sibling], search: { ...getMailSnapshot().search, messages: [row] },
      open: { accountId: row.accountId, messageId: row.messageId, message: row, body } as never });
    onMailRouteChanged(event(receipt(10, 'routed')));
    const state = getMailSnapshot();
    for (const one of [state.messages[0], state.search.messages[0], state.open!.message]) {
      expect(one).toMatchObject({ route: receipt(10, 'routed'), flags: ['\\Seen'], routingUnavailable: false });
    }
    expect(state.messages[1]).toBe(sibling);
    expect(state.open!.body).toBe(body);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores an older event arriving after the settled receipt', () => {
    patch({ messages: [message()] });
    onMailRouteChanged(event(receipt(11, 'routed')));
    onMailRouteChanged(event(receipt(10, 'routing')));
    expect(getMailSnapshot().messages[0]!.route).toEqual(receipt(11, 'routed'));
  });

  it('never patches another account, another message or malformed timestamps', () => {
    const row = message();
    patch({ messages: [row] });
    onMailRouteChanged(event(receipt(10), 'fixture:two'));
    onMailRouteChanged(event(receipt(10), 'fixture:one', 'INBOX:1:2'));
    onMailRouteChanged(event(receipt(Number.NaN)));
    expect(getMailSnapshot().messages[0]).toBe(row);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a fixture with no version on either side still matches, as before', () => {
    patch({ messages: [message()] });
    onMailRouteChanged(event(receipt(10, 'routed')));
    expect(getMailSnapshot().messages[0]!.route).toEqual(receipt(10, 'routed'));
  });
});

describe('a reused id: the receipt belongs to one delivery', () => {
  it('a late receipt of the old delivery never lands on the new reply in the list, search or reader', () => {
    const fresh = delivery(NEW);
    patch({ messages: [fresh], search: { ...getMailSnapshot().search, messages: [fresh] },
      open: { accountId: fresh.accountId, messageId: fresh.messageId, message: fresh } as never });
    // Newer timestamp too, so only the version guard can refuse it.
    onMailRouteChanged(event(receipt(50, 'routed'), 'fixture:one', 'INBOX:1:1', OLD));
    const state = getMailSnapshot();
    for (const one of [state.messages[0], state.search.messages[0], state.open!.message]) expect(one).toBe(fresh);
  });

  it('a receipt with no version never lands on a versioned row, nor a versioned one on a row with none', () => {
    const fresh = delivery(NEW);
    const legacy = message('fixture:two');
    patch({ messages: [fresh, legacy] });
    onMailRouteChanged(event(receipt(10, 'routed')));
    onMailRouteChanged(event(receipt(10, 'routed'), 'fixture:two', 'INBOX:1:1', NEW));
    expect(getMailSnapshot().messages[0]).toBe(fresh);
    expect(getMailSnapshot().messages[1]).toBe(legacy);
  });

  it('the new delivery takes its own receipt, and the old one arriving after it changes nothing', () => {
    patch({ messages: [delivery(OLD)] });
    onMailRouteChanged(event(receipt(10, 'routed'), 'fixture:one', 'INBOX:1:1', OLD));
    expect(getMailSnapshot().messages[0]!.route).toEqual(receipt(10, 'routed'));
    // The provider reuses the id for a new reply: the refreshed row carries no receipt yet.
    patch({ messages: [delivery(NEW)] });
    onMailRouteChanged(event(receipt(20, 'routing'), 'fixture:one', 'INBOX:1:1', NEW));
    onMailRouteChanged(event(receipt(30, 'routed'), 'fixture:one', 'INBOX:1:1', OLD));
    expect(getMailSnapshot().messages[0]).toMatchObject({ deliveryVersion: NEW, route: receipt(20, 'routing') });
    // The at guard still holds within one delivery.
    onMailRouteChanged(event(receipt(15, 'failed'), 'fixture:one', 'INBOX:1:1', NEW));
    expect(getMailSnapshot().messages[0]!.route).toEqual(receipt(20, 'routing'));
  });

  it('the grouped pages apply the same version and time guards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [delivery(NEW)] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await loadGroupPage({ role: 'inbox' }, 'personal', '', 'first');
    expect(groupedRows()).toHaveLength(1);
    onMailRouteChanged(event(receipt(50, 'routed'), 'fixture:one', 'INBOX:1:1', OLD));
    expect(groupedRows()[0]!.route).toBeUndefined();
    onMailRouteChanged(event(receipt(20, 'routing'), 'fixture:one', 'INBOX:1:1', NEW));
    expect(groupedRows()[0]).toMatchObject({ deliveryVersion: NEW, route: receipt(20, 'routing'), routingUnavailable: false });
    onMailRouteChanged(event(receipt(10, 'failed'), 'fixture:one', 'INBOX:1:1', NEW));
    onMailRouteChanged(event(receipt(60, 'failed'), 'fixture:one', 'INBOX:1:1', OLD));
    expect(groupedRows()[0]!.route).toEqual(receipt(20, 'routing'));
  });
});
