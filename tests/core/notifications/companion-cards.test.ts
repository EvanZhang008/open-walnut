/**
 * The cloud companion's own cards (stage 4d of docs/plan/walnut-companion-unified-replica.md):
 * its store lives in cache/ and every write its producers make reaches the Mac over
 * the `server.notifications.cards` relay (core/notifications/companion-cards.ts).
 *
 * Pinned:
 *   - the box's store is `cache/companion-notifications.json`; the data dir's
 *     notifications.json (the Mac's, from git) is never written, and the box's own
 *     error cards in it come along once;
 *   - every producer write is reported (new, fold, replace, settled, removed), a
 *     letter never, and a report made before the sink started is kept for it;
 *   - while the Mac does not answer, a card's changes fold into one entry on disk;
 *     the Mac's answer takes it; an older Mac keeps it waiting; a refused batch is
 *     dropped; a change that raced a send stays for the next one.
 *
 * Real: the store, the outbox file. Mocked: constants (temp dirs, CLOUD_MODE), the
 * relay to the Mac (the seam every relay goes through).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-cards', { CLOUD_MODE: true }))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }
const calls: Array<{ action: string; params: any }> = []
let reply: (action: string, params: any) => Reply | Promise<Reply> = () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge', notSent: true } })
vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: async (action: string, _sid: string, params: unknown) => { calls.push({ action, params }); return reply(action, params) },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  addNotification, upsertNotification, replaceNotification, removeNotification, recoverNotifications,
  resolvePermissionNotification, listNotifications, NOTIFICATIONS_STORE_FILE,
} from '../../../src/core/notifications/store.js'
import { _resetOwnCardsForTesting, setOwnCardSink, type OwnCardChange } from '../../../src/core/notifications/mirror.js'
import {
  _companionCardsSavedForTesting, _holdCompanionCardSendsForTesting, _resetCompanionCardsForTesting,
  coalesceCard, flushCompanionCards, noteOwnCardChanges, pendingCompanionCards, startCompanionCards,
} from '../../../src/core/notifications/companion-cards.js'

const SHARED = path.join(WALNUT_HOME, 'notifications.json')
const OUTBOX = path.join(WALNUT_HOME, 'cache', 'companion-notification-outbox.json')
const offline = (): Reply => ({ ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge', notSent: true } })
const took = (_a: string, p: any): Reply => ({ ok: true, result: { applied: p.cards.length, skipped: 0, refused: [] } })
const sentCards = () => calls.filter((c) => c.action === 'server.notifications.cards').flatMap((c) => c.params.cards as Array<{ key: string; mode: string; fires: number; record: { id: string; count?: number; resolved?: string } }>)

beforeEach(() => {
  fs.rmSync(path.join(WALNUT_HOME, 'cache'), { recursive: true, force: true })
  fs.rmSync(SHARED, { force: true })
  calls.length = 0
  reply = offline
  _resetOwnCardsForTesting()
  _resetCompanionCardsForTesting()
  // Sends happen when a test asks (flushCompanionCards), never on a timer of their own.
  _holdCompanionCardSendsForTesting(true)
  setOwnCardSink(noteOwnCardChanges)
})

describe('the box\'s own store', () => {
  it('lives in cache/, and the data dir\'s file (the Mac\'s) is never written', async () => {
    expect(NOTIFICATIONS_STORE_FILE).toBe(path.join(WALNUT_HOME, 'cache', 'companion-notifications.json'))
    fs.writeFileSync(SHARED, JSON.stringify({ version: 1, notifications: [] }))
    const before = fs.readFileSync(SHARED, 'utf8')
    await addNotification({ kind: 'cron', severity: 'info', title: 'Box digest', dedupKey: 'cron:box' })
    expect(fs.readFileSync(SHARED, 'utf8')).toBe(before)
    expect(JSON.parse(fs.readFileSync(NOTIFICATIONS_STORE_FILE, 'utf8')).notifications.map((n: { dedupKey: string }) => n.dedupKey)).toEqual(['cron:box'])
  })
})

describe('what the store reports', () => {
  it('every producer write, and never a letter', async () => {
    const seen: OwnCardChange[] = []
    setOwnCardSink((c) => seen.push(...c))
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1', requestId: 'r1', sessionId: 's-box' })
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1' })
    await upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Plugin sync failed', dedupKey: 'logerr:p', recoveryKey: 'plugin:chat' })
    await upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Plugin sync failed', dedupKey: 'logerr:p', recoveryKey: 'plugin:chat' })
    await replaceNotification({ kind: 'reminder', severity: 'info', title: 'Stand-up', dedupKey: 'plugin:chat:standup' })
    await resolvePermissionNotification('r1', 'expired')
    await recoverNotifications(['plugin:chat'])
    await removeNotification('plugin:chat:standup')
    await addNotification({ kind: 'letter', severity: 'info', title: 'A letter', dedupKey: 'letter:lt-1', letterId: 'lt-1' })
    expect(seen.map((c) => `${c.mode}:${c.key}`)).toEqual([
      'add:perm:r1', 'upsert:logerr:p', 'upsert:logerr:p', 'replace:plugin:chat:standup',
      'state:perm:r1', 'state:logerr:p', 'remove:plugin:chat:standup',
    ])
    expect(seen.find((c) => c.mode === 'state' && c.key === 'logerr:p')?.record).toMatchObject({ resolved: 'recovered', origin: 'replica', count: 2 })
  })

  it('a report made before the sink started is handed to it', async () => {
    _resetOwnCardsForTesting()
    await addNotification({ kind: 'skill', severity: 'success', title: 'New skill: acme', dedupKey: 'skill:acme:1' })
    const seen: string[] = []
    setOwnCardSink((c) => seen.push(...c.map((x) => x.key)))
    expect(seen).toEqual(['skill:acme:1'])
  })

  it('the box\'s own error cards in the data dir\'s file come along once; the Mac\'s do not', async () => {
    _resetOwnCardsForTesting()
    vi.resetModules()
    fs.rmSync(path.join(WALNUT_HOME, 'cache'), { recursive: true, force: true })
    fs.writeFileSync(SHARED, JSON.stringify({ version: 1, notifications: [
      { id: 'n-box', kind: 'operation-error', severity: 'error', title: 'Backup failing', dedupKey: 'error:backup', recoveryKey: 'backup', timestamp: 1, read: false, origin: 'replica' },
      { id: 'n-mac', kind: 'operation-error', severity: 'error', title: 'Mac card', dedupKey: 'error:mac', timestamp: 1, read: false },
      { id: 'n-perm', kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:mac', timestamp: 1, read: false },
    ] }))
    const fresh = await import('../../../src/core/notifications/store.js')
    expect((await fresh.listNotifications()).feed.map((n) => n.dedupKey)).toEqual(['error:backup'])
  })
})

describe('coalesceCard', () => {
  const rec = (over: Record<string, unknown> = {}) => ({ id: 'n1', kind: 'operation-error', severity: 'error', title: 't', timestamp: 1, read: false, dedupKey: 'k', ...over }) as never
  const change = (mode: OwnCardChange['mode'], over: Record<string, unknown> = {}): OwnCardChange => ({ mode, key: 'k', record: rec(over) })
  it('keeps the card as it now stands, the strongest mode and the occurrences', () => {
    let e = coalesceCard(undefined, change('upsert'), 1)
    e = coalesceCard(e, change('upsert', { count: 2 }), 2)
    e = coalesceCard(e, change('state', { count: 2, resolved: 'recovered' }), 3)
    expect(e).toMatchObject({ mode: 'upsert', fires: 2, at: 3, record: { count: 2, resolved: 'recovered' } })
  })
  it('a made-then-settled card goes as a new card; a removal ends it; made again it replaces', () => {
    expect(coalesceCard(coalesceCard(undefined, change('add'), 1), change('state', { resolved: 'expired' }), 2)).toMatchObject({ mode: 'add', record: { resolved: 'expired' } })
    const gone = coalesceCard(coalesceCard(undefined, change('add'), 1), change('remove'), 2)
    expect(gone).toMatchObject({ mode: 'remove', fires: 0 })
    expect(coalesceCard(gone, change('state'), 3).mode).toBe('remove')
    expect(coalesceCard(gone, change('add', { id: 'n2' }), 4)).toMatchObject({ mode: 'replace', fires: 1, record: { id: 'n2' } })
  })
})

describe('the outbox', () => {
  it('while the Mac does not answer: one entry per card, on disk; the Mac\'s answer takes them', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Sync failed', dedupKey: 'logerr:storm', timestamp: 1_000 + i })
    }
    await addNotification({ kind: 'cron', severity: 'info', title: 'Digest', dedupKey: 'cron:d' })
    expect(await flushCompanionCards('test')).toBe(0)
    await _companionCardsSavedForTesting()
    const onDisk = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'))
    expect(Object.keys(onDisk.cards).sort()).toEqual(['cron:d', 'logerr:storm'])
    expect(onDisk.cards['logerr:storm']).toMatchObject({ mode: 'upsert', fires: 5, record: { count: 5 } })
    expect(pendingCompanionCards().cards.map((c) => c.dedupKey).sort()).toEqual(['cron:d', 'logerr:storm'])

    // A restart keeps them (the file is read again).
    _resetCompanionCardsForTesting()
    calls.length = 0
    reply = took
    expect(await flushCompanionCards('test')).toBe(2)
    expect(sentCards().map((c) => [c.key, c.mode, c.fires])).toEqual([['logerr:storm', 'upsert', 5], ['cron:d', 'add', 1]])
    expect(pendingCompanionCards().cards).toEqual([])
    expect(JSON.parse(fs.readFileSync(OUTBOX, 'utf8')).cards).toEqual({})
  })

  it('an older Mac keeps them waiting; a refused batch is dropped', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'Digest', dedupKey: 'cron:old' })
    reply = () => ({ ok: false, failure: { kind: 'needs_upgrade', message: 'The primary box predates this mobile action' } })
    await flushCompanionCards('test')
    expect(pendingCompanionCards().cards.map((c) => c.dedupKey)).toEqual(['cron:old'])
    reply = () => ({ ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'cards must be an array' } })
    await flushCompanionCards('test')
    expect(pendingCompanionCards().cards).toEqual([])
  })

  it('a change that raced the send stays for the next one', async () => {
    await upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Sync failed', dedupKey: 'logerr:race', timestamp: 10 })
    reply = async (a, p) => {
      // The card fires again while its first send is on the wire.
      await upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Sync failed', dedupKey: 'logerr:race', timestamp: 20 })
      return took(a, p)
    }
    await flushCompanionCards('test')
    const left = pendingCompanionCards().cards
    expect(left.map((c) => [c.dedupKey, c.count])).toEqual([['logerr:race', 2]])
  })

  it('startCompanionCards installs the sink: a card made after it is sent soon', async () => {
    _resetOwnCardsForTesting()
    _holdCompanionCardSendsForTesting(false)
    reply = took
    const handle = startCompanionCards()
    try {
      await addNotification({ kind: 'hook', severity: 'info', title: 'Hook ran', dedupKey: 'hook:soon' })
      await vi.waitFor(() => expect(sentCards().map((c) => c.key)).toEqual(['hook:soon']), { timeout: 3_000 })
      expect(sentCards()[0].record.id).toBe((await listNotifications()).feed.find((n) => n.dedupKey === 'hook:soon')?.id)
    } finally {
      handle.stop()
    }
  })
})
