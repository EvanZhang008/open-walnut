/**
 * The group's one-line summary and "Keep out of Inbox" through the real routes: a real server
 * (`startServer({ port: 0, dev: true })`), the real mail plugin, and an in-test provider plugin with
 * two providers, one that can move mail to an archive and one that cannot. The labeling and summary
 * model is the Playwright fixture's deterministic stand-in (groups-labeler.mjs); nothing reaches a
 * real model or a real mailbox. Every name and address is invented.
 *
 * What it pins:
 * - `/groups` carries a `summary` per group: the model's line for two or more unread, the subject for one;
 * - `skipInbox` needs a group in `then`, and `/groups/archive` needs a rule that has it;
 * - the card's "move the unread now" queues only the accounts that can move, and says how many it
 *   skipped; the moved mail leaves the group, the rest stays;
 * - a NEW mail the model files into that group afterwards is moved on its own, unread; one that
 *   arrived before the rule is not.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mail-groups-filter-routes-test'))

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { mailSyncForTesting } from '../../src/integrations/mail/sync.js'
import type { MailService } from '../../src/integrations/mail/service.js'
import type { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { SKIP_INBOX_NEEDS_GROUP } from '../../src/integrations/mail/sort-rules-schema.js'
import type { GroupItem, GroupsResponse, RulesResponse } from '../../src/integrations/mail/sort-types.js'
import type { MailEnvelope } from '../../src/integrations/mail/types.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { setPluginFastTextOverride } from '../../src/core/plugins/plugin-fast-text.js'

const MARINA = 'fxarch:marina'
const FERRY = 'fxplain:ferry'
const NOW = Date.now()
const ALL = 'scope=role:inbox'
const BUILDS = 'u:build-results'

interface Recorded { archive: Array<{ accountId: string; messageIds: string[] }>; markRead: number }
const recorded = () => (globalThis as unknown as { __mailFilterCalls: Recorded }).__mailFilterCalls

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

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  let last: T | undefined
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) {
    last = await read().catch(() => undefined)
    if (last !== undefined && ok(last)) return last
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)?.slice(0, 400)}`)
}

async function writeProviderPlugin(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', 'mail-filter-fixture')
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'mail-filter-fixture', name: 'Mail Filter Fixture', description: 'One account that can archive, one that cannot', version: '1.0.0',
    apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', dependencies: { mail: '^1.0.0' },
  }))
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const calls = (globalThis.__mailFilterCalls ??= { archive: [], markRead: 0 });
function provider(id, account, archive) {
  return {
    id, label: id,
    capabilities: { search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none', ...(archive ? { archive: true } : {}) },
    setup: { fields: [], submit: async () => { throw new Error('no setup'); } },
    listAccounts: async () => [account],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [
      { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 0, total: 0 },
      { mailboxId: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 0 },
    ],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    markRead: async () => { calls.markRead += 1; },
    send: async () => { throw new Error('cannot send'); },
    ...(archive ? {
      archiveMany: async (accountId, messageIds) => {
        calls.archive.push({ accountId, messageIds });
        return messageIds.map((messageId) => ({ messageId, ok: true }));
      },
    } : {}),
  };
}
export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const one = base.registerProvider(provider('fxarch', { accountId: '${MARINA}', providerId: 'fxarch', displayName: 'Marina Robin', address: 'robin@marina.example.invalid', state: 'active' }, true));
  const two = base.registerProvider(provider('fxplain', { accountId: '${FERRY}', providerId: 'fxplain', displayName: 'Ferry Robin', address: 'robin@ferry.example.invalid', state: 'active' }, false));
  return { dispose: () => { one.dispose(); two.dispose(); } };
}
`)
}

function envelope(account: string, n: number, subject: string, from: { address: string; name?: string }, at: number): MailEnvelope {
  return {
    messageId: `INBOX:1:${n}`,
    rfcMessageId: `<${account.replace(':', '-')}-${n}@example.invalid>`,
    mailboxId: 'INBOX',
    from,
    to: [{ address: account === MARINA ? 'robin@marina.example.invalid' : 'robin@ferry.example.invalid' }],
    subject,
    sentAt: at,
    receivedAt: at,
    flags: [],
  }
}

const builder = { address: 'robot@ci.example.invalid', name: 'Build Robot' }

beforeAll(async () => {
  const labeler = await import('../e2e/browser/fixtures/mail-fixture-provider/groups-labeler.mjs') as {
    fixtureLabelAnswer: (user: string) => string
    fixtureSummaryAnswer: (user: string) => string
    isLabelRequest: (request: unknown) => boolean
    isSummaryRequest: (request: unknown) => boolean
  }
  setPluginFastTextOverride(async (request) => {
    const user = request.messages.find((one) => one.role === 'user')?.content ?? ''
    if (labeler.isSummaryRequest(request)) return labeler.fixtureSummaryAnswer(user)
    if (!labeler.isLabelRequest(request)) throw new Error('This test has no rule model.')
    return labeler.fixtureLabelAnswer(user)
  })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins: {} }), 'utf-8')
  await writeProviderPlugin()
  await startServer({ port: 0, dev: true }).then((server) => {
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0
  })
  await waitFor(async () => (await get<{ db: string }>('/health')).body.db, (db) => db === 'ready', 30_000, 'the mail database')
  await waitFor(async () => (await get<{ accounts: unknown[] }>('/accounts')).body.accounts?.length ?? 0, (n) => n === 2, 60_000, 'two accounts')
  for (const account of [MARINA, FERRY]) {
    await waitFor(async () => (await get<{ mailboxes: unknown[] }>(`/mailboxes?account=${encodeURIComponent(account)}`)).body.mailboxes?.length ?? 0, (n) => n === 2, 60_000, `${account} folders`)
  }
  const sync = mailSyncForTesting() as unknown as { deps: { service: MailService; sort: MailSortEngine } }
  service = sync.deps.service
  engine = sync.deps.sort
  await engine.refreshIdentities()
  const hour = 3_600_000
  await service.ingestPage(MARINA, [
    ...Array.from({ length: 6 }, (_, i) => envelope(MARINA, i + 1, `Build ${40 + i} passed on main`, builder, NOW - hour - i * 60_000)),
    envelope(MARINA, 20, 'Sensor offline at pier 3', { address: 'pager@alerts.example.invalid', name: 'Pager' }, NOW - 2 * hour),
    envelope(MARINA, 21, 'Weekend offer on chandlery', { address: 'hello@shop.example.invalid', name: 'Tide Shop' }, NOW - 3 * hour),
    envelope(MARINA, 22, 'New arrivals in the shop', { address: 'hello@shop.example.invalid', name: 'Tide Shop' }, NOW - 4 * hour),
  ])
  await service.ingestPage(FERRY, Array.from({ length: 4 }, (_, i) => envelope(FERRY, i + 1, `Build ${70 + i} failed on ferry-line`, builder, NOW - hour - i * 90_000)))
  await engine.idle()
  await waitFor(async () => (await get<GroupsResponse>(`/groups?${ALL}`)).body, (body) => body.ai?.pending === 0
    && body.groups.find((one) => one.id === BUILDS)?.summaryBy === 'ai', 120_000, 'labels and summaries')
}, 240_000)

afterAll(async () => {
  setPluginFastTextOverride(null)
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined)
})

const groupsNow = async () => (await get<GroupsResponse>(`/groups?${ALL}`)).body
const group = (body: GroupsResponse, id: string): GroupItem | undefined => body.groups.find((one) => one.id === id)

describe('the one line under each group', () => {
  it('two or more unread: the model\'s line; one unread: its subject', async () => {
    const body = await groupsNow()
    const builds = group(body, BUILDS)!
    expect(builds.unread).toBe(10)
    // The fixture writes "<first four words of the two newest distinct subjects>".
    expect(builds).toMatchObject({ summaryBy: 'ai', summary: 'Build 70 failed on and Build 40 passed on' })
    const pager = group(body, 'u:pager-alerts')!
    expect(pager.unread).toBe(1)
    expect(pager.summary).toBe('Sensor offline at pier 3')
    expect(pager.summaryBy).toBeUndefined()
    for (const one of body.groups) expect(one.summary.length).toBeGreaterThan(0)
  })

  it('a folder view shows the same line (lines are kept per group, not per folder)', async () => {
    const marina = (await get<GroupsResponse>(`/groups?account=${encodeURIComponent(MARINA)}&mailbox=INBOX`)).body
    expect(group(marina, BUILDS)).toMatchObject({ unread: 6, summaryBy: 'ai', summary: 'Build 70 failed on and Build 40 passed on' })
  })
})

describe('keep out of the Inbox', () => {
  it('skipInbox needs a group in then', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const { status, body } = await send<{ errors: Array<{ field: string; message: string }> }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: [], rules: [{ when: { group: 'Build results' }, then: 'Not important', source: 'user', skipInbox: true }],
    })
    expect(status).toBe(400)
    expect(body.errors).toEqual([expect.objectContaining({ field: 'skipInbox', message: SKIP_INBOX_NEEDS_GROUP })])
  })

  it('moving the unread now needs a rule that keeps mail out of the inbox', async () => {
    const builds = group(await groupsNow(), BUILDS)!
    const { status, body } = await send<{ message: string }>('POST', '/groups/archive', { scope: { role: 'inbox' }, group: BUILDS, watermark: builds.watermark, ruleId: 'r-nothing' })
    expect(status).toBe(400)
    expect(body.message).toMatch(/keeps mail out of the inbox/)
    expect(recorded().archive).toEqual([])
  })

  it('saves the rule, moves only what can move, and a new arrival follows on its own', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const saved = await send<{ fileRev: string }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: [],
      rules: [{ id: 'r-builds', when: { group: 'Build results' }, then: 'Build results', source: 'user', skipInbox: true }],
    })
    expect(saved.status).toBe(200)
    await engine.idle()
    const rules = (await get<RulesResponse>('/rules')).body
    expect(rules.rules[0]).toMatchObject({ id: 'r-builds', skipInbox: true })

    // The card is told which accounts cannot move before anything is saved or moved.
    const shown = group(await groupsNow(), BUILDS)!
    expect(shown.cannotArchive).toEqual(['Ferry Robin'])

    const moved = await send<{ queued: number; skipped: number }>('POST', '/groups/archive', {
      scope: { role: 'inbox' }, group: BUILDS, watermark: shown.watermark, ruleId: 'r-builds',
    })
    expect(moved).toEqual({ status: 202, body: { queued: 6, skipped: 4 } })
    const after = await waitFor(groupsNow, (body) => group(body, BUILDS)?.unread === 4, 30_000, 'the six marina builds to leave')
    expect(group(after, BUILDS)!.cannotArchive).toEqual(['Ferry Robin'])
    expect(recorded().archive.flatMap((one) => one.messageIds.map((id) => `${one.accountId} ${id}`)).sort())
      .toEqual(Array.from({ length: 6 }, (_, i) => `${MARINA} INBOX:1:${i + 1}`).sort())
    // A move is not a read: nothing was marked read on the way.
    expect(recorded().markRead).toBe(0)
    const left = await get<{ messages: Array<{ messageId: string }> }>(`/messages?account=${encodeURIComponent(MARINA)}&mailbox=INBOX&limit=50`)
    expect(left.body.messages.map((one) => one.messageId).sort()).toEqual(['INBOX:1:20', 'INBOX:1:21', 'INBOX:1:22'])

    // A mail that ARRIVES now is labeled by the model, lands in the group, and is moved on its own.
    // One that was received before the rule existed stays, even though it lands in the same group.
    await service.ingestPage(MARINA, [
      envelope(MARINA, 30, 'Build 99 passed on main', builder, Date.now() + 1_000),
      envelope(MARINA, 31, 'Build 12 passed on main', builder, NOW - 30 * 3_600_000),
    ])
    await waitFor(async () => recorded().archive.flatMap((one) => one.messageIds), (ids) => ids.includes('INBOX:1:30'), 60_000, 'the new build to move')
    await engine.idle()
    const rows = await get<{ messages: Array<{ messageId: string; flags: string[] }> }>(`/messages?account=${encodeURIComponent(MARINA)}&mailbox=INBOX&limit=50`)
    expect(rows.body.messages.map((one) => one.messageId)).toContain('INBOX:1:31')
    expect(rows.body.messages.map((one) => one.messageId)).not.toContain('INBOX:1:30')
    expect(recorded().archive.flatMap((one) => one.messageIds)).not.toContain('INBOX:1:31')
  })
})
