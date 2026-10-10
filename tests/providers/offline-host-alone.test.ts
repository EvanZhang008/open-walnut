/**
 * What the offline host gives the server this daemon started while no server
 * leads (src/providers/offline-host-core.ts `sessionsOf`, `deliverHuman`;
 * docs/plan/walnut-servers-everywhere.md "Host server, leader away"): the copy's
 * sessions with their tasks, and a person's message written as typed and
 * journaled for the server that takes the host back.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice, type OfflineHostDeps } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'

const HOME = '/fixture/walnut-home'
const LIVE = 'aaaaaaaa-1111-4111-8111-111111111111'
const IDLE = 'bbbbbbbb-2222-4222-8222-222222222222'
const LANE = 'cccccccc-3333-4333-8333-333333333333'

function slice(): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.parse('2026-10-05T10:00:00Z'), host: 'oldbox',
    sessions: [
      { sid: LIVE, taskId: 'mfix0000-0001', title: 'Fix the build' },
      { sid: IDLE, title: 'Old report' },
      { sid: LANE, title: 'Environment lane', aside: true },
    ],
    tasks: [{ id: 'mfix0000-0001', title: 'Release: fix the build', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
  }
}

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })

function harness(over: Partial<OfflineHostDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-alone-'))
  dirs.push(dir)
  const delivered: Array<{ sid: string; text: string; messageId: string }> = []
  const deps: OfflineHostDeps = {
    fs, path, dir,
    now: () => Date.parse('2026-10-05T12:00:00Z'),
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(),
    log: () => {},
    isLive: (sid) => sid === LIVE,
    turnActive: () => false,
    streamOffset: () => 100,
    deliver: async (sid, text, messageId) => { delivered.push({ sid, text, messageId }); return { ok: true } },
    ...over,
  }
  const host = createOfflineHost(deps)
  host.configure(slice())
  return { host, delivered }
}

describe('sessionsOf', () => {
  it('lists the copy\'s sessions with their task, lane sessions left out', () => {
    const h = harness()
    expect(h.host.sessionsOf(HOME)).toEqual({
      host: 'oldbox', asOf: '2026-10-05T10:00:00.000Z',
      sessions: [
        { sid: LIVE, title: 'Fix the build', taskId: 'mfix0000-0001', taskTitle: 'Release: fix the build', taskPhase: 'IN_PROGRESS' },
        { sid: IDLE, title: 'Old report' },
      ],
    })
  })

  it('has nothing for a Walnut this host keeps no copy for', () => {
    expect(harness().host.sessionsOf('/fixture/other-home')).toBeNull()
  })

  it('shows a task change the host made itself (the overlay)', async () => {
    const h = harness()
    const r = await h.host.handle(HOME, LIVE, 'tools.call', { name: 'task_update', args: { id: 'mfix0000-0001', title: 'Release: build is green' } })
    expect(r.ok).toBe(true)
    expect(h.host.sessionsOf(HOME)!.sessions[0].taskTitle).toBe('Release: build is green')
  })
})

describe('deliverHuman', () => {
  it('writes the text as typed and journals one delivery from no session', async () => {
    const h = harness()
    const r = await h.host.deliverHuman(HOME, LIVE, '  hello from the phone  ', 'qm-alone-1')
    expect(r).toEqual({ ok: true, result: { delivered: true, targetSessionId: LIVE, messageId: 'qm-alone-1' } })
    expect(h.delivered).toEqual([{ sid: LIVE, text: 'hello from the phone', messageId: 'qm-alone-1' }])
    const recs = h.host.drain(HOME).records
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'delivery', fromSessionId: '', toSessionId: LIVE, messageId: 'qm-alone-1' })
  })

  it('gives a message id of another shape a fresh one', async () => {
    const h = harness()
    const r = await h.host.deliverHuman(HOME, LIVE, 'hi', 'not an id')
    expect(r.ok && (r.result.messageId as string)).toMatch(/^qm-offline-[0-9a-f]{16}$/)
  })

  it('refuses a stopped session, a session of no copy, an empty text, and writes nothing', async () => {
    const h = harness()
    expect(await h.host.deliverHuman(HOME, IDLE, 'hi', undefined)).toMatchObject({ ok: false, error: { code: 'not_running' } })
    expect(await h.host.deliverHuman(HOME, 'dddddddd-4444-4444-8444-444444444444', 'hi', undefined)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await h.host.deliverHuman('/fixture/other-home', LIVE, 'hi', undefined)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await h.host.deliverHuman(HOME, LIVE, '   ', undefined)).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(await h.host.deliverHuman(HOME, LIVE, 42, undefined)).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(h.delivered).toHaveLength(0)
    expect(h.host.drain(HOME).records).toHaveLength(0)
  })

  it('journals nothing when the write into the session failed', async () => {
    const h = harness({ deliver: async () => ({ ok: false, reason: 'EPIPE' }) })
    expect(await h.host.deliverHuman(HOME, LIVE, 'hi', undefined)).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(h.host.drain(HOME).records).toHaveLength(0)
  })

  it('a deliver that throws is an answer, not a crash', async () => {
    const h = harness({ deliver: async () => { throw new Error('boom') } })
    expect(await h.host.deliverHuman(HOME, LIVE, 'hi', undefined)).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})
