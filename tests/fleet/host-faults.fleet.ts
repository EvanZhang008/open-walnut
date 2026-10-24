/**
 * Host faults only separate machines make (tests/fleet/README.md). One fleet, two hosts:
 *   capbox   reached through a link that closes any connection past 4 MB, as some
 *            SSH proxies do with large transfers
 *   skewbox  whose wall clock runs 10 minutes behind the Mac's (libfaketime, for
 *            every process an SSH session starts there, the daemon included)
 *
 *   C1  the deploy through the cap: the one-stream binary upload is cut, the Mac
 *       falls back to 256 KB chunks (each over its own SSH connection), the daemon
 *       starts, and a session there answers
 *   C2  capbox freezes mid-turn (docker pause, its sockets open) and thaws: the
 *       turn's write lands on the Mac once and its reply reaches the Mac once
 *   C3  skewbox, lid closed mid-turn: the write is journaled on a clock 10 minutes
 *       behind, and the Mac applies it on wake, once
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { dockerUnavailable } from './docker.js'
import { startFleet, type Fleet } from './fleet.js'
import { appliedLines, attemptsSummary, expectControlMaster, journaledTitle, results, startHostSession, startUpdateTurn, updateTurnsEnded, type HostSession } from './steps.js'

const unavailable = await dockerUnavailable()
if (unavailable) process.stdout.write(`\n[fleet] SKIPPED: Docker is not available here (${unavailable}). Start Docker and run bun run test:fleet.\n\n`)

const CAP_BYTES = 4 * 1024 * 1024
const SKEW = '-10m'

describe.skipIf(!!unavailable)('the fleet: host faults', () => {
  let f: Fleet
  let cap: HostSession
  const times: Record<string, number> = {}
  const t0 = () => { const s = Date.now(); return () => Date.now() - s }

  beforeAll(async () => {
    const took = t0()
    f = await startFleet({ hosts: ['capbox', 'skewbox'], clockOffset: { skewbox: SKEW } })
    times.boot = took()
    process.stdout.write(`[fleet] run ${f.run} at ${f.base}: Mac on :${f.mac.port}, booted in ${times.boot} ms\n`)
  }, 600_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && f) process.stdout.write(`[fleet] diagnostics for "${task.name}":\n${await f.diagnostics()}\n`)
  })
  afterAll(async () => {
    process.stdout.write(`[fleet] times (ms): ${JSON.stringify(times)}\n`)
    // What the Mac did with a turn that ended while it was away (read for the report, not asserted).
    const handBacks = f?.mac.logLines(/task handed back after out-of-band session end/).map((l) => { const j = JSON.parse(l); return `${j.source} ${j.oldPhase} ${j.taskId}` }) ?? []
    if (handBacks.length) process.stdout.write(`[fleet] hand-backs: ${handBacks.join(' | ')}\n`)
    await f?.stop()
  }, 120_000)

  it('C1: through a link that cuts large transfers, the daemon deploys in chunks and a session answers', async () => {
    const took = t0()
    const proxy = f.hosts.capbox!.proxy
    proxy.capUpBytes(CAP_BYTES)
    times.connect = await f.addHost('capbox', {}, 300_000)
    const said = f.mac.logLines(/binary deployed|single-stream deploy failed|chunked upload progress|daemon source deployed/).filter((l) => l.includes('capbox')).map((l) => JSON.parse(l).message as string)
    process.stdout.write(`[fleet] capbox deploy: ${[...new Set(said)].join(' | ')}; connections cut: ${proxy.capped()}\n`)
    expect(said).toContain('DaemonConnection: binary deployed via chunked pipe')
    expect(proxy.capped()).toBeGreaterThan(0)
    expectControlMaster(f, 'capbox')
    // The deploy is done: the cap goes, so the long-lived connections are not cut later.
    proxy.capUpBytes(null)
    cap = await startHostSession(f, 'capbox', 'Chunked deploy check', 'hello capbox')
    times.c1 = took()
  }, 420_000)

  it('C2: the host freezes mid-turn and thaws; the write lands once and the reply reaches the Mac once', async () => {
    const took = t0()
    const title = 'Written across a frozen host'
    await startUpdateTurn(f, cap, title, 6)
    await f.pauseHost('capbox')
    await new Promise((r) => setTimeout(r, 15_000))
    await f.unpauseHost('capbox')
    await updateTurnsEnded(f, cap, 1)
    process.stdout.write(`[fleet] frozen host: walnut attempts ${await attemptsSummary(f, cap)}\n`)
    await waitFor(() => f.macTask(cap.taskId)?.title === title, 180_000, 'the write to reach the Mac')
    const reply = `echo: updated ${cap.taskId}`
    await waitFor(async () => {
      const h = await f.mac.call('GET', `/api/sessions/${cap.sid}/history`)
      return h.status === 200 && h.text.includes(reply)
    }, 120_000, 'the Mac to read the reply back')
    expect(await results(f, cap, reply)).toBe(1)
    const h = await f.mac.call('GET', `/api/sessions/${cap.sid}/history`)
    expect(h.text.split(reply).length - 1, 'the reply once in the Mac history').toBe(1)
    // However it went (relayed after the thaw, or journaled and drained), the Mac applied it at most once.
    expect(appliedLines(f, cap.taskId).length).toBeLessThanOrEqual(1)
    times.c2 = took()
  }, 420_000)

  it('C3: a host 10 minutes behind journals a write while the lid is closed; the Mac applies it once on wake', async () => {
    const took = t0()
    times.skewConnect = await f.addHost('skewbox')
    expectControlMaster(f, 'skewbox')
    const s = await startHostSession(f, 'skewbox', 'Skewed clock check', 'hello skewbox')
    const title = 'Written on a slow clock'
    await startUpdateTurn(f, s, title, 4)
    const slept = Date.now()
    f.sleepMac()
    await updateTurnsEnded(f, s, 1)
    // Past the host's keepalive: the wake is a reconnect over SSH.
    await new Promise((r) => setTimeout(r, Math.max(0, 12_000 - (Date.now() - slept))))
    process.stdout.write(`[fleet] skewed host: walnut attempts ${await attemptsSummary(f, s)}\n`)
    const recs = await journaledTitle(f, s, title)
    expect(recs, JSON.stringify((await f.hostJournal('skewbox')).records)).toHaveLength(1)
    process.stdout.write(`[fleet] skewed record: ${JSON.stringify(recs[0]).slice(0, 600)}\n`)
    f.wakeMac()
    await waitFor(() => f.macTask(s.taskId)?.title === title, 120_000, 'the Mac to apply the skewed write')
    await waitFor(async () => (await f.hostJournal('skewbox')).acked.has(recs[0]!.seq), 60_000, 'the record to be acked')
    await waitFor(() => appliedLines(f, s.taskId).length > 0, 30_000, 'the Mac to log the apply')
    await new Promise((r) => setTimeout(r, 2_000))
    expect(appliedLines(f, s.taskId)).toHaveLength(1)
    times.c3 = took()
  }, 420_000)
})
