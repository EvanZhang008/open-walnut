/**
 * A host's one Walnut service without a copy (experiment service_without_copy) while its leader is
 * away, every piece a real process (tests/helpers/copyless-cluster.ts: the Mac server with its
 * daemon, the host under its launcher switched to its one service without a copy). Every call is a
 * session's own `walnut` CLI, run inside the session (startSessionCaller), with the user-PATH
 * walnut a production host has (it waits out a restart while the service's own bin/walnut is gone).
 *
 *   R4   the service ended by hand during a call (SIGTERM; its launcher starts it again), the Mac
 *        away: a board_post held in flight (the service stopped, the call sent, the service ended,
 *        then let go), and one made while the service is down. Each call ends ok within the CLI's
 *        wait (the CLI rides the restart, and a `needs_leader {why: 'service_starting'}` the new
 *        service answers before it is seated), each is journaled once, lands on the Mac once
 *        when it is back, and the sessions' CLIs are the same processes after both restarts.
 *   T1   a trigger fires while the Mac is away into a live session and into one its person
 *        stopped: the service delivers into the live one, and wakes the stopped one with it on
 *        the host; each fire reaches its session once, away or after the return, never twice, and
 *        the Mac's transcript holds each once. No call or fire of that time is the daemon's own
 *        away answer (G1).
 *
 * Run time about 4 minutes (boot and switch about 40 s, T1 about 2 minutes: the host offers an
 * unclaimed fire once a minute, R4 about 1 minute).
 * `bun --bun vitest run --config vitest.e2e.config.ts tests/e2e/copyless-away-restart-e2e.test.ts`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, sleep, waitFor, WINDOWS, type ReplicaCluster } from '../helpers/replica-cluster.js'
import { deliveries, gatewayCall, hostJournal, keepLogsOnFailure, logSince, sessionCliPid, userRowsWith } from '../helpers/replica-cluster-reads.js'
import {
  boardPosts, CLI_WAIT_MS, OWN_LINES, servicePid, startCopylessCluster, startOnHost, startSessionCaller, switchToCopyless,
  type CallerAnswer, type CopylessCluster, type HostTask,
} from '../helpers/copyless-cluster.js'
import { newCallId } from '../../src/lib/op-call-id.js'

const show = (label: string, v: unknown) => process.stdout.write(`copyless-away-restart-e2e: ${label} ${JSON.stringify(v).slice(0, 1500)}\n`)
const said = (r: CallerAnswer) => `${r.stdout}\n${r.stderr}`
const FIRE = { live: 'The live watch fired.', stopped: 'The quiet watch fired.' } as const

describe.skipIf(!BUN)('a host\'s one service without a copy, restarted or fired at while its leader is away', () => {
  let k: CopylessCluster
  let c: ReplicaCluster
  /** Started on the service without a copy, so the Mac's messages reach them (their callers run in a turn). */
  let live: HostTask
  let quiet: HostTask
  let worker: HostTask
  const recordsOf = (callId: string) => hostJournal(c).filter((r) => String(r.opId ?? '').startsWith(`${callId}-`))
  /** Puts the Mac to sleep and waits out its quiet window: the host's service answers alone from then on. */
  async function macAway(): Promise<number> {
    const slept = c.sleepMac()
    const quietAt = slept.after + WINDOWS.quietMs + 2_000
    if (Date.now() < quietAt) await sleep(quietAt - Date.now())
    return slept.after
  }

  beforeAll(async () => {
    k = await startCopylessCluster()
    c = k.c
    show('cluster at', c.base)
    const warm = await startOnHost(k, 'Host warmup', 'hello warmup')
    await switchToCopyless(c, warm.sid)
    live = await startOnHost(k, 'Host watcher', 'hello watcher')
    quiet = await startOnHost(k, 'Host sleeper', 'hello sleeper')
    worker = await startOnHost(k, 'Host caller', 'hello caller')
    const set = await c.mac('PUT', `/api/v1/tasks/${worker.task}/board`, { html: '<h2>Plan</h2><walnut-thread id="away"></walnut-thread>' })
    expect(set.status, JSON.stringify(set.json)).toBeLessThan(300)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('T1: a fire while the Mac is away reaches a live session and a stopped one, each once', async () => {
    keepLogsOnFailure(() => c, 'copyless-t1')
    // Each session arms its own trigger (session "this": its task), whose check fires once its file appears.
    const gates = { live: path.join(k.hostCwd, 'gate-live'), stopped: path.join(k.hostCwd, 'gate-stopped') }
    const triggers: Record<string, string> = {}
    for (const [name, s] of [['live', live], ['stopped', quiet]] as const) {
      const check = path.join(k.hostCwd, `check-${name}.sh`)
      fs.writeFileSync(check, `if [ -f ${gates[name]} ]; then echo '{"fire":true,"items":[{"id":"${name}-1"}]}'; else echo '{"fire":false}'; fi\n`, { mode: 0o755 })
      const caller = await startSessionCaller(k, s)
      const armed = await caller.call('trigger_create', {
        run: `sh ${check}`, every: '10s', prompt: FIRE[name], name: `${name} watch`,
        description: 'Checks a file every 10 seconds; when it appears, the session looks at it.',
      })
      show(`trigger ${name}`, { code: armed.code, json: armed.json })
      expect(armed.code, said(armed)).toBe(0)
      triggers[name] = String(armed.json?.id ?? '')
      expect(triggers[name]).not.toBe('')
      await caller.stop()
    }
    // The person stops the sleeper's session (the session panel's Stop): its CLI ends, its conversation is kept.
    const stop = await c.mac('POST', `/api/sessions/${quiet.sid}/terminate`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    await waitFor(() => (sessionCliPid(c, quiet.sid) === 0 ? true : null), 60_000, 'the stopped session\'s CLI to end')
    // One check of each with no fire yet, while the Mac answers.
    await sleep(12_000)
    const from = Date.now()
    try {
      await macAway()
      for (const g of Object.values(gates)) fs.writeFileSync(g, '')
      await waitFor(() => (deliveries(c, live.sid, FIRE.live) > 0 ? true : null), 150_000, 'the fire to reach the live session while the Mac is away')
      await waitFor(() => (deliveries(c, quiet.sid, FIRE.stopped) > 0 ? true : null), 150_000, 'the fire to wake the stopped session while the Mac is away')
      // Woken on the host: its CLI runs again, for the fire.
      expect(sessionCliPid(c, quiet.sid)).toBeGreaterThan(0)
      const lines = logSince(c, from)
      show('fire lines', lines.filter((l) => /trigger/.test(String(l.msg))).map((l) => `${l.msg} ${l.reason ?? l.error ?? ''}`).slice(0, 30))
      expect(lines.filter((l) => l.msg === 'trigger: host resume failed')).toEqual([])
      // G1: the service delivered them, never the daemon's own away code.
      expect(lines.filter((l) => OWN_LINES.includes(String(l.msg)) || String(l.msg).includes('this daemon delivers the fire itself')).map((l) => String(l.msg))).toEqual([])
    } finally {
      if (c.asleep()) c.wakeMac()
    }
    // Back: the Mac records each fire (its history and the session's transcript), and nothing is delivered again.
    for (const [name, s] of [['live', live], ['stopped', quiet]] as const) {
      await waitFor(async () => {
        const t = await c.mac('GET', `/api/v1/sessions/${s.sid}/transcript?fresh=1`)
        return userRowsWith(t.json, FIRE[name]) > 0 ? true : null
      }, 180_000, `the Mac's transcript of the ${name} session to hold its fire`)
    }
    // A minute more: the host's next tick and the Mac's own delivery would come within it.
    await sleep(70_000)
    for (const [name, s] of [['live', live], ['stopped', quiet]] as const) {
      const t = await c.mac('GET', `/api/v1/sessions/${s.sid}/transcript?fresh=1`)
      const seen = { host: deliveries(c, s.sid, FIRE[name]), mac: userRowsWith(t.json, FIRE[name]) }
      show(`the ${name} fire`, seen)
      expect(seen).toEqual({ host: 1, mac: 1 })
    }
  }, 600_000)

  it('R4: the service ended by hand during a call, the Mac away: each call ends ok, is journaled once and lands once', async () => {
    keepLogsOnFailure(() => c, 'copyless-r4')
    const caller = await startSessionCaller(k, worker)
    const pids = { worker: sessionCliPid(c, worker.sid), live: sessionCliPid(c, live.sid) }
    const post = (text: string) => ({ task: worker.task, thread: 'away', text })
    // What "the service answers again" means here: the session's call is answered (it opens no port).
    const ready = async () => (await gatewayCall(c, worker.sid, 'walnut_status', {})).ok === true
    const ids = { held: newCallId(), down: newCallId() }
    const from = Date.now()
    let held: CallerAnswer
    let down: CallerAnswer
    try {
      await macAway()
      // In flight: the service stopped, the call sent into its socket, the service ended, then let go.
      const pid0 = servicePid(c)
      c.holdHostService(true)
      const t0 = Date.now()
      const first = caller.call('board_post', post('posted while the service restarted'), { callId: ids.held })
      // The CLI has written its line once its process is up (its command line holds the words) and a moment passed.
      await waitFor(() => (execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).includes(ids.held) ? true : null), 30_000, 'the walnut CLI to run')
      await sleep(2_000)
      const restarted = c.restartReplica(180_000, undefined, ready)
      c.holdHostService(false)
      const pid1 = await restarted
      held = await first
      show('the call held across the restart', { pid0, pid1, ms: Date.now() - t0, code: held.code, json: held.json, err: held.stderr.slice(0, 400) })
      // While it is down: the call starts once the old service ended, before the new one answers.
      let second: Promise<CallerAnswer> | null = null
      const pid2 = await c.restartReplica(180_000, () => { second = caller.call('board_post', post('posted while the service was down'), { callId: ids.down }) }, ready)
      down = await second!
      show('the call made while the service was down', { pid2, code: down.code, ms: down.ms, json: down.json, err: down.stderr.slice(0, 400) })
      for (const [name, r] of [['held', held], ['down', down]] as const) {
        expect(r.code, `${name}: ${said(r)}`).toBe(0)
        expect(r.json?.queued, `${name}: ${said(r)}`).toBe(true)
        expect(r.ms, name).toBeLessThan(CLI_WAIT_MS + 5_000)
        expect(recordsOf(ids[name]), name).toHaveLength(1)
      }
      const lines = logSince(c, from)
      show('service lines', lines.filter((l) => /not seated|service_starting|anonymous|riding|restart/.test(String(l.msg))).map((l) => `${l.msg} ${l.op ?? ''}`).slice(0, 20))
      expect(lines.filter((l) => String(l.msg).includes('names a session it does not run inside'))).toEqual([])
      expect(lines.filter((l) => OWN_LINES.includes(String(l.msg))).map((l) => `${l.msg} ${l.op ?? ''}`)).toEqual([])
      // The sessions' CLIs went through both restarts: the same processes, adopted by each new service.
      expect({ worker: sessionCliPid(c, worker.sid), live: sessionCliPid(c, live.sid) }).toEqual(pids)
    } finally {
      if (c.asleep()) c.wakeMac()
    }
    for (const id of Object.values(ids)) await waitFor(() => (recordsOf(id).length === 0 ? true : null), 180_000, 'the records to drain and be acked')
    await sleep(10_000)
    expect(await boardPosts(c, worker.task, 'away', 'posted while the service restarted')).toBe(1)
    expect(await boardPosts(c, worker.task, 'away', 'posted while the service was down')).toBe(1)
    await caller.stop()
  }, 600_000)
})
