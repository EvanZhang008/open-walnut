/**
 * A routine runs where its work runs (clock-routine-v1, docs/plan/walnut-trigger.md
 * "Clock routines"): a scheduled `session` routine whose task's session runs on
 * the host keeps its clock in that host's daemon. The Mac sleeps (SIGSTOP, a lid
 * close: its sockets stay open and go silent), the slot comes, the host's daemon
 * fires and delivers the run into the session there. The Mac wakes and records
 * that run once, and delivers nothing itself.
 *
 * Every piece is a real process (tests/helpers/replica-cluster.ts): a non-ephemeral
 * Mac server child with its own daemon, a host daemon twin with its trigger
 * sidecar, the replica that daemon supervises, and the cluster's mock CLI as
 * `claude` on the host.
 *
 * Twins: both (source, then standalone) when bun is on this machine, the source twin
 * alone otherwise; REPLICA_CLUSTER_TWINS=source|standalone|source,standalone picks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUN, HOST_KEY, sleep, startReplicaCluster, waitFor, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')

const PROMPT = 'Post the nightly digest for the marina board.'
const EVERY_MS = 10 * 60_000

function hostStream(c: ReplicaCluster, sid: string): Array<Record<string, any>> {
  try {
    return fs.readFileSync(path.join(c.base, 'hd', 'streams', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return {} } })
  } catch { return [] }
}

/** Turns of the host session that answered the routine's prompt (the mock CLI echoes what it read). */
const routineTurns = (c: ReplicaCluster, sid: string) => hostStream(c, sid).filter((l) => l.type === 'result' && String(l.result).includes(PROMPT))

function hostTriggerState(c: ReplicaCluster, id: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(path.join(c.base, 'hd', 'trigger-state', `${id}.json`), 'utf8')) } catch { return null }
}

function hostSliceHolds(c: ReplicaCluster, needles: string[]): boolean {
  const dir = path.join(c.base, 'hd', 'offline-host')
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith('slice-') && n.endsWith('.json')) } catch { return false }
  return names.some((n) => { const t = fs.readFileSync(path.join(dir, n), 'utf8'); return needles.every((x) => t.includes(x)) })
}

describe.each(TWINS)('a clock routine fires on its host while the Mac sleeps (%s twin)', (twin) => {
  let c: ReplicaCluster
  let taskId = ''
  let sid = ''
  let routineId = ''
  let firstSlot = 0

  const routine = async (): Promise<Record<string, any>> => (await c.mac('GET', `/api/routines/${routineId}`)).json.job

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    const hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    const t = await c.mac('POST', '/api/tasks', { title: 'Marina digest', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
    const st = await c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'default', message: 'hello digest' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await waitFor(() => hostStream(c, sid).some((l) => l.type === 'result' && String(l.result).includes('hello digest')), 120_000, 'the host session to answer')
    // Every ten minutes, the first slot about a minute and a half out: one run in this test.
    firstSlot = Date.now() + 90_000
    const r = await c.mac('POST', '/api/routines', {
      name: 'Marina digest', enabled: true,
      schedule: { kind: 'every', everyMs: EVERY_MS, anchorMs: firstSlot - EVERY_MS },
      executor: { type: 'session', config: { target: taskId, prompt: PROMPT } },
    })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    routineId = r.json.job.id as string
    // Its work runs on devbox, so its clock moves there; the host knows the task's session.
    await waitFor(async () => (await routine()).state?.clockHost === HOST_KEY, 60_000, 'the clock to move to the host')
    await waitFor(() => hostTriggerState(c, routineId)?.clock?.fromMs === firstSlot, 30_000, 'the host daemon to arm the clock')
    await waitFor(() => hostSliceHolds(c, [taskId, sid]), 60_000, 'the host copy to hold the task and its session')
    expect((await routine()).state.nextRunAtMs).toBe(firstSlot)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the Mac sleeps; the host fires on the slot and delivers the run into the session there', async () => {
    c.sleepMac()
    expect(Date.now()).toBeLessThan(firstSlot)
    // The slot, a tick, the claim grace (30 s) and the next tick.
    await waitFor(() => routineTurns(c, sid).length > 0, firstSlot - Date.now() + 120_000, 'the run in the host session', 500)
    const st = hostTriggerState(c, routineId)!
    expect(st.pendingFires).toHaveLength(1)
    expect(st.pendingFires[0]).toMatchObject({ seq: 1, clock: { slotMs: firstSlot, fromMs: firstSlot }, host: { sessionId: sid, seqs: [1] } })
    expect(st.clock).toEqual({ fromMs: firstSlot, nextRunAtMs: firstSlot + EVERY_MS })
    // The run fired at its slot, not before.
    expect(st.pendingFires[0].atMs).toBeGreaterThanOrEqual(firstSlot)
    await sleep(8_000)
    expect(routineTurns(c, sid)).toHaveLength(1)
  }, 300_000)

  it('the Mac wakes and shows that run once, delivering nothing itself', async () => {
    c.wakeMac()
    const job = await waitFor(async () => {
      const j = await routine()
      return j?.state?.fireCount === 1 ? j : null
    }, 120_000, 'the Mac to record the run', 500)
    expect(job.state.clockHost).toBe(HOST_KEY)
    expect(job.state.nextRunAtMs).toBe(firstSlot + EVERY_MS)
    expect(job.state.fireLog).toHaveLength(1)
    expect(String(job.state.fireLog[0].delivery?.summary)).toContain(HOST_KEY)
    expect(job.state.fireLog[0].delivery?.sessionId).toBe(sid)
    // The Mac acked it, and a while later nothing ran twice anywhere.
    await waitFor(() => (hostTriggerState(c, routineId)?.pendingFires ?? [1]).length === 0, 60_000, 'the ack')
    await sleep(15_000)
    expect(routineTurns(c, sid)).toHaveLength(1)
    expect((await routine()).state.fireCount).toBe(1)
  }, 300_000)
})
