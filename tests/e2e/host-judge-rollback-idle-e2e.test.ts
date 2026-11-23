/**
 * Rolling back the switch while a host runs a session (deliverable 11, the documented order: switch
 * off, wait for the host's sessions to end, then install an older release; docs/plan/
 * one-service-every-host.md "Rolling back"), and the host's idle scan with the leader away, every
 * piece a real process: the cluster of tests/helpers/host-judge-cluster.ts, the Mac's daemon link
 * through a proxy the test cuts, and the host's runtime with its idle windows shortened
 * (WALNUT_SESSION_IDLE_WARNING_MS, WALNUT_SESSION_IDLE_KILL_MS, WALNUT_SESSION_IDLE_SCAN_MS):
 * a session with no subscriber and no output for IDLE_KILL_MS is killed ("idle scan: killing idle
 * session (no subscribers, no output)").
 *
 *   R1 on       a host-judged session runs and answers
 *   R2 off      the switch off on the Mac: the session keeps running and reaching the Mac (a send is
 *               answered over the channel), and a new start takes the legacy path
 *   R3 away     the Mac's link cut and the Mac stopped, past three idle windows: the legacy session
 *               (whose one subscriber was the Mac's link) is killed by the scan, the control that
 *               the windows are short; the host-judged one is not (its host's runner holds it), and
 *               its CLI still runs. A leader restart is the same to the host as this: no link of
 *               the leader's holds the session either way.
 *   R4 end      the Mac back: the host-judged session still answers the Mac, and a stop from the
 *               Mac ends it there; every fact of it reached the Mac once and in order. Only then
 *               does the documented order install an older host (M1 of
 *               host-judge-mixed-versions-e2e.test.ts is that host)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, logSince, sessionCliEnv, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'
import { channelClassOf } from '../../src/core/session-channel/event-classes.js'

const RUN = !!BUN && process.platform !== 'win32'
const IDLE_KILL_MS = 8_000
const hash = (d: unknown) => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex')
const KILLED = 'idle scan: killing idle session (no subscribers, no output)'

describe.skipIf(!RUN)('rolling the switch back while a host runs a session, and the host\'s idle scan with the leader away', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sid = ''
  let legacySid = ''

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const macRow = async (s: string) => { const r = await h.c.mac('GET', `/api/sessions/${s}`); return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null }

  beforeAll(async () => {
    h = await startHostJudgeCluster({
      linkProxy: true,
      hostEnv: { WALNUT_SESSION_IDLE_WARNING_MS: '2000', WALNUT_SESSION_IDLE_KILL_MS: String(IDLE_KILL_MS), WALNUT_SESSION_IDLE_SCAN_MS: '1000' },
    })
    process.stdout.write(`host-judge-rollback-idle-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`rollback-idle: logs at ${writeClusterLogs(h.c, 'rollback-idle')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  const startOn = async (title: string, message: string) => {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    return st.json.sessionId as string
  }

  it('R1: a host-judged session runs and answers', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    sid = await startOn('Host judged, then rolled back', 'ROUND on')
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND on'), 120_000, 'the first answer on the Mac').catch(fail)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 400_000)

  it('R2: the switch off: the running session keeps reaching the Mac, and a new start takes the legacy path', async () => {
    const off = await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: false } })
    expect(off.status, JSON.stringify(off.json)).toBe(200)
    await waitFor(async () => !(await h.mac(`/side?host=${HOST_KEY}`)).judges, 30_000, 'the Mac to stop handing starts to the host').catch(fail)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND after off' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND after off'), 120_000, 'the host session to answer after the switch went off').catch(fail)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    legacySid = await startOn('Legacy after the switch', 'ROUND legacy')
    await waitFor(() => hostStream(h.c, legacySid).some((l) => l.type === 'result' && String(l.result).includes('ROUND legacy')), 120_000, 'the legacy session to answer').catch(fail)
    expect(await h.mac(`/judge?sid=${legacySid}`)).toEqual({ judge: 'legacy', host: null })
    expect(await channelEvents(legacySid)).toEqual([])
  }, 400_000)

  it('R3: with the Mac away, the idle scan kills the legacy session and leaves the host-judged one to its host', async () => {
    const at = Date.now()
    h.c.cutLink()
    h.c.sleepMac()
    try {
      // The control: the legacy session's only subscriber was the Mac's link, so the short window takes it.
      await waitFor(() => logSince(h.c, at).some((l) => l.msg === KILLED && l.sid === legacySid), IDLE_KILL_MS * 6, 'the idle scan to kill the legacy session').catch(fail)
      // Three more windows: the host-judged session is held by its host's runner.
      await new Promise((r) => setTimeout(r, IDLE_KILL_MS * 3))
      const kills = logSince(h.c, at).filter((l) => l.msg === KILLED).map((l) => l.sid)
      expect(kills, JSON.stringify(kills)).not.toContain(sid)
      expect(sessionCliEnv(h.c, sid), 'the host-judged session\'s CLI still runs').not.toBeNull()
      // Idle as long as the legacy one was: the scan looked at it and let it be.
      const warned = logSince(h.c, at).filter((l) => l.sid === sid && /^idle scan: /.test(String(l.msg)))
      expect(warned, JSON.stringify(warned)).toEqual([])
    } finally {
      h.c.wakeMac()
      h.c.mendLink()
    }
  }, 400_000)

  it('R4: the Mac back, the session still answers it, a stop from the Mac ends it on the host, and every fact reached the Mac once', async () => {
    await waitFor(async () => (await h.mac(`/side?host=${HOST_KEY}`)).linked, 120_000, 'the Mac to link the host again').catch(fail)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND back' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND back'), 120_000, 'the answer after the Mac came back').catch(fail)
    const stop = await h.c.mac('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(stop.status, JSON.stringify(stop.json)).toBeLessThan(300)
    await waitFor(async () => (await macRow(sid))?.process_status === 'stopped', 60_000, 'the Mac to read it stopped').catch(fail)
    expect((await h.host(`/row?sid=${sid}`)).row?.process_status).toBe('stopped')
    await waitFor(() => sessionCliEnv(h.c, sid) === null, 30_000, 'its CLI to end on the host').catch(fail)
    // Every fact, from the switch on through its end: once, in order.
    let last = -1
    let since = 0
    await waitFor(async () => {
      const head = (await h.host('/facts?after=0')).head
      if (head !== last) { last = head; since = Date.now(); return false }
      return Date.now() - since >= 1_000 && ((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= head
    }, 60_000, 'the Mac\'s cursor at the host\'s head', 200).catch(fail)
    const log = ((await h.host('/facts?after=0')).recs as HostFactRecord[]).filter((r) => r.sid === sid && channelClassOf(r.name) === 'fact')
    const mac = (await channelEvents(sid)).filter((e) => channelClassOf(e.name) === 'fact')
    const host = log.map((r) => `${r.name}:${r.refs ? 'cut' : hash(r.data).slice(0, 12)}`)
    const seen = mac.map((e, i) => `${e.name}:${log[i]?.refs ? 'cut' : e.hash.slice(0, 12)}`)
    expect(seen, `host: ${host.join(' ')}\nmac:  ${seen.join(' ')}`).toEqual(host)
    // A new start still goes the legacy way.
    expect((await h.mac(`/side?host=${HOST_KEY}`)).judges).toBe(false)
  }, 400_000)
})
