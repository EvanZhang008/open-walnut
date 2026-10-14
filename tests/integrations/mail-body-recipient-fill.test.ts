/**
 * A conversation-shaped provider's body read fills the recipients its listing could not address.
 *
 * The listing names every participant by display name only (`{ name, address: '' }`), and only the
 * body read returns real addresses. 2026-10-14: an Outlook reply opened with an empty `To`, and
 * reply all with nobody in `Cc`, because the body never handed addresses over and the base treated a
 * list of bare names as "already known". These pin the base half against the real plugin database:
 *
 * - a list of bare names is a gap, and a body fills it (an addressed list is never touched);
 * - the read that fetched the body answers with the filled addresses at once;
 * - a later poll that only moves a flag keeps them (a cached body is never fetched again);
 * - a reply landing in the thread retires them with the body, so they never sit under a new sender.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailDrafts } from '../../src/integrations/mail/drafts.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { fillAddressesFromBody, recipientsForUpdate } from '../../src/integrations/mail/service-body.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { MailBody, MailCapabilities, MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'html', attachments: 'none',
};

const ACCOUNT = 'convo:acct-1';
const THREAD = 'inbox:conv-alder';
const FIRST_AT = Date.UTC(2026, 9, 13, 16, 0, 0);
const REPLY_AT = Date.UTC(2026, 9, 14, 9, 30, 0);
const MINE = 'birch@example.test';

/** What the body read hands over: the newest node's real addresses. */
const BODY: MailBody = {
  format: 'html',
  html: '<p>Please confirm the details.</p>',
  text: 'Please confirm the details.',
  bytes: 33,
  from: { name: 'Alder Desk', address: 'alder@example.test' },
  to: [{ name: 'Birch, Sam', address: MINE }],
  cc: [{ address: 'cedar@example.test' }, { address: 'dogwood@example.test' }],
};

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openBase(body: { current: MailBody }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-recipient-fill-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const bodyReads: string[] = [];
  const spec: MailProviderSpec = {
    id: 'convo',
    label: 'A conversation-shaped fixture',
    capabilities: { ...CAPABILITIES },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (_account, messageId) => { bodyReads.push(messageId); return body.current; },
    send: async () => ({ acceptedAt: Date.now() }),
  };
  providers.register(spec, 'the-fixture-plugin');
  const service = new MailService({ store, bodies, providers, log: { info: vi.fn(), debug: vi.fn() } });
  await store.upsertAccount({
    accountId: ACCOUNT, providerId: 'convo', displayName: 'A mailbox', address: MINE,
    state: 'active', healthJson: null, payload: '{}',
  });
  return { store, service, bodyReads };
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** The thread as a conversation listing shows it: names, and not one address. */
function listed(over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: THREAD,
    rfcMessageId: 'conv-alder',
    mailboxId: 'inbox',
    from: { name: 'Alder Desk', address: '' },
    to: [{ name: 'Birch, Sam', address: '' }],
    subject: 'Please confirm',
    snippet: 'Please confirm the details.',
    sentAt: FIRST_AT,
    receivedAt: FIRST_AT,
    flags: [],
    ...over,
  };
}

describe('fillAddressesFromBody: a list of bare names is a gap', () => {
  it('fills to and cc when every stored entry is a name with no address', () => {
    const fill = fillAddressesFromBody({
      fromAddr: '',
      payload: { from: { name: 'Alder Desk', address: '' }, to: [{ name: 'Birch, Sam', address: '' }] },
    }, BODY);
    expect(fill.filled.sort()).toEqual(['cc', 'from', 'to']);
    expect(fill.fromAddr).toBe('alder@example.test');
    expect(fill.payload.to).toEqual([{ name: 'Birch, Sam', address: MINE }]);
    expect(fill.payload.cc).toEqual([{ address: 'cedar@example.test' }, { address: 'dogwood@example.test' }]);
  });

  it('never replaces a list that already holds an address', () => {
    const fill = fillAddressesFromBody({
      fromAddr: 'elm@example.test',
      payload: { from: { address: 'elm@example.test' }, to: [{ address: 'fir@example.test' }, { name: 'Bare' } as never] },
    }, BODY);
    expect(fill.filled).toEqual(['cc']);
    expect(fill.fromAddr).toBeUndefined();
    expect(fill.payload.to).toEqual([{ address: 'fir@example.test' }, { name: 'Bare' }]);
  });

  it('drops a directory path offered as an address, and fills nothing from it', () => {
    const fill = fillAddressesFromBody({ fromAddr: '', payload: {} }, {
      ...BODY,
      from: { name: 'Grove Team', address: '/o=ExchangeLabs/ou=Exchange/cn=Recipients/cn=grove' },
      to: undefined,
      cc: undefined,
    });
    expect(fill.filled).toEqual([]);
    expect(fill.dropped).toEqual(['from']);
  });
});

describe('recipientsForUpdate', () => {
  const learned = [{ name: 'Birch, Sam', address: MINE }];
  it('keeps a learned list when the envelope names nobody by address', () => {
    expect(recipientsForUpdate([{ name: 'Birch, Sam', address: '' }], learned)).toBe(learned);
    expect(recipientsForUpdate(undefined, learned)).toBe(learned);
  });
  it('takes the envelope list whenever it names an address itself', () => {
    const offered = [{ address: 'holly@example.test' }];
    expect(recipientsForUpdate(offered, learned)).toBe(offered);
  });
  it('passes the envelope through when nothing was learned', () => {
    const offered = [{ name: 'Birch, Sam', address: '' }];
    expect(recipientsForUpdate(offered, undefined)).toBe(offered);
  });
});

describe('the base, end to end on the real database', () => {
  it('the read that fetched the body answers with every address, and the list keeps them', async () => {
    const one = await openBase({ current: BODY });
    await one.service.ingestPage(ACCOUNT, [listed()]);

    const read = await one.service.readMessage(ACCOUNT, THREAD);
    expect(read.message.from).toEqual({ name: 'Alder Desk', address: 'alder@example.test' });
    expect(read.message.to).toEqual([{ name: 'Birch, Sam', address: MINE }]);
    expect(read.message.cc).toEqual([{ address: 'cedar@example.test' }, { address: 'dogwood@example.test' }]);

    // A second open is served from disk and says the same.
    const again = await one.service.readMessage(ACCOUNT, THREAD);
    expect(again.message.cc?.map((a) => a.address)).toEqual(['cedar@example.test', 'dogwood@example.test']);
    expect(one.bodyReads).toEqual([THREAD]);
  });

  it('a poll that only marks the thread read keeps the learned addresses', async () => {
    const one = await openBase({ current: BODY });
    await one.service.ingestPage(ACCOUNT, [listed()]);
    await one.service.readMessage(ACCOUNT, THREAD);

    await one.service.ingestPage(ACCOUNT, [listed({ flags: ['\\Seen'] })]);
    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 10 });
    const row = page.messages.find((m) => m.messageId === THREAD)!;
    expect(row.flags).toContain('\\Seen');
    expect(row.from?.address).toBe('alder@example.test');
    expect(row.to).toEqual([{ name: 'Birch, Sam', address: MINE }]);
    expect(row.cc?.map((a) => a.address)).toEqual(['cedar@example.test', 'dogwood@example.test']);
    expect(one.bodyReads).toEqual([THREAD]);
  });

  it('a reply landing in the thread retires the old addresses, and the next read learns the new ones', async () => {
    const body = { current: BODY };
    const one = await openBase(body);
    await one.service.ingestPage(ACCOUNT, [listed()]);
    await one.service.readMessage(ACCOUNT, THREAD);

    await one.service.ingestPage(ACCOUNT, [listed({
      from: { name: 'Ivy Ops', address: '' }, sentAt: REPLY_AT, receivedAt: REPLY_AT,
    })]);
    const moved = await one.service.readEnvelope(ACCOUNT, THREAD);
    // Nothing of the old newest message stays under the new sender's name.
    expect(moved.from).toEqual({ name: 'Ivy Ops', address: '' });
    expect(moved.to).toEqual([{ name: 'Birch, Sam', address: '' }]);
    expect(moved.cc ?? []).toEqual([]);

    body.current = {
      ...BODY,
      from: { name: 'Ivy Ops', address: 'ivy@example.test' },
      cc: [{ address: 'juniper@example.test' }],
    };
    const read = await one.service.readMessage(ACCOUNT, THREAD);
    expect(read.message.from).toEqual({ name: 'Ivy Ops', address: 'ivy@example.test' });
    expect(read.message.cc).toEqual([{ address: 'juniper@example.test' }]);
    expect(one.bodyReads).toEqual([THREAD, THREAD]);
  });
});

describe('a reply with no address for its sender', () => {
  const drafts = new MailDrafts({ store: {} as never, events: { emit: () => undefined } as never });
  const row = (over: Record<string, unknown>) => ({
    draft_id: 'dr-1', account_id: ACCOUNT, in_reply_to: null, to_json: '[]', subject: 'Re: Please confirm',
    body_md: 'Confirmed.', revision: 1, state: 'composing', origin: 'console', payload: '{}', ...over,
  }) as never;

  it('may go out with an empty To only when the provider addresses the original sender itself', () => {
    const reply = row({ in_reply_to: 'conv-alder' });
    expect(() => drafts.assertSendable(reply, { send: true, replyAddressesSender: true })).not.toThrow();
    expect(() => drafts.assertSendable(reply, { send: true })).toThrow(/at least one recipient/);
  });

  it('a new message still needs a recipient, whatever the provider declares', () => {
    expect(() => drafts.assertSendable(row({}), { send: true, replyAddressesSender: true }))
      .toThrow(/at least one recipient/);
  });
});
