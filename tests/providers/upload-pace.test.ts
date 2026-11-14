/**
 * A host's own connections learn their upload pace (src/providers/upload-pace.ts) instead of
 * holding every host to one relay's numbers (2026-11-13: a plain SSH host moved 9 MB at the old
 * fixed 20 KB/s in 7.5 minutes):
 *
 *   - with no memory, the bulk channel's forward uploads 2 MB at full speed (well under a second);
 *     after the connection under it is cut while uploading, the next one is paced;
 *   - a stop by Walnut, a close with nothing going up, and a cut while the host's whole link went
 *     down (the real host-link ledger) teach nothing; a cut paces the redial at once, and is
 *     undone when the host's link is found to have dropped with it;
 *   - cuts within one judgement are rolled back as one; ssh ending on its ServerAlive timeout
 *     (a stall) teaches nothing;
 *   - a probe changes the pace of a connection already running;
 *   - the memory survives a reload (a server restart) in a machine-local file; a broken file, or
 *     an entry of another shape, reads as no memory.
 *
 * MACHINE SAFETY: WALNUT_HOME is a temp data home (createMockConstants); the store file is named
 * by WALNUT_UPLOAD_PACE_FILE in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-upload-pace-test'))

import { CHANNEL_RULES, HostUploadPace, type UploadPaceDeps } from '../../src/providers/upload-pace.js'
import { pacedForward } from '../../src/providers/paced-forward.js'
import type { LaneForward } from '../../src/providers/stream-lane.js'
import { updateStoreMachineId, updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { __resetHostLinkLedgerForTest, noteHostLinkDown } from '../../src/providers/host-link-ledger.js'

const KB = 1024
const MB = 1024 * KB
const cleanups: Array<() => unknown> = []
let storeFile = ''
const savedEnv = process.env.WALNUT_UPLOAD_PACE_FILE

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-upload-pace-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  storeFile = path.join(dir, 'upload-pace.json')
  process.env.WALNUT_UPLOAD_PACE_FILE = storeFile
  __resetHostLinkLedgerForTest()
})
afterEach(async () => {
  vi.useRealTimers()
  await updateStoresSettled()
  for (const c of cleanups.splice(0).reverse()) await c()
  if (savedEnv === undefined) delete process.env.WALNUT_UPLOAD_PACE_FILE
  else process.env.WALNUT_UPLOAD_PACE_FILE = savedEnv
  __resetHostLinkLedgerForTest()
})

/** A host's own connection: a far end that takes what comes, and an `exit` that ends it as ssh would. */
async function farEnd() {
  let received = 0
  const conns = new Set<net.Socket>()
  const server = net.createServer((s) => {
    conns.add(s)
    s.on('data', (b: Buffer) => { received += b.length })
    s.on('error', () => {})
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  let exitCbs: Array<(why: string) => void> = []
  const fwd: LaneForward = {
    port,
    onExit: (cb) => { exitCbs.push(cb) },
    stop: () => { for (const cb of exitCbs.splice(0)) cb('stopped') },
  }
  cleanups.push(() => new Promise<void>((r) => { for (const c of conns) c.destroy(); server.close(() => r()) }))
  return { fwd, received: () => received, exit: (why: string) => { const cbs = exitCbs; exitCbs = []; for (const cb of cbs) cb(why) } }
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Upload `bytes` through a paced forward; resolves with the ms until the far end had them all. */
async function upload(port: number, far: { received: () => number }, bytes: number): Promise<{ ms: number; client: net.Socket }> {
  const client = net.connect(port, '127.0.0.1')
  cleanups.push(() => client.destroy())
  await new Promise<void>((r) => client.once('connect', () => r()))
  const before = far.received()
  const startedAt = Date.now()
  client.write(Buffer.alloc(bytes, 9))
  await waitFor(() => far.received() - before >= bytes, 20_000, 'the whole upload')
  return { ms: Date.now() - startedAt, client }
}

const noLinkDrop: UploadPaceDeps = { judgeMs: 0, hostLinkDroppedNear: () => false }

describe('the bulk channel learns its pace from cuts', () => {
  it('with no memory 2 MB goes up at full speed; after a cut while uploading, the next connection is paced', async () => {
    const pace = new HostUploadPace('plainhost', 'bulk', noLinkDrop)
    const far = await farEnd()
    const fwd = await pacedForward(far.fwd, { learn: pace })
    cleanups.push(() => fwd.stop())
    expect(pace.limits).toBeNull()
    const first = await upload(fwd.port, far, 2 * MB)
    // The old fixed 20 KB/s took about 100 s for this.
    expect(first.ms).toBeLessThan(1_000)

    // The relay ends the connection right after it carried that upload.
    far.exit('code 255: client_loop: send disconnect: Broken pipe')
    await waitFor(() => pace.limits !== null, 2_000, 'the pace to learn')
    const limits = pace.limits!
    // A third of the rate it reached (2 MB within the one second counted at least).
    expect(limits.bytesPerSec).toBeLessThanOrEqual(Math.ceil(2 * MB / 3))
    expect(limits.bytesPerSec).toBeGreaterThan(100 * KB)

    // The next connection goes at that pace: 2 MB takes at least (2 MB - burst) / pace.
    const far2 = await farEnd()
    const fwd2 = await pacedForward(far2.fwd, { learn: pace })
    cleanups.push(() => fwd2.stop())
    const second = await upload(fwd2.port, far2, 2 * MB)
    const floorMs = ((2 * MB - limits.burstBytes) / limits.bytesPerSec) * 1000
    expect(second.ms).toBeGreaterThan(floorMs * 0.9)
  })

  it('a stop by Walnut, or a close with nothing going up, teaches nothing', async () => {
    const pace = new HostUploadPace('quiethost', 'bulk', noLinkDrop)
    const far = await farEnd()
    const fwd = await pacedForward(far.fwd, { learn: pace })
    await upload(fwd.port, far, 256 * KB)
    fwd.stop()
    // The connection under a forward Walnut did not stop ends with nothing in flight for a while.
    const now = vi.fn(() => Date.now())
    const idle = new HostUploadPace('quiethost', 'bulk', { ...noLinkDrop, now })
    const far2 = await farEnd()
    const fwd2 = await pacedForward(far2.fwd, { learn: idle })
    cleanups.push(() => fwd2.stop())
    await upload(fwd2.port, far2, 64 * KB)
    const later = Date.now() + 60_000
    now.mockImplementation(() => later)
    far2.exit('code 255: Connection reset by peer')
    await new Promise((r) => setTimeout(r, 50))
    expect(pace.limits).toBeNull()
    expect(idle.limits).toBeNull()
  })

  it("a cut while the host's whole link went down too (sleep, network loss) teaches nothing", async () => {
    const pace = new HostUploadPace('sleepyhost', 'bulk', { judgeMs: 0 })
    noteHostLinkDown('sleepyhost')
    const far = await farEnd()
    const fwd = await pacedForward(far.fwd, { learn: pace })
    cleanups.push(() => fwd.stop())
    await upload(fwd.port, far, 512 * KB)
    far.exit('code 255: Broken pipe')
    await new Promise((r) => setTimeout(r, 50))
    expect(pace.limits).toBeNull()
    // Another host whose link stayed up learns from the same kind of cut.
    const other = new HostUploadPace('awakehost', 'bulk', { judgeMs: 0 })
    const far2 = await farEnd()
    const fwd2 = await pacedForward(far2.fwd, { learn: other })
    cleanups.push(() => fwd2.stop())
    await upload(fwd2.port, far2, 512 * KB)
    far2.exit('code 255: Broken pipe')
    await waitFor(() => other.limits !== null, 2_000, 'the other host to learn')
  })

  it('a cut paces the redial at once; when its host link turns out to have dropped too, the pace before comes back', async () => {
    let linkDropped = false
    const pace = new HostUploadPace('flakyhost', 'lane', { judgeMs: 150, hostLinkDroppedNear: () => linkDropped })
    const p = pace.pacer()
    await p.take(90 * KB)
    pace.ended(p, { byWalnut: false })
    await waitFor(() => pace.limits !== null, 1_000, 'the provisional pace')
    // The next connection, dialled before the judgement, already goes at it.
    expect(pace.pacer().limits).toEqual(pace.limits)
    linkDropped = true
    await waitFor(() => pace.limits === null, 2_000, 'the pace to be restored')
    await updateStoresSettled()
    expect(fs.existsSync(storeFile)).toBe(false)
  })
})

describe('a cut is judged even while the redial carries demand', () => {
  /** A cut, then the redial's pacer keeps bytes waiting (demand ticks) through the judgement. */
  async function cutThenDemand(pace: HostUploadPace) {
    const seed = pace.pacer()
    await seed.take(90 * KB)
    pace.ended(seed, { byWalnut: false })
    await waitFor(() => pace.limits !== null, 1_000, 'the provisional pace')
    const redial = pace.pacer()
    cleanups.push(() => redial.drop('done'))
    for (let i = 0; i < 40; i++) void redial.take(8 * KB).catch(() => {})
    return redial
  }

  it('the host link dropped too: the pace before comes back', async () => {
    const pace = new HostUploadPace('swaphost', 'lane', { judgeMs: 600, hostLinkDroppedNear: () => true })
    const redial = await cutThenDemand(pace)
    await waitFor(() => pace.limits === null, 3_000, 'the pace to be restored')
    expect(redial.limits).toBeNull()
  })

  it('a real cut: kept in the file for the next server', async () => {
    const pace = new HostUploadPace('cuthost', 'lane', { judgeMs: 600, hostLinkDroppedNear: () => false })
    await cutThenDemand(pace)
    // The judge runs judgeMs after the cut and writes then: wait on the file, not a clock.
    await vi.waitFor(async () => {
      await updateStoresSettled()
      expect(fs.existsSync(storeFile)).toBe(true)
    }, { timeout: 5_000, interval: 50 })
    const next = new HostUploadPace('cuthost', 'lane', noLinkDrop)
    await next.ready()
    expect(next.limits).toEqual(pace.limits)
  })
})

describe('cuts close together are judged as one', () => {
  it('two cuts within the judgement, the second with the host link dropped: back to unpaced, nothing written', async () => {
    const pace = new HostUploadPace('blipphost', 'lane', { judgeMs: 300, hostLinkDroppedNear: () => true })
    const first = pace.pacer()
    await first.take(900 * KB)
    pace.ended(first, { byWalnut: false })
    await waitFor(() => pace.limits !== null, 1_000, 'the first provisional pace')
    const afterFirst = pace.limits!.bytesPerSec
    // The redial, cut again in the same outage.
    const second = pace.pacer()
    await second.take(64 * KB)
    pace.ended(second, { byWalnut: false })
    await waitFor(() => (pace.limits?.bytesPerSec ?? Infinity) < afterFirst, 1_000, 'the second provisional pace')
    await waitFor(() => pace.limits === null, 3_000, 'both cuts to be rolled back')
    await new Promise((r) => setTimeout(r, 400))
    expect(pace.limits).toBeNull()
    await updateStoresSettled()
    expect(fs.existsSync(storeFile)).toBe(false)
  })
})

describe("ssh's ServerAlive timeout is a stall, not a cut", () => {
  it('the bulk forward ending on it while uploading teaches nothing', async () => {
    const pace = new HostUploadPace('stallhost', 'bulk', noLinkDrop)
    const far = await farEnd()
    const fwd = await pacedForward(far.fwd, { learn: pace })
    cleanups.push(() => fwd.stop())
    await upload(fwd.port, far, 512 * KB)
    far.exit('code 255: Timeout, server stallhost not responding.')
    await new Promise((r) => setTimeout(r, 50))
    expect(pace.limits).toBeNull()
  })
})

describe('a probe paces a running connection', () => {
  it('ten minutes of demand with no cut raise the pace of the pacer already running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pace = new HostUploadPace('relayhost', 'lane', noLinkDrop)
    // A first cut at 30 KB/s: paced at 10 KB/s, under a ceiling of 30.
    const seed = pace.pacer()
    void seed.take(30 * KB)
    pace.ended(seed, { byWalnut: false })
    await vi.waitFor(() => expect(pace.limits?.bytesPerSec).toBe(10 * KB))
    const p = pace.pacer()
    expect(p.limits?.bytesPerSec).toBe(10 * KB)
    // Keep bytes waiting for eleven minutes.
    for (let i = 0; i < 700; i++) void p.take(10 * KB).catch(() => {})
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(p.limits!.bytesPerSec).toBe(12 * KB)
    expect(pace.limits!.bytesPerSec).toBe(12 * KB)
    p.drop('done')
  })
})

describe('the memory is kept for the next server', () => {
  it('survives a reload, in the file the store names', async () => {
    const pace = new HostUploadPace('devbox', 'bulk', noLinkDrop)
    const p = pace.pacer()
    await p.take(600 * KB)
    pace.ended(p, { byWalnut: false })
    await waitFor(() => pace.limits !== null, 2_000, 'the pace to learn')
    await updateStoresSettled()
    expect(fs.existsSync(storeFile)).toBe(true)
    const reloaded = new HostUploadPace('devbox', 'bulk', noLinkDrop)
    expect(reloaded.limits).toBeNull()
    await reloaded.ready()
    expect(reloaded.limits).toEqual(pace.limits)
    // Per channel: the lane of the same host has learned nothing.
    const lane = new HostUploadPace('devbox', 'lane', noLinkDrop)
    await lane.ready()
    expect(lane.limits).toBeNull()
  })

  it('a kept pace under the floor of today is read back at the floor', async () => {
    const id = await updateStoreMachineId()
    const at = Date.now()
    fs.writeFileSync(storeFile, JSON.stringify({ [`${id}|ssh:devbox#bulk`]: { rate: 1024, ceiling: 3072, cutAt: at, at, demandMs: 0 } }))
    const pace = new HostUploadPace('devbox', 'bulk', noLinkDrop)
    await pace.ready()
    expect(pace.limits!.bytesPerSec).toBe(CHANNEL_RULES.bulk.floor)
  })

  it('a broken file, or an entry of another shape, reads as no memory', async () => {
    fs.writeFileSync(storeFile, '{ not json')
    const broken = new HostUploadPace('devbox', 'bulk', noLinkDrop)
    await broken.ready()
    expect(broken.limits).toBeNull()
    const id = await updateStoreMachineId()
    fs.writeFileSync(storeFile, JSON.stringify({ [`${id}|ssh:devbox#bulk`]: { rate: 'slow', at: Date.now() } }))
    const odd = new HostUploadPace('devbox', 'bulk', noLinkDrop)
    await odd.ready()
    expect(odd.limits).toBeNull()
    // And it still learns, writing over what it could not read.
    const p = odd.pacer()
    await p.take(300 * KB)
    odd.ended(p, { byWalnut: false })
    await waitFor(() => odd.limits !== null, 2_000, 'the pace to learn')
  })
})
