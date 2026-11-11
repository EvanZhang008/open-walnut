/**
 * The inbound router's ledger (src/core/router/store.ts) through the real database worker.
 *
 * Two RouterStore instances on one home and Area are two worker threads with two SQLite
 * connections, which lock the file exactly as two processes would, so they stand in for "another
 * process". Every file lives under this test's own temp home. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { ROUTER_EVIDENCE_MAX, ROUTER_HISTORY_MAX, RouterStore, routerAreaId, routerKey, routerMessageId } from '../../src/core/router/store.js'
import type { RouterItem, RouterSource } from '../../src/core/router/types.js'

let home: string
const opened: Array<{ dispose(): Promise<void> }> = []
const AREA = 'personal'

function store(areaId = AREA): RouterStore {
  const one = new RouterStore(home, areaId)
  opened.push(one)
  return one
}

function areaFile(areaId = AREA): string {
  return path.join(home, 'router', 'areas', areaId, 'items.sqlite')
}

function rawClient(areaId = AREA): PluginDatabaseClient {
  const client = new PluginDatabaseClient(areaFile(areaId))
  opened.push(client)
  return client
}

/** The message id this file's default Area gives a key and a task. */
const messageId = (key: string, taskId: string) => routerMessageId(AREA, key, taskId)

function item(source: RouterSource, extra: Partial<RouterItem> = {}): RouterItem {
  return { source, key: routerKey(source), sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule', ...extra }
}

const mail = (account: string, message: string): RouterSource => ({ kind: 'mail', account, message })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-store-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const one of opened.splice(0)) await one.dispose().catch(() => undefined)
  fs.rmSync(home, { recursive: true, force: true })
})

describe('routerKey', () => {
  it('keeps the account exactly as given: case, spaces and lookalikes are other accounts', async () => {
    const accounts = ['desk@marina.example.invalid', 'Desk@marina.example.invalid', ' desk@marina.example.invalid', 'desk@marina.example.invalid ']
    const keys = accounts.map((account) => routerKey(mail(account, 'INBOX:1:7')))
    expect(new Set(keys).size).toBe(accounts.length)

    const ledger = store()
    for (const [index, account] of accounts.entries()) {
      const result = await ledger.claim(item(mail(account, 'INBOX:1:7')), { status: 'routing', taskId: `task-${index}`, reason: 'rule' })
      expect(result.fresh).toBe(true)
      expect(result.route.source.account).toBe(account)
    }
  })

  it('never lets the separator join two different sources into one key', () => {
    const pairs: Array<[RouterSource, RouterSource]> = [
      [mail('a:b', 'c'), mail('a', 'b:c')],
      [mail('a%3Ab', 'c'), mail('a:b', 'c')],
      [mail('a%', '3Ab:c'), mail('a%3A', 'b:c')],
      [{ kind: 'slack', account: 'crew', message: 'C1:171.2' }, { kind: 'slack', account: 'crew:C1', message: '171.2' }],
      [{ kind: 'mail', account: 'crew', message: 'm1' }, { kind: 'slack', account: 'crew', message: 'm1' }],
    ]
    for (const [left, right] of pairs) expect(routerKey(left)).not.toBe(routerKey(right))
  })

  it('keeps an unversioned key as it was, and gives each version its own key that no message can spell', () => {
    expect(routerKey(mail('crew', 'm1'))).toBe('mail:crew:m1')
    expect(routerKey({ ...mail('crew', 'm1'), version: '' })).toBe('mail:crew:m1')
    const keys = [
      routerKey(mail('crew', 'm1')),
      routerKey({ ...mail('crew', 'm1'), version: 'v1' }),
      routerKey({ ...mail('crew', 'm1'), version: 'v2' }),
      routerKey({ ...mail('crew', 'm1'), version: 'v1:x' }),
      routerKey(mail('crew', 'm1:version=v1')),
      routerKey({ ...mail('crew', 'm1:version=v1'), version: 'v1' }),
      routerKey({ ...mail('crew:m1', 'version=v1') }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    expect(() => routerKey({ ...mail('crew', 'm1'), version: 7 as never })).toThrow(/version/)
  })

  it('refuses an empty part, an unknown kind, and a claim with no key or a bad source', async () => {
    expect(() => routerKey(mail('', 'm1'))).toThrow(/account/)
    expect(() => routerKey(mail('crew', ''))).toThrow(/message/)
    expect(() => routerKey({ kind: 'fax' as never, account: 'crew', message: 'm1' })).toThrow(/kind/)
    const ledger = store()
    await expect(ledger.claim({ ...item(mail('crew', 'm1')), key: '' }, { status: 'not_routed', reason: 'r' })).rejects.toThrow(/item key/)
    await expect(ledger.claim({ ...item(mail('crew', 'm2')), source: mail('', 'm2') }, { status: 'not_routed', reason: 'r' })).rejects.toThrow(/account/)
    await expect(ledger.get('')).rejects.toThrow(/key/)
    expect(fs.existsSync(ledger.file)).toBe(false)
  })

  it('keeps an adapter key as given, so one item seen under two sources is one row', async () => {
    const ledger = store()
    // Shaped like a mail adapter's key: the RFC id, which survives a move between folders.
    const key = JSON.stringify(['mail', 'crew', 'rfc', '<m1@marina.example.invalid>'])
    const inbox = await ledger.claim({ ...item(mail('crew', 'INBOX:1:7')), key }, { status: 'routing', taskId: 'task-a', reason: 'r' })
    expect(inbox.fresh).toBe(true)
    expect(inbox.route.key).toBe(key)
    expect(inbox.route.messageId).toBe(messageId(key, 'task-a'))
    const moved = await ledger.claim({ ...item(mail('crew', 'Archive:4:2')), key }, { status: 'routing', taskId: 'task-b', reason: 'r' })
    expect(moved).toEqual({ fresh: false, route: inbox.route })
    // A key that differs only in the account is another row.
    const other = JSON.stringify(['mail', 'Crew', 'rfc', '<m1@marina.example.invalid>'])
    expect((await ledger.claim({ ...item(mail('Crew', 'INBOX:1:7')), key: other }, { status: 'not_routed', reason: 'r' })).fresh).toBe(true)
  })
})

describe('claim', () => {
  it('gives a routing claim a stable qm-route id of key and target, and a not_routed one none', async () => {
    const ledger = store()
    const routed = await ledger.claim(item(mail('crew', 'm1'), { threadKey: 'thread-9' }), { status: 'routing', taskId: 'task-a', reason: 'thread match', ruleId: 'rule-1', byTaskId: 'task-lead' }, 1_000)
    expect(routed.fresh).toBe(true)
    expect(routed.route).toMatchObject({
      key: routerKey(mail('crew', 'm1')), status: 'routing', taskId: 'task-a', reason: 'thread match',
      ruleId: 'rule-1', byTaskId: 'task-lead', threadKey: 'thread-9', at: 1_000,
    })
    expect(routed.route.messageId).toMatch(/^qm-route-[0-9a-f]{32}$/)
    expect(routed.route.areaId).toBe(AREA)
    expect(routed.route.messageId).toBe(messageId(routed.route.key, 'task-a'))
    expect(messageId(routed.route.key, 'task-b')).not.toBe(routed.route.messageId)
    expect(messageId(routerKey(mail('crew', 'm2')), 'task-a')).not.toBe(routed.route.messageId)
    expect(routerMessageId('work', routed.route.key, 'task-a')).not.toBe(routed.route.messageId)

    const skipped = await ledger.claim(item(mail('crew', 'm2')), { status: 'not_routed', reason: 'newsletter' }, 1_001)
    expect(skipped.fresh).toBe(true)
    expect(skipped.route.status).toBe('not_routed')
    expect(skipped.route).not.toHaveProperty('messageId')
    expect(skipped.route).not.toHaveProperty('taskId')
  })

  it('refuses routing without a task and not_routed with one', async () => {
    const ledger = store()
    await expect(ledger.claim(item(mail('crew', 'm1')), { status: 'routing', reason: 'x' })).rejects.toThrow(/taskId/)
    await expect(ledger.claim(item(mail('crew', 'm1')), { status: 'not_routed', taskId: 'task-a', reason: 'x' })).rejects.toThrow(/no taskId/)
    await expect(ledger.claim(item(mail('crew', 'm1')), { status: 'routed' as never, taskId: 'task-a', reason: 'x' })).rejects.toThrow(/routing or not_routed/)
    expect(await ledger.get(routerKey(mail('crew', 'm1')))).toBeUndefined()
  })

  it('never overwrites an existing row: a later claim reads the first one', async () => {
    const ledger = store()
    const first = await ledger.claim(item(mail('crew', 'm1')), { status: 'not_routed', reason: 'no rule' }, 1_000)
    const second = await ledger.claim(item(mail('crew', 'm1'), { subject: 'Changed', threadKey: 't2' }), { status: 'routing', taskId: 'task-b', reason: 'late rule' }, 2_000)
    expect(second.fresh).toBe(false)
    expect(second.route).toEqual(first.route)
    expect(await ledger.get(first.route.key)).toEqual(first.route)
  })

  it('has exactly one winner among concurrent claims from two connections', async () => {
    const left = store()
    const right = store()
    // Open both first, so the race is the claim and not the file's creation.
    await left.get('mail:warmup:0')
    await right.get('mail:warmup:0')
    const source = mail('crew', 'race-1')
    const claims = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? left : right)
      .claim(item(source), { status: 'routing', taskId: `task-${index}`, reason: `caller ${index}` }, 5_000 + index))
    const results = await Promise.all(claims)
    const winners = results.filter((result) => result.fresh)
    expect(winners).toHaveLength(1)
    const winner = winners[0]!.route
    for (const result of results) expect(result.route).toEqual(winner)
    expect(winner.messageId).toBe(messageId(winner.key, winner.taskId!))
    expect(await right.get(winner.key)).toEqual(winner)
  })

  it('has exactly one winner when several connections create a new file at the same moment', async () => {
    const stores = Array.from({ length: 4 }, () => store('race-area'))
    expect(fs.existsSync(areaFile('race-area'))).toBe(false)
    const source = mail('crew', 'race-cold')
    // No warm-up: the first request of every store opens the file, the WAL switch and the
    // migration race with the claims.
    const results = await Promise.all(stores.map((one, index) =>
      one.claim(item(source), { status: 'routing', taskId: `task-${index}`, reason: 'cold' }, 7_000 + index)))
    expect(results.filter((result) => result.fresh)).toHaveLength(1)
    for (const result of results) expect(result.route).toEqual(results.find((r) => r.fresh)!.route)
  })
})

describe('settle', () => {
  it('writes only the row with that key, that message id and a status it may leave', async () => {
    const ledger = store()
    const one = (await ledger.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route
    const two = (await ledger.claim(item(mail('crew', 'm2')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route

    const wrongId = await ledger.settle(one.key, two.messageId!, { status: 'routed' }, 2_000)
    expect(wrongId.settled).toBe(false)
    expect(wrongId.route).toEqual(one)
    expect(await ledger.get(two.key)).toEqual(two)

    const missing = await ledger.settle(routerKey(mail('crew', 'nope')), one.messageId!, { status: 'routed' })
    expect(missing).toEqual({ settled: false, route: undefined })

    const done = await ledger.settle(one.key, one.messageId!, { status: 'routed' }, 3_000)
    expect(done.settled).toBe(true)
    expect(done.route).toMatchObject({ status: 'routed', at: 3_000, messageId: one.messageId })
    expect(await ledger.get(two.key)).toEqual(two)

    // Settled once: a repeat and a contrary outcome both leave it.
    expect((await ledger.settle(one.key, one.messageId!, { status: 'routed' }, 4_000)).settled).toBe(false)
    const contrary = await ledger.settle(one.key, one.messageId!, { status: 'failed', error: 'late refusal' }, 4_000)
    expect(contrary.settled).toBe(false)
    expect(contrary.route).toEqual(done.route)
  })

  it('takes routing to unknown, and unknown to a late routed or failed, but never back to unknown', async () => {
    const ledger = store()
    const route = (await ledger.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route
    const unsure = await ledger.settle(route.key, route.messageId!, { status: 'unknown', error: 'answer lost' }, 2_000)
    expect(unsure.settled).toBe(true)
    expect(unsure.route).toMatchObject({ status: 'unknown', error: 'answer lost', at: 2_000 })
    expect((await ledger.settle(route.key, route.messageId!, { status: 'unknown' }, 2_500)).settled).toBe(false)

    const late = await ledger.settle(route.key, route.messageId!, { status: 'routed' }, 3_000)
    expect(late.settled).toBe(true)
    expect(late.route).toMatchObject({ status: 'routed', at: 3_000 })
    expect(late.route).not.toHaveProperty('error')
  })

  it('orders transitions even within one millisecond or when the host clock moves back', async () => {
    const ledger = store()
    const route = (await ledger.claim(item(mail('crew', 'clock')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1000)).route
    const failed = await ledger.settle(route.key, route.messageId!, { status: 'failed' }, 1000)
    expect(failed.route!.at).toBe(1001)
    const retry = await ledger.retry(route.key, 900)
    expect(retry.route!.at).toBe(1002)
    const done = await ledger.settle(route.key, route.messageId!, { status: 'routed' }, 900)
    expect(done.route!.at).toBe(1003)
  })

  it('never settles a not_routed row, which has no message id', async () => {
    const ledger = store()
    const route = (await ledger.claim(item(mail('crew', 'm1')), { status: 'not_routed', reason: 'muted' })).route
    const result = await ledger.settle(route.key, messageId(route.key, 'task-a'), { status: 'routed' })
    expect(result.settled).toBe(false)
    expect(result.route).toEqual(route)
  })

  it('lets one of two concurrent settles win', async () => {
    const left = store()
    const right = store()
    const route = (await left.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' })).route
    await right.get(route.key)
    const [a, b] = await Promise.all([
      left.settle(route.key, route.messageId!, { status: 'routed' }, 2_000),
      right.settle(route.key, route.messageId!, { status: 'failed', error: 'refused' }, 2_000),
    ])
    expect([a.settled, b.settled].filter(Boolean)).toHaveLength(1)
    const final = await left.get(route.key)
    expect(final!.status).toBe(a.settled ? 'routed' : 'failed')
  })
})

describe('retry', () => {
  it('claims only a failed row again, under the same message id', async () => {
    const ledger = store()
    const route = (await ledger.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route

    const whileRouting = await ledger.retry(route.key, 1_500)
    expect(whileRouting.fresh).toBe(false)
    expect(whileRouting.route).toEqual(route)

    await ledger.settle(route.key, route.messageId!, { status: 'failed', error: 'target busy' }, 2_000)
    const again = await ledger.retry(route.key, 3_000)
    expect(again.fresh).toBe(true)
    expect(again.route).toMatchObject({ status: 'routing', taskId: 'task-a', messageId: route.messageId, at: 3_000 })
    expect(again.route).not.toHaveProperty('error')

    await ledger.settle(route.key, route.messageId!, { status: 'unknown' }, 4_000)
    expect((await ledger.retry(route.key, 5_000)).fresh).toBe(false)
    await ledger.settle(route.key, route.messageId!, { status: 'routed' }, 6_000)
    expect((await ledger.retry(route.key, 7_000)).fresh).toBe(false)

    const skipped = (await ledger.claim(item(mail('crew', 'm2')), { status: 'not_routed', reason: 'muted' })).route
    expect(await ledger.retry(skipped.key)).toEqual({ fresh: false, route: skipped })
    expect(await ledger.retry(routerKey(mail('crew', 'nope')))).toEqual({ fresh: false, route: undefined })
  })

  it('has one winner among concurrent retries from two connections', async () => {
    const left = store()
    const right = store()
    const route = (await left.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' })).route
    await left.settle(route.key, route.messageId!, { status: 'failed', error: 'x' })
    await right.get(route.key)
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? left : right).retry(route.key, 9_000)))
    expect(results.filter((result) => result.fresh)).toHaveLength(1)
    for (const result of results) expect(result.route).toMatchObject({ status: 'routing', messageId: route.messageId })
  })
})

describe('history', () => {
  it('reads one exact account of one kind, newest claim first, filtered and bounded', async () => {
    const ledger = store()
    let t = 10_000
    for (let i = 0; i < 6; i++) {
      await ledger.claim(item(mail('crew', `m${i}`), { threadKey: i % 2 ? 'odd' : 'even', sender: i < 3 ? 'pat@a.example.invalid' : 'sam@a.example.invalid' }), { status: 'not_routed', reason: 'r' }, t++)
    }
    await ledger.claim(item(mail('Crew', 'm0')), { status: 'not_routed', reason: 'r' }, t++)
    await ledger.claim(item(mail('crew2', 'm0')), { status: 'not_routed', reason: 'r' }, t++)
    await ledger.claim(item({ kind: 'slack', account: 'crew', message: 'm0' }), { status: 'not_routed', reason: 'r' }, t++)

    const all = await ledger.history({ kind: 'mail', account: 'crew', limit: 50 })
    expect(all.map((route) => route.source.message)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1', 'm0'])
    expect(all.every((route) => route.source.kind === 'mail' && route.source.account === 'crew')).toBe(true)

    expect((await ledger.history({ kind: 'mail', account: 'crew', threadKey: 'odd', limit: 50 })).map((route) => route.source.message)).toEqual(['m5', 'm3', 'm1'])
    expect((await ledger.history({ kind: 'mail', account: 'crew', sender: 'sam@a.example.invalid', limit: 50 })).map((route) => route.source.message)).toEqual(['m5', 'm4', 'm3'])
    expect((await ledger.history({ kind: 'mail', account: 'crew', threadKey: 'even', sender: 'pat@a.example.invalid', limit: 50 })).map((route) => route.source.message)).toEqual(['m2', 'm0'])
    expect((await ledger.history({ kind: 'mail', account: 'crew', limit: 2 })).map((route) => route.source.message)).toEqual(['m5', 'm4'])
    expect(await ledger.history({ kind: 'mail', account: 'crew', limit: 0 })).toHaveLength(1)
    expect(await ledger.history({ kind: 'mail', account: 'crew', limit: 1e9 })).toHaveLength(6)
    expect((await ledger.history({ kind: 'mail', account: 'Crew', limit: 50 })).map((route) => route.source.account)).toEqual(['Crew'])
    expect(await ledger.history({ kind: 'slack', account: 'crew', limit: 50 })).toHaveLength(1)
    expect(await ledger.history({ kind: 'mail', account: 'nobody', limit: 50 })).toEqual([])
    await expect(ledger.history({ kind: 'mail', account: 'crew', limit: Number.NaN })).rejects.toThrow(/limit/)
    expect(ROUTER_HISTORY_MAX).toBeLessThanOrEqual(500)
  })

  it('answers from an index in index order, with no sort pass', async () => {
    const ledger = store()
    await ledger.claim(item(mail('crew', 'm1')), { status: 'not_routed', reason: 'r' })
    const client = rawClient()
    const plan = async (where: string, params: unknown[]) => (await client.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT key FROM router_items WHERE ${where} ORDER BY created_at DESC, key DESC LIMIT ?`, [...params, 10],
    )).map((row) => row.detail).join(' | ')
    const byAccount = await plan('kind = ? AND account = ?', ['mail', 'crew'])
    expect(byAccount).toMatch(/INDEX router_items_/)
    expect(byAccount).not.toMatch(/TEMP B-TREE/)
    const byThread = await plan('kind = ? AND account = ? AND thread_key = ?', ['mail', 'crew', 't'])
    expect(byThread).toMatch(/INDEX router_items_thread/)
    expect(byThread).not.toMatch(/TEMP B-TREE/)
    const bySender = await plan('kind = ? AND account = ? AND sender = ?', ['mail', 'crew', 's'])
    expect(bySender).toMatch(/INDEX router_items_sender/)
    expect(bySender).not.toMatch(/TEMP B-TREE/)
  })
})

describe('getMany', () => {
  it('reads any number of keys in one statement, skipping missing and repeated ones', async () => {
    const ledger = store()
    const keys: string[] = []
    for (let i = 0; i < 40; i++) {
      const route = (await ledger.claim(item(mail('crew', `bulk-${i}`)), i % 3 ? { status: 'not_routed', reason: 'r' } : { status: 'routing', taskId: 'task-a', reason: 'r' })).route
      keys.push(route.key)
    }
    const all = vi.spyOn(PluginDatabaseClient.prototype, 'all')
    const get = vi.spyOn(PluginDatabaseClient.prototype, 'get')
    const asked = [...keys, keys[0]!, keys[1]!, routerKey(mail('crew', 'missing')), routerKey(mail('Crew', 'bulk-0'))]
    const found = await ledger.getMany(asked)
    expect(all).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
    expect([...found.keys()].sort()).toEqual([...keys].sort())
    expect(found.get(keys[0]!)).toEqual(await ledger.get(keys[0]!))
  })

  it('answers an empty list without opening the file', async () => {
    const ledger = store()
    expect((await ledger.getMany([])).size).toBe(0)
    expect(fs.existsSync(ledger.file)).toBe(false)
  })
})

describe('storage', () => {
  it('opens lazily at <home>/router/areas/<areaId>/items.sqlite, private, and keeps every row across a reopen', async () => {
    const first = store()
    expect(first.areaId).toBe(AREA)
    expect(first.file).toBe(areaFile())
    expect(fs.existsSync(first.file)).toBe(false)
    const route = (await first.claim(item(mail('crew', 'm1'), { threadKey: 't1' }), { status: 'routing', taskId: 'task-a', reason: 'r', ruleId: 'rule-1' }, 1_000)).route
    const settled = (await first.settle(route.key, route.messageId!, { status: 'failed', error: 'refused' }, 2_000)).route
    await first.dispose()
    await expect(first.get(route.key)).rejects.toThrow(/closed/)
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(first.file)).mode & 0o777).toBe(0o700)

    for (let round = 0; round < 3; round++) {
      const again = store()
      expect(await again.get(route.key)).toEqual(settled)
      const reclaim = await again.claim(item(mail('crew', 'm1')), { status: 'not_routed', reason: 'other' })
      expect(reclaim).toEqual({ fresh: false, route: settled })
      await again.dispose()
    }
  })

  it('reads a status a newer version wrote as unknown, so it is never sent again', async () => {
    const ledger = store()
    const route = (await ledger.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'r' })).route
    await rawClient().run("UPDATE router_items SET status = 'held_for_review' WHERE key = ?", [route.key])
    expect((await ledger.get(route.key))!.status).toBe('unknown')
    expect((await ledger.retry(route.key)).fresh).toBe(false)
  })
})

describe('areas', () => {
  it('keeps two Areas apart: the same source and key in each is its own row, never read across', async () => {
    const personal = store('personal')
    const work = store('work')
    expect(personal.file).not.toBe(work.file)
    const source = mail('crew', 'shared-1')
    const key = routerKey(source)

    const mine = await personal.claim(item(source, { threadKey: 't1' }), { status: 'routing', taskId: 'task-a', reason: 'personal rule' }, 1_000)
    expect(await work.get(key)).toBeUndefined()
    expect((await work.getMany([key])).size).toBe(0)
    expect(await work.history({ kind: 'mail', account: 'crew', limit: 50 })).toEqual([])

    const theirs = await work.claim(item(source, { threadKey: 't1' }), { status: 'routing', taskId: 'task-a', reason: 'work rule' }, 2_000)
    // Each Area's first claim wins in that Area; neither reads the other's decision.
    expect(mine.fresh).toBe(true)
    expect(theirs.fresh).toBe(true)
    expect(mine.route).toMatchObject({ areaId: 'personal', key, reason: 'personal rule', at: 1_000 })
    expect(theirs.route).toMatchObject({ areaId: 'work', key, reason: 'work rule', at: 2_000 })
    // Same key and task, other Area: another queue message, so neither delivery drops the other.
    expect(theirs.route.messageId).toBe(routerMessageId('work', key, 'task-a'))
    expect(theirs.route.messageId).not.toBe(mine.route.messageId)

    // One Area's message id settles nothing in the other.
    expect((await work.settle(key, mine.route.messageId!, { status: 'routed' }, 3_000)).settled).toBe(false)
    expect((await personal.settle(key, mine.route.messageId!, { status: 'failed', error: 'busy' }, 3_000)).settled).toBe(true)
    expect(await work.get(key)).toEqual(theirs.route)
    expect((await work.retry(key, 4_000)).fresh).toBe(false)
    expect((await personal.retry(key, 4_000)).fresh).toBe(true)

    expect((await personal.history({ kind: 'mail', account: 'crew', threadKey: 't1', limit: 50 })).map((route) => route.areaId)).toEqual(['personal'])
    expect((await work.history({ kind: 'mail', account: 'crew', threadKey: 't1', limit: 50 })).map((route) => route.areaId)).toEqual(['work'])
    expect(fs.readdirSync(path.join(home, 'router', 'areas')).sort()).toEqual(['personal', 'work'])
  })

  it('refuses an unsafe Area id before touching the disk, so no path leaves the areas root', () => {
    const unsafe: unknown[] = [
      '', '.', '..', '../work', '../../escape', 'a/b', 'a\\b', '/abs', 'Personal', 'WORK', ' work', 'work ',
      '-work', '_work', 'work.old', 'work\n', 'wo\u0000rk', 'a'.repeat(81), 'caf\u00e9', undefined, null, 7, {},
    ]
    for (const areaId of unsafe) {
      expect(() => new RouterStore(home, areaId as string)).toThrow(/area id/)
      expect(() => routerAreaId(areaId)).toThrow(/area id/)
      expect(() => routerMessageId(areaId as string, 'mail:crew:m1', 'task-a')).toThrow(/area id/)
    }
    expect(fs.readdirSync(home)).toEqual([])

    for (const areaId of ['a', '0', 'work', 'personal_2', 'side-job', 'a'.repeat(80)]) {
      const one = new RouterStore(home, areaId)
      expect(one.areaId).toBe(areaId)
      expect(one.file).toBe(areaFile(areaId))
      expect(path.relative(path.join(home, 'router', 'areas'), one.file)).toBe(path.join(areaId, 'items.sqlite'))
    }
    expect(fs.readdirSync(home)).toEqual([])
  })
})

describe('getSource and getSources', () => {
  /** A canonical key an adapter builds itself (a mail's RFC id), unlike the default routerKey. */
  const canonical = (account: string, rfc: string) => JSON.stringify(['mail', account, 'rfc', rfc])

  it('reads one row by its exact kind, account and message, never a lookalike', async () => {
    const ledger = store()
    const source = mail('desk@marina.example.invalid', 'INBOX:1:7')
    await ledger.claim(item(source), { status: 'routing', taskId: 'task-a', reason: 'rule' })

    expect(await ledger.getSource(source)).toMatchObject({ source, taskId: 'task-a', status: 'routing', areaId: AREA })
    for (const other of [
      mail('Desk@marina.example.invalid', 'INBOX:1:7'),
      mail(' desk@marina.example.invalid', 'INBOX:1:7'),
      mail('dock@marina.example.invalid', 'INBOX:1:7'),
      mail('desk@marina.example.invalid', 'INBOX:1:70'),
      { kind: 'slack', account: 'desk@marina.example.invalid', message: 'INBOX:1:7' } as RouterSource,
    ]) {
      expect(await ledger.getSource(other)).toBeUndefined()
    }
  })

  it('finds a row claimed under a canonical key by its source, and the key still reads it', async () => {
    const ledger = store()
    const source = mail('desk@marina.example.invalid', 'INBOX:1:9')
    const key = canonical(source.account, '<rota-9@marina.example.invalid>')
    expect(key).not.toBe(routerKey(source))
    await ledger.claim(item(source, { key }), { status: 'routing', taskId: 'task-a', reason: 'rule' })

    expect(await ledger.getSource(source)).toMatchObject({ key, source, taskId: 'task-a' })
    expect(await ledger.get(key)).toMatchObject({ key, source })
    expect(await ledger.get(routerKey(source))).toBeUndefined()
    const batch = await ledger.getSources([source])
    expect([...batch.keys()]).toEqual([routerKey(source)])
    expect(batch.get(routerKey(source))).toMatchObject({ key, source })
  })

  it('reads a batch in one call, keyed by each source\'s routerKey, once per source', async () => {
    const ledger = store()
    const a = mail('desk@marina.example.invalid', 'INBOX:1:1')
    const b = mail('desk@marina.example.invalid', 'INBOX:1:2')
    const c: RouterSource = { kind: 'slack', account: 'crew', message: 'C1:171.2' }
    const missing = mail('desk@marina.example.invalid', 'INBOX:1:3')
    await ledger.claim(item(a), { status: 'routing', taskId: 'task-a', reason: 'rule' })
    await ledger.claim(item(b, { key: canonical(b.account, '<b@marina.example.invalid>') }), { status: 'not_routed', reason: 'nothing to do' })
    await ledger.claim(item(c), { status: 'routing', taskId: 'task-c', reason: 'rule' })

    const all = vi.spyOn(PluginDatabaseClient.prototype, 'all')
    const found = await ledger.getSources([a, b, c, missing, { ...a }, a])
    expect(all).toHaveBeenCalledTimes(1)
    expect([...found.keys()].sort()).toEqual([routerKey(a), routerKey(b), routerKey(c)].sort())
    expect(found.get(routerKey(a))).toMatchObject({ source: a, taskId: 'task-a' })
    expect(found.get(routerKey(b))).toMatchObject({ source: b, status: 'not_routed' })
    expect(found.get(routerKey(c))).toMatchObject({ source: c, taskId: 'task-c' })
    expect(found.has(routerKey(missing))).toBe(false)
  })

  it('never matches across accounts or kinds in a batch', async () => {
    const ledger = store()
    await ledger.claim(item(mail('desk@marina.example.invalid', 'INBOX:1:5')), { status: 'routing', taskId: 'task-a', reason: 'rule' })
    const found = await ledger.getSources([
      mail('dock@marina.example.invalid', 'INBOX:1:5'),
      mail('Desk@marina.example.invalid', 'INBOX:1:5'),
      { kind: 'wechat', account: 'desk@marina.example.invalid', message: 'INBOX:1:5' },
    ])
    expect(found.size).toBe(0)
  })

  it('reads only its own Area\'s ledger', async () => {
    const personal = store('personal')
    const work = store('work')
    const shared = mail('desk@marina.example.invalid', 'INBOX:1:8')
    const onlyWork = mail('desk@marina.example.invalid', 'INBOX:1:88')
    await personal.claim(item(shared), { status: 'routing', taskId: 'task-personal', reason: 'rule' })
    await work.claim(item(shared), { status: 'routing', taskId: 'task-work', reason: 'rule' })
    await work.claim(item(onlyWork), { status: 'routing', taskId: 'task-work', reason: 'rule' })

    expect(await personal.getSource(shared)).toMatchObject({ areaId: 'personal', taskId: 'task-personal' })
    expect(await work.getSource(shared)).toMatchObject({ areaId: 'work', taskId: 'task-work' })
    expect(await personal.getSource(onlyWork)).toBeUndefined()
    const batch = await personal.getSources([shared, onlyWork])
    expect([...batch.keys()]).toEqual([routerKey(shared)])
    expect(batch.get(routerKey(shared))).toMatchObject({ areaId: 'personal', taskId: 'task-personal' })
  })

  it('refuses a bad source before touching the disk and answers an empty batch without opening the file', async () => {
    const ledger = store()
    await expect(ledger.getSource(mail('', 'INBOX:1:1'))).rejects.toThrow()
    await expect(ledger.getSource({ kind: 'fax', account: 'a', message: 'm' } as unknown as RouterSource)).rejects.toThrow()
    await expect(ledger.getSources([mail('desk@marina.example.invalid', 'INBOX:1:1'), mail('desk@marina.example.invalid', '')])).rejects.toThrow()
    expect((await ledger.getSources([])).size).toBe(0)
    expect(fs.existsSync(areaFile())).toBe(false)
  })
})

describe('source aliases', () => {
  /** A mail adapter's canonical key: the RFC id, which a move or a copy keeps. */
  const rfcKey = (account: string, rfc: string) => JSON.stringify(['mail', account, 'rfc', rfc])
  const ACCOUNT = 'desk@marina.example.invalid'
  const inbox = mail(ACCOUNT, 'INBOX:1:31')
  const archive = mail(ACCOUNT, 'Archive:4:2')
  const copy = mail(ACCOUNT, 'Crew:2:9')
  const KEY = rfcKey(ACCOUNT, '<slot-31@marina.example.invalid>')

  it('binds a moved source to the first row, which keeps its original source, across a reopen', async () => {
    const first = store()
    const claimed = (await first.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'rule' }, 1_000)).route
    expect(await first.getSource(archive)).toBeUndefined()

    const bound = await first.bindSource(archive, KEY, 2_000)
    expect(bound).toEqual({ bound: true, route: claimed })
    // Binding again is a no-op, and the row (its original source, its time) never moved.
    expect(await first.bindSource(archive, KEY, 3_000)).toEqual({ bound: false, route: claimed })
    expect(await first.get(KEY)).toEqual(claimed)
    await first.dispose()

    const again = store()
    expect(await again.getSource(archive)).toEqual(claimed)
    expect(await again.getSource(inbox)).toEqual(claimed)
    expect((await again.getSource(archive))!.source).toEqual(inbox)
    // The original source was bound by the claim itself: binding it is a no-op too.
    expect((await again.bindSource(inbox, KEY)).bound).toBe(false)
  })

  it('a claim that loses under another source of the same item binds that source to the winner', async () => {
    const left = store()
    const right = store()
    await Promise.all([left.get('warm-up'), right.get('warm-up')])
    const results = await Promise.all([
      left.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'left' }),
      right.claim(item(archive, { key: KEY }), { status: 'routing', taskId: 'task-b', reason: 'right' }),
    ])
    expect(results.filter((result) => result.fresh)).toHaveLength(1)
    const winner = results.find((result) => result.fresh)!.route
    for (const result of results) expect(result.route).toEqual(winner)
    expect(await left.getSource(inbox)).toEqual(winner)
    expect(await right.getSource(archive)).toEqual(winner)
  })

  it('refuses to rebind a source to another key, and a claim under a source bound elsewhere makes no row', async () => {
    const ledger = store()
    const otherKey = rfcKey(ACCOUNT, '<slot-32@marina.example.invalid>')
    await ledger.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'r' })
    await ledger.claim(item(copy, { key: otherKey }), { status: 'not_routed', reason: 'r' })
    await ledger.bindSource(archive, KEY)

    for (const source of [archive, inbox]) {
      await expect(ledger.bindSource(source, otherKey)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    }
    await expect(ledger.bindSource(copy, KEY)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    const third = rfcKey(ACCOUNT, '<slot-33@marina.example.invalid>')
    await expect(ledger.claim(item(archive, { key: third }), { status: 'not_routed', reason: 'r' })).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    expect(await ledger.get(third)).toBeUndefined()
    expect(await ledger.getSource(archive)).toMatchObject({ key: KEY })
    expect(await ledger.getSource(copy)).toMatchObject({ key: otherKey })
  })

  it('a claim under an existing key checks that its own source names that key', async () => {
    const ledger = store()
    const otherKey = rfcKey(ACCOUNT, '<slot-34@marina.example.invalid>')
    await ledger.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'r' })
    await ledger.claim(item(copy, { key: otherKey }), { status: 'not_routed', reason: 'r' })
    // Another account or kind under this key: refused, never the other account's row.
    const lookalike = mail('Desk@marina.example.invalid', 'INBOX:1:31')
    await expect(ledger.claim(item(lookalike, { key: KEY }), { status: 'not_routed', reason: 'r' })).rejects.toMatchObject({ code: 'source_mismatch' })
    const slack: RouterSource = { kind: 'slack', account: ACCOUNT, message: 'C1:1.2' }
    await expect(ledger.claim(item(slack, { key: KEY }), { status: 'not_routed', reason: 'r' })).rejects.toMatchObject({ code: 'source_mismatch' })
    expect(await ledger.getSource(lookalike)).toBeUndefined()
    expect(await ledger.getSource(slack)).toBeUndefined()
    // The exact source already names another key that exists: refused, never that other row.
    await expect(ledger.claim(item(inbox, { key: otherKey }), { status: 'not_routed', reason: 'r' })).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    expect(await ledger.getSource(inbox)).toMatchObject({ key: KEY })
    expect(await ledger.get(otherKey)).toMatchObject({ source: copy })
  })

  it('two keys racing for one exact source make one row; the loser is refused', async () => {
    const left = store()
    const right = store()
    await Promise.all([left.get('warm-up'), right.get('warm-up')])
    const keys = [rfcKey(ACCOUNT, '<race-a@marina.example.invalid>'), rfcKey(ACCOUNT, '<race-b@marina.example.invalid>')]
    const results = await Promise.allSettled(keys.map((key, index) =>
      (index ? right : left).claim(item(inbox, { key }), { status: 'not_routed', reason: `caller ${index}` })))
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(1)
    const winner = (won[0] as PromiseFulfilledResult<{ fresh: boolean; route: { key: string } }>).value
    expect(winner.fresh).toBe(true)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toMatchObject({ code: 'source_bound_elsewhere' })
    expect((await left.getMany(keys)).size).toBe(1)
    expect(await right.getSource(inbox)).toMatchObject({ key: winner.route.key })
  })

  it('binds only to a row of its own file, kind and account', async () => {
    const personal = store('personal')
    const work = store('work')
    await personal.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'r' })
    await personal.bindSource(archive, KEY)

    // Another Area's file has no such row, and never sees this Area's alias.
    await expect(work.bindSource(archive, KEY)).rejects.toMatchObject({ code: 'route_missing' })
    expect(await work.getSource(archive)).toBeUndefined()
    expect((await work.getSources([archive, inbox])).size).toBe(0)
    // Another account, even one differing only in case, or another kind: never bound, never read.
    const lookalike = mail('Desk@marina.example.invalid', 'Archive:4:2')
    await expect(personal.bindSource(lookalike, KEY)).rejects.toMatchObject({ code: 'source_mismatch' })
    await expect(personal.bindSource({ kind: 'slack', account: ACCOUNT, message: 'C1:1.2' }, KEY)).rejects.toMatchObject({ code: 'source_mismatch' })
    expect(await personal.getSource(lookalike)).toBeUndefined()
    // A key with no row binds nothing.
    await expect(personal.bindSource(copy, rfcKey(ACCOUNT, '<none@marina.example.invalid>'))).rejects.toMatchObject({ code: 'route_missing' })
    expect(await personal.getSource(copy)).toBeUndefined()
    await expect(personal.bindSource(copy, '')).rejects.toThrow(/key/)
  })

  it('reads aliases, original sources and rows from before aliases in one batch', async () => {
    const ledger = store()
    const legacy = mail(ACCOUNT, 'INBOX:1:40')
    const legacyKey = rfcKey(ACCOUNT, '<legacy-40@marina.example.invalid>')
    const missing = mail(ACCOUNT, 'INBOX:1:41')
    await ledger.claim(item(inbox, { key: KEY }), { status: 'routing', taskId: 'task-a', reason: 'r' })
    await ledger.bindSource(archive, KEY)
    await ledger.claim(item(legacy, { key: legacyKey }), { status: 'not_routed', reason: 'r' })
    // A row an older Walnut wrote has no alias at all.
    const raw = rawClient()
    await raw.run('DELETE FROM router_source_aliases WHERE key = ?', [legacyKey])
    await raw.run('DELETE FROM router_delivery_aliases WHERE key = ?', [legacyKey])

    const all = vi.spyOn(PluginDatabaseClient.prototype, 'all')
    const found = await ledger.getSources([inbox, archive, legacy, missing, { ...archive }])
    expect(all).toHaveBeenCalledTimes(1)
    expect([...found.keys()].sort()).toEqual([routerKey(inbox), routerKey(archive), routerKey(legacy)].sort())
    expect(found.get(routerKey(archive))).toMatchObject({ key: KEY, source: inbox })
    expect(found.get(routerKey(inbox))).toMatchObject({ key: KEY, source: inbox })
    expect(found.get(routerKey(legacy))).toMatchObject({ key: legacyKey, source: legacy })
    expect(await ledger.getSource(legacy)).toMatchObject({ key: legacyKey })
    // The old row's original source binds once to its own key, and to no other.
    expect((await ledger.bindSource(legacy, legacyKey)).bound).toBe(true)
    await expect(ledger.bindSource(legacy, KEY)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
  })
})

describe('source versions', () => {
  /** A conversation handle the mail cache reuses for every later reply in that conversation. */
  const ACCOUNT = 'desk@marina.example.invalid'
  const HANDLE = 'conv:marina-rota'
  const rfcKey = (rfc: string) => JSON.stringify(['mail', ACCOUNT, 'rfc', rfc])
  const at = (message: string, version?: string): RouterSource =>
    ({ kind: 'mail', account: ACCOUNT, message, ...(version === undefined ? {} : { version }) })
  const KEY_A = rfcKey('<rota-a@marina.example.invalid>')
  const KEY_B = rfcKey('<rota-b@marina.example.invalid>')

  it('claims two versions of one handle as two rows, each read back by its own version only', async () => {
    const ledger = store()
    const a = at(HANDLE, 'va')
    const b = at(HANDLE, 'vb')
    const first = await ledger.claim(item(a, { key: KEY_A, subject: 'First reply' }), { status: 'routing', taskId: 'task-a', reason: 'rule' }, 1_000)
    const second = await ledger.claim(item(b, { key: KEY_B, subject: 'Second reply' }), { status: 'routing', taskId: 'task-b', reason: 'rule' }, 2_000)
    expect(first.fresh).toBe(true)
    expect(second.fresh).toBe(true)
    expect(first.route).toMatchObject({ key: KEY_A, source: a, subject: 'First reply', taskId: 'task-a' })
    expect(second.route).toMatchObject({ key: KEY_B, source: b, subject: 'Second reply', taskId: 'task-b' })

    expect(await ledger.getSource(a)).toEqual(first.route)
    expect(await ledger.getSource(b)).toEqual(second.route)
    // Neither the unversioned handle nor a third version reads either row.
    expect(await ledger.getSource(at(HANDLE))).toBeUndefined()
    expect(await ledger.getSource(at(HANDLE, 'vc'))).toBeUndefined()

    const all = vi.spyOn(PluginDatabaseClient.prototype, 'all')
    const batch = await ledger.getSources([a, b, at(HANDLE), at(HANDLE, 'vc'), { ...a }])
    expect(all).toHaveBeenCalledTimes(1)
    expect([...batch.keys()].sort()).toEqual([routerKey(a), routerKey(b)].sort())
    expect(batch.get(routerKey(a))).toEqual(first.route)
    expect(batch.get(routerKey(b))).toEqual(second.route)
    expect((await ledger.history({ kind: 'mail', account: ACCOUNT, limit: 10 })).map((route) => route.source.version)).toEqual(['vb', 'va'])

    // A default key per version works the same way: two rows, two message ids.
    const one = await ledger.claim(item(at('conv:pier', 'v1')), { status: 'routing', taskId: 'task-a', reason: 'r' })
    const two = await ledger.claim(item(at('conv:pier', 'v2')), { status: 'routing', taskId: 'task-a', reason: 'r' })
    expect([one.fresh, two.fresh]).toEqual([true, true])
    expect(one.route.key).not.toBe(two.route.key)
    expect(one.route.messageId).not.toBe(two.route.messageId)
  })

  it('has exactly one winner per version among concurrent duplicates from two connections', async () => {
    const left = store()
    const right = store()
    await Promise.all([left.get('warm-up'), right.get('warm-up')])
    const versions = ['va', 'vb', 'vc']
    const claims = versions.flatMap((version) => Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? right : left).claim(item(at(HANDLE, version), { key: rfcKey(`<rota-${version}@marina.example.invalid>`) }),
        { status: 'routing', taskId: `task-${version}-${index}`, reason: `caller ${index}` }, 3_000 + index)
        .then((result) => ({ version, result }))))
    const results = await Promise.all(claims)
    for (const version of versions) {
      const mine = results.filter((entry) => entry.version === version).map((entry) => entry.result)
      const winners = mine.filter((result) => result.fresh)
      expect(winners).toHaveLength(1)
      for (const result of mine) expect(result.route).toEqual(winners[0]!.route)
      expect(winners[0]!.route.source).toEqual(at(HANDLE, version))
      expect(await right.getSource(at(HANDLE, version))).toEqual(winners[0]!.route)
    }
    expect(await left.history({ kind: 'mail', account: ACCOUNT, limit: 50 })).toHaveLength(versions.length)
  })

  it('never lets an older version\'s row or alias answer for a new version of the handle', async () => {
    const ledger = store()
    const moved = 'Archive:4:9'
    await ledger.claim(item(at(HANDLE, 'va'), { key: KEY_A }), { status: 'routing', taskId: 'task-a', reason: 'r' })
    expect((await ledger.bindSource(at(moved, 'va'), KEY_A)).bound).toBe(true)
    // An unversioned row from before versions, under the same handle, is version '' only.
    const legacy = await ledger.claim(item(at(HANDLE), { key: rfcKey('<legacy@marina.example.invalid>') }), { status: 'not_routed', reason: 'r' })
    expect(legacy.route.source).toEqual(at(HANDLE))

    for (const source of [at(HANDLE, 'vb'), at(moved, 'vb'), at(moved)]) {
      expect(await ledger.getSource(source)).toBeUndefined()
      expect((await ledger.getSources([source])).size).toBe(0)
    }
    expect(await ledger.getSource(at(HANDLE))).toEqual(legacy.route)
    expect(await ledger.getSource(at(moved, 'va'))).toMatchObject({ key: KEY_A, source: at(HANDLE, 'va') })

    // The new version claims its own row, and the old version's row and alias stay as they were.
    const fresh = await ledger.claim(item(at(HANDLE, 'vb'), { key: KEY_B }), { status: 'routing', taskId: 'task-b', reason: 'r' })
    expect(fresh.fresh).toBe(true)
    expect(await ledger.getSource(at(HANDLE, 'vb'))).toEqual(fresh.route)
    expect(await ledger.getSource(at(HANDLE, 'va'))).toMatchObject({ key: KEY_A, taskId: 'task-a' })
    expect(await ledger.getSource(at(moved, 'vb'))).toBeUndefined()
  })

  it('never binds one version to another version\'s row, while a moved copy of the same version binds', async () => {
    const ledger = store()
    const a = (await ledger.claim(item(at(HANDLE, 'va'), { key: KEY_A }), { status: 'routing', taskId: 'task-a', reason: 'r' })).route

    for (const source of [at(HANDLE, 'vb'), at('Archive:4:9', 'vb'), at('Archive:4:9')]) {
      await expect(ledger.bindSource(source, KEY_A)).rejects.toMatchObject({ code: 'source_mismatch' })
      await expect(ledger.claim(item(source, { key: KEY_A }), { status: 'routing', taskId: 'task-b', reason: 'r' }))
        .rejects.toMatchObject({ code: 'source_mismatch' })
      expect(await ledger.getSource(source)).toBeUndefined()
    }
    expect(await ledger.get(KEY_A)).toEqual(a)

    // A copy of the same delivery under another handle binds to the row and reads it.
    const copy = at('Crew:2:9', 'va')
    expect(await ledger.bindSource(copy, KEY_A)).toEqual({ bound: true, route: a })
    expect(await ledger.claim(item(at('Trash:1:3', 'va'), { key: KEY_A }), { status: 'not_routed', reason: 'r' })).toEqual({ fresh: false, route: a })
    expect(await ledger.getSource(at('Trash:1:3', 'va'))).toEqual(a)
    // Bound to its version's row once, it is never rebound to another row of that version.
    await ledger.claim(item(at('Crew:2:10', 'va'), { key: KEY_B }), { status: 'not_routed', reason: 'r' })
    await expect(ledger.bindSource(copy, KEY_B)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
  })

  it('opens a ledger an older version wrote, keeps its rows and aliases as version \'\', and survives a reopen', async () => {
    // The v1 and v2 schema exactly as an older Walnut wrote it, with a row and a moved-source alias.
    const old = rawClient()
    await old.migrate([
      {
        version: 1,
        sql: `CREATE TABLE router_items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL,
          thread_key TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, reason TEXT NOT NULL,
          rule_id TEXT, by_task_id TEXT, message_id TEXT, error TEXT, created_at INTEGER NOT NULL, at INTEGER NOT NULL);`,
      },
      {
        version: 2,
        sql: `CREATE TABLE router_source_aliases (kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL, key TEXT NOT NULL,
          created_at INTEGER NOT NULL, PRIMARY KEY (kind, account, message));`,
      },
    ])
    const id = messageId(KEY_A, 'task-a')
    await old.run(`INSERT INTO router_items (key, kind, account, message, thread_key, sender, subject, status, task_id, reason,
      rule_id, by_task_id, message_id, error, created_at, at) VALUES (?, 'mail', ?, ?, NULL, 'pat@a.example.invalid', 'Rota', 'routed',
      'task-a', 'rule', NULL, NULL, ?, NULL, 1000, 1500)`, [KEY_A, ACCOUNT, HANDLE, id])
    await old.run("INSERT INTO router_source_aliases VALUES ('mail', ?, 'Archive:4:9', ?, 1200)", [ACCOUNT, KEY_A])
    await old.dispose()

    const expected = {
      areaId: AREA, key: KEY_A, source: at(HANDLE), sender: 'pat@a.example.invalid', subject: 'Rota',
      status: 'routed', taskId: 'task-a', reason: 'rule', at: 1500, messageId: id,
    }
    for (let round = 0; round < 2; round++) {
      const ledger = store()
      expect(await ledger.get(KEY_A)).toEqual(expected)
      expect(await ledger.getSource(at(HANDLE))).toEqual(expected)
      expect(await ledger.getSource(at('Archive:4:9'))).toEqual(expected)
      // The old identity grants nothing to a versioned source of the same handle or the moved one.
      expect(await ledger.getSource(at(HANDLE, 'va'))).toBeUndefined()
      expect(await ledger.getSource(at('Archive:4:9', 'va'))).toBeUndefined()
      await ledger.dispose()
    }

    const ledger = store()
    const versioned = await ledger.claim(item(at(HANDLE, 'vb'), { key: KEY_B }), { status: 'routing', taskId: 'task-b', reason: 'r' })
    expect(versioned.fresh).toBe(true)
    expect(await ledger.get(KEY_A)).toEqual(expected)

    const raw = rawClient()
    expect(await raw.all('SELECT kind, account, message, key, created_at FROM router_source_aliases')).toEqual([
      { kind: 'mail', account: ACCOUNT, message: 'Archive:4:9', key: KEY_A, created_at: 1200 },
    ])
    expect(await raw.all('SELECT message, source_version, key FROM router_delivery_aliases ORDER BY created_at')).toEqual([
      { message: 'Archive:4:9', source_version: '', key: KEY_A },
      { message: HANDLE, source_version: 'vb', key: KEY_B },
    ])
    expect(await raw.all('SELECT key, source_version FROM router_items ORDER BY created_at')).toEqual([
      { key: KEY_A, source_version: '' },
      { key: KEY_B, source_version: 'vb' },
    ])
    expect((await raw.get<{ version: number }>('SELECT MAX(version) AS version FROM _walnut_plugin_migrations'))!.version).toBe(4)
  })

  it('reads an alias an older Walnut wrote into the v2 table after the migration, for unversioned sources only', async () => {
    const ledger = store()
    const original = (await ledger.claim(item(at(HANDLE), { key: KEY_A }), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route
    const versioned = (await ledger.claim(item(at(HANDLE, 'vb'), { key: KEY_B }), { status: 'routing', taskId: 'task-b', reason: 'r' }, 2_000)).route
    // An older Walnut, run on this migrated file, binds moved sources only in the table it knows.
    const older = rawClient()
    await older.run("INSERT INTO router_source_aliases VALUES ('mail', ?, 'Archive:4:9', ?, 3000)", [ACCOUNT, KEY_A])
    // It cannot tell versions apart, so it may bind a handle to a versioned row: never read that.
    await older.run("INSERT INTO router_source_aliases VALUES ('mail', ?, 'Archive:4:10', ?, 3001)", [ACCOUNT, KEY_B])
    await ledger.dispose()

    const again = store()
    expect(await again.getSource(at('Archive:4:9'))).toEqual(original)
    expect(await again.getSource(at('Archive:4:10'))).toBeUndefined()
    for (const source of [at('Archive:4:9', 'va'), at('Archive:4:9', 'vb'), at('Archive:4:10', 'vb')]) {
      expect(await again.getSource(source)).toBeUndefined()
    }
    const all = vi.spyOn(PluginDatabaseClient.prototype, 'all')
    const batch = await again.getSources([at('Archive:4:9'), at('Archive:4:10'), at('Archive:4:9', 'vb'), at('Archive:4:10', 'vb'), at(HANDLE, 'vb')])
    expect(all).toHaveBeenCalledTimes(1)
    expect([...batch.keys()].sort()).toEqual([routerKey(at('Archive:4:9')), routerKey(at(HANDLE, 'vb'))].sort())
    expect(batch.get(routerKey(at('Archive:4:9')))).toEqual(original)
    expect(batch.get(routerKey(at(HANDLE, 'vb')))).toEqual(versioned)

    // The old alias holds the source: never rebound to another unversioned row, and a bind writes v3 only.
    const other = (await again.claim(item(at('Crew:2:9'), { key: rfcKey('<rota-c@marina.example.invalid>') }), { status: 'not_routed', reason: 'r' })).route
    await expect(again.bindSource(at('Archive:4:9'), other.key)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    await expect(again.claim(item(at('Archive:4:9'), { key: other.key }), { status: 'not_routed', reason: 'r' })).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    expect(await again.bindSource(at('Archive:4:9'), KEY_A)).toEqual({ bound: true, route: original })
    expect(await again.getSource(at('Archive:4:9'))).toEqual(original)
    // The bind wrote the v3 table only; the old rows stay exactly as the older Walnut wrote them.
    const raw = rawClient()
    expect(await raw.all('SELECT message, source_version, key FROM router_delivery_aliases WHERE message = ?', ['Archive:4:9']))
      .toEqual([{ message: 'Archive:4:9', source_version: '', key: KEY_A }])
    expect(await raw.all('SELECT key FROM router_source_aliases ORDER BY created_at')).toEqual([{ key: KEY_A }, { key: KEY_B }])
  })
})

describe('legacy receipts', () => {
  const HANDLED = { taskId: 'task-desk', reason: 'Handled before the router', evidence: 'Reply in the desk thread on the same day', at: 4_000, byTaskId: 'task-lead' }
  const versioned = (message: string, version = 'delivery-1'): RouterSource => ({ ...mail('crew', message), version })

  it('records a routed receipt with no message id, marked legacy with its evidence, and reads it back the same after a reopen', async () => {
    const ledger = store()
    const source = versioned('m1')
    const made = await ledger.recordLegacy(item(source, { threadKey: 'thread-1' }), HANDLED)
    const expected = {
      areaId: AREA, key: routerKey(source), source, threadKey: 'thread-1', sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule',
      status: 'routed', taskId: 'task-desk', reason: 'Handled before the router', byTaskId: 'task-lead', at: 4_000,
      evidence: 'Reply in the desk thread on the same day', origin: 'legacy',
    }
    expect(made).toEqual({ fresh: true, route: expected })
    expect(made.route).not.toHaveProperty('messageId')
    expect(made.route).not.toHaveProperty('ruleId')
    await ledger.dispose()
    const again = store()
    expect(await again.get(made.route.key)).toEqual(expected)
    expect(await again.getSource(source)).toEqual(expected)
    expect(await again.getSource(mail('crew', 'm1'))).toBeUndefined()
    expect(await again.getSource(versioned('m1', 'delivery-2'))).toBeUndefined()
    expect(await again.history({ kind: 'mail', account: 'crew', limit: 10 })).toEqual([expected])
    const raw = rawClient()
    expect(await raw.all('SELECT status, message_id, receipt_origin, evidence, created_at FROM router_items')).toEqual([
      { status: 'routed', message_id: null, receipt_origin: 'legacy', evidence: 'Reply in the desk thread on the same day', created_at: 4_000 },
    ])
    expect(await raw.all('SELECT message, source_version, key FROM router_delivery_aliases')).toEqual([
      { message: 'm1', source_version: 'delivery-1', key: made.route.key },
    ])
  })

  it('is never settled, retried or sent: the ledger cannot move it, and the store has no way to send', async () => {
    const ledger = store()
    const route = (await ledger.recordLegacy(item(versioned('m1')), HANDLED)).route
    const anyId = messageId(route.key, 'task-desk')
    for (const status of ['routed', 'failed', 'unknown'] as const) {
      expect(await ledger.settle(route.key, anyId, { status }, 9_000)).toEqual({ settled: false, route })
    }
    expect(await ledger.retry(route.key, 9_000)).toEqual({ fresh: false, route })
    expect(await ledger.claim(item(versioned('m1')), { status: 'routing', taskId: 'task-other', reason: 'late' })).toEqual({ fresh: false, route })
    const code = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/core/router/store.ts'), 'utf8')
    expect(code.match(/^import .*$/gm)!.every((line) => !/session|send|task-start|queue/.test(line))).toBe(true)
  })

  it('leaves an existing row exactly as it was, whatever its status', async () => {
    const ledger = store()
    const routed = (await ledger.claim(item(versioned('m1')), { status: 'routing', taskId: 'task-a', reason: 'r', ruleId: 'rule-1' }, 1_000)).route
    await ledger.settle(routed.key, routed.messageId!, { status: 'routed' }, 2_000)
    const failed = (await ledger.claim(item(versioned('m2')), { status: 'routing', taskId: 'task-a', reason: 'r' }, 1_000)).route
    await ledger.settle(failed.key, failed.messageId!, { status: 'failed', error: 'busy' }, 2_000)
    const skipped = (await ledger.claim(item(versioned('m3')), { status: 'not_routed', reason: 'muted' }, 1_000)).route
    const raw = rawClient()
    const before = await raw.all('SELECT * FROM router_items ORDER BY key')
    for (const one of [routed, failed, skipped]) {
      const kept = await ledger.get(one.key)
      expect(await ledger.recordLegacy(item(one.source), HANDLED)).toEqual({ fresh: false, route: kept })
      expect(kept).not.toHaveProperty('origin')
      expect(kept).not.toHaveProperty('evidence')
    }
    expect(await raw.all('SELECT * FROM router_items ORDER BY key')).toEqual(before)
    expect((await raw.all<{ receipt_origin: string }>('SELECT receipt_origin FROM router_items')).map((r) => r.receipt_origin)).toEqual(['router', 'router', 'router'])
  })

  it('makes one row among concurrent writes from two connections', async () => {
    const left = store()
    const right = store()
    await left.get('mail:warmup:0')
    await right.get('mail:warmup:0')
    const source = versioned('race-1')
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? left : right)
      .recordLegacy(item(source), { ...HANDLED, taskId: `task-${index}`, at: 5_000 + index })))
    const winners = results.filter((r) => r.fresh)
    expect(winners).toHaveLength(1)
    for (const result of results) expect(result.route).toEqual(winners[0]!.route)
    const raw = rawClient()
    expect(await raw.get('SELECT COUNT(*) AS n FROM router_items')).toEqual({ n: 1 })
    expect(await raw.get('SELECT COUNT(*) AS n FROM router_delivery_aliases')).toEqual({ n: 1 })
  })

  it('makes no row for a source that already names another item', async () => {
    const ledger = store()
    const first = (await ledger.claim(item(versioned('m1')), { status: 'not_routed', reason: 'muted' })).route
    await expect(ledger.recordLegacy(item(versioned('m1'), { key: 'mail:crew:other-key' }), HANDLED)).rejects.toMatchObject({ code: 'source_bound_elsewhere' })
    expect(await ledger.get('mail:crew:other-key')).toBeUndefined()
    expect(await ledger.getSource(versioned('m1'))).toEqual(first)
  })

  it('refuses missing or oversized evidence, a missing time or target, and a route claim carrying either field', async () => {
    const ledger = store()
    const source = versioned('m1')
    for (const bad of [
      { ...HANDLED, evidence: '' }, { ...HANDLED, evidence: '   ' }, { ...HANDLED, evidence: 'x'.repeat(ROUTER_EVIDENCE_MAX + 1) },
      { ...HANDLED, evidence: undefined as unknown as string }, { ...HANDLED, at: undefined as unknown as number },
      { ...HANDLED, at: Number.NaN }, { ...HANDLED, taskId: '' }, { ...HANDLED, reason: '' },
    ]) await expect(ledger.recordLegacy(item(source), bad)).rejects.toThrow(TypeError)
    for (const extra of [{ origin: 'legacy' }, { evidence: 'Looked handled' }]) {
      await expect(ledger.claim(item(source), { status: 'routing', taskId: 'task-a', reason: 'r', ...extra } as never)).rejects.toThrow(/no origin or evidence/)
    }
    expect(await ledger.getSource(source)).toBeUndefined()
    expect((await ledger.recordLegacy(item(source), { ...HANDLED, evidence: 'x'.repeat(ROUTER_EVIDENCE_MAX) })).fresh).toBe(true)
  })

  it('opens a v3 ledger: its rows read exactly as before, as routes the router made', async () => {
    // The v1 to v3 schema exactly as the previous Walnut wrote it, with one routed row.
    const old = rawClient()
    await old.migrate([
      { version: 1, sql: `CREATE TABLE router_items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL,
        thread_key TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, reason TEXT NOT NULL,
        rule_id TEXT, by_task_id TEXT, message_id TEXT, error TEXT, created_at INTEGER NOT NULL, at INTEGER NOT NULL);` },
      { version: 2, sql: `CREATE TABLE router_source_aliases (kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL, key TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (kind, account, message));` },
      { version: 3, sql: `ALTER TABLE router_items ADD COLUMN source_version TEXT NOT NULL DEFAULT '';
        CREATE TABLE router_delivery_aliases (kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL, source_version TEXT NOT NULL,
        key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, account, message, source_version));` },
    ])
    const source = versioned('m1')
    const key = routerKey(source)
    const id = messageId(key, 'task-a')
    await old.run(`INSERT INTO router_items (key, kind, account, message, source_version, thread_key, sender, subject, status, task_id, reason,
      rule_id, by_task_id, message_id, error, created_at, at) VALUES (?, 'mail', 'crew', 'm1', 'delivery-1', NULL, 's', 'Rota', 'routed',
      'task-a', 'rule', 'rule-1', NULL, ?, NULL, 1000, 1500)`, [key, id])
    await old.run("INSERT INTO router_delivery_aliases VALUES ('mail', 'crew', 'm1', 'delivery-1', ?, 1000)", [key])
    await old.dispose()

    const expected = { areaId: AREA, key, source, sender: 's', subject: 'Rota', status: 'routed', taskId: 'task-a', reason: 'rule', ruleId: 'rule-1', at: 1500, messageId: id }
    const ledger = store()
    expect(await ledger.getSource(source)).toEqual(expected)
    expect(await ledger.recordLegacy(item(source), HANDLED)).toEqual({ fresh: false, route: expected })
    const raw = rawClient()
    expect(await raw.get('SELECT receipt_origin, evidence FROM router_items')).toEqual({ receipt_origin: 'router', evidence: null })
    expect((await raw.get<{ version: number }>('SELECT MAX(version) AS version FROM _walnut_plugin_migrations'))!.version).toBe(4)
  })
})

describe('hasRouterDecisions', () => {
  const HANDLED = { taskId: 'task-desk', reason: 'Handled before the router', evidence: 'Reply in the desk thread', at: 4_000 }
  const versioned = (message: string): RouterSource => ({ ...mail('crew', message), version: 'delivery-1' })

  it('is false for an empty ledger and for one holding only legacy receipts', async () => {
    const ledger = store()
    expect(await ledger.hasRouterDecisions()).toBe(false)
    await ledger.recordLegacy(item(versioned('m1')), HANDLED)
    await ledger.recordLegacy(item(versioned('m2')), HANDLED)
    expect(await ledger.hasRouterDecisions()).toBe(false)
  })

  it('is true for a router decision in every status, however old', async () => {
    const statuses = ['routing', 'routed', 'not_routed', 'failed', 'unknown'] as const
    for (const [index, status] of statuses.entries()) {
      const ledger = store(`area-${index}`)
      await ledger.recordLegacy(item(versioned('legacy-1')), HANDLED)
      const source = versioned(`m-${status}`)
      // At time 1: no clock decides it, only the row's origin.
      const claimed = await ledger.claim(item(source), status === 'not_routed'
        ? { status: 'not_routed', reason: 'muted' }
        : { status: 'routing', taskId: 'task-a', reason: 'rule' }, 1)
      if (status !== 'routing' && status !== 'not_routed') {
        const settled = await ledger.settle(claimed.route.key, claimed.route.messageId!, { status }, 2)
        expect(settled.route?.status).toBe(status)
      }
      expect((await ledger.get(claimed.route.key))?.status).toBe(status)
      expect(await ledger.hasRouterDecisions()).toBe(true)
    }
  })

  it('counts a row an older Walnut wrote before receipts had an origin as the router\'s', async () => {
    const old = rawClient()
    await old.migrate([
      { version: 1, sql: `CREATE TABLE router_items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, message TEXT NOT NULL,
        thread_key TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, reason TEXT NOT NULL,
        rule_id TEXT, by_task_id TEXT, message_id TEXT, error TEXT, created_at INTEGER NOT NULL, at INTEGER NOT NULL);` },
    ])
    await old.run(`INSERT INTO router_items (key, kind, account, message, thread_key, sender, subject, status, task_id, reason, rule_id, by_task_id,
      message_id, error, created_at, at) VALUES ('mail:crew:m1', 'mail', 'crew', 'm1', NULL, 's', 'Rota', 'not_routed', NULL, 'muted', NULL, NULL, NULL, NULL, 1, 1)`)
    await old.dispose()
    expect(await store().hasRouterDecisions()).toBe(true)
  })
})

describe('overview (the router page summary)', () => {
  it('reads zero and no newest row for an empty area', async () => {
    expect(await store().overview()).toEqual({ counts: {} })
  })

  it('counts each state and names the newest row by its latest change', async () => {
    const ledger = store()
    const first = await ledger.claim(item(mail('crew', 'm1')), { status: 'routing', taskId: 'task-a', reason: 'thread match' }, 1_000)
    await ledger.claim(item(mail('crew', 'm2')), { status: 'not_routed', reason: 'newsletter' }, 2_000)
    await ledger.claim(item(mail('crew', 'm3')), { status: 'routing', taskId: 'task-b', reason: 'new subject' }, 3_000)
    await ledger.settle(first.route.key, messageId(first.route.key, 'task-a'), { status: 'routed' }, 4_000)
    const view = await ledger.overview()
    expect(view.counts).toEqual({ routed: 1, not_routed: 1, routing: 1 })
    expect(view.latest).toMatchObject({ key: first.route.key, status: 'routed', taskId: 'task-a', at: 4_000 })
  })

  it('leaves out legacy receipts: work handled before the router is no decision of its own', async () => {
    const ledger = store()
    await ledger.recordLegacy(item(mail('crew', 'old')), { taskId: 'task-desk', reason: 'Handled before the router', evidence: 'Reply in the desk thread', at: 9_000 })
    expect(await ledger.overview()).toEqual({ counts: {} })
    await ledger.claim(item(mail('crew', 'new')), { status: 'not_routed', reason: 'newsletter' }, 2_000)
    const view = await ledger.overview()
    expect(view.counts).toEqual({ not_routed: 1 })
    expect(view.latest).toMatchObject({ status: 'not_routed', at: 2_000 })
  })
})

