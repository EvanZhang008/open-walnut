/**
 * A session whose host goes away (sessions/host-lost.ts), over real SSH (tests/fleet/README.md).
 * Two hosts: `laptop`, whose link the run takes down on purpose (the proxy drops every
 * connection and holds new ones silent, the host itself and its CLI still running, as a
 * laptop that left the network), and `box`, where the work goes on.
 *
 * 2026-11-07: a task whose session ran on a laptop that went offline was stuck for good:
 * task_move answered 502, task_start on another host was refused ("already has its active
 * session"), task_stop said "its host has not confirmed it yet".
 *
 *   L1  both hosts connect; a session on laptop answers a turn
 *   L2  laptop's link is down: the stop answers at once that the session is stopped here
 *       (hostLost on the record), though its CLI still runs on laptop
 *   L3  task_move to box: the task goes on there in a new session that answers, with what
 *       Walnut knew of the conversation; nothing waits for laptop
 *   L4  laptop comes back: its daemon ends the old CLI before anything else, the record
 *       says so, and the one CLI of the task is box's
 *   L5  a second task on laptop, link down again: task_start on box moves it there
 *       (no refusal), and laptop's CLI of it ends when the link heals
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { dockerUnavailable } from './docker.js'
import { startFleet, type Fleet } from './fleet.js'
import { makeTask, results, startHostSession, startSession, type HostSession } from './steps.js'
import { HOST_GONE_AFTER_MS } from '../../src/core/sessions/host-lost.js'

const unavailable = await dockerUnavailable()
if (unavailable) process.stdout.write(`\n[fleet] SKIPPED: Docker is not available here (${unavailable}). Start Docker and run bun run test:fleet.\n\n`)

describe.skipIf(!!unavailable)('the fleet: a session host that goes away', () => {
  let f: Fleet
  let s: HostSession
  let moved: HostSession
  const times: Record<string, number> = {}
  const t0 = () => { const start = Date.now(); return () => Date.now() - start }
  /** The mock CLI processes on a host that run this session id (its command line names it). */
  const clisOf = async (host: string, sid: string) => (await f.hostExec(host, 'ps -eo pid,args')).split('\n')
    .filter((l) => l.includes(sid) && /claude/.test(l) && !/\bps -eo\b/.test(l))
  const record = async (sid: string) => (await f.mac.call('GET', `/api/sessions/${sid}`)).json?.session as Record<string, any>
  let droppedAt = 0
  const takeDown = async (host: string) => {
    f.cutLink(host, 'drop')
    droppedAt = Date.now()
    await waitFor(async () => !(await f.hostConnected(host)), 90_000, `the Mac to see ${host} drop`)
  }
  /** Work goes on elsewhere only once a host has been away a while (hostGone): wait that out. */
  const awayLongEnough = async () => {
    const left = droppedAt + HOST_GONE_AFTER_MS + 5_000 - Date.now()
    if (left > 0) await new Promise((r) => setTimeout(r, left))
  }

  beforeAll(async () => {
    const took = t0()
    f = await startFleet({ hosts: ['laptop', 'box'] })
    times.boot = took()
    process.stdout.write(`[fleet] run ${f.run} at ${f.base}: Mac on :${f.mac.port}, booted in ${times.boot} ms\n`)
  }, 600_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && f) process.stdout.write(`[fleet] diagnostics for "${task.name}":\n${await f.diagnostics()}\n`)
  })
  afterAll(async () => {
    process.stdout.write(`[fleet] times (ms): ${JSON.stringify(times)}\n`)
    await f?.stop()
  }, 120_000)

  it('L1: both hosts connect and a session on laptop answers', async () => {
    times.laptop = await f.addHost('laptop')
    times.box = await f.addHost('box')
    s = await startHostSession(f, 'laptop', 'Parser on the laptop', 'hello laptop')
    expect(await clisOf('laptop', s.sid)).toHaveLength(1)
  }, 420_000)

  it('L2: with laptop gone, the stop answers at once: stopped here, its CLI still running there', async () => {
    await takeDown('laptop')
    const took = t0()
    const stop = await f.mac.call('POST', `/api/v1/sessions/${s.sid}/terminate`, {})
    times.stop = took()
    process.stdout.write(`[fleet] stop with laptop gone: ${stop.status} in ${times.stop} ms: ${stop.text.slice(0, 300)}\n`)
    expect(stop.status, stop.text).toBe(200)
    expect(stop.json).toMatchObject({ status: 'terminated', hostLost: { host: 'laptop' } })
    expect(times.stop).toBeLessThan(30_000)
    const rec = await record(s.sid)
    expect(rec).toMatchObject({ process_status: 'stopped', hostLost: { host: 'laptop' }, stopRequest: { state: 'pending' } })
    // The laptop is only off the network: its CLI still runs there.
    expect(await clisOf('laptop', s.sid)).toHaveLength(1)
  }, 180_000)

  it('L3: task_move to box carries the task on there at once', async () => {
    await awayLongEnough()
    const took = t0()
    const mv = await f.mac.call('POST', `/api/v1/tasks/${s.taskId}/move`, { host: 'box', text: 'hello box' })
    times.move = took()
    process.stdout.write(`[fleet] move with laptop gone: ${mv.status} in ${times.move} ms: ${mv.text.slice(0, 400)}\n`)
    expect(mv.status, mv.text).toBeLessThan(300)
    const body = (mv.json?.result ?? mv.json) as Record<string, any>
    expect(body).toMatchObject({ state: 'done', fromHost: 'laptop' })
    expect(String((body.moved ?? []).join(' '))).toMatch(/Nothing was copied: laptop could not be reached/)
    moved = { host: 'box', taskId: s.taskId, sid: String(body.sessionId) }
    await waitFor(async () => (await results(f, moved, 'echo: hello box')) > 0, 120_000, 'the moved session on box to answer')
    expect(await record(s.sid)).toMatchObject({ archived: true, supersededBy: moved.sid })
  }, 420_000)

  it('L4: laptop comes back; its daemon ends the old CLI first, and the task\'s one CLI is box\'s', async () => {
    const took = t0()
    f.healLink('laptop')
    await waitFor(() => f.hostConnected('laptop'), 180_000, 'the Mac to reconnect to laptop')
    times.reconnect = took()
    await waitFor(async () => (await clisOf('laptop', s.sid)).length === 0, 120_000, 'laptop\'s old CLI to end')
    times.ended = took()
    await waitFor(async () => !!(await record(s.sid)).hostLost?.endedAt, 60_000, 'the record to say its host ended it')
    expect((await record(s.sid)).stopRequest?.state).toBe('confirmed')
    expect(await clisOf('box', moved.sid)).toHaveLength(1)
    expect(await clisOf('box', s.sid)).toHaveLength(0)
  }, 300_000)

  it('L5: a start on box for a task whose laptop is gone moves it there', async () => {
    // Right after L4's reconnect the host's copy may take longer than startHostSession's 10 s.
    const n = await startSession(f, 'laptop', await makeTask(f, 'Second laptop task'), 'hello again laptop')
    await waitFor(async () => (await results(f, n, 'echo: hello again laptop')) > 0, 90_000, 'the second session on laptop to answer')
    await waitFor(() => f.hostSliceHolds('laptop', n.sid), 60_000, "laptop's copy to name the second session")
    await takeDown('laptop')
    await awayLongEnough()
    const took = t0()
    const st = await f.mac.call('POST', `/api/v1/tasks/${n.taskId}/start`, { host: 'box', mode: 'default', message: 'hello start on box' })
    times.start = took()
    process.stdout.write(`[fleet] start on box with laptop gone: ${st.status} in ${times.start} ms: ${st.text.slice(0, 400)}\n`)
    expect(st.status, st.text).toBeLessThan(300)
    const sid = String(st.json.sessionId)
    expect(sid).not.toBe(n.sid)
    await waitFor(async () => (await results(f, { host: 'box', taskId: n.taskId, sid }, 'echo: hello start on box')) > 0, 120_000, 'the started session on box to answer')
    expect(await record(n.sid)).toMatchObject({ hostLost: { host: 'laptop' } })
    f.healLink('laptop')
    await waitFor(async () => (await clisOf('laptop', n.sid)).length === 0, 240_000, 'laptop\'s CLI of the second task to end')
  }, 600_000)
})
