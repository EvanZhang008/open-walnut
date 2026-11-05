/**
 * The work card's pushes on the wire: the real APNs sender (src/core/push/apns.ts) talking
 * HTTP/2 to a stand-in for Apple on localhost (WALNUT_APNS_ORIGIN), driven by the card's
 * service (src/core/push/work-card.ts) with the same send call its runtime uses.
 *
 * What Apple would see is pinned here: the device path, the `liveactivity` push type on the
 * `.push-type.liveactivity` topic, the priority, the expiration, a signed provider token, and
 * a body with no `alert`, `sound` or `badge`. A 410 takes the token off the rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('apns-wire'))

import { closeApnsSessions, sendApns } from '../../src/core/push/apns.js'
import { END_EXPIRES_MS, END_GRACE_MS, STALE_AFTER_MS, WorkCardService, type WorkCardDeps } from '../../src/core/push/work-card.js'
import type { PushTokenEntry, Task } from '../../src/core/types.js'

interface Seen { headers: http2.IncomingHttpHeaders; body: Record<string, unknown> }

const LIVE = 'a'.repeat(64)
const GONE = 'b'.repeat(64)
const T0 = Date.parse('2026-11-04T09:00:00Z')

let server: http2.Http2Server
const seen: Seen[] = []
let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apns-wire-'))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPath = path.join(dir, 'AuthKey_TEST.p8')
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  server = http2.createServer()
  server.on('stream', (stream, headers) => {
    let raw = ''
    stream.setEncoding('utf8')
    stream.on('data', (c: string) => { raw += c })
    stream.on('end', () => {
      seen.push({ headers, body: JSON.parse(raw) as Record<string, unknown> })
      const gone = String(headers[':path']).endsWith(GONE)
      stream.respond({ ':status': gone ? 410 : 200, 'content-type': 'application/json' })
      stream.end(gone ? JSON.stringify({ reason: 'Unregistered' }) : '')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const env = {
    WALNUT_APNS_ORIGIN: `http://127.0.0.1:${port}`,
    WALNUT_APNS_KEY_ID: 'KEYID12345', WALNUT_APNS_TEAM_ID: 'TEAMID1234', WALNUT_APNS_KEY_PATH: keyPath,
    WALNUT_APNS_TOPIC: 'dev.openwalnut.ios',
  }
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
})

afterAll(async () => {
  closeApnsSessions()
  await new Promise<void>((r) => server.close(() => r()))
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(dir, { recursive: true, force: true })
})

function row(key: string, card: string): PushTokenEntry {
  return {
    token: key.repeat(64).slice(0, 64), platform: 'ios', key_name: key, registered_at: new Date(T0).toISOString(),
    work_card: { token: card, activity_id: `act-${key}`, registered_at: new Date(T0).toISOString() },
  }
}

describe('a card push as Apple receives it', () => {
  it('an update, then an end, each a silent Live Activity push; a token Apple calls gone leaves the rows', async () => {
    let tasks: Array<Partial<Task>> = [{ id: 'w', title: 'Ship it', phase: 'IN_PROGRESS', user_status: { state: 'working' } as Task['user_status'], updated_at: new Date(T0).toISOString() }]
    const clock = { t: T0 }
    const cleared: string[][] = []
    const deps: WorkCardDeps = {
      tasks: async () => tasks as Task[],
      rows: async () => [row('c', LIVE), row('d', GONE)].filter((r) => !cleared.flat().includes(r.work_card!.token)),
      // The runtime's own call (work-card.ts defaultDeps; its source is pinned in work-card.test.ts).
      send: (targets, payload, priority, expiration) => sendApns(targets, payload, { pushType: 'liveactivity', priority, expiration }),
      clearTokens: async (t) => { cleared.push(t); return t.length },
      now: () => clock.t,
      saveStretch: async () => {},
      canPush: async () => true,
    }
    const svc = new WorkCardService(deps)
    await svc.tick(); await svc.idle()

    expect(seen).toHaveLength(2)
    for (const s of seen) {
      expect(s.headers[':method']).toBe('POST')
      expect(s.headers['apns-push-type']).toBe('liveactivity')
      expect(s.headers['apns-topic']).toBe('dev.openwalnut.ios.push-type.liveactivity')
      expect(s.headers['apns-priority']).toBe('5')
      expect(s.headers['apns-expiration']).toBe(String(Math.floor((T0 + STALE_AFTER_MS) / 1000)))
      expect(String(s.headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
      const aps = s.body.aps as Record<string, unknown>
      expect(Object.keys(s.body)).toEqual(['aps'])
      expect(aps).toMatchObject({ event: 'update', 'content-state': { working: 1, needs: 0, completed: 0 } })
      for (const loud of ['alert', 'sound', 'badge']) expect(aps).not.toHaveProperty(loud)
    }
    expect(seen.map((s) => String(s.headers[':path'])).sort()).toEqual([`/3/device/${LIVE}`, `/3/device/${GONE}`])
    expect(cleared).toEqual([[GONE]])

    // It finishes; once nothing worked for the grace the card that is left gets its end.
    tasks = [{ id: 'w', title: 'Ship it', phase: 'COMPLETE', completed_at: new Date(T0 + 60_000).toISOString() }]
    clock.t = T0 + 60_000
    await svc.tick(); await svc.idle()
    clock.t = T0 + 60_000 + END_GRACE_MS
    await svc.tick(); await svc.idle()
    const end = seen.at(-1)!
    expect(String(end.headers[':path'])).toBe(`/3/device/${LIVE}`)
    expect(end.headers['apns-priority']).toBe('10')
    expect(end.headers['apns-expiration']).toBe(String(Math.floor((clock.t + END_EXPIRES_MS) / 1000)))
    expect(end.body.aps).toMatchObject({ event: 'end', 'content-state': { working: 0, completed: 1 } })
    expect(end.body.aps).toHaveProperty('dismissal-date')
    for (const loud of ['alert', 'sound', 'badge']) expect(end.body.aps).not.toHaveProperty(loud)
    expect(cleared.at(-1)).toEqual([LIVE])
  })
})
