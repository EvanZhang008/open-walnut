/**
 * The leader sends no command to the process manager of a host that runs and judges a session
 * (docs/plan/one-service-every-host.md, phase 2, Done when 1; src/core/sessions/session-command-gate.ts),
 * every piece a real process: the cluster of tests/helpers/host-judge-cluster.ts with the switch on
 * at both ends, the CLI the cluster's mock, run on the host by its service's runtime.
 *
 * Every session-process command the Mac's process aims at a daemon passes the gate in
 * DaemonConnection.send, which counts it by session (the Mac's /session-cmds probe): what the Mac
 * sends the host's daemon about a session is that count. In order, on one session:
 *   C1 list      the session lists (list GET, its own GET) with its true liveness, from the channel
 *   C2 scans     the Mac's own scans of it (liveness, a health monitor check, a capacity check that must
 *                evict one idle session there, the orphan candidates and sweep) read it alive and
 *                touch it nowhere: it is no eviction victim and no orphan
 *   C3 checks    a recheck and an automatic-recovery read answer the host's word; the read is carried
 *                out by the host against its own daemon (host-lifecycle.ts)
 *   C4 complete  completing its task stops it, carried out by the host
 *   C5 stop      a second session's stop asked on the Mac, carried out by the host
 * After each: zero session commands aimed at a daemon for it, and no refusal anywhere in the Mac.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('the Mac sends a host-judged session\'s host daemon no command, every piece a real process', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let sid = ''

  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const macRow = async (s: string): Promise<Record<string, any> | null> => {
    const r = await h.c.mac('GET', `/api/sessions/${s}`)
    return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null
  }
  const hostRow = async (s: string): Promise<Record<string, any> | null> => (await h.host(`/row?sid=${s}`)).row ?? null
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  /** Nothing aimed at a daemon for `s`, and no refusal of any session's command in the Mac, its daemon link to the host up throughout. */
  async function noCommands(s: string): Promise<void> {
    const c = await h.mac(`/session-cmds?sid=${s}`)
    expect(c, JSON.stringify(c)).toEqual({ aimed: {}, refusals: {} })
    expect((await h.mac(`/daemon-link?host=${HOST_KEY}`)).connected).toBe(true)
  }

  async function startTask(title: string, message: string): Promise<{ taskId: string; sid: string }> {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const id = t.json.task.id as string
    const st = await h.c.mac('POST', `/api/v1/tasks/${id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const s = st.json.sessionId as string
    await waitFor(async () => resultOn(((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel'), `echo: ${message}`) ?? null, 120_000, 'the answer on the Mac')
      .catch((err) => { throw new Error(say(String(err))) })
    // The turn ended: the host reads it idle, and so does the Mac's copy of its row.
    await waitFor(async () => (await macRow(s))?.process_status === 'idle', 60_000, 'the Mac to read it idle').catch((err) => { throw new Error(say(String(err))) })
    return { taskId: id, sid: s }
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judged-session-commands-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel')
    // The Mac's daemon link to the host is up: a command for the session would have a way to go, so none going is the gate's doing.
    await waitFor(async () => (await h.mac(`/daemon-link?host=${HOST_KEY}`)).connected === true, 120_000, 'the Mac\'s daemon link to the host')
    ;({ taskId, sid } = await startTask('Host judged commands', 'ROUND one'))
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-commands: logs at ${writeClusterLogs(h.c, 'host-judged-commands')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('C1: the session lists with its true liveness, and its host\'s daemon is asked nothing', async () => {
    const list = await h.c.mac('GET', '/api/sessions')
    expect(list.status, JSON.stringify(list.json)).toBe(200)
    const rows = (list.json.sessions ?? list.json) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.claudeSessionId === sid), JSON.stringify(rows).slice(0, 2000)).toMatchObject({ process_status: 'idle', judge: 'host', host: HOST_KEY })
    expect(await macRow(sid)).toMatchObject({ process_status: 'idle' })
    await noCommands(sid)
  })

  it('C2: the Mac\'s own scans read it alive and touch it nowhere: no eviction, no orphan, no repair', async () => {
    const s = await h.mac(`/scans?sid=${sid}&host=${HOST_KEY}`)
    expect(s.alive).toBe(true)
    expect(s.evicted).toEqual([])
    expect(s.orphans).toEqual([])
    expect(s.swept).toEqual([])
    expect(s.row).toMatchObject({ process_status: 'idle', judge: 'host' })
    // Still idle on the host: nothing stopped it.
    expect(await hostRow(sid)).toMatchObject({ process_status: 'idle' })
    await noCommands(sid)
  })

  it('C3: a recheck and an automatic-recovery read answer the host\'s word, the read carried out by the host', async () => {
    const re = await h.c.mac('POST', `/api/sessions/${sid}/recheck`, {})
    expect(re.status, JSON.stringify(re.json)).toBe(200)
    expect(re.json).toMatchObject({ sessionId: sid, checked: true, alive: true, processStatus: 'idle' })
    const sup = await h.c.mac('GET', `/api/sessions/${sid}/supervision`)
    expect(sup.status, JSON.stringify(sup.json)).toBe(200)
    // The host's own daemon answered (a fresh read, not the kept state of an earlier one, and not the
    // answer of a host that could not reach its daemon at all).
    expect(sup.json, JSON.stringify(sup.json)).toMatchObject({ available: expect.any(Boolean) })
    expect(sup.json.stale, JSON.stringify(sup.json)).toBeUndefined()
    expect(sup.json.startup, JSON.stringify(sup.json)).not.toBe('unavailable')
    await noCommands(sid)
  })

  it('C4: completing its task stops it, carried out by the host', async () => {
    const done = await h.c.mac('POST', `/api/v1/tasks/${taskId}/complete`, {})
    expect(done.status, JSON.stringify(done.json)).toBeLessThan(300)
    await waitFor(async () => (await hostRow(sid))?.process_status === 'stopped' && (await macRow(sid))?.process_status === 'stopped', 60_000, 'the host to stop it and the Mac to read it')
      .catch((err) => { throw new Error(say(String(err))) })
    await noCommands(sid)
  })

  it('C5: a stop asked on the Mac is carried out by the host, and its daemon is asked nothing', async () => {
    const second = await startTask('Host judged stop', 'ROUND two')
    const stop = await h.c.mac('POST', `/api/v1/sessions/${second.sid}/terminate`, { force: true })
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ status: 'terminated' })
    await waitFor(async () => (await hostRow(second.sid))?.process_status === 'stopped' && (await macRow(second.sid))?.process_status === 'stopped', 60_000, 'both ends to read it stopped')
      .catch((err) => { throw new Error(say(String(err))) })
    // A list after the stop reads it stopped, from the channel.
    const list = await h.c.mac('GET', '/api/sessions')
    const rows = (list.json.sessions ?? list.json) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.claudeSessionId === second.sid)).toMatchObject({ process_status: 'stopped' })
    await noCommands(second.sid)
    await noCommands(sid)
  })
})
