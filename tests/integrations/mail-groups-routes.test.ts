/**
 * The inbox sorting routes against a real server (`startServer({ port: 0, dev: true })`), a real
 * mail plugin and an in-test provider plugin whose two accounts have the REAL shapes: one IMAP-like
 * (addresses everywhere, marketing subdomains, list headers), one Outlook-like (no sender
 * addresses, display-name recipients, group aliases, and mostly no recipients at all). Every name
 * and address is invented.
 *
 * The invariants (C7): a group holds only UNREAD mail and each group's unread equals its
 * `/messages?group=&unread=1` pages walked to the end; Important unread + every group's unread = the
 * scope's cached unread; All Inboxes is the sum of the two inboxes. Rows arrive through the real
 * ingest path. The labeling model is the Playwright fixture's deterministic stand-in
 * (groups-labeler.mjs), installed on the host seam, so no test ever reaches a real model.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mail-groups-routes-test'))

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { mailSyncForTesting } from '../../src/integrations/mail/sync.js'
import type { MailService } from '../../src/integrations/mail/service.js'
import type { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import type { GroupsResponse, RulesResponse } from '../../src/integrations/mail/sort-types.js'
import type { MailEnvelope } from '../../src/integrations/mail/types.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { setPluginFastTextOverride } from '../../src/core/plugins/plugin-fast-text.js'

const PROVIDER = 'sortfake'
const MARINA = `${PROVIDER}:marina`
const FERRY = `${PROVIDER}:ferry`
const PER_ACCOUNT = 1_500
const NOW = Date.now()

let server: HttpServer
let port = 0
let service: MailService
let engine: MailSortEngine

function url(route: string): string {
  return `http://127.0.0.1:${port}/api/plugins/mail${route}`
}

async function get<T>(route: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url(route))
  return { status: response.status, body: await response.json() as T }
}

async function send<T>(method: string, route: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url(route), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}

const inbox = (account: string) => `account=${encodeURIComponent(account)}&mailbox=INBOX`
const ALL = 'scope=role:inbox'

/** The provider plugin: two accounts, fixed folder counts (the provider's own numbers), no mail of its own. */
async function writeProviderPlugin(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', 'mail-sort-fixture')
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'mail-sort-fixture', name: 'Mail Sort Fixture', description: 'Two sorting-shaped accounts', version: '1.0.0',
    apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', dependencies: { mail: '^1.0.0' },
  }))
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const calls = (globalThis.__mailSortCalls ??= { markRead: [], markReadMany: [] });
export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const accounts = [
    { accountId: '${MARINA}', providerId: '${PROVIDER}', displayName: 'Harbour, Robin', address: 'robin@marina.example.invalid', state: 'active' },
    { accountId: '${FERRY}', providerId: '${PROVIDER}', displayName: 'Harbour, Robin', address: 'robin@ferry.example.invalid', state: 'active' },
  ];
  const handle = base.registerProvider({
    id: '${PROVIDER}', label: 'Sort fixture',
    capabilities: { search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none' },
    setup: { fields: [], submit: async () => { throw new Error('no setup'); } },
    listAccounts: async () => accounts,
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async (accountId) => [
      { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: accountId === '${FERRY}' ? 19 : 3, total: accountId === '${FERRY}' ? 25204 : 37901 },
      { mailboxId: 'Sent', name: 'Sent', role: 'sent', unread: 0, total: 0 },
    ],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    markRead: async (accountId, messageId, read) => { calls.markRead.push({ accountId, messageId, read }); },
    markReadMany: async (accountId, messageIds, read) => {
      calls.markReadMany.push({ accountId, messageIds, read });
      return messageIds.map((messageId) => ({ messageId, ok: true }));
    },
    send: async () => { throw new Error('cannot send'); },
  });
  return { dispose: () => handle.dispose() };
}
`)
}

const meMarina = { address: 'robin@marina.example.invalid', name: 'Harbour, Robin' }
const meByName = { name: 'Harbour, Robin', address: '' }
const oneClick = { oneClick: true, https: ['https://em.shop.example.invalid/u'] }

/** IMAP-shaped: every row has an address. */
const MARINA_SHAPES: Array<Partial<MailEnvelope>> = [
  { from: { address: 'no-reply@review.example.invalid' }, to: [meMarina], subject: '[Action Required] Review' },
  { from: { address: 'noreply-oncall-notifications@page.example.invalid' }, to: [meMarina] },
  { from: { address: 'issues@tickets.example.invalid' }, to: [meMarina] },
  { from: { address: 'notifications@code.example.invalid' }, to: [meMarina] },
  { from: { address: 'hello@em.shop.example.invalid' }, to: [meMarina], listUnsubscribe: oneClick },
  { from: { address: 'tidings@lists.example.invalid' }, to: [meMarina], listUnsubscribe: { oneClick: false, mailto: ['leave@lists.example.invalid'], listId: 'tidings.lists.example.invalid' } },
  { from: { address: 'news@shop.example.invalid' }, to: [meMarina] },
  { from: { address: 'offers@e.shop.example.invalid' }, to: [meMarina] },
  { from: { address: 'statements@bank.example.invalid' }, to: [meMarina], listUnsubscribe: oneClick },
  { from: { address: 'harbourclub@club.example.invalid' }, to: [meMarina] },
  { from: { address: 'carol@friend.example.invalid' }, to: [meMarina] },
  { from: { address: 'carol.pier@friend.example.invalid', name: 'Carol Pier' }, to: [meMarina] },
  { from: { address: 'carol.pier@friend.example.invalid', name: 'Carol Pier' }, to: [{ address: 'crew@marina.example.invalid' }] },
  { from: { address: 'dana.pier@friend.example.invalid', name: 'Dana Pier' }, to: [{ address: 'crew@marina.example.invalid' }], cc: [meMarina] },
  { from: { address: 'tidewear@shop.example.invalid', name: 'Tidewear' }, to: [meMarina] },
]

/** Outlook-shaped: no sender addresses; recipients only on recent rows, often names only. */
function ferryShape(i: number): Partial<MailEnvelope> {
  const recent = i < 100 && i % 2 === 0
  if (i % 10 < 4) return { from: { address: '', name: 'Brand Tide to Shore' } }
  if (i % 10 === 4) return { from: { address: '', name: 'payroll' } }
  if (i % 10 === 5) return { from: { address: '', name: 'Survey Desk' } }
  if (i % 10 === 6) return { from: { address: '', name: 'Change Desk' }, subject: `Action Required: window ${i}`, ...(i < 30 ? { to: [meByName] } : {}) }
  if (i % 10 === 7) return { from: { address: '', name: '\u00d8st, \u00c5se' }, to: [{ name: 'crew-leads', address: '' }, { address: 'dock-team@' }] }
  return { from: { address: '', name: 'Pier, Dana' }, ...(recent ? { to: [meByName] } : {}) }
}

function envelopesFor(account: string): MailEnvelope[] {
  return Array.from({ length: PER_ACCOUNT }, (_, i) => {
    const shape = account === MARINA ? MARINA_SHAPES[i % MARINA_SHAPES.length]! : ferryShape(i)
    return {
      messageId: `INBOX:1:${i + 1}`,
      rfcMessageId: `<${account.replace(':', '-')}-${i}@example.invalid>`,
      mailboxId: 'INBOX',
      from: shape.from!,
      ...(shape.to ? { to: shape.to } : {}),
      ...(shape.cc ? { cc: shape.cc } : {}),
      subject: shape.subject ?? `Note ${i}`,
      sentAt: NOW - (i + 1) * 60_000,
      flags: i % 7 === 0 ? [] : ['\\Seen'],
      ...(shape.listUnsubscribe ? { listUnsubscribe: shape.listUnsubscribe } : {}),
    }
  })
}

/** Polls until `read()` returns `want` (expect.poll is only allowed inside a test, not in beforeAll). */
async function waitFor<T>(read: () => Promise<T>, want: T, timeoutMs: number): Promise<void> {
  let last: T | undefined
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) {
    if ((last = await read().catch(() => undefined)) === want) return
  }
  throw new Error(`timed out waiting for ${String(want)}; last saw ${String(last)}`)
}

/** Labeling calls seen by the stand-in model. */
let labelCalls = 0

beforeAll(async () => {
  const labeler = await import('../e2e/browser/fixtures/mail-fixture-provider/groups-labeler.mjs') as {
    fixtureLabelAnswer: (user: string) => string
    fixtureSummaryAnswer: (user: string) => string
    isLabelRequest: (request: unknown) => boolean
    isSummaryRequest: (request: unknown) => boolean
  }
  setPluginFastTextOverride(async (request) => {
    const user = request.messages.find((one) => one.role === 'user')?.content ?? ''
    // The group summaries share the labeling model; they are answered but not counted as labeling.
    if (labeler.isSummaryRequest(request)) return labeler.fixtureSummaryAnswer(user)
    if (!labeler.isLabelRequest(request)) throw new Error('This test has no rule model.')
    labelCalls += 1
    return labeler.fixtureLabelAnswer(user)
  })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins: {} }), 'utf-8')
  await writeProviderPlugin()
  server = await startServer({ port: 0, dev: true })
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  await waitFor(async () => (await get<{ db: string }>('/health')).body.db, 'ready', 30_000)
  // The account mirror comes from the provider's own listAccounts (the real path).
  await waitFor(async () => (await get<{ accounts: unknown[] }>('/accounts')).body.accounts?.length ?? 0, 2, 60_000)
  await waitFor(async () => (await get<{ mailboxes: unknown[] }>(`/mailboxes?account=${encodeURIComponent(FERRY)}`)).body.mailboxes?.length ?? 0, 2, 60_000)
  // The ingest path itself, reached through the poll loop's own service (the provider has no mail to poll).
  const sync = mailSyncForTesting() as unknown as { deps: { service: MailService; sort: MailSortEngine } }
  service = sync.deps.service
  engine = sync.deps.sort
  await engine.refreshIdentities()
  for (const account of [MARINA, FERRY]) {
    const all = envelopesFor(account)
    for (let at = 0; at < all.length; at += 250) await service.ingestPage(account, all.slice(at, at + 250))
  }
  await engine.idle()
  // The model labels the unread mail in batches; every later case reads the settled answer.
  await waitFor(async () => (await get<GroupsResponse>(`/groups?scope=role:inbox`)).body.ai?.pending ?? -1, 0, 120_000)
  await engine.idle()
}, 240_000)

afterAll(async () => {
  setPluginFastTextOverride(null)
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined)
})

interface Dto { messageId: string; accountId: string; flags: string[]; sort?: { group: string; reason: string; why: string }; senderKey?: string }

/** Every row of a `/messages` query, walked with `nextBefore` to the end. */
async function pageAll(query: string): Promise<Dto[]> {
  const out: Dto[] = []
  let before: string | undefined
  for (let guard = 0; guard < 100; guard += 1) {
    const { status, body } = await get<{ messages: Dto[]; nextBefore?: string }>(`/messages?${query}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`)
    expect(status).toBe(200)
    out.push(...body.messages)
    if (!body.nextBefore) return out
    before = body.nextBefore
  }
  throw new Error('paging did not end')
}

const unreadOf = (rows: Dto[]) => rows.filter((row) => !row.flags.includes('\\Seen')).length

function groupedUnread(groups: GroupsResponse): number {
  return groups.groups.reduce((acc, group) => acc + group.unread, 0)
}

describe('GET /groups: the counts invariants (C7)', () => {
  it('the model labeled the unread mail, in batches of at most 30', async () => {
    const { body } = await get<GroupsResponse>(`/groups?${ALL}`)
    expect(body.ai).toEqual({ state: 'on', pending: 0 })
    const unread = unreadOf(await pageAll(`${ALL}&unread=1`))
    expect(labelCalls).toBeGreaterThanOrEqual(Math.ceil(unread / 30))
  })

  it('Important + every group = the cached inbox unread, for each inbox and for All Inboxes', async () => {
    for (const query of [inbox(MARINA), inbox(FERRY), ALL]) {
      const { status, body } = await get<GroupsResponse>(`/groups?${query}`)
      expect(status).toBe(200)
      expect(body.important.unread + groupedUnread(body)).toBe(body.cachedUnread)
      expect(body.cachedTotal).toBe(query === ALL ? 2 * PER_ACCOUNT : PER_ACCOUNT)
      expect(body.recomputing).toBeUndefined()
      expect(body.rulesRev).toBe(engine.rulesRev)
      // Only groups that hold unread mail are in the answer.
      for (const group of body.groups) expect(group.unread).toBeGreaterThan(0)
    }
  })

  it('cached and provider numbers are both reported, and they differ (real shape d)', async () => {
    const ferry = (await get<GroupsResponse>(`/groups?${inbox(FERRY)}`)).body
    expect(ferry.providerUnread).toBe(19)
    expect(ferry.providerTotal).toBe(25204)
    expect(ferry.cachedUnread).toBe(unreadOf(await pageAll(`${inbox(FERRY)}&unread=1`)))
    expect(ferry.cachedUnread).not.toBe(ferry.providerUnread)
  })

  it('All Inboxes is the sum of the two inboxes, group by group', async () => {
    const [a, b, all] = await Promise.all([inbox(MARINA), inbox(FERRY), ALL].map(async (q) => (await get<GroupsResponse>(`/groups?${q}`)).body))
    expect(all!.important).toEqual({ total: a!.important.total + b!.important.total, unread: a!.important.unread + b!.important.unread })
    for (const group of all!.groups) {
      const one = a!.groups.find((g) => g.id === group.id)?.unread ?? 0
      const two = b!.groups.find((g) => g.id === group.id)?.unread ?? 0
      expect([group.id, group.unread]).toEqual([group.id, one + two])
    }
    expect(all!.providerUnread).toBe(a!.providerUnread + b!.providerUnread)
    expect(all!.seq).toBeGreaterThanOrEqual(Math.max(a!.seq, b!.seq))
  })

  it('each group\'s unread equals its /messages?group=&unread=1 pages walked to the end', async () => {
    for (const query of [inbox(MARINA), inbox(FERRY), ALL]) {
      const { body } = await get<GroupsResponse>(`/groups?${query}`)
      for (const group of [...body.groups, { id: 'important', ...body.important }]) {
        const rows = await pageAll(`${query}&group=${encodeURIComponent(group.id)}&unread=1`)
        expect([query, group.id, rows.length]).toEqual([query, group.id, group.unread])
        for (const row of rows) {
          expect(row.sort?.group).toBe(group.id)
          expect(row.senderKey).toBeTruthy()
        }
      }
    }
  })

  it('the groups are the model\'s names, newest first, with top senders and watermarks', async () => {
    const { body } = await get<GroupsResponse>(`/groups?${ALL}`)
    const ids = body.groups.map((group) => group.id)
    for (const id of ids) expect(id).toMatch(/^[us]:/)
    for (const old of ['notifications', 'promotions', 'group-mail', 'unsorted']) expect(ids).not.toContain(old)
    expect(body.groups.some((group) => group.label === 'Pager alerts')).toBe(true)
    const newest = body.groups.map((group) => group.newestAt)
    expect([...newest].sort((x, y) => y - x)).toEqual(newest)
    for (const group of body.groups) {
      expect(group.topSenders.length).toBeLessThanOrEqual(3)
      expect(group.topSenders.reduce((sum, one) => sum + one.unread, 0)).toBeLessThanOrEqual(group.unread)
      expect(group.watermark.seq).toBeGreaterThan(0)
      expect(group.markableUnread).toBe(group.unread)
      expect(group.readOnlyAccounts).toEqual([])
    }
    expect(body.groups.some((group) => group.unsubscribable > 0)).toBe(true)
  })

  it('answers well inside 150 ms at 3,000 rows (best of five, warm)', async () => {
    await get(`/groups?${ALL}`)
    const times: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now()
      const { status } = await get(`/groups?${ALL}`)
      times.push(performance.now() - started)
      expect(status).toBe(200)
    }
    expect(Math.min(...times)).toBeLessThan(150)
  })
})

describe('GET /groups/summary and the scope checks', () => {
  it('summary is the badge number: Important unread, the grouped unread, and what waits for the model', async () => {
    const [summary, groups] = await Promise.all([
      get<{ importantUnread: number; sortedUnread: number; pending: number; rulesRev: string }>('/groups/summary'),
      get<GroupsResponse>(`/groups?${ALL}`),
    ])
    expect(summary.status).toBe(200)
    expect(summary.body).toEqual({
      importantUnread: groups.body.important.unread,
      sortedUnread: groupedUnread(groups.body),
      pending: 0,
      rulesRev: groups.body.rulesRev,
    })
  })

  it('refuses a scope that names both an inbox and a role, or neither', async () => {
    expect((await get(`/groups?${ALL}&${inbox(MARINA)}`)).status).toBe(400)
    expect((await get('/groups')).status).toBe(400)
  })
})

describe('/messages group and sender filters', () => {
  it('a sender group\'s id (address or name, with spaces) is a valid filter; sender narrows a group', async () => {
    // Read payroll mail the model never saw sits in its sender's group.
    const payroll = await pageAll(`${inbox(FERRY)}&group=${encodeURIComponent('s:name:payroll')}`)
    expect(payroll.length).toBeGreaterThan(0)
    for (const row of payroll) expect(row.sort!.group).toBe('s:name:payroll')
    const groups = (await get<GroupsResponse>(`/groups?${ALL}`)).body
    const withSenders = groups.groups.find((group) => group.topSenders.length > 1)!
    const key = withSenders.topSenders[0]!.key
    const rows = await pageAll(`${ALL}&group=${encodeURIComponent(withSenders.id)}&sender=${encodeURIComponent(key)}`)
    expect(rows.length).toBeGreaterThan(0)
    expect(new Set(rows.map((row) => row.senderKey))).toEqual(new Set([key]))
    expect((await get(`/messages?${ALL}&sender=x`)).status).toBe(400)
    expect((await get(`/messages?${ALL}&group=${encodeURIComponent('bad group!')}`)).status).toBe(400)
    expect((await get(`/messages?${ALL}&group=not-important`)).status).toBe(400)
  })

  it('the DTO carries sort only when a group was asked for, with the model\'s why', async () => {
    const plain = await get<{ messages: Dto[] }>(`/messages?${inbox(MARINA)}&limit=5`)
    expect(plain.body.messages.every((row) => row.sort === undefined && row.senderKey === undefined)).toBe(true)
    const groups = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    const model = groups.groups.find((group) => group.id.startsWith('u:'))!
    const rows = await pageAll(`${inbox(MARINA)}&group=${encodeURIComponent(model.id)}&unread=1`)
    expect(rows[0]!.sort).toMatchObject({ group: model.id, reason: 'ai' })
    expect(rows[0]!.sort!.why.length).toBeGreaterThan(0)
    // Read mail the model never saw falls back to the built-ins: a person writing to Robin is Important.
    const important = await pageAll(`${inbox(FERRY)}&group=important`)
    const reasons = new Set(important.map((row) => row.sort!.reason))
    expect([...reasons].every((one) => ['ai', 'builtin:direct', 'builtin:person'].includes(one))).toBe(true)
    const person = important.find((row) => row.sort!.reason === 'builtin:person')!
    expect(person.sort!.why).toBe('From a person')
  })
})

describe('read flags move the group counts', () => {
  it('one markRead takes one unread off exactly that group', async () => {
    const before = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    const group = before.groups.find((one) => one.unread > 1)!
    const target = (await pageAll(`${inbox(MARINA)}&group=${encodeURIComponent(group.id)}&unread=1`))[0]!
    const response = await send<{ ok: boolean }>('POST', `/messages/${encodeURIComponent(MARINA)}/${encodeURIComponent(target.messageId)}/read`, { read: true })
    expect(response.status).toBe(200)
    const after = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    expect(after.groups.find((one) => one.id === group.id)!.unread).toBe(group.unread - 1)
    expect(after.important.unread).toBe(before.important.unread)
    expect(after.cachedUnread).toBe(before.cachedUnread - 1)
  })

  it('a group whose last unread is read leaves the answer', async () => {
    const before = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    const small = [...before.groups].sort((a, b) => a.unread - b.unread)[0]!
    const rows = await pageAll(`${inbox(MARINA)}&group=${encodeURIComponent(small.id)}&unread=1`)
    const outcomes = await service.markReadMany(MARINA, rows.map((row) => row.messageId), true)
    expect(outcomes.every((one) => one.ok)).toBe(true)
    const after = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    expect(after.groups.some((one) => one.id === small.id)).toBe(false)
    await service.markReadMany(MARINA, rows.map((row) => row.messageId), false)
    const back = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    expect(back.groups.find((one) => one.id === small.id)?.unread).toBe(small.unread)
  })

  it('markReadMany applies flags and the folder counter exactly like markRead', async () => {
    const before = (await get<GroupsResponse>(`/groups?${inbox(FERRY)}`)).body
    const group = before.groups.find((one) => one.unread >= 5)!
    const ids = (await pageAll(`${inbox(FERRY)}&group=${encodeURIComponent(group.id)}&unread=1`)).slice(0, 5).map((row) => row.messageId)
    const outcomes = await service.markReadMany(FERRY, ids, true)
    expect(outcomes).toEqual(ids.map((messageId) => ({ messageId, ok: true })))
    const after = (await get<GroupsResponse>(`/groups?${inbox(FERRY)}`)).body
    expect(after.groups.find((one) => one.id === group.id)?.unread ?? 0).toBe(group.unread - 5)
    expect(after.cachedUnread).toBe(before.cachedUnread - 5)
    const back = await service.markReadMany(FERRY, ids, false)
    expect(back.every((one) => one.ok)).toBe(true)
    expect((await get<GroupsResponse>(`/groups?${inbox(FERRY)}`)).body.cachedUnread).toBe(before.cachedUnread)
  })
})

describe('the rules routes', () => {
  const rulesFile = () => path.join(WALNUT_HOME, 'plugin-data', 'mail', 'sort-rules.yaml')

  it('GET /rules names the real absolute path, the eight built-ins and the catalog', async () => {
    const { status, body } = await get<RulesResponse>('/rules')
    expect(status).toBe(200)
    expect(body.path).toBe(rulesFile())
    expect(path.isAbsolute(body.path)).toBe(true)
    expect(body.exists).toBe(false)
    expect(body.fileRev).toBe('missing')
    expect(body.rules).toEqual([])
    expect(body.builtins.map((one) => one.id)).toHaveLength(8)
    expect(body.builtins.at(-1)).toMatchObject({ id: 'b-unknown', then: 'Not important' })
    // The two reserved places first, then the model's groups that hold unread mail.
    expect(body.catalog.slice(0, 2)).toEqual([
      { id: 'important', label: 'Important', source: 'reserved' },
      { id: 'not-important', label: 'Not important', source: 'reserved' },
    ])
    const groups = (await get<GroupsResponse>(`/groups?${ALL}`)).body
    const named = groups.groups.filter((one) => one.id.startsWith('u:')).map((one) => one.id).sort()
    expect(body.catalog.filter((one) => one.source === 'group').map((one) => one.id).sort()).toEqual(named)
    expect(body.error).toBeUndefined()
  })

  it('PUT /rules refuses a typo of a known name with the exact sentence and writes nothing', async () => {
    const { status, body } = await send<{ error: string; errors: Array<{ message: string; index: number; field: string }> }>('PUT', '/rules', {
      baseRev: 'missing', groups: [], rules: [{ when: { from: 'issues@*' }, then: 'Importnat', source: 'user' }],
    })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid')
    expect(body.errors).toEqual([{ index: 0, field: 'then', message: 'then: Importnat is not a group. Did you mean Important?' }])
    await expect(fsp.access(rulesFile())).rejects.toThrow()
  })

  it('PUT /rules with a stale baseRev is 409 changed', async () => {
    const { status, body } = await send<{ error: string; message: string }>('PUT', '/rules', { baseRev: 'deadbeef0000', groups: [], rules: [] })
    expect(status).toBe(409)
    expect(body).toEqual({ error: 'changed', message: 'The rules file changed on disk. Reload to see the new version.' })
  })

  it('a saved rule moves mail into a new group; the invariants still hold after the re-sort', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const saved = await send<{ rulesRev: string; fileRev: string }>('PUT', '/rules', {
      baseRev: before.fileRev,
      groups: ['On-call & tickets'],
      rules: [{ when: { from: ['noreply-oncall-notifications@*', 'issues@*'] }, then: 'On-call & tickets', source: 'learned', note: 'Pages and tickets' }],
    })
    expect(saved.status).toBe(200)
    expect(saved.body.rulesRev).not.toBe(before.rulesRev)
    await engine.idle()
    const groups = (await get<GroupsResponse>(`/groups?${ALL}`)).body
    const oncall = groups.groups.find((group) => group.id === 'u:on-call-tickets')!
    const rows = await pageAll(`${ALL}&group=${encodeURIComponent('u:on-call-tickets')}`)
    expect(rows).toHaveLength(200)
    expect(oncall).toMatchObject({ label: 'On-call & tickets', unread: unreadOf(rows) })
    expect(groups.important.unread + groupedUnread(groups)).toBe(groups.cachedUnread)
    expect(rows[0]!.sort).toMatchObject({ reason: expect.stringMatching(/^rule:r-[0-9a-f]{6}$/), why: 'You taught Walnut: Pages and tickets' })
    const rules = (await get<RulesResponse>('/rules')).body
    expect(rules.exists).toBe(true)
    expect(rules.rules[0]!.id).toMatch(/^r-[0-9a-f]{6}$/)
    expect(rules.rules[0]!.summary).toBe('From noreply-oncall-notifications@* or issues@* \u2192 On-call & tickets')
  })

  it('a group rule sends everything the model files under that name to Important', async () => {
    const current = (await get<RulesResponse>('/rules')).body
    const groups = (await get<GroupsResponse>(`/groups?${ALL}`)).body
    const pager = groups.groups.find((group) => group.label === 'Pager alerts')
    // The on-call rule above took the pager mail; the model's other groups are the ones left to test.
    const target = pager ?? groups.groups.find((group) => group.id.startsWith('u:') && group.id !== 'u:on-call-tickets')!
    const saved = await send<{ rulesRev: string }>('PUT', '/rules', {
      baseRev: current.fileRev,
      groups: current.groups,
      rules: [...current.rules.map(({ summary: _s, ...rule }) => rule), { when: { group: target.label }, then: 'Important', source: 'learned' }],
    })
    expect(saved.status).toBe(200)
    await engine.idle()
    const after = (await get<GroupsResponse>(`/groups?${ALL}`)).body
    expect(after.groups.some((group) => group.id === target.id)).toBe(false)
    expect(after.important.unread).toBe(groups.important.unread + target.unread)
    // Undo: the rule out again, and the group is back with its unread.
    const now = (await get<RulesResponse>('/rules')).body
    const undone = await send('PUT', '/rules', {
      baseRev: now.fileRev, groups: now.groups, rules: now.rules.slice(0, -1).map(({ summary: _s, ...rule }) => rule),
    })
    expect(undone.status).toBe(200)
    await engine.idle()
    expect((await get<GroupsResponse>(`/groups?${ALL}`)).body.groups.find((group) => group.id === target.id)?.unread).toBe(target.unread)
  })

  it('reordering groups or editing a note does not change rulesRev and starts no re-sort (C64)', async () => {
    const current = (await get<RulesResponse>('/rules')).body
    const reordered = await send<{ rulesRev: string; fileRev: string }>('PUT', '/rules', {
      baseRev: current.fileRev,
      groups: ['Notices', 'On-call & tickets'],
      rules: current.rules.map(({ summary: _summary, ...rule }) => ({ ...rule, note: 'A different note' })),
    })
    expect(reordered.status).toBe(200)
    expect(reordered.body.rulesRev).toBe(current.rulesRev)
    expect(engine.recomputing()).toBeUndefined()
  })

  it('touch re-sorts the corrected mail before the answer returns', async () => {
    const current = (await get<RulesResponse>('/rules')).body
    // An unread mail the model filed in one of its groups (not Important).
    const groups = (await get<GroupsResponse>(`/groups?${inbox(MARINA)}`)).body
    const model = groups.groups.find((group) => group.id.startsWith('u:') && group.id !== 'u:on-call-tickets')!
    const target = (await pageAll(`${inbox(MARINA)}&group=${encodeURIComponent(model.id)}&unread=1`))[0]!
    // The fixture's durable ids are deterministic (see `envelopesFor`), so no body fetch is needed.
    const rfc = `<${MARINA.replace(':', '-')}-${Number(target.messageId.split(':')[2]) - 1}@example.invalid>`
    const saved = await send<{ rulesRev: string }>('PUT', '/rules', {
      baseRev: current.fileRev,
      groups: current.groups,
      rules: [{ when: { message: rfc }, then: 'Important', source: 'learned', label: 'Only the mail "Note"' }, ...current.rules.map(({ summary: _s, ...rule }) => rule)],
      touch: { accountId: MARINA, messageId: target.messageId },
    })
    expect(saved.status).toBe(200)
    const important = await pageAll(`${inbox(MARINA)}&group=important&unread=1`)
    expect(important.map((row) => row.messageId)).toContain(target.messageId)
    await engine.idle()
  })

  it('init is 409 once the file exists, and leaves it untouched; restore brings back the .bak', async () => {
    const text = await fsp.readFile(rulesFile(), 'utf8')
    const init = await send<{ error: string }>('POST', '/rules/init', {})
    expect(init.status).toBe(409)
    expect(await fsp.readFile(rulesFile(), 'utf8')).toBe(text)
    // Every save so far was one editing session (under 60 s apart) that began with no file: no .bak.
    const none = await send<{ error: string }>('POST', '/rules/restore', {})
    expect([none.status, none.body.error]).toEqual([404, 'no-backup'])
    await fsp.writeFile(`${rulesFile()}.bak`, text)
    await fsp.writeFile(rulesFile(), 'version: 1\ngroups: []\nrules: []\n')
    const restore = await send<{ fileRev: string }>('POST', '/rules/restore', {})
    expect(restore.status).toBe(200)
    expect(await fsp.readFile(rulesFile(), 'utf8')).toBe(text)
    expect((await get<RulesResponse>('/rules')).body.rules.length).toBeGreaterThan(0)
    await engine.idle()
  })

  it('PUT /groups/pref stores the switch; a non-boolean is 400', async () => {
    expect((await send<{ on: boolean }>('PUT', '/groups/pref', { on: false })).body).toEqual({ on: false })
    expect(engine.groupedOn()).toBe(false)
    expect((await send('PUT', '/groups/pref', { on: 'yes' })).status).toBe(400)
    expect((await send<{ on: boolean }>('PUT', '/groups/pref', { on: true })).body).toEqual({ on: true })
  })
})
