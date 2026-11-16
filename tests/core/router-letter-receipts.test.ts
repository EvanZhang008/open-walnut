/**
 * A letter to the person is recorded as such (src/core/router/letter-receipts.ts, store.ts
 * `noteLetter`), so an item the router sent the person never reads as a grey "Not routed".
 *
 * Why (2026-11-16): a DoorDash interview invitation the router had sent the person as an inbox
 * letter showed "Not routed" in Mail, and the person read it as nobody having it.
 *
 * A real RouterStore under this test's own temp home; the letter sender and the inbox lookup are
 * fakes. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../src/lib/sqlite.js'
import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { routerLetterOpKey, withLetterReceipts } from '../../src/core/router/letter-receipts.js'
import { routeItem, type RouterDeliveryDeps } from '../../src/core/router/service.js'
import { RouterStore, routerKey } from '../../src/core/router/store.js'
import type { RouterItem, RouterSource } from '../../src/core/router/types.js'
import type { Task } from '../../src/core/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const DESK = 'desk@marina.example.invalid'
const item = (message: string): RouterSource => ({ kind: 'mail', account: DESK, message, version: `v-${message}` })
const ITEMS = ['INBOX:1:1', 'INBOX:1:2', 'INBOX:1:3'].map(item)
const itemFor = (source: RouterSource): RouterItem => ({ source: { ...source }, key: routerKey(source), sender: 'pat@marina.example.invalid', subject: 'Dock slot' })

let home: string
let areas: RouterAreasFile
let store: RouterStore

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-letter-receipts-'))
  seedTaskStore(home)
  await updateRouterAreas(home, () => ({
    version: 1,
    areas: [{ id: 'mail', name: 'Mail', host: '__local__', taskIds: ['router'], sources: [{ kind: 'mail', account: DESK }] }],
    routers: [{ taskId: 'router', areaId: 'mail', paused: false }],
    items: [],
    openItems: ITEMS.map((source) => ({ source, areaId: 'mail' })),
  }))
  areas = await readRouterAreas(home)
  store = new RouterStore(home, 'mail')
})

afterEach(async () => {
  await store.dispose().catch(() => undefined)
  if (home && path.basename(home).startsWith('router-letter-receipts-')) fs.rmSync(home, { recursive: true, force: true })
})

function deps(letter: RouterDeliveryDeps['letter']): RouterDeliveryDeps {
  return {
    areas, store, letter, noise: null,
    resolve: async (source) => itemFor(source),
    getTask: async (id) => ({ id, title: id === 'router' ? 'Mail router' : id, org_role: id === 'router' ? 'router' : undefined, phase: 'IN_PROGRESS' }) as Task,
    send: async () => ({ ok: true }),
  }
}

/** What an older build left: a not_routed row whose letter nobody noted. */
function forgetLetter(key: string): void {
  const db = new Database(store.file)
  try { db.prepare('UPDATE router_items SET letter_id = NULL WHERE key = ?').run(key) } finally { db.close() }
}

describe('a letter to the person on its receipt', () => {
  it('a for_user decision notes the letter it sent, once', async () => {
    const letter = vi.fn(async () => 'lt-dock-1')
    const first = await routeItem({ source: ITEMS[0]!, forUser: true, reason: 'Only the person can approve', text: 'Approve the slot.', byTaskId: 'router' }, deps(letter))
    expect(first.route).toMatchObject({ status: 'not_routed', letterId: 'lt-dock-1' })
    expect(first.route.letterUnchecked).toBeUndefined()
    expect(await store.get(first.route.key)).toMatchObject({ letterId: 'lt-dock-1' })
    const again = await routeItem({ source: ITEMS[0]!, forUser: true, reason: 'Only the person can approve', text: 'Approve the slot.', byTaskId: 'router' }, deps(letter))
    expect(again).toMatchObject({ fresh: false, route: { letterId: 'lt-dock-1' } })
    expect(letter).toHaveBeenCalledTimes(1)
  })

  it('a letter whose send failed goes out on the next for_user call, and only then', async () => {
    const decide = { source: ITEMS[2]!, forUser: true, reason: 'Only the person can approve', text: 'Approve.', byTaskId: 'router' }
    await expect(routeItem(decide, deps(async () => { throw new Error('inbox busy') }))).rejects.toThrow('inbox busy')
    const key = routerKey(ITEMS[2]!)
    expect(await store.get(key)).toMatchObject({ status: 'not_routed', letterPending: true })
    const letter = vi.fn(async () => 'lt-late')
    expect((await routeItem(decide, deps(letter))).route).toMatchObject({ letterId: 'lt-late' })
    expect((await store.get(key))!.letterPending).toBeUndefined()
    await routeItem(decide, deps(letter))
    expect(letter).toHaveBeenCalledTimes(1)
  })

  it('noise is known to have no letter, so nothing is looked up for it', async () => {
    const result = await routeItem({ source: ITEMS[1]!, notRouted: true, reason: 'A newsletter', byTaskId: 'router' }, deps(vi.fn()))
    expect(result.route.letterId).toBeUndefined()
    expect(result.route.letterUnchecked).toBeUndefined()
    const findLetters = vi.fn(async () => new Map<string, string>())
    await withLetterReceipts([result.route], { store: () => store, findLetters })
    expect(findLetters).not.toHaveBeenCalled()
  })

  it('an older build\'s row is answered from the inbox by its letter\'s op key, one time only', async () => {
    const sent = await routeItem({ source: ITEMS[0]!, forUser: true, reason: 'Only the person can approve', text: 'Approve.', byTaskId: 'router' }, deps(async () => 'lt-old'))
    const noise = await routeItem({ source: ITEMS[1]!, notRouted: true, reason: 'A newsletter', byTaskId: 'router' }, deps(vi.fn()))
    for (const key of [sent.route.key, noise.route.key]) forgetLetter(key)
    const rows = [(await store.get(sent.route.key))!, (await store.get(noise.route.key))!]
    expect(rows.map((row) => row.letterUnchecked)).toEqual([true, true])
    const findLetters = vi.fn(async (keys: readonly string[]) => new Map(keys.filter((key) => key === routerLetterOpKey('mail', sent.route.key)).map((key) => [key, 'lt-old'])))
    const answered = await withLetterReceipts(rows, { store: () => store, findLetters })
    expect(answered.map((row) => [row.letterId, row.letterUnchecked])).toEqual([['lt-old', undefined], [undefined, undefined]])
    expect(findLetters).toHaveBeenCalledTimes(1)
    // Written back: the next read needs no lookup.
    const reread = [(await store.get(sent.route.key))!, (await store.get(noise.route.key))!]
    expect(reread.map((row) => [row.letterId, row.letterUnchecked])).toEqual([['lt-old', undefined], [undefined, undefined]])
    await withLetterReceipts(reread, { store: () => store, findLetters })
    expect(findLetters).toHaveBeenCalledTimes(1)
  })

  it('an inbox that cannot be read leaves the rows to be asked again', async () => {
    const sent = await routeItem({ source: ITEMS[2]!, forUser: true, reason: 'Only the person can approve', text: 'Approve.', byTaskId: 'router' }, deps(async () => 'lt-x'))
    forgetLetter(sent.route.key)
    const row = (await store.get(sent.route.key))!
    const answered = await withLetterReceipts([row], { store: () => store, findLetters: async () => { throw new Error('index unreadable') } })
    expect(answered[0]!.letterUnchecked).toBe(true)
    expect((await store.get(sent.route.key))!.letterUnchecked).toBe(true)
  })

  it('the router page counts letters apart from what needed nothing', async () => {
    await routeItem({ source: ITEMS[0]!, forUser: true, reason: 'Only the person can approve', text: 'Approve.', byTaskId: 'router' }, deps(async () => 'lt-1'))
    await routeItem({ source: ITEMS[1]!, notRouted: true, reason: 'A newsletter', byTaskId: 'router' }, deps(vi.fn()))
    const overview = await store.overview()
    expect(overview.counts.not_routed).toBe(2)
    expect(overview.letters).toBe(1)
  })
})
