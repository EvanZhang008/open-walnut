/**
 * One decision per mail across mailboxes (2026-11-14, the Walnut VP: the same mail, one Message-ID,
 * was handed over twice, once per mailbox): confirmAccountArrivals enters a mail once per area,
 * whichever of the person's mailboxes it reached first. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { confirmAccountArrivals, rfcIdOf } from '../../src/core/router/account-intake.js'
import type { RouterItem, RouterSource } from '../../src/core/router/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const DESK = 'desk@marina.example.invalid'
const HOME_BOX = 'home@marina.example.invalid'
const OTHER_AREA_BOX = 'shop@bakery.example.invalid'
const key = (account: string, rfc: string) => JSON.stringify(['mail', account, 'rfc', rfc])

let home: string
const prior = process.env.WALNUT_MAIL_AUTO_ROUTER

beforeEach(async () => {
  process.env.WALNUT_MAIL_AUTO_ROUTER = '1'
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-one-mail-'))
  seedTaskStore(home)
  await updateRouterAreas(home, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['router-p'], sources: [{ kind: 'mail', account: DESK }, { kind: 'mail', account: HOME_BOX }] },
      { id: 'side', name: 'Side', host: '__local__', taskIds: ['router-s'], sources: [{ kind: 'mail', account: OTHER_AREA_BOX }] },
    ],
    routers: [{ taskId: 'router-p', areaId: 'personal', paused: false }, { taskId: 'router-s', areaId: 'side', paused: false }],
    items: [],
    accountBindings: [
      { kind: 'mail', account: DESK, areaId: 'personal', boundAt: 1 },
      { kind: 'mail', account: HOME_BOX, areaId: 'personal', boundAt: 1 },
      { kind: 'mail', account: OTHER_AREA_BOX, areaId: 'side', boundAt: 1 },
    ],
  }) as RouterAreasFile)
})

afterEach(() => {
  if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior
  fs.rmSync(home, { recursive: true, force: true })
})

/** A cache where every asked source is current, keyed by the Message-ID each message carries. */
function deps(rfcOf: Record<string, string>) {
  return {
    resolve: async (source: RouterSource): Promise<RouterItem> => ({
      source: { ...source }, key: `k-${source.account}-${source.message}`,
      ...(rfcOf[source.message] ? { scopeKey: key(source.account, rfcOf[source.message]!) } : {}),
    } as RouterItem),
    current: async (sources: readonly RouterSource[]) => [...sources],
  }
}

const mail = (account: string, message: string): RouterSource => ({ kind: 'mail', account, message, version: `v-${message}` })

describe('one mail reached two of the person\'s mailboxes', () => {
  it('is entered once per area: the second mailbox\'s copy of the same Message-ID is not new', async () => {
    const rfc = { 'INBOX:1:1': '<dock-slot@marina.example.invalid>', 'INBOX:2:9': '<dock-slot@marina.example.invalid>' }
    expect(await confirmAccountArrivals([mail(DESK, 'INBOX:1:1')], home, deps(rfc))).toHaveLength(1)
    expect(await confirmAccountArrivals([mail(HOME_BOX, 'INBOX:2:9')], home, deps(rfc))).toEqual([])
    expect(((await readRouterAreas(home)).openItems ?? []).map((one) => one.source.account)).toEqual([DESK])
  })

  it('in one batch too, and a mail with another Message-ID or no Message-ID still goes in', async () => {
    const rfc = { 'INBOX:1:1': '<a@marina.example.invalid>', 'INBOX:2:9': '<a@marina.example.invalid>', 'INBOX:2:10': '<b@marina.example.invalid>' }
    const entered = await confirmAccountArrivals([mail(DESK, 'INBOX:1:1'), mail(HOME_BOX, 'INBOX:2:9'), mail(HOME_BOX, 'INBOX:2:10'), mail(HOME_BOX, 'INBOX:2:11')], home, deps(rfc))
    expect(entered.map((one) => `${one.account} ${one.message}`)).toEqual([`${DESK} INBOX:1:1`, `${HOME_BOX} INBOX:2:10`, `${HOME_BOX} INBOX:2:11`])
  })

  it('another area keeps its own copy: the rule is one decision per mail per router', async () => {
    const rfc = { 'INBOX:1:1': '<a@marina.example.invalid>', 'INBOX:3:3': '<a@marina.example.invalid>' }
    await confirmAccountArrivals([mail(DESK, 'INBOX:1:1')], home, deps(rfc))
    expect(await confirmAccountArrivals([mail(OTHER_AREA_BOX, 'INBOX:3:3')], home, deps(rfc))).toHaveLength(1)
  })

  it('reads the Message-ID only from a key by Message-ID', () => {
    expect(rfcIdOf(key(DESK, '<a@x>'))).toBe('<a@x>')
    expect(rfcIdOf(JSON.stringify(['mail', DESK, 'cache', 'INBOX:1:1']))).toBeUndefined()
    expect(rfcIdOf('not json')).toBeUndefined()
    expect(rfcIdOf(undefined)).toBeUndefined()
  })
})
