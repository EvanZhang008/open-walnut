/**
 * The IMAP provider's sorting signals (spec 5.8, 6.2, 6.3, C55 C56): a fake IMAP session records every
 * command, so what reaches the server is the evidence.
 *
 * - `Precedence` / `Auto-Submitted` ride the poll's header list and land on `envelope.bulkHeaders`,
 *   and they do NOT change the envelope hash (old rows are never rewritten to learn them).
 * - `markReadMany` is `UID STORE +FLAGS (\Seen)` in sets of at most 200 UIDs.
 * - `categoryHints` searches only when the server announces `X-GM-EXT-1`, and never stores a flag.
 * - `fetchListHeaders` asks for header FIELDS (imapflow's `headers` query, sent as `BODY.PEEK`),
 *   never the source, and never changes `\Seen`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ImapPool, setImapClientFactory, type ImapClient, type ImapFetchedMessage,
} from '../../src/integrations/mail-imap/client.js'
import { accountIdFor, ImapAccountStore } from '../../src/integrations/mail-imap/config.js'
import { encodeMessageId } from '../../src/integrations/mail-imap/coords.js'
import { BULK_HEADERS, LATE_HEADER_FIELDS, bulkHeadersOf, lateHeadersOf, toEnvelope, uidChunks } from '../../src/integrations/mail-imap/mime.js'
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js'
import { envelopeHashOf } from '../../src/integrations/mail/contract.js'
import type { MailProviderSpec } from '../../src/integrations/mail/types.js'

const ADDRESS = 'robin@marina.example.invalid'
const ACCOUNT = accountIdFor(ADDRESS)
const LATE = [
  'List-Unsubscribe: <https://leave.example.invalid/u/late>, <mailto:leave@lists.example.invalid>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'List-Id: The lists weekly <weekly.lists.example.invalid>',
  'Precedence: bulk',
].join('\r\n')

interface Wire {
  capabilities: string[]
  commands: Array<{ op: string; range?: string; query?: unknown; options?: unknown; flags?: string[] }>
  seen: Set<number>
  headers: Map<number, string>
}
let wire: Wire

class FakeImap implements ImapClient {
  usable = true
  get capabilities() { return new Map(wire.capabilities.map((name) => [name, true])) }
  async connect() { wire.commands.push({ op: 'connect' }) }
  async logout() {}
  close() {}
  async list() { return [{ path: 'INBOX', name: 'INBOX', flags: new Set<string>(), specialUse: '\\Inbox' }] as never }
  async mailboxOpen(path: string) {
    wire.commands.push({ op: 'select', range: path })
    return { path, uidValidity: 7n, uidNext: 500, exists: 400 } as never
  }
  async *fetch(range: string, query: unknown, options?: unknown): AsyncIterable<ImapFetchedMessage> {
    wire.commands.push({ op: 'fetch', range, query, options })
    for (const uid of range.split(',').map(Number)) {
      yield { uid, headers: Buffer.from(wire.headers.get(uid) ?? '') } as ImapFetchedMessage
    }
  }
  async fetchOne() { return false as const }
  async messageFlagsAdd(range: string, flags: string[], options?: unknown) {
    wire.commands.push({ op: 'store+', range, flags, options })
    for (const uid of range.split(',').map(Number)) wire.seen.add(uid)
    return true
  }
  async messageFlagsRemove(range: string, flags: string[], options?: unknown) {
    wire.commands.push({ op: 'store-', range, flags, options })
    for (const uid of range.split(',').map(Number)) wire.seen.delete(uid)
    return true
  }
  async search(query: unknown, options?: unknown) {
    wire.commands.push({ op: 'search', query, options })
    const raw = (query as { gmraw?: string }).gmraw
    return raw === 'category:promotions' ? [11, 12] : raw === 'category:social' ? [13] : []
  }
  async append() { return {} }
  on() { return this }
}

let provider: MailProviderSpec
let pool: ImapPool

beforeAll(async () => {
  setImapClientFactory(async () => new FakeImap())
  let config: Record<string, unknown> = {}
  const secrets = new Map<string, string>()
  const host = {
    config: { get: async () => config, patch: async (patch: Record<string, unknown>) => { config = { ...config, ...patch }; return config } },
    secrets: {
      get: async (key: string) => secrets.get(key), set: async (key: string, value: string) => { secrets.set(key, value) },
      delete: async (key: string) => { secrets.delete(key) }, list: async () => [...secrets.keys()],
    },
  }
  const store = new ImapAccountStore(host as never)
  const log = { debug: () => {}, info: () => {}, warn: () => {} }
  pool = new ImapPool({ settings: (id) => store.settings(id), password: (id) => store.password(id), log })
  provider = createImapProvider({ store, pool, log })
  await store.save({ address: ADDRESS, host: 'imap.example.invalid', port: 993, tls: 'tls', password: 'not-a-real-password', displayName: 'Harbour, Robin' })
})

afterAll(async () => {
  setImapClientFactory(null)
  await pool.disposeAll()
})

beforeEach(() => {
  wire = { capabilities: ['IMAP4rev1', 'IDLE'], commands: [], seen: new Set(), headers: new Map() }
})

const id = (uid: number) => encodeMessageId('INBOX', '7', uid)

describe('the poll carries Precedence and Auto-Submitted, outside the hash', () => {
  it('lists both headers and parses them lowercased (Auto-Submitted: no is not automated)', () => {
    expect([...BULK_HEADERS]).toEqual(['precedence', 'auto-submitted'])
    expect(bulkHeadersOf({ precedence: 'Bulk', 'auto-submitted': 'auto-generated' })).toEqual({ precedence: 'bulk', autoSubmitted: 'auto-generated' })
    expect(bulkHeadersOf({ 'auto-submitted': 'no' })).toBeUndefined()
    expect(bulkHeadersOf({})).toBeUndefined()
  })

  it('puts them on the envelope and leaves the envelope hash unchanged', () => {
    const base: ImapFetchedMessage = {
      uid: 5, flags: new Set<string>(), envelope: { subject: 'Moorings digest', from: [{ address: 'sam.keel@almanac.example.invalid' }], date: new Date(1_700_000_000_000) },
    } as never
    const plain = toEnvelope('INBOX', '7', { ...base, headers: Buffer.from('Message-ID: <a@example.invalid>') } as never)
    const bulk = toEnvelope('INBOX', '7', { ...base, headers: Buffer.from('Message-ID: <a@example.invalid>\r\nPrecedence: bulk') } as never)
    expect(bulk.bulkHeaders).toEqual({ precedence: 'bulk' })
    expect(plain.bulkHeaders).toBeUndefined()
    expect(envelopeHashOf(bulk)).toBe(envelopeHashOf(plain))
  })
})

describe('markReadMany: UID STORE in sets of 200', () => {
  it('sends one STORE per 200 UIDs and answers every id', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => id(i + 1))
    const out = await provider.markReadMany!(ACCOUNT, ids, true)
    const stores = wire.commands.filter((one) => one.op === 'store+')
    expect(stores.map((one) => one.range!.split(',').length)).toEqual([200, 200, 50])
    expect(stores.every((one) => JSON.stringify(one.flags) === JSON.stringify(['\\Seen']) && (one.options as { uid?: boolean }).uid)).toBe(true)
    expect(out.filter((one) => one.ok)).toHaveLength(450)
    expect(uidChunks([1, 2, 3], 2)).toEqual(['1,2', '3'])
  })

  it('marks unread with -FLAGS and refuses a handle that is not IMAP', async () => {
    const out = await provider.markReadMany!(ACCOUNT, [id(9), 'not-a-handle'], false)
    expect(wire.commands.filter((one) => one.op === 'store-').map((one) => one.range)).toEqual(['9'])
    expect(out.find((one) => one.messageId === 'not-a-handle')).toMatchObject({ ok: false })
  })
})

describe('categoryHints: Gmail only, read only (C55)', () => {
  it('sends no SEARCH at all without X-GM-EXT-1', async () => {
    expect(await provider.categoryHints!(ACCOUNT, 'INBOX')).toEqual({ promotions: [], social: [] })
    expect(wire.commands.some((one) => one.op === 'search')).toBe(false)
  })

  it('runs the two X-GM-RAW searches with X-GM-EXT-1 and never a STORE', async () => {
    wire.capabilities.push('X-GM-EXT-1')
    expect(await provider.categoryHints!(ACCOUNT, 'INBOX')).toEqual({ promotions: [id(11), id(12)], social: [id(13)] })
    expect(wire.commands.filter((one) => one.op === 'search').map((one) => one.query)).toEqual([
      { gmraw: 'category:promotions' }, { gmraw: 'category:social' },
    ])
    expect(wire.commands.some((one) => one.op.startsWith('store'))).toBe(false)
  })
})

describe('fetchListHeaders: header fields only, never \\Seen (C56)', () => {
  it('asks for the five header fields, parses them, and records "nothing there" as null', async () => {
    wire.headers.set(21, LATE)
    wire.headers.set(22, 'Subject: nothing to see')
    const out = await provider.fetchListHeaders!(ACCOUNT, 'INBOX', [id(21), id(22)])
    const fetches = wire.commands.filter((one) => one.op === 'fetch')
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.query).toEqual({ uid: true, headers: [...LATE_HEADER_FIELDS] })
    expect(JSON.stringify(fetches[0]!.query)).not.toMatch(/source|bodyParts|flags/)
    expect(wire.commands.some((one) => one.op.startsWith('store'))).toBe(false)
    expect(wire.seen.size).toBe(0)
    expect(out).toEqual([
      { messageId: id(21), headers: {
        listUnsubscribe: { https: ['https://leave.example.invalid/u/late'], mailto: ['mailto:leave@lists.example.invalid'], oneClick: true, listId: 'weekly.lists.example.invalid' },
        listUnsubscribePost: 'List-Unsubscribe=One-Click', listId: 'weekly.lists.example.invalid', precedence: 'bulk',
      } },
      { messageId: id(22), headers: null },
    ])
    expect(lateHeadersOf('')).toBeNull()
  })

  it('ignores ids from another folder', async () => {
    expect(await provider.fetchListHeaders!(ACCOUNT, 'INBOX', [encodeMessageId('Archive', '7', 3)])).toEqual([])
    expect(wire.commands.some((one) => one.op === 'fetch')).toBe(false)
  })
})
