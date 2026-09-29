/**
 * Control probe against the local fake bridge (never the real cloud box):
 * the handshake and traffic mimic the daemon's, every frame is verified by
 * seq + sha256, and each failure mode ends in the right close record and a
 * redial. Intervals are shrunk to milliseconds.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFakeBridge } from '../../../scripts/bridge-monitor/fake-bridge.mjs'
import { nextBurstAt, resolveBurstPhase, startProbe } from '../../../scripts/bridge-monitor/probe.mjs'
import { buildLinks } from '../../../scripts/bridge-monitor/lib/classify.mjs'

type AnyRec = Record<string, any>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, timeoutMs = 8000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met in time')
    await sleep(25)
  }
}

const FAST = {
  hostAlias: 'probe', pingEveryMs: 100, payloadEveryMs: 150, payloadBytes: 64 * 1024, burstEveryMs: 1000,
  burstBytes: 2 * 1024 * 1024, burstPhaseSec: 0, silenceMs: 600, dialTimeoutMs: 2000, backoffMaxMs: 400,
}

let cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function setup(bridgeOpts: AnyRec = {}, probeOpts: AnyRec = {}) {
  const fb = await createFakeBridge({ token: 'tok-test', silenceMs: 60_000, sweepMs: 1000, ...bridgeOpts })
  const recs: AnyRec[] = []
  const probe = startProbe({ ...FAST, url: fb.url, token: 'tok-test', log: (r: AnyRec) => recs.push({ t: new Date().toISOString(), ...r }), ...probeOpts })
  cleanup.push(async () => { await probe.stop(); await fb.close() })
  const evs = (ev: string) => recs.filter((r) => r.ev === ev)
  return { fb, probe, recs, evs }
}

describe('control probe', () => {
  it('says hello as host "probe", answers the ping RPC, and every frame verifies', async () => {
    const { fb, evs } = await setup()
    await until(() => evs('burst').length >= 1 && fb.stats.verified >= 6)
    expect(fb.stats.hellos).toBe(1)
    expect(fb.events.find((e: AnyRec) => e.ev === 'hello')).toMatchObject({ hostAlias: 'probe' })
    expect(fb.stats.pings).toBeGreaterThan(0)
    expect(fb.stats.rpcAnswered).toBeGreaterThan(0)
    expect(fb.stats.corrupt).toBe(0)
    expect(fb.stats.seqGaps).toBe(0)
    expect(fb.stats.maxFrameBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(evs('connected')[0]).toMatchObject({ connId: expect.stringMatching(/^p-\d+-[0-9a-f]+-1$/), dialMs: expect.any(Number) })
    expect(evs('burst')[0]).toMatchObject({ bytes: 2 * 1024 * 1024, drainMs: expect.any(Number) })
  })

  it('logs the daemon close fields and redials after a server close (1001)', async () => {
    const { fb, evs } = await setup()
    await until(() => fb.stats.rpcAnswered >= 3)
    fb.closeAll(1001, 'going away')
    await until(() => evs('connected').length >= 2)
    const close = evs('conn-close')[0]
    for (const k of ['connId', 'uptimeMs', 'code', 'reason', 'wasClean', 'lastError', 'bytesIn', 'bytesOut', 'framesIn', 'framesOut',
      'maxOutFrameBytes', 'maxOutFrameKind', 'bufferedAmountPeak', 'bufferedAmountAtClose', 'lastInboundAgeMs', 'rttMsP50',
      'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs']) {
      expect(close, k).toHaveProperty(k)
    }
    expect(close).toMatchObject({ code: 1001, reason: 'going away', wasClean: true })
    expect(close.rttMsP50).toEqual(expect.any(Number))
    expect(evs('closed')).toHaveLength(1)
    // The records form links the summarizer can read.
    const [link] = buildLinks(evs('connected').concat(evs('conn-close'), evs('closed')))
    expect(link).toMatchObject({ cause: 'closed', close: { code: 1001 } })
  })

  it('an abrupt reset reads as 1006, not clean', async () => {
    const { fb, evs } = await setup()
    await until(() => fb.stats.rpcAnswered >= 2)
    fb.destroyAll()
    await until(() => evs('conn-close').length >= 1)
    expect(evs('conn-close')[0]).toMatchObject({ code: 1006, wasClean: false })
    await until(() => evs('connected').length >= 2)
  })

  it('the silence watchdog tears a quiet link down and redials', async () => {
    const { fb, evs } = await setup()
    await until(() => fb.stats.rpcAnswered >= 2)
    fb.setSilent(true)
    await until(() => evs('silence').length >= 1)
    expect(evs('silence-detected')[0].silentMs).toBeGreaterThanOrEqual(600)
    fb.setSilent(false)
    await until(() => evs('connected').length >= 2)
  })

  it('a refused token is a dial failure with backoff, never a link', async () => {
    const { fb, evs } = await setup({}, { token: 'wrong' })
    await until(() => evs('dial-failed').length >= 3)
    expect(evs('dial-failed')[0].error).toMatch(/401/)
    expect(evs('connected')).toHaveLength(0)
    expect(fb.stats.rejected).toBeGreaterThanOrEqual(3)
  })

  it('a dead endpoint keeps retrying with bounded backoff', async () => {
    // Backoff starts at 1 s and doubles, capped at backoffMaxMs with +/-25% jitter.
    // With the cap at 200 ms every retry comes within 250 ms (plus slack for a
    // loaded machine); an uncapped doubling would wait 0.75 s, 1.5 s, 3 s, ...
    const recs: AnyRec[] = []
    const probe = startProbe({ ...FAST, backoffMaxMs: 200, url: 'ws://127.0.0.1:9/bridge', token: 'x', log: (r: AnyRec) => recs.push({ ...r, at: Date.now() }) })
    cleanup.push(() => probe.stop())
    await until(() => recs.filter((r) => r.ev === 'dial-failed').length >= 6)
    expect(recs.some((r) => r.ev === 'connected')).toBe(false)
    const at = recs.filter((r) => r.ev === 'dial-failed').map((r) => r.at)
    const spacing = at.slice(1).map((t, i) => t - at[i])
    expect(Math.max(...spacing)).toBeLessThan(200 * 1.25 + 600)
  })
})

describe('burst schedule', () => {
  it('bursts land on the configured phase of the cycle, never in the past', () => {
    const every = 15 * 60_000
    const base = Math.floor(Date.parse('2026-03-10T10:00:00Z') / every) * every
    expect(nextBurstAt(base + 1000, every, 150)).toBe(base + 150_000)
    expect(nextBurstAt(base + 150_000, every, 150)).toBe(base + every + 150_000)
    expect(((nextBurstAt(base + 300_000, every, 90) / 1000) - 90) % 900).toBe(0)
  })

  it('auto phase sits half a 5-minute cycle away from the M1 slot; 150 s without a summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-probe-'))
    try {
      expect(resolveBurstPhase('auto', dir)).toBe(150)
      fs.writeFileSync(path.join(dir, 'last-summary.json'), JSON.stringify({ phase: { phaseSec: 200 } }))
      expect(resolveBurstPhase('auto', dir)).toBe(50)
      expect(resolveBurstPhase(30, dir)).toBe(30)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
