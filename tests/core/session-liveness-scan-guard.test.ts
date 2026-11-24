/**
 * A scan that judges many sessions' processes asks them a few at once, and no single ask waits
 * past STATUS_PROBE_TIMEOUT_MS.
 *
 * 2026-11-23: real use rang on `host_load` (its answer lost at the 10 s self-call limit, 29 times
 * in a day) and task starts took up to two minutes. GET /hosts/load runs getActiveSessionsByHost,
 * which asked each of 38 running clouddev sessions its daemon `status` one after another, each
 * with the command's 30 s default, over a host link whose round trip was 0.1 to 3 s.
 *
 * Pinned: the session-tracker scans overlap their asks under LIVENESS_PROBE_CONCURRENCY and keep
 * their verdicts in order; the two `status` readers on that path pass the short deadline and read
 * no answer as alive; and every file that awaits isSessionProcessAlive is listed with why it asks
 * one session, so a new loop of awaits fails here until it goes through livenessOfAll.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-liveness-scan-guard'))

const probeMs = 40
let inFlight = 0
let maxInFlight = 0
let probed: string[] = []
const dead = new Set<string>()
/** Sessions whose daemon never answers. */
const hung = new Set<string>()

vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { claudeSessionId: string }) => {
    probed.push(s.claudeSessionId)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, hung.has(s.claudeSessionId) ? 60_000 : probeMs))
    inFlight--
    return !dead.has(s.claudeSessionId)
  },
  isLocalJsonlFresh: () => 'unknown' as const,
}))

import {
  createSessionRecord, updateSessionRecord, getActiveSessionsByHost, getAllAliveSessionsByHost, checkSessionLimit,
  livenessOfAll, listSessions,
} from '../../src/core/session-tracker.js'
import { LIVENESS_PROBE_CONCURRENCY } from '../../src/core/sessions/liveness-concurrency.js'
import { STATUS_PROBE_TIMEOUT_MS } from '../../src/providers/daemon-status-reply.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { WALNUT_HOME } from '../../src/constants.js'

const REPO = path.resolve(__dirname, '../..')
const N = 24
let seeded: string[] = []

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  inFlight = 0; maxInFlight = 0; probed = []; seeded = []; dead.clear(); hung.clear()
  for (let i = 0; i < N; i++) {
    const sid = `run-${i}`
    seeded.push(sid)
    await createSessionRecord(sid, `task-${i}`, 'proj', undefined, { pid: 999999990 + i, ...(i % 3 === 0 ? {} : { host: 'devbox' }) })
    await updateSessionRecord(sid, { process_status: 'running', last_status_change: new Date().toISOString() })
  }
  probed = []
})

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); break }
    catch { await new Promise(r => setTimeout(r, 50)) }
  }
})

function expectOverlapped(): void {
  expect([...probed].sort()).toEqual([...seeded].sort())
  expect(maxInFlight).toBeGreaterThan(1)
  expect(maxInFlight).toBeLessThanOrEqual(LIVENESS_PROBE_CONCURRENCY)
}

describe('session scans ask a few sessions at once', () => {
  it('getActiveSessionsByHost: every session asked once, overlapped, the dead ones left out', async () => {
    dead.add('run-1'); dead.add('run-3')
    const started = Date.now()
    const byHost = await getActiveSessionsByHost()
    // One after another this is N × probeMs (960 ms); a few at once, a few waves.
    expect(Date.now() - started).toBeLessThan(N * probeMs / 2)
    expectOverlapped()
    const ids = (k: string) => (byHost[k] ?? []).map(s => s.claudeSessionId).sort()
    expect(ids('local')).toEqual(seeded.filter((_, i) => i % 3 === 0 && i !== 3).sort())
    expect(ids('devbox')).toEqual(seeded.filter((_, i) => i % 3 !== 0 && i !== 1).sort())
  })

  it('getAllAliveSessionsByHost: overlapped, in order', async () => {
    const byHost = await getAllAliveSessionsByHost()
    expectOverlapped()
    expect((byHost.devbox ?? []).map(s => s.claudeSessionId)).toEqual(
      seeded.filter((_, i) => i % 3 !== 0).filter(sid => (byHost.devbox ?? []).some(s => s.claudeSessionId === sid)))
    expect((byHost.devbox ?? []).length + (byHost.local ?? []).length).toBe(N)
  })

  it('a host filter asks only those hosts\' sessions (a start on one host never waits on another link)', async () => {
    const byHost = await getActiveSessionsByHost({ hosts: ['local'] })
    expect([...probed].sort()).toEqual(seeded.filter((_, i) => i % 3 === 0).sort())
    expect(Object.keys(byHost)).toEqual(['local'])
  })

  it('callers that scan at the same time share one scan', async () => {
    const [a, b] = await Promise.all([getActiveSessionsByHost(), getActiveSessionsByHost()])
    expect(probed).toHaveLength(N)
    expect(a.devbox?.length).toBe(b.devbox?.length)
    expect(a.devbox).not.toBe(b.devbox) // each caller gets its own lists
  })

  it('the whole scan answers by its deadline; a session not answered keeps its state (alive), never a death', async () => {
    // The first 16 answer (two waves), the last 8 hang: every worker ends up on a hung probe.
    for (const sid of seeded.slice(16)) hung.add(sid)
    dead.add(seeded[2]!)
    const rows = (await listSessions()).filter(r => seeded.includes(r.claudeSessionId))
      .sort((x, y) => seeded.indexOf(x.claudeSessionId) - seeded.indexOf(y.claudeSessionId))
    const started = Date.now()
    const alive = await livenessOfAll(rows, 300)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(alive).toHaveLength(N)
    expect(alive[2]).toBe(false)
    expect(alive.filter((v, i) => !v && i !== 2)).toEqual([])
    expect(alive.slice(16).every(Boolean)).toBe(true)
  })

  it("checkSessionLimit asks only its own host's sessions", async () => {
    const r = await checkSessionLimit('devbox')
    expect([...probed].sort()).toEqual(seeded.filter((_, i) => i % 3 !== 0).sort())
    expect(maxInFlight).toBeLessThanOrEqual(LIVENESS_PROBE_CONCURRENCY)
    expect(r).toBeDefined()
  })
})

describe('a liveness status ask waits STATUS_PROBE_TIMEOUT_MS at most, and no answer reads alive', () => {
  function managerSending(send: (cmd: string, params: unknown, timeoutMs?: number) => Promise<unknown>): RemoteSessionManager {
    const mgr = new RemoteSessionManager('sid-live', 'devbox', null)
    const internals = mgr as unknown as { conn: unknown; _sid: string }
    internals.conn = { connected: true, send }
    internals._sid = 'sid-live'
    return mgr
  }

  it('RemoteSessionManager.isAlive passes the short deadline', async () => {
    const asked: Array<number | undefined> = []
    const mgr = managerSending(async (_cmd, _p, timeoutMs) => { asked.push(timeoutMs); return { ok: true, exists: true, alive: true } })
    expect(await mgr.isAlive()).toBe(true)
    expect(asked).toEqual([STATUS_PROBE_TIMEOUT_MS])
    expect(STATUS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })

  it('an ask past its deadline reads alive, never a death', async () => {
    const mgr = managerSending(async () => { throw new Error(`daemon command timeout: status (${STATUS_PROBE_TIMEOUT_MS}ms)`) })
    expect(await mgr.isAlive()).toBe(true)
  })

  it("isSessionProcessAlive's probe passes the short deadline; other probeDaemonSession callers keep the command's", () => {
    const dc = fs.readFileSync(path.join(REPO, 'src/providers/daemon-connection.ts'), 'utf8')
    const probe = dc.slice(dc.indexOf('export async function probeDaemonSession('), dc.indexOf('export async function probeDaemonSessionArgs('))
    expect(probe).toMatch(/send\('status', \{ sid: sessionId \}, timeoutMs\)/)
    const liveness = fs.readFileSync(path.join(REPO, 'src/utils/session-liveness.ts'), 'utf8')
    // The host is the row's place as this server reaches it (session-row-owner.ts execHostOf).
    expect(liveness).toMatch(/probeDaemonSession\(remoteHost, session\.claudeSessionId, STATUS_PROBE_TIMEOUT_MS\)/)
  })
})

/**
 * Every file that awaits isSessionProcessAlive, and why it asks one session at a time. A scan of
 * many sessions uses session-tracker.ts livenessOfAll instead.
 */
const SINGLE_ASKS: Record<string, string> = {
  'src/core/session-tracker.ts': 'livenessOfAll itself: each worker of its bounded pool asks one session',
  'src/core/session-reconcile.ts': 'reconcileProcessStatus: the one session it reconciles',
  'src/core/sessions/folder-gone.ts': 'the one session whose folder went missing',
  'src/core/sessions/session-lifecycle.ts': 'the one session a route or op acts on',
  'src/core/session-reconciler.ts': 'inside Promise.allSettled over its zombie candidates: already all at once',
}

describe('no scan awaits isSessionProcessAlive one session after another', () => {
  it('every file that awaits it is listed with why', () => {
    const found = new Set<string>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && /await isSessionProcessAlive\(/.test(fs.readFileSync(p, 'utf8'))) found.add(path.relative(REPO, p))
      }
    }
    walk(path.join(REPO, 'src'))
    expect([...found].sort()).toEqual(Object.keys(SINGLE_ASKS).sort())
  })
})
