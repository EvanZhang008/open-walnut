/**
 * "Filter mails like these" through the real routes: a real server (`startServer({ port: 0, dev: true })`),
 * the real mail plugin, and an in-test provider plugin with one account that can file mail into a
 * folder (`moveMany`, making the folder when missing) and one that cannot. The labeling model is the
 * Playwright fixture's deterministic stand-in; nothing reaches a real model or mailbox. Every name and
 * address is invented.
 *
 * What it pins (2026-11-09, the person: "I want all of these go to a filter folder, this is crazy too
 * crowded"):
 * - a rule with `moveTo` needs a group in `then`, and a folder name Walnut can use;
 * - `/rules/apply` files EVERY inbox mail the filter decides, read or unread, whenever it arrived, into
 *   the folder, never marking anything read, and skips the account that cannot file mail;
 * - mail the filter does not decide (the same sender's other mail) stays in the inbox;
 * - a new arrival is filed on its own; the folder named on the rule at move time is the one used;
 * - the folder shows: `/mailboxes` marks it `filter`, and the account's folders are listed again;
 * - a deleted filter files nothing more.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mail-folder-filter-routes-test'))

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { mailSyncForTesting } from '../../src/integrations/mail/sync.js'
import type { MailService } from '../../src/integrations/mail/service.js'
import type { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { MOVE_TO_NEEDS_GROUP } from '../../src/integrations/mail/sort-rules-schema.js'
import type { RulesResponse } from '../../src/integrations/mail/sort-types.js'
import type { MailEnvelope } from '../../src/integrations/mail/types.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { setPluginFastTextOverride } from '../../src/core/plugins/plugin-fast-text.js'

const MARINA = 'fxfile:marina'
const FERRY = 'fxplain:ferry'
const NOW = Date.now()

interface Recorded { moves: Array<{ accountId: string; messageIds: string[]; folder: string }>; folders: string[]; markRead: number }
const recorded = () => (globalThis as unknown as { __mailFolderCalls: Recorded }).__mailFolderCalls

let port = 0
let service: MailService
let engine: MailSortEngine
const relisted: string[] = []

const url = (route: string) => `http://127.0.0.1:${port}/api/plugins/mail${route}`

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
  const dir = path.join(WALNUT_HOME, 'plugins', 'mail-folder-fixture')
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'mail-folder-fixture', name: 'Mail Folder Fixture', description: 'One account that can file mail into folders, one that cannot', version: '1.0.0',
    apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', dependencies: { mail: '^1.0.0' },
  }))
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const calls = (globalThis.__mailFolderCalls ??= { moves: [], folders: [], markRead: 0 });
function provider(id, account, move) {
  return {
    id, label: id,
    capabilities: { search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none', ...(move ? { move: true } : {}) },
    setup: { fields: [], submit: async () => { throw new Error('no setup'); } },
    listAccounts: async () => [account],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [
      { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 0, total: 0 },
      ...(move ? calls.folders.map((folder) => ({ mailboxId: folder, name: folder, role: 'other', unread: 0, total: 0 })) : []),
    ],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    markRead: async () => { calls.markRead += 1; },
    send: async () => { throw new Error('cannot send'); },
    ...(move ? {
      moveMany: async (accountId, messageIds, folder) => {
        if (!calls.folders.includes(folder)) calls.folders.push(folder);
        calls.moves.push({ accountId, messageIds, folder });
        return messageIds.map((messageId) => ({ messageId, ok: true }));
      },
    } : {}),
  };
}
export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const one = base.registerProvider(provider('fxfile', { accountId: '${MARINA}', providerId: 'fxfile', displayName: 'Marina Robin', address: 'robin@marina.example.invalid', state: 'active' }, true));
  const two = base.registerProvider(provider('fxplain', { accountId: '${FERRY}', providerId: 'fxplain', displayName: 'Ferry Robin', address: 'robin@ferry.example.invalid', state: 'active' }, false));
  return { dispose: () => { one.dispose(); two.dispose(); } };
}
`)
}

const ci = { address: 'notifications@ci.example.invalid', name: 'CI Robot' }

function envelope(account: string, n: number, subject: string, from: { address: string; name?: string }, at: number, seen = false): MailEnvelope {
  return {
    messageId: `INBOX:1:${n}`,
    rfcMessageId: `<${account.replace(':', '-')}-${n}@example.invalid>`,
    mailboxId: 'INBOX',
    from,
    to: [{ address: account === MARINA ? 'robin@marina.example.invalid' : 'robin@ferry.example.invalid' }],
    subject,
    sentAt: at,
    receivedAt: at,
    flags: seen ? ['\\Seen'] : [],
  }
}

const inboxIds = async (account: string) =>
  (await get<{ messages: Array<{ messageId: string }> }>(`/messages?account=${encodeURIComponent(account)}&mailbox=INBOX&limit=100`)).body.messages.map((one) => one.messageId).sort()
const movedIds = () => recorded().moves.flatMap((one) => one.messageIds.map((id) => `${one.accountId} ${id} -> ${one.folder}`)).sort()

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
    await waitFor(async () => (await get<{ mailboxes: unknown[] }>(`/mailboxes?account=${encodeURIComponent(account)}`)).body.mailboxes?.length ?? 0, (n) => n >= 1, 60_000, `${account} folders`)
  }
  const sync = mailSyncForTesting() as unknown as { deps: { service: MailService; sort: MailSortEngine }; markRelistDue: (id: string) => void }
  service = sync.deps.service
  engine = sync.deps.sort
  // Who asked for a folder list again (a filter that made its folder does).
  const relist = sync.markRelistDue.bind(sync)
  sync.markRelistDue = (accountId: string) => { relisted.push(accountId); relist(accountId) }
  await engine.refreshIdentities()
  const hour = 3_600_000
  await service.ingestPage(MARINA, [
    // Five CI failures, two of them already read, one received days ago.
    envelope(MARINA, 1, '[acme/ferry] Run failed: Build - main (1a2b3c)', ci, NOW - hour),
    envelope(MARINA, 2, '[acme/ferry] Run failed: Lint - main (4d5e6f)', ci, NOW - 2 * hour),
    envelope(MARINA, 3, '[acme/ferry] Run failed: Release - v1.2 (7a8b9c)', ci, NOW - 3 * hour, true),
    envelope(MARINA, 4, '[acme/ferry] Run failed: Build - main (0f0f0f)', ci, NOW - 4 * hour, true),
    envelope(MARINA, 5, '[acme/ferry] Run failed: Build - main (abcdef)', ci, NOW - 5 * 24 * hour),
    // The same sender's review comment, and another sender: the filter decides neither.
    envelope(MARINA, 6, '[acme/ferry] New comment on pull request 77', ci, NOW - hour),
    envelope(MARINA, 7, 'Sensor offline at pier 3', { address: 'pager@alerts.example.invalid', name: 'Pager' }, NOW - hour),
  ])
  await service.ingestPage(FERRY, [envelope(FERRY, 1, '[acme/ferry] Run failed: Build - main (999999)', ci, NOW - hour)])
  await engine.idle()
}, 240_000)

afterAll(async () => {
  setPluginFastTextOverride(null)
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined)
})

describe('a filter into a folder', () => {
  it('needs a group in then and a folder name Walnut can use', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const reserved = await send<{ errors: Array<{ field: string; message: string }> }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: [], rules: [{ when: { fromContains: 'ci.example' }, then: 'Not important', source: 'user', moveTo: 'CI' }],
    })
    expect(reserved.status).toBe(400)
    expect(reserved.body.errors).toEqual([expect.objectContaining({ field: 'moveTo', message: MOVE_TO_NEEDS_GROUP })])
    const inbox = await send<{ errors: Array<{ field: string }> }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: ['CI'], rules: [{ when: { fromContains: 'ci.example' }, then: 'CI', source: 'user', moveTo: 'inbox' }],
    })
    expect(inbox.status).toBe(400)
    expect(inbox.body.errors.map((one) => one.field)).toEqual(['moveTo'])
    // A folder the mail server keeps for itself: filing into Trash would be a deletion done later.
    for (const folder of ['Trash', 'Projects/Junk', 'Deleted Items', '[Google Mail]/Bin']) {
      const system = await send<{ errors: Array<{ field: string }> }>('PUT', '/rules', {
        baseRev: before.fileRev, groups: ['CI'], rules: [{ when: { fromContains: 'ci.example' }, then: 'CI', source: 'user', moveTo: folder }],
      })
      expect(system.status, folder).toBe(400)
      expect(system.body.errors.map((one) => one.field), folder).toEqual(['moveTo'])
    }
    const apply = await send<{ message: string }>('POST', '/rules/apply', { ruleId: 'r-nothing' })
    expect(apply.status).toBe(400)
    expect(recorded().moves).toEqual([])
  })

  it('files every inbox mail it decides, read or unread, old or new, and nothing else', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const saved = await send<{ fileRev: string }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: ['CI runs'],
      rules: [{ id: 'r-ci', when: { fromContains: 'CI.EXAMPLE', subject: 'run failed' }, then: 'CI runs', source: 'user', moveTo: 'CI runs' }],
    })
    expect(saved.status).toBe(200)
    await engine.idle()
    const rules = (await get<RulesResponse>('/rules')).body
    expect(rules.rules[0]).toMatchObject({ id: 'r-ci', moveTo: 'CI runs', summary: 'From a sender with "CI.EXAMPLE" with "run failed" in the subject → CI runs, filed into CI runs' })

    const applied = await send<{ found: number; queued: number; skipped: number }>('POST', '/rules/apply', { ruleId: 'r-ci' })
    expect(applied).toEqual({ status: 202, body: { found: 6, queued: 5, skipped: 1 } })
    await waitFor(async () => movedIds(), (ids) => ids.length === 5, 30_000, 'the five CI mails to move')
    expect(movedIds()).toEqual([1, 2, 3, 4, 5].map((n) => `${MARINA} INBOX:1:${n} -> CI runs`))
    // A move is not a read.
    expect(recorded().markRead).toBe(0)
    expect(await waitFor(() => inboxIds(MARINA), (ids) => ids.length === 2, 30_000, 'the moved rows to leave')).toEqual(['INBOX:1:6', 'INBOX:1:7'])
    // The account that cannot file mail keeps its mail in the inbox.
    expect(await inboxIds(FERRY)).toEqual(['INBOX:1:1'])
    // The folder shows: its account is listed again, and the folder is marked as a filter's.
    expect(relisted).toContain(MARINA)
    const folders = await waitFor(
      async () => (await get<{ mailboxes: Array<{ mailboxId: string; filter?: true }> }>(`/mailboxes?account=${encodeURIComponent(MARINA)}`)).body.mailboxes,
      (list) => list.some((one) => one.mailboxId === 'CI runs'), 60_000, 'the new folder in the list')
    expect(folders.find((one) => one.mailboxId === 'CI runs')).toMatchObject({ filter: true })
  }, 180_000)

  it('a new arrival is filed on its own, into the folder the rule names at move time', async () => {
    await service.ingestPage(MARINA, [envelope(MARINA, 30, '[acme/ferry] Run failed: Build - main (303030)', ci, Date.now() + 1_000)])
    await waitFor(async () => movedIds(), (ids) => ids.some((one) => one.startsWith(`${MARINA} INBOX:1:30 `)), 60_000, 'the new failure to move')
    expect(movedIds()).toContain(`${MARINA} INBOX:1:30 -> CI runs`)

    // Renaming the folder on the rule: the next mail goes to the new one.
    const before = (await get<RulesResponse>('/rules')).body
    const renamed = await send<{ fileRev: string }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: ['CI runs'],
      rules: [{ id: 'r-ci', when: { fromContains: 'ci.example', subject: 'run failed' }, then: 'CI runs', source: 'user', moveTo: 'Builds/Failed' }],
    })
    expect(renamed.status).toBe(200)
    await engine.idle()
    await service.ingestPage(MARINA, [envelope(MARINA, 31, '[acme/ferry] Run failed: Lint - main (313131)', ci, Date.now() + 2_000)])
    await waitFor(async () => movedIds(), (ids) => ids.some((one) => one.startsWith(`${MARINA} INBOX:1:31 `)), 60_000, 'the next failure to move')
    expect(movedIds()).toContain(`${MARINA} INBOX:1:31 -> Builds/Failed`)
  })

  it('a filter for one account files only that account\'s mail', async () => {
    await service.ingestPage(FERRY, [envelope(FERRY, 40, '[acme/ferry] Run failed: Docs - main (404040)', ci, NOW - 60_000)])
    await service.ingestPage(MARINA, [envelope(MARINA, 40, '[acme/ferry] Run failed: Docs - main (414141)', ci, NOW - 60_000)])
    await engine.idle()
    const before = (await get<RulesResponse>('/rules')).body
    const saved = await send<{ fileRev: string }>('PUT', '/rules', {
      baseRev: before.fileRev, groups: ['Docs runs'],
      rules: [{ id: 'r-docs', when: { fromContains: 'ci.example', subject: 'Run failed: Docs', account: MARINA }, then: 'Docs runs', source: 'user', moveTo: 'Docs runs' }],
    })
    expect(saved.status).toBe(200)
    await engine.idle()
    const applied = await send<{ found: number; queued: number; skipped: number }>('POST', '/rules/apply', { ruleId: 'r-docs' })
    // FERRY's matching mail is not this filter's at all (not even counted as skipped).
    expect(applied).toEqual({ status: 202, body: { found: 1, queued: 1, skipped: 0 } })
    await waitFor(async () => movedIds(), (ids) => ids.includes(`${MARINA} INBOX:1:40 -> Docs runs`), 30_000, 'the one account\'s mail to move')
    expect(movedIds().filter((one) => one.startsWith(FERRY))).toEqual([])
    expect(await inboxIds(FERRY)).toContain('INBOX:1:40')
  })

  it('a deleted filter files nothing more', async () => {
    const before = (await get<RulesResponse>('/rules')).body
    const cleared = await send<{ fileRev: string }>('PUT', '/rules', { baseRev: before.fileRev, groups: [], rules: [] })
    expect(cleared.status).toBe(200)
    await engine.idle()
    const count = recorded().moves.length
    await service.ingestPage(MARINA, [envelope(MARINA, 32, '[acme/ferry] Run failed: Build - main (323232)', ci, Date.now() + 3_000)])
    await engine.idle()
    await new Promise((r) => setTimeout(r, 3_000))
    expect(recorded().moves.length).toBe(count)
    expect(await inboxIds(MARINA)).toContain('INBOX:1:32')
  })
})
