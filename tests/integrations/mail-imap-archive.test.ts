/**
 * The IMAP half of "keep out of the Inbox": `archiveMany` moves Inbox mail to the account's archive
 * folder with `UID MOVE`, against a fake ImapFlow (no socket).
 *
 * The facts pinned here are each a real way to lose or misfile mail:
 * - the target is the folder the person named, then `\Archive`, then Gmail's `\All`, then a folder
 *   CALLED Archive; an account with none moves nothing and says why;
 * - imapflow answers a refused MOVE with `false`, not a throw, so a resolved call is not a success;
 * - a server without MOVE is refused outright: imapflow's fallback there is COPY + `\Deleted` +
 *   EXPUNGE, which deletes even when the copy failed, and without UIDPLUS expunges every `\Deleted`
 *   mail in the folder;
 * - no flag is touched: unread mail arrives in the archive unread;
 * - a handle from before a UIDVALIDITY reset moves nothing: its UID may be another mail by now.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ImapPool,
  setImapClientFactory,
  type ImapClient,
  type ImapConnectOptions,
  type ImapListEntry,
} from '../../src/integrations/mail-imap/client.js'
import { ImapAccountStore, localIdFor } from '../../src/integrations/mail-imap/config.js'
import { encodeMessageId } from '../../src/integrations/mail-imap/coords.js'
import { FOLDER_RESET, NO_MOVE, archiveTarget, createImapProvider } from '../../src/integrations/mail-imap/provider.js'
import type { MailProviderSpec } from '../../src/integrations/mail/types.js'

const ADDRESS = 'robin@marina.example.invalid'
const log = { debug() {}, info() {}, warn() {} }

interface Wire {
  capabilities: string[]
  listing: ImapListEntry[]
  commands: string[]
  moves: Array<{ from: string; range: string; to: string; uid: boolean }>
  /** What `messageMove` resolves to (imapflow: an object, `false` on NO, `undefined` when not selected). */
  moveAnswer: unknown
  flagOps: number
}

let wire: Wire

class FakeImap implements ImapClient {
  usable = true
  readonly capabilities: Set<string>
  private open = ''
  constructor(readonly options: ImapConnectOptions) { this.capabilities = new Set(wire.capabilities) }
  async connect() {}
  async logout() {}
  close() {}
  async list() { wire.commands.push('list'); return wire.listing }
  async mailboxOpen(path: string) {
    wire.commands.push(`open ${path}`)
    this.open = path
    return { path, uidValidity: '9001', exists: 3, uidNext: 10 }
  }
  async *fetch() { /* not used */ }
  async fetchOne() { return false as const }
  async messageFlagsAdd() { wire.flagOps += 1; return true }
  async messageFlagsRemove() { wire.flagOps += 1; return true }
  async append() { return true }
  async messageMove(range: string, to: string, options?: unknown) {
    wire.commands.push(`move ${range} -> ${to}`)
    wire.moves.push({ from: this.open, range, to, uid: (options as { uid?: boolean } | undefined)?.uid === true })
    return wire.moveAnswer
  }
  on() { return this }
}

function freshWire(): Wire {
  return {
    capabilities: ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'],
    listing: [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Archive', specialUse: '\\Archive' },
      { path: 'Old', name: 'Old' },
    ],
    commands: [],
    moves: [],
    moveAnswer: { path: 'INBOX', destination: 'Archive' },
    flagOps: 0,
  }
}

async function provider(roles?: Record<string, string>): Promise<{ spec: MailProviderSpec; pool: ImapPool; accountId: string }> {
  let config: Record<string, unknown> = {}
  const secrets = new Map<string, string>()
  const host = {
    config: {
      get: async () => config,
      patch: async (patch: Record<string, unknown>) => { config = { ...config, ...patch }; return config },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async (key: string, value: string) => { secrets.set(key, value) },
      delete: async (key: string) => { secrets.delete(key) },
      list: async () => [...secrets.keys()],
    },
  }
  const store = new ImapAccountStore(host as never)
  const entry = await store.save({ address: ADDRESS, host: 'imap.example.invalid', port: 993, tls: 'tls', password: 'not-a-real-one' })
  if (roles) {
    const accounts = (config.accounts ?? {}) as Record<string, Record<string, unknown>>
    const local = localIdFor(ADDRESS)
    await host.config.patch({ accounts: { ...accounts, [local]: { ...accounts[local], roles } } })
  }
  const pool = new ImapPool({ settings: (id) => store.settings(id), password: (id) => store.password(id), log })
  pools.push(pool)
  return { spec: createImapProvider({ store, pool, log }), pool, accountId: entry.accountId }
}

const pools: ImapPool[] = []
const inbox = (uid: number) => encodeMessageId('INBOX', '9001', uid)

beforeAll(() => { setImapClientFactory(async (options) => new FakeImap(options)) })
afterAll(async () => {
  setImapClientFactory(null)
  for (const pool of pools.splice(0)) await pool.disposeAll()
})
beforeEach(() => { wire = freshWire() })

describe('archiveTarget', () => {
  it('prefers the configured role, then \\Archive, then \\All, then a folder named Archive', () => {
    const boxes = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/All Mail', specialUse: '\\All' },
      { path: 'Archives', name: 'Archives' },
      { path: 'Kept', name: 'Kept' },
    ]
    expect(archiveTarget(boxes, { Kept: 'archive' })).toBe('Kept')
    expect(archiveTarget(boxes)).toBe('[Gmail]/All Mail')
    expect(archiveTarget([...boxes, { path: 'Box/Archive', specialUse: '\\Archive' }])).toBe('Box/Archive')
    // Only an attribute in `flags` (a server that does not report SPECIAL-USE the imapflow way).
    expect(archiveTarget([{ path: 'INBOX' }, { path: 'Stored', flags: new Set(['\\Archive']) }])).toBe('Stored')
    expect(archiveTarget([{ path: 'INBOX' }, { path: 'Trash', flags: ['\\Trash'] }])).toBeUndefined()
  })
})

describe('archiveMany', () => {
  it("moves each folder's mail with ONE UID MOVE and touches no flag", async () => {
    const { spec, accountId } = await provider()

    const outcome = await spec.archiveMany!(accountId, [inbox(3), inbox(5), encodeMessageId('Old', '9001', 2)])

    expect(outcome).toEqual([
      { messageId: inbox(3), ok: true }, { messageId: inbox(5), ok: true }, { messageId: 'Old:9001:2', ok: true },
    ])
    expect(wire.moves).toEqual([
      { from: 'INBOX', range: '3,5', to: 'Archive', uid: true },
      { from: 'Old', range: '2', to: 'Archive', uid: true },
    ])
    expect(wire.flagOps).toBe(0)
    expect(spec.capabilities.archive).toBe(true)
  })

  it('mail already in the archive folder counts as moved, with no command', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.archiveMany!(accountId, [encodeMessageId('Archive', '9001', 4)])
    expect(outcome).toEqual([{ messageId: 'Archive:9001:4', ok: true }])
    expect(wire.moves).toEqual([])
  })

  it('an account with no archive folder moves nothing and says so', async () => {
    wire.listing = [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Trash', specialUse: '\\Trash' }]
    const { spec, accountId } = await provider()
    const outcome = await spec.archiveMany!(accountId, [inbox(1)])
    expect(outcome).toEqual([{ messageId: inbox(1), ok: false, reason: 'This account has no Archive folder.' }])
    expect(wire.moves).toEqual([])
  })

  it("a folder the person set as the archive wins over the server's \\Archive", async () => {
    const { spec, accountId } = await provider({ Old: 'archive' })
    await spec.archiveMany!(accountId, [inbox(7)])
    expect(wire.moves.map((one) => one.to)).toEqual(['Old'])
  })

  it('a refused MOVE (imapflow resolves false) is a failure, not a move', async () => {
    wire.moveAnswer = false
    const { spec, accountId } = await provider()
    const outcome = await spec.archiveMany!(accountId, [inbox(3), inbox(5)])
    expect(outcome.map((one) => one.ok)).toEqual([false, false])
    expect(outcome[0]!.reason).toMatch(/refused to move/)
    // A refusal is not a dead connection: the account is not backed off and the next command runs.
    wire.moveAnswer = { path: 'INBOX', destination: 'Archive' }
    const connects = wire.commands.length
    expect(await spec.archiveMany!(accountId, [inbox(3)])).toEqual([{ messageId: inbox(3), ok: true }])
    expect(wire.commands.length).toBeGreaterThan(connects)
  })

  it('a server without MOVE is refused before anything is sent (never COPY + EXPUNGE)', async () => {
    wire.capabilities = ['IMAP4rev1', 'UIDPLUS']
    const { spec, accountId } = await provider()
    const outcome = await spec.archiveMany!(accountId, [inbox(3)])
    expect(outcome).toEqual([{ messageId: inbox(3), ok: false, reason: NO_MOVE }])
    expect(wire.moves).toEqual([])
    expect(wire.commands.some((one) => one.startsWith('open'))).toBe(false)
  })

  it('a handle from before the folder was reset moves nothing; the current ones still move', async () => {
    const { spec, accountId } = await provider()
    const stale = encodeMessageId('INBOX', '8000', 3)
    const outcome = await spec.archiveMany!(accountId, [stale, inbox(5)])
    expect(outcome).toEqual([{ messageId: stale, ok: false, reason: FOLDER_RESET }, { messageId: inbox(5), ok: true }])
    expect(wire.moves).toEqual([{ from: 'INBOX', range: '5', to: 'Archive', uid: true }])
  })

  it('a handle that is not an IMAP handle fails alone, without a connection', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.archiveMany!(accountId, ['not-a-handle'])
    expect(outcome).toEqual([{ messageId: 'not-a-handle', ok: false, reason: 'not an IMAP message handle' }])
    expect(wire.commands).toEqual([])
  })
})
