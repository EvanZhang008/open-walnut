/**
 * The Mac's side of stage 4d (docs/plan/walnut-companion-unified-replica.md): the
 * relay actions the cloud companion calls on it, through the real relay dispatcher
 * (handleSessionControlRelay) against a real store in a temp data dir.
 *
 * Pinned:
 *   - `server.notifications.cards`: every mode applies once, keyed by the dedupKey
 *     with the box's id, and a resend of the same batch changes nothing; a fold
 *     counts the occurrences the box folded; a settled stamp never brings back a
 *     card the human dismissed here; a removal takes only the box's copy; a bad card
 *     is refused alone; the feed's live events go out;
 *   - `server.notifications.mark`: the console route's rules (keys, ids, an empty key
 *     list names nothing, no filter marks all but letters);
 *   - `server.ui-prefs.put`: the route's LWW merge into this Mac's file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apply-companion-cards'))

import { UI_PREFS_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { addNotification, listNotifications, NOTIFICATIONS_STORE_FILE, type NotificationRecord } from '../../../src/core/notifications/store.js'
import { bus } from '../../../src/core/event-bus.js'

const T0 = 1_800_000_000_000

function card(over: Partial<NotificationRecord> & { dedupKey: string }): NotificationRecord {
  return { id: `notif-box-${over.dedupKey}`, kind: 'operation-error', severity: 'error', title: 'Plugin sync failed', timestamp: T0, read: false, origin: 'replica', ...over }
}

async function send(cards: Array<{ key?: string; mode: string; fires?: number; record: NotificationRecord }>) {
  const r = await handleSessionControlRelay('server.notifications.cards', '__server__', {
    cards: cards.map((c) => ({ key: c.key ?? c.record.dedupKey, fires: c.fires ?? 1, mode: c.mode, record: c.record })),
  })
  if (!r.ok) throw new Error(r.error)
  return r.result as { applied: number; skipped: number; refused: string[] }
}

const feed = async () => (await listNotifications()).feed
const byKey = async (k: string) => (await feed()).find((n) => n.dedupKey === k)

beforeEach(() => {
  fs.rmSync(NOTIFICATIONS_STORE_FILE, { force: true })
  fs.rmSync(UI_PREFS_FILE, { force: true })
})

describe('server.notifications.cards on the Mac', () => {
  it('stores the Mac\'s own file, the data dir\'s notifications.json', () => {
    expect(NOTIFICATIONS_STORE_FILE).toBe(`${WALNUT_HOME}/notifications.json`)
  })

  it('add: inserted with the box\'s id, once; a card the Mac already has under the key stays', async () => {
    const c = card({ dedupKey: 'logerr:acme:1', kind: 'cron', severity: 'info', title: 'Acme digest sent' })
    expect(await send([{ mode: 'add', record: c }])).toEqual({ applied: 1, skipped: 0, refused: [] })
    expect(await send([{ mode: 'add', record: c }])).toEqual({ applied: 0, skipped: 1, refused: [] })
    expect((await feed()).map((n) => n.id)).toEqual(['notif-box-logerr:acme:1'])
    await addNotification({ kind: 'cron', severity: 'info', title: 'Mac own', dedupKey: 'cron:mac' })
    await send([{ mode: 'add', record: card({ dedupKey: 'cron:mac', kind: 'cron', title: 'Box says' }) }])
    expect((await byKey('cron:mac'))?.title).toBe('Mac own')
  })

  it('upsert: a standing card only refreshes; one that comes back after it settled counts the box\'s folds and is unread; the same batch twice counts once', async () => {
    await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:sync', count: 1 }) }])
    const first = await byKey('logerr:sync')
    expect(first).toMatchObject({ id: 'notif-box-logerr:sync', count: 1, origin: 'replica' })
    // The human read it here.
    await handleSessionControlRelay('server.notifications.mark', '__server__', { dedupKeys: ['logerr:sync'] })
    // Still failing on the box: the latest body and stamp, no count, still read.
    const standing = card({ dedupKey: 'logerr:sync', body: 'Still failing', lastTimestamp: T0 + 30_000 })
    expect((await send([{ mode: 'upsert', fires: 2, record: standing }])).applied).toBe(1)
    expect(await byKey('logerr:sync')).toMatchObject({ count: 1, read: true, body: 'Still failing', lastTimestamp: T0 + 30_000 })
    // It settles, then fails again: that is news.
    await send([{ mode: 'state', fires: 0, record: card({ dedupKey: 'logerr:sync', resolved: 'recovered', resolvedAt: T0 + 40_000, severity: 'info', lastTimestamp: T0 + 30_000 }) }])
    const later = card({ dedupKey: 'logerr:sync', body: 'Sync failed again', count: 2, lastTimestamp: T0 + 60_000 })
    expect((await send([{ mode: 'upsert', fires: 3, record: later }])).applied).toBe(1)
    expect(await send([{ mode: 'upsert', fires: 3, record: later }])).toEqual({ applied: 0, skipped: 1, refused: [] })
    expect(await byKey('logerr:sync')).toMatchObject({ id: 'notif-box-logerr:sync', count: 4, read: false, body: 'Sync failed again', lastTimestamp: T0 + 60_000 })
    expect((await byKey('logerr:sync'))?.resolved).toBeUndefined()
  })

  it('upsert: a box card the human dismissed here while it was failing does not come back until it recovers', async () => {
    await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:gone', recoveryKey: 'plugin:acme' }) }])
    await handleSessionControlRelay('server.notifications.dismiss', '__server__', { dedupKeys: ['logerr:gone'] })
    const again = card({ dedupKey: 'logerr:gone', recoveryKey: 'plugin:acme', lastTimestamp: T0 + 60_000 })
    expect((await send([{ mode: 'upsert', record: again }])).applied).toBe(0)
    expect(await byKey('logerr:gone')).toBeUndefined()
    // A box card that is already settled is not held back by the dismissal.
    const { recoverNotifications } = await import('../../../src/core/notifications/store.js')
    await recoverNotifications(['plugin:acme'])
    const fresh = card({ dedupKey: 'logerr:gone', recoveryKey: 'plugin:acme', lastTimestamp: T0 + 120_000 })
    expect((await send([{ mode: 'upsert', record: fresh }])).applied).toBe(1)
  })

  it('state: stamps the Mac\'s card; a card dismissed here stays gone; an older stamp never settles a newer occurrence', async () => {
    await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:a' }) }, { mode: 'upsert', record: card({ dedupKey: 'logerr:b' }) }])
    const settled = { resolved: 'recovered' as const, resolvedAt: T0 + 5_000, severity: 'info' as const }
    expect((await send([{ mode: 'state', fires: 0, record: card({ dedupKey: 'logerr:a', ...settled }) }])).applied).toBe(1)
    expect(await byKey('logerr:a')).toMatchObject({ resolved: 'recovered', severity: 'info' })
    await handleSessionControlRelay('server.notifications.dismiss', '__server__', { dedupKeys: ['logerr:b'] })
    expect((await send([{ mode: 'state', fires: 0, record: card({ dedupKey: 'logerr:b', ...settled }) }])).applied).toBe(0)
    expect(await byKey('logerr:b')).toBeUndefined()
    // The Mac saw a newer occurrence than the stamp's.
    await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:c', lastTimestamp: T0 + 90_000 }) }])
    expect((await send([{ mode: 'state', fires: 0, record: card({ dedupKey: 'logerr:c', ...settled }) }])).applied).toBe(0)
    expect((await byKey('logerr:c'))?.resolved).toBeUndefined()
  })

  it('replace: the box\'s card takes the key\'s place, once', async () => {
    await addNotification({ kind: 'reminder', severity: 'info', title: 'Stand-up (old)', dedupKey: 'plugin:chat:standup' })
    const fresh = card({ id: 'notif-box-r2', dedupKey: 'plugin:chat:standup', kind: 'reminder', severity: 'info', title: 'Stand-up', origin: undefined })
    expect((await send([{ mode: 'replace', record: fresh }])).applied).toBe(1)
    expect(await send([{ mode: 'replace', record: fresh }])).toEqual({ applied: 0, skipped: 1, refused: [] })
    expect((await feed()).filter((n) => n.dedupKey === 'plugin:chat:standup').map((n) => [n.id, n.title])).toEqual([['notif-box-r2', 'Stand-up']])
  })

  it('remove: only the box\'s copy goes', async () => {
    await send([{ mode: 'add', record: card({ dedupKey: 'hook:box', kind: 'hook', origin: undefined }) }])
    await addNotification({ kind: 'hook', severity: 'info', title: 'Mac hook', dedupKey: 'hook:mac' })
    const mine = await send([{ mode: 'remove', fires: 0, record: card({ dedupKey: 'hook:box', kind: 'hook', origin: undefined }) }])
    const theirs = await send([{ mode: 'remove', fires: 0, record: card({ dedupKey: 'hook:mac', kind: 'hook', origin: undefined }) }])
    expect([mine.applied, theirs.applied]).toEqual([1, 0])
    expect((await feed()).map((n) => n.dedupKey)).toEqual(['hook:mac'])
  })

  it('refuses a bad card alone, never the batch; a letter is never taken', async () => {
    const out = await send([
      { mode: 'add', record: card({ dedupKey: 'letter:lt-1', kind: 'letter' }) },
      { key: 'not-its-key', mode: 'add', record: card({ dedupKey: 'logerr:x' }) },
      { mode: 'sideways', record: card({ dedupKey: 'logerr:y' }) },
      { mode: 'add', record: card({ dedupKey: 'logerr:z', origin: 'mars' as never }) },
      { mode: 'add', record: card({ dedupKey: 'logerr:ok', fix: { taskId: 't1', startedAt: T0 } }) },
    ])
    expect(out).toEqual({ applied: 1, skipped: 0, refused: ['letter:lt-1', 'not-its-key', 'logerr:y', 'logerr:z'] })
    // A repair session is this Mac's own: never taken from the box.
    expect((await byKey('logerr:ok'))?.fix).toBeUndefined()
    const tooMany = await handleSessionControlRelay('server.notifications.cards', '__server__', { cards: Array.from({ length: 101 }, () => ({})) })
    expect(tooMany).toMatchObject({ ok: false, errorKind: 'bad_request' })
    expect(await handleSessionControlRelay('server.notifications.cards', '__server__', {})).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })

  it('tells the open consoles: new, updated, removed', async () => {
    const seen: string[] = []
    for (const name of ['notification:new', 'notification:updated', 'notification:removed']) {
      bus.subscribe(`t-${name}`, (e) => { if (e.name === name) seen.push(name) }, { global: true, interest: [name] })
    }
    try {
      await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:ev' }) }])
      await send([{ mode: 'upsert', record: card({ dedupKey: 'logerr:ev', lastTimestamp: T0 + 1 }) }])
      await send([{ mode: 'remove', fires: 0, record: card({ dedupKey: 'logerr:ev' }) }])
      expect(seen).toEqual(['notification:new', 'notification:updated', 'notification:removed'])
    } finally {
      for (const name of ['notification:new', 'notification:updated', 'notification:removed']) bus.unsubscribe(`t-${name}`)
    }
  })
})

describe('server.notifications.mark on the Mac: the console route\'s rules', () => {
  it('by key, by id, an empty key list names nothing, no filter marks all but letters', async () => {
    const a = await addNotification({ kind: 'cron', severity: 'info', title: 'a', dedupKey: 'k:a' })
    await addNotification({ kind: 'cron', severity: 'info', title: 'b', dedupKey: 'k:b' })
    await addNotification({ kind: 'cron', severity: 'info', title: 'c', dedupKey: 'k:c' })
    await addNotification({ kind: 'letter', severity: 'info', title: 'letter', dedupKey: 'letter:lt-9', letterId: 'lt-9' })
    const mark = async (params: Record<string, unknown>) => ((await handleSessionControlRelay('server.notifications.mark', '__server__', params)) as { result: { unreadCount: number } }).result.unreadCount
    expect(await mark({ dedupKeys: [] })).toBe(4)
    expect(await mark({ dedupKeys: ['k:b'] })).toBe(3)
    expect(await mark({ ids: [a.id] })).toBe(2)
    expect(await mark({})).toBe(1)
    expect((await byKey('letter:lt-9'))?.read).toBe(false)
  })
})

describe('server.ui-prefs.put on the Mac', () => {
  it('merges last-writer-wins into this Mac\'s file, and refuses a bad body', async () => {
    const put = (prefs: unknown) => handleSessionControlRelay('server.ui-prefs.put', '__server__', { prefs })
    expect(await put({ 'open-walnut-panel-width': { v: '420', ts: 20 } })).toEqual({ ok: true, result: { ok: true } })
    expect(await put({ 'open-walnut-panel-width': { v: '300', ts: 10 } })).toEqual({ ok: true, result: { ok: true } })
    expect(JSON.parse(fs.readFileSync(UI_PREFS_FILE, 'utf8'))).toEqual({ 'open-walnut-panel-width': { v: '420', ts: 20 } })
    expect(await put(['not', 'an', 'object'])).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})
