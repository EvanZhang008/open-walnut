/**
 * What the mail router's noise decision does to an email (src/integrations/mail/router-noise.ts),
 * below the routes: a real database, the real service's markRead and the real filter mover, against
 * in-test providers (one that can archive, one that cannot). The router side (when it is called, and
 * the reason it writes) is pinned in tests/core/router-service.test.ts.
 *
 * What it pins:
 * - inbox mail is marked read first, then moved to the archive, and the inbox row leaves the cache;
 * - mail in any other folder is only marked read: its folder was someone's choice;
 * - mail already read is not flagged again, and a changed or missing copy is left alone;
 * - an account that cannot archive, or a move the server refuses, says so and keeps the mail;
 * - the copy is checked again right before the move: a reply that arrived meanwhile stays in the inbox;
 * - the noise move is no rule's (none exists here), and nothing is ever deleted on the server.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import type { RouterSource } from '../../src/core/router/types.js'
import { MailBodyStore } from '../../src/integrations/mail/bodies.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { CANNOT_ARCHIVE, MailFilterMover } from '../../src/integrations/mail/mail-filter-moves.js'
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js'
import { tidyNoiseMail, type MailNoiseDeps } from '../../src/integrations/mail/router-noise.js'
import { mailRowDeliveryVersion } from '../../src/integrations/mail/router-source.js'
import { MailService } from '../../src/integrations/mail/service.js'
import { MailStore } from '../../src/integrations/mail/store.js'
import type { MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js'

const MARINA = 'fx:marina'
const FERRY = 'plain:ferry'
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0)

interface Rig {
  dir: string
  client: PluginDatabaseClient
  db: MailDatabase
  store: MailStore
  service: MailService
  mover: MailFilterMover
  calls: string[]
  answer: (messageId: string) => { ok: boolean; reason?: string }
}

let rig: Rig

function spec(id: string, archive: boolean): MailProviderSpec {
  return {
    id,
    label: id,
    capabilities: {
      search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none', ...(archive ? { archive: true } : {}),
    },
    setup: { fields: [], submit: async () => { throw new Error('no setup') } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    send: async () => { throw new Error('cannot send') },
    markRead: async (_account: string, messageId: string, read: boolean) => { rig.calls.push(`read:${messageId}:${read}`) },
    ...(archive ? {
      archiveMany: async (_account: string, ids: string[]) => {
        rig.calls.push(`archive:${ids.join(',')}`)
        return ids.map((messageId) => ({ messageId, ...rig.answer(messageId) }))
      },
    } : {}),
  } as MailProviderSpec
}

function mail(n: number, extra: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: `INBOX:1:${n}`,
    rfcMessageId: `<n${n}@shop.example.invalid>`,
    mailboxId: 'INBOX',
    from: { address: 'news@shop.example.invalid', name: 'Shop' },
    to: [{ address: 'robin@marina.example.invalid' }],
    subject: `Weekly offers ${n}`,
    sentAt: T0 - n * 60_000,
    receivedAt: T0 - n * 60_000,
    flags: [],
    ...extra,
  }
}

function deps(): MailNoiseDeps {
  return {
    store: rig.store,
    canMarkRead: () => true,
    markRead: (accountId, messageId) => rig.service.markRead(accountId, messageId, true),
    canArchive: (accountId) => rig.mover.canArchive(accountId),
    archive: (accountId, messageId, stillCurrent) => rig.mover.archiveNow(accountId, messageId, stillCurrent),
  }
}

/** The router's exact source for a cached row: its delivery version included. */
async function sourceOf(account: string, messageId: string): Promise<RouterSource> {
  const row = await rig.store.getMessage(account, messageId)
  return { kind: 'mail', account, message: messageId, version: mailRowDeliveryVersion(row!) }
}

const cached = async (account: string, messageId: string) => rig.store.getMessage(account, messageId)
const seen = async (account: string, messageId: string) => JSON.parse((await cached(account, messageId))?.flags_json ?? '[]').includes('\\Seen')

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-noise-'))
  const client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  for (const [account, provider] of [[MARINA, 'fx'], [FERRY, 'plain']] as const) {
    await client.run('INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, ?, ?, ?)', [account, provider, 'Robin', `robin@${provider}.example.invalid`])
    await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role, unread, total) VALUES (?, 'INBOX', 'Inbox', 'inbox', 0, 0)", [account])
    await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'Receipts', 'Receipts', 'other')", [account])
  }
  const db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  const store = new MailStore(db)
  const bodies = new MailBodyStore(dir)
  const providers = new MailProviderRegistry(() => undefined)
  providers.register(spec('fx', true), 'test')
  providers.register(spec('plain', false), 'test')
  // No sort rule exists at all: every rule-driven move would be dropped, the noise move is not.
  const mover = new MailFilterMover({
    store, bodies, providers,
    groupsChanged: () => undefined,
    ruleLive: async () => false,
    timeout: () => ({ dispose: () => undefined }),
    now: () => T0,
  })
  const service = new MailService({ store, bodies, providers, filters: mover })
  rig = { dir, client, db, store, service, mover, calls: [], answer: () => ({ ok: true }) }
})

afterEach(async () => {
  rig.mover.dispose()
  await rig.db.dispose().catch(() => undefined)
  await fsp.rm(rig.dir, { recursive: true, force: true })
})

describe('a noise email in the inbox', () => {
  it('is marked read, then moved to the archive, and its inbox row leaves the cache', async () => {
    await rig.service.ingestPage(MARINA, [mail(1)])
    const outcome = await tidyNoiseMail(deps(), await sourceOf(MARINA, 'INBOX:1:1'))
    expect(outcome).toEqual({ read: true, archived: true })
    expect(rig.calls).toEqual(['read:INBOX:1:1:true', 'archive:INBOX:1:1'])
    expect(await cached(MARINA, 'INBOX:1:1')).toBeUndefined()
    // No move ledger row: the noise move is no rule's, and is never retried in the background.
    expect(await rig.client.get('SELECT COUNT(*) AS n FROM mail_filter_moves')).toEqual({ n: 0 })
  })

  it('already read: only moved', async () => {
    await rig.service.ingestPage(MARINA, [mail(2, { flags: ['\\Seen'] })])
    expect(await tidyNoiseMail(deps(), await sourceOf(MARINA, 'INBOX:1:2'))).toEqual({ read: true, archived: true })
    expect(rig.calls).toEqual(['archive:INBOX:1:2'])
  })

  it('an account with no archive: marked read, kept in the inbox, and the reason is given', async () => {
    await rig.service.ingestPage(FERRY, [mail(3)])
    expect(await tidyNoiseMail(deps(), await sourceOf(FERRY, 'INBOX:1:3'))).toEqual({ read: true, archived: false, note: 'this account has no archive' })
    expect(await seen(FERRY, 'INBOX:1:3')).toBe(true)
    expect(rig.mover.canArchive(FERRY)).toBe(false)
    expect(await rig.mover.archiveNow(FERRY, 'INBOX:1:3', async () => true)).toEqual({ ok: false, reason: CANNOT_ARCHIVE })
  })

  it('a move the server refuses keeps the mail in the inbox, read, and says why', async () => {
    rig.answer = () => ({ ok: false, reason: 'The server said no.' })
    await rig.service.ingestPage(MARINA, [mail(4)])
    expect(await tidyNoiseMail(deps(), await sourceOf(MARINA, 'INBOX:1:4'))).toEqual({ read: true, archived: false, note: 'The server said no.' })
    expect(await cached(MARINA, 'INBOX:1:4')).toBeDefined()
    expect(await seen(MARINA, 'INBOX:1:4')).toBe(true)
  })
})

describe('a noise email the router may not move', () => {
  it('in another folder: only marked read', async () => {
    await rig.service.ingestPage(MARINA, [mail(5, { messageId: 'Receipts:1:5', mailboxId: 'Receipts' })])
    expect(await tidyNoiseMail(deps(), await sourceOf(MARINA, 'Receipts:1:5'))).toEqual({ read: true, archived: false })
    expect(rig.calls).toEqual(['read:Receipts:1:5:true'])
    expect(await cached(MARINA, 'Receipts:1:5')).toBeDefined()
  })

  it('a copy that changed between the flag and the move stays in the inbox', async () => {
    await rig.service.ingestPage(MARINA, [mail(7)])
    const source = await sourceOf(MARINA, 'INBOX:1:7')
    const changing = deps()
    const markRead = changing.markRead
    changing.markRead = async (accountId, messageId) => {
      await markRead(accountId, messageId)
      // A reply lands in the same row (an Outlook conversation) while the flag call runs.
      await rig.service.ingestPage(MARINA, [mail(7, { subject: 'Re: Weekly offers 7', flags: ['\\Seen'] })])
    }
    expect(await tidyNoiseMail(changing, source)).toEqual({ read: true, archived: false, note: 'a later delivery replaced the email' })
    expect(rig.calls).toEqual(['read:INBOX:1:7:true'])
    expect(await cached(MARINA, 'INBOX:1:7')).toBeDefined()
  })

  it('a copy that changed or is gone is left alone, with no call to the server', async () => {
    await rig.service.ingestPage(MARINA, [mail(6)])
    const source = await sourceOf(MARINA, 'INBOX:1:6')
    expect(await tidyNoiseMail(deps(), { ...source, version: 'another-delivery' })).toEqual({ read: false, archived: false, note: 'a later delivery replaced the email' })
    expect(await tidyNoiseMail(deps(), { ...source, message: 'INBOX:1:404' })).toEqual({ read: false, archived: false, note: 'the email is no longer in the cache' })
    expect(rig.calls).toEqual([])
  })
})
