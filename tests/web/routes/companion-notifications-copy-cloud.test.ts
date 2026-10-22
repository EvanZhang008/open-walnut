/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: git sync no longer writes the companion's data dir, so the Mac's
 * notification feed reaches the box as the `notifications` copy kind (the Mac's round,
 * copy-kind.ts syncCopyKinds, over the real client and the real /bridge/replica door),
 * and the box's feeds read it while the Mac is away. The Mac is a fake behind the
 * relay seam (callPrimaryControl).
 *
 * Pinned:
 *   - before a round, the away feed is the file git sync last wrote (an older Mac);
 *   - after one, the console's away feed and the phone's (GET /api/v1/notifications,
 *     which answered 503 before) are the copy's cards with the box's own on top,
 *     marked `offline`, the phone's with `x-walnut-copy-as-of`, never the git file;
 *   - while the Mac answers, both feeds are the Mac's, with no copy header;
 *   - a feed the human cleared on the Mac empties the copy in one round (no half
 *     rule hold), and the away feed then shows only the box's own cards;
 *   - every write of a store tells its listeners (the Mac's round follows it).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-notifications-copy-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }
const mac = { up: false }
const OFFLINE: Reply = { ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge', notSent: true } }
const MAC_LIVE_FEED = [{ id: 'n-live-1', kind: 'cron', severity: 'info', title: 'Acme live card', dedupKey: 'cron:live', timestamp: 9_000, read: false }]
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async (action: string): Promise<Reply> => {
    if (!mac.up) return OFFLINE
    if (action === 'server.notifications') return { ok: true, result: { feed: MAC_LIVE_FEED, unreadCount: 1 } }
    if (action === 'server.notifications.cards') return { ok: true, result: { applied: 0, skipped: 0, refused: [] } }
    return OFFLINE
  },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { addNotification, onNotificationStoreWritten, type NotificationRecord } from '../../../src/core/notifications/store.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }

const card = (id: string, dedupKey: string, title: string, timestamp: number, read = false): NotificationRecord =>
  ({ id, kind: 'cron', severity: 'info', title, dedupKey, timestamp, read }) as NotificationRecord
// What git sync last brought from the Mac, before git stopped.
const GIT_FEED = JSON.stringify({ version: 1, notifications: [card('n-git-1', 'cron:git', 'Acme card from git', 1_000)] })
let macCards: NotificationRecord[] = []

function macKinds(): CopyKind<any>[] {
  return copyKinds().filter((k) => k.kind === 'notifications').map((k) => ({ ...k, watch: () => () => {}, rows: async () => macCards }))
}
const companion: CopyTarget = {
  id: 'companion', kind: 'companion', label: 'Cloud companion',
  available: async () => true,
  post: (payload, opts) => postToCloudReplica(payload, opts),
}

async function get(p: string): Promise<{ status: number; body: any; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${T.phone}` } })
  return { status: r.status, body: await r.json().catch(() => ({})), asOf: r.headers.get(COPY_AS_OF_HEADER) }
}
// The box's own error cards (a test box runs niced, say) ride the same feed; the cases name theirs.
const keys = (feed: Array<{ dedupKey: string }>) => feed.map((n) => n.dedupKey).filter((k) => !k.startsWith('logerr:'))

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c7', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d8', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await fs.writeFile(path.join(WALNUT_HOME, 'notifications.json'), GIT_FEED)
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  await addNotification({ kind: 'hook', severity: 'info', title: 'Box hook ran', dedupKey: 'hook:box-1' })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the Mac\'s feed on the box', () => {
  it('before a round, away: the file git sync last wrote, with the box\'s own card', async () => {
    const r = await get('/api/notifications')
    expect([r.status, r.body.offline, keys(r.body.feed)]).toEqual([200, true, ['cron:git', 'hook:box-1']])
    const v1 = await get('/api/v1/notifications')
    expect([v1.status, v1.body.offline, v1.asOf, keys(v1.body.feed)]).toEqual([200, true, null, ['cron:git', 'hook:box-1']])
  })

  it('after a round, away: the copy\'s cards, never the git file; the phone\'s feed carries the copy\'s age', async () => {
    macCards = [card('n-mac-1', 'cron:acme', 'Acme digest sent', 2_000, true), card('n-mac-2', 'error:backup', 'Mac backup failing', 3_000)]
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.map((x) => `${x.kind}:${x.action}`)).toEqual(['notifications:synced'])
    const r = await get('/api/notifications')
    expect([r.body.offline, keys(r.body.feed)]).toEqual([true, ['cron:acme', 'error:backup', 'hook:box-1']])
    expect(r.body.feed.find((n: NotificationRecord) => n.dedupKey === 'error:backup')?.title).toBe('Mac backup failing')
    const v1 = await get('/api/v1/notifications')
    expect([v1.status, v1.body.offline, keys(v1.body.feed)]).toEqual([200, true, ['cron:acme', 'error:backup', 'hook:box-1']])
    expect(Number(v1.asOf)).toBeGreaterThan(0)
    expect(v1.body.unreadCount).toBe(v1.body.feed.filter((n: NotificationRecord) => !n.read).length)
  })

  it('while the Mac answers: both feeds are the Mac\'s, with no copy header', async () => {
    mac.up = true
    try {
      const r = await get('/api/notifications')
      expect([r.body.offline, keys(r.body.feed)]).toEqual([undefined, ['cron:live', 'hook:box-1']])
      const v1 = await get('/api/v1/notifications')
      expect([v1.status, v1.body.offline, v1.asOf]).toEqual([200, undefined, null])
      expect(keys(v1.body.feed)[0]).toBe('cron:live')
    } finally {
      mac.up = false
    }
  })

  it('a feed cleared on the Mac empties the copy in one round; away shows the box\'s own cards only', async () => {
    macCards = []
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results[0]).toMatchObject({ kind: 'notifications', action: 'synced' })
    const r = await get('/api/v1/notifications')
    expect([r.body.offline, keys(r.body.feed)]).toEqual([true, ['hook:box-1']])
  })
})

describe('the store tells its listeners', () => {
  it('every write calls them, and a stopped listener hears nothing more', async () => {
    let heard = 0
    const stop = onNotificationStoreWritten(() => { heard++ })
    await addNotification({ kind: 'hook', severity: 'info', title: 'One more', dedupKey: 'hook:box-2' })
    expect(heard).toBe(1)
    stop()
    await addNotification({ kind: 'hook', severity: 'info', title: 'And another', dedupKey: 'hook:box-3' })
    expect(heard).toBe(1)
  })
})
