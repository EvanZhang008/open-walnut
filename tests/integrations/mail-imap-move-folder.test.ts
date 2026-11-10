/**
 * The IMAP half of a filter rule's `moveTo`: `moveMany` files mail into a named folder with
 * `UID MOVE`, making the folder with `CREATE` when the account has none, against a fake ImapFlow
 * (no socket). Same fakes as mail-imap-archive.test.ts.
 *
 * What is pinned:
 * - an existing folder is used as listed (exact path first, then case-insensitively) and never made;
 * - a missing folder is made ONCE, then the mail moves into it;
 * - mail already in the target counts as moved, with no command;
 * - a server without MOVE moves nothing (never COPY + EXPUNGE);
 * - a CREATE the server refuses refuses every id with the server's words, and nothing moves;
 * - names Walnut will not file into (INBOX, Gmail's own folders, empty, wildcards) are refused
 *   before any CREATE or MOVE;
 * - no flag is touched: unread mail arrives unread.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ImapPool,
  setImapClientFactory,
  type ImapClient,
  type ImapConnectOptions,
  type ImapListEntry,
} from '../../src/integrations/mail-imap/client.js'
import { ImapAccountStore } from '../../src/integrations/mail-imap/config.js'
import { encodeMessageId } from '../../src/integrations/mail-imap/coords.js'
import { FOLDER_RESET, NO_MOVE, createImapProvider, folderNameProblem } from '../../src/integrations/mail-imap/provider.js'
import type { MailProviderSpec } from '../../src/integrations/mail/types.js'

const ADDRESS = 'kestrel@marina-lane.example.invalid'
const log = { debug() {}, info() {}, warn() {} }

interface Wire {
  capabilities: string[]
  listing: ImapListEntry[]
  commands: string[]
  creates: string[]
  /** When set, `mailboxCreate` throws this message (a server NO). */
  createError: string | null
  moves: Array<{ from: string; range: string; to: string; uid: boolean }>
  moveAnswer: unknown
  flagOps: number
  /** The personal namespace the fake server reports (RFC 2342), when any. */
  namespace?: { prefix?: string; delimiter?: string }
}

let wire: Wire

class FakeImap implements ImapClient {
  usable = true
  readonly capabilities: Set<string>
  readonly namespace?: { prefix?: string; delimiter?: string }
  private open = ''
  constructor(readonly options: ImapConnectOptions) {
    this.capabilities = new Set(wire.capabilities)
    if (wire.namespace) this.namespace = wire.namespace
  }
  async connect() {}
  async logout() {}
  close() {}
  async list() { wire.commands.push('list'); return wire.listing }
  async mailboxOpen(path: string) {
    wire.commands.push(`open ${path}`)
    this.open = path
    return { path, uidValidity: '9001', exists: 3, uidNext: 10 }
  }
  async mailboxCreate(path: string | string[]) {
    // imapflow joins an array path with the server's delimiter (and adds the namespace prefix).
    const delimiter = wire.namespace?.delimiter ?? '/'
    const name = (wire.namespace?.prefix ?? '') + (Array.isArray(path) ? path.join(delimiter) : path)
    wire.commands.push(`create ${name}`)
    if (wire.createError) throw new Error(wire.createError)
    wire.creates.push(name)
    wire.listing = [...wire.listing, { path: name, name }]
    return { path: name, created: true }
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
      { path: 'Receipts', name: 'Receipts' },
      { path: 'Projects/Ferry Builds', name: 'Ferry Builds' },
    ],
    commands: [],
    creates: [],
    createError: null,
    moves: [],
    moveAnswer: { path: 'INBOX', destination: 'Receipts' },
    flagOps: 0,
  }
}

const pools: ImapPool[] = []

async function provider(): Promise<{ spec: MailProviderSpec; accountId: string }> {
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
  const pool = new ImapPool({ settings: (id) => store.settings(id), password: (id) => store.password(id), log })
  pools.push(pool)
  return { spec: createImapProvider({ store, pool, log }), accountId: entry.accountId }
}

const inbox = (uid: number) => encodeMessageId('INBOX', '9001', uid)

beforeAll(() => { setImapClientFactory(async (options) => new FakeImap(options)) })
afterAll(async () => {
  setImapClientFactory(null)
  for (const pool of pools.splice(0)) await pool.disposeAll()
})
beforeEach(() => { wire = freshWire() })

describe('moveMany', () => {
  it('advertises the move capability', async () => {
    const { spec } = await provider()
    expect(spec.capabilities.move).toBe(true)
    expect(typeof spec.moveMany).toBe('function')
  })

  it('an existing folder: one UID MOVE per source folder, no CREATE, no flag touched', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3), inbox(5), encodeMessageId('Archive', '9001', 2)], 'Receipts')
    expect(outcome).toEqual([
      { messageId: inbox(3), ok: true }, { messageId: inbox(5), ok: true }, { messageId: 'Archive:9001:2', ok: true },
    ])
    expect(wire.creates).toEqual([])
    expect(wire.commands.some((one) => one.startsWith('create'))).toBe(false)
    expect(wire.moves).toEqual([
      { from: 'INBOX', range: '3,5', to: 'Receipts', uid: true },
      { from: 'Archive', range: '2', to: 'Receipts', uid: true },
    ])
    expect(wire.flagOps).toBe(0)
  })

  it('a nested folder path is used as listed', async () => {
    const { spec, accountId } = await provider()
    await spec.moveMany!(accountId, [inbox(4)], 'Projects/Ferry Builds')
    expect(wire.creates).toEqual([])
    expect(wire.moves.map((one) => one.to)).toEqual(['Projects/Ferry Builds'])
  })

  it('a missing folder is made once, then the mail moves into it', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3), inbox(8)], 'CI Runs')
    expect(outcome).toEqual([{ messageId: inbox(3), ok: true }, { messageId: inbox(8), ok: true }])
    expect(wire.creates).toEqual(['CI Runs'])
    // CREATE comes before the MOVE that needs it.
    const createAt = wire.commands.indexOf('create CI Runs')
    const moveAt = wire.commands.findIndex((one) => one.startsWith('move'))
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(moveAt).toBeGreaterThan(createAt)
    expect(wire.moves).toEqual([{ from: 'INBOX', range: '3,8', to: 'CI Runs', uid: true }])
    expect(wire.flagOps).toBe(0)

    // The next batch finds the folder it made and makes nothing more.
    await spec.moveMany!(accountId, [inbox(9)], 'CI Runs')
    expect(wire.creates).toEqual(['CI Runs'])
  })

  it('the folder name is trimmed before it is looked up or made', async () => {
    const { spec, accountId } = await provider()
    await spec.moveMany!(accountId, [inbox(1)], '  Night Builds  ')
    expect(wire.creates).toEqual(['Night Builds'])
    expect(wire.moves.map((one) => one.to)).toEqual(['Night Builds'])
  })

  it("a case-insensitive match uses the server's own spelling and makes nothing", async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(6)], 'receipts')
    expect(outcome).toEqual([{ messageId: inbox(6), ok: true }])
    expect(wire.creates).toEqual([])
    expect(wire.moves).toEqual([{ from: 'INBOX', range: '6', to: 'Receipts', uid: true }])
  })

  it('an exact match wins over a case-insensitive one', async () => {
    wire.listing = [...wire.listing, { path: 'RECEIPTS', name: 'RECEIPTS' }]
    const { spec, accountId } = await provider()
    await spec.moveMany!(accountId, [inbox(6)], 'RECEIPTS')
    expect(wire.moves.map((one) => one.to)).toEqual(['RECEIPTS'])
    await spec.moveMany!(accountId, [inbox(7)], 'Receipts')
    expect(wire.moves.map((one) => one.to)).toEqual(['RECEIPTS', 'Receipts'])
  })

  it('mail already in the target folder counts as moved, with no MOVE', async () => {
    const { spec, accountId } = await provider()
    const already = encodeMessageId('Receipts', '9001', 4)
    const outcome = await spec.moveMany!(accountId, [already, inbox(2)], 'receipts')
    expect(outcome).toEqual([{ messageId: already, ok: true }, { messageId: inbox(2), ok: true }])
    expect(wire.moves).toEqual([{ from: 'INBOX', range: '2', to: 'Receipts', uid: true }])
    expect(wire.creates).toEqual([])
  })

  it('a server without MOVE moves nothing and says why (existing folder)', async () => {
    wire.capabilities = ['IMAP4rev1', 'UIDPLUS']
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3), inbox(4)], 'Receipts')
    expect(outcome).toEqual([
      { messageId: inbox(3), ok: false, reason: NO_MOVE }, { messageId: inbox(4), ok: false, reason: NO_MOVE },
    ])
    expect(wire.moves).toEqual([])
    expect(wire.creates).toEqual([])
    expect(wire.commands.some((one) => one.startsWith('open'))).toBe(false)
    expect(wire.flagOps).toBe(0)
  })

  it('a server without MOVE makes no folder either (missing folder)', async () => {
    wire.capabilities = ['IMAP4rev1', 'UIDPLUS']
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3)], 'Never Made')
    expect(outcome).toEqual([{ messageId: inbox(3), ok: false, reason: NO_MOVE }])
    expect(wire.moves).toEqual([])
    // A folder made for mail that can never be moved into it is clutter in the person's account.
    expect(wire.creates).toEqual([])
  })

  it("a refused CREATE refuses every id with the server's words, and moves nothing", async () => {
    wire.createError = 'NO [CANNOT] Mailbox name not permitted here'
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3), encodeMessageId('Archive', '9001', 9)], 'Odd Box')
    expect(outcome).toHaveLength(2)
    for (const one of outcome) {
      expect(one.ok).toBe(false)
      expect(one.reason).toContain('did not make the folder Odd Box')
      expect(one.reason).toContain('Mailbox name not permitted here')
    }
    expect(outcome.map((one) => one.messageId)).toEqual([inbox(3), 'Archive:9001:9'])
    expect(wire.moves).toEqual([])
  })

  it('a refusal is returned, never thrown, and the next call still runs', async () => {
    wire.createError = 'NO quota exceeded'
    const { spec, accountId } = await provider()
    await expect(spec.moveMany!(accountId, [inbox(3)], 'Overflow')).resolves.toEqual([
      expect.objectContaining({ messageId: inbox(3), ok: false }),
    ])
    wire.createError = null
    expect(await spec.moveMany!(accountId, [inbox(3)], 'Overflow')).toEqual([{ messageId: inbox(3), ok: true }])
    expect(wire.creates).toEqual(['Overflow'])
  })

  it('a refused MOVE (imapflow resolves false) is a failure, not a move', async () => {
    wire.moveAnswer = false
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(3)], 'Receipts')
    expect(outcome[0]!.ok).toBe(false)
    expect(outcome[0]!.reason).toMatch(/refused to move/)
  })

  it('a handle from before the folder was reset moves nothing; the current ones still move', async () => {
    const { spec, accountId } = await provider()
    const stale = encodeMessageId('INBOX', '8000', 3)
    const outcome = await spec.moveMany!(accountId, [stale, inbox(5)], 'Receipts')
    expect(outcome).toEqual([{ messageId: stale, ok: false, reason: FOLDER_RESET }, { messageId: inbox(5), ok: true }])
    expect(wire.moves).toEqual([{ from: 'INBOX', range: '5', to: 'Receipts', uid: true }])
  })

  it('a handle that is not an IMAP handle fails alone, without a connection', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, ['not-a-handle'], 'Receipts')
    expect(outcome).toEqual([{ messageId: 'not-a-handle', ok: false, reason: 'not an IMAP message handle' }])
    expect(wire.commands).toEqual([])
  })

  it('a nested folder that is missing is made from its parts', async () => {
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(2)], 'Projects / Night Builds')
    expect(outcome).toEqual([{ messageId: inbox(2), ok: true }])
    expect(wire.creates).toEqual(['Projects/Night Builds'])
    expect(wire.moves.map((one) => one.to)).toEqual(['Projects/Night Builds'])
  })

  it("a server with a personal namespace: the person's '/' path matches the server's prefixed name", async () => {
    wire.namespace = { prefix: 'INBOX.', delimiter: '.' }
    wire.listing = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'INBOX.Projects.CI', name: 'CI', delimiter: '.' },
    ]
    const { spec, accountId } = await provider()
    await spec.moveMany!(accountId, [inbox(2)], 'Projects/CI')
    expect(wire.creates).toEqual([])
    expect(wire.moves.map((one) => one.to)).toEqual(['INBOX.Projects.CI'])

    // A missing one is made with the server's delimiter, and the move goes where it was made.
    await spec.moveMany!(accountId, [inbox(3)], 'Projects/Docs')
    expect(wire.creates).toEqual(['INBOX.Projects.Docs'])
    expect(wire.moves.map((one) => one.to)).toEqual(['INBOX.Projects.CI', 'INBOX.Projects.Docs'])
  })

  it('a folder the server marks as Trash (whatever its name) is refused, nothing made or moved', async () => {
    wire.listing = [...wire.listing, { path: 'Papierkorb', name: 'Papierkorb', specialUse: '\\Trash' }]
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(2)], 'Papierkorb')
    expect(outcome).toEqual([{ messageId: inbox(2), ok: false, reason: 'Papierkorb is a folder your mail server keeps for itself; name a folder of your own.' }])
    expect(wire.creates).toEqual([])
    expect(wire.moves).toEqual([])
  })

  it('a \\Noselect folder is refused', async () => {
    wire.listing = [...wire.listing, { path: 'Holder', name: 'Holder', flags: new Set(['\\Noselect']) }]
    const { spec, accountId } = await provider()
    const outcome = await spec.moveMany!(accountId, [inbox(2)], 'Holder')
    expect(outcome[0]).toMatchObject({ ok: false, reason: expect.stringContaining('keeps for itself') })
    expect(wire.moves).toEqual([])
  })

  it("the account's archive folder may be a filter's folder", async () => {
    const { spec, accountId } = await provider()
    expect(await spec.moveMany!(accountId, [inbox(2)], 'Archive')).toEqual([{ messageId: inbox(2), ok: true }])
    expect(wire.moves.map((one) => one.to)).toEqual(['Archive'])
  })

  const BAD = ['INBOX', 'inbox', '[Gmail]/Spam', '[gmail]/All Mail', '', '   ', 'Builds*', 'Half%', 'Line\nBreak', 'x'.repeat(201)]
  for (const name of BAD) {
    it(`refuses the folder name ${JSON.stringify(name.length > 20 ? `${name.slice(0, 8)}... (${name.length})` : name)} before any CREATE or MOVE`, async () => {
      const { spec, accountId } = await provider()
      const outcome = await spec.moveMany!(accountId, [inbox(3), inbox(4)], name)
      const reason = folderNameProblem(name.trim())
      expect(reason).toBeTruthy()
      expect(outcome).toEqual([
        { messageId: inbox(3), ok: false, reason }, { messageId: inbox(4), ok: false, reason },
      ])
      expect(wire.creates).toEqual([])
      expect(wire.moves).toEqual([])
      expect(wire.commands.some((one) => one.startsWith('create') || one.startsWith('move') || one.startsWith('open'))).toBe(false)
    })
  }

  it('the read flag is never touched on any path', async () => {
    const { spec, accountId } = await provider()
    await spec.moveMany!(accountId, [inbox(1)], 'Receipts')
    await spec.moveMany!(accountId, [inbox(2)], 'Fresh Folder')
    await spec.moveMany!(accountId, [inbox(3)], 'INBOX')
    wire.createError = 'NO'
    await spec.moveMany!(accountId, [inbox(4)], 'Another Folder')
    expect(wire.flagOps).toBe(0)
  })
})

describe('folderNameProblem', () => {
  // The one rule set every filter path reads (src/integrations/mail/folder-name.ts), re-exported here.
  it('accepts ordinary and nested names', () => {
    for (const name of ['Receipts', 'Projects/Ferry Builds', 'Gmail notes', 'Inbox copies', 'Not important', 'x'.repeat(200)]) {
      expect(folderNameProblem(name), name).toBeNull()
    }
  })

  it('refuses each kind of bad name with its own sentence', () => {
    expect(folderNameProblem('')).toBe('Name the folder.')
    expect(folderNameProblem('   ')).toBe('Name the folder.')
    expect(folderNameProblem('x'.repeat(201))).toBe('A folder name is at most 200 characters.')
    for (const name of ['a*b', 'a%b', 'a\tb', 'a\u007fb']) {
      expect(folderNameProblem(name), JSON.stringify(name)).toBe('A folder name cannot hold control characters, * or %.')
    }
    expect(folderNameProblem('Inbox')).toBe('Mail cannot be filed into the Inbox it leaves.')
    expect(folderNameProblem('[Gmail]/Starred')).toBe('Gmail keeps its own [Gmail] folders; name a folder of your own.')
    expect(folderNameProblem('[Google Mail]/Drafts')).toBe('Gmail keeps its own [Gmail] folders; name a folder of your own.')
    for (const name of ['a//b', '/Receipts', 'Receipts/']) {
      expect(folderNameProblem(name), name).toBe('A folder name cannot have an empty level (two "/" in a row, or one at an end).')
    }
    for (const name of ['a..b', 'Receipts.', '.Receipts', 'Acme Inc./CI']) {
      expect(folderNameProblem(name), name).toBe('A folder name cannot start or end with a dot, or hold two dots in a row.')
    }
    // A dot inside a level is an ordinary name on a "/" server and a level on a "." server.
    expect(folderNameProblem('Acme Inc. CI')).toBeNull()
    expect(folderNameProblem('Builds.Failed')).toBeNull()
  })

  it('refuses a system folder by its leaf name, at any level', () => {
    for (const name of ['Trash', 'Projects/Spam', 'Old.Junk', 'Sent Items', 'Deleted Items', 'Drafts', 'All Mail', 'Work/INBOX']) {
      const leaf = name.split(/[/.]/).pop()!
      expect(folderNameProblem(name), name).toBe(
        `"${leaf}" is a folder your mail server keeps for itself (Trash, Junk, Sent and the like). Name a folder of your own.`,
      )
    }
  })
})
