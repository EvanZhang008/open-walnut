/**
 * The switch turned on while the host's copy of it still says off, every piece a real process
 * (docs/plan/one-service-every-host.md, phase 2; src/core/session-channel/switch-catch-up.ts): the
 * cluster of tests/helpers/host-judge-cluster.ts with the host reading the switch from its config
 * copy (not forced on), as a production host does.
 *
 *   L1 lag   the experiment off, the host's copy says so; then on, with the copy's next round held
 *            (the probe's /hold-copy: the copy lags its write, as it does for a few seconds in
 *            production). A start on the host is refused `host_runs_sessions_off` first; the Mac
 *            sends the config copy now, the host takes it, and the same start goes once more: it
 *            runs on the host and its answer comes back; the start did not fail
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('the host\'s copy of the switch lags the write that turned it on', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-8000)}\n--- replica ---\n${h.c.logs().replica.slice(-4000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  /** What the host's config copy says of the experiment now (its file, as its getConfig reads it). */
  const hostCopySays = (): boolean | null => {
    try {
      const t = fs.readFileSync(path.join(h.c.replicaData, 'cache', 'replica', 'config.json'), 'utf8')
      const m = /"host_runs_sessions"\s*:\s*(true|false)/.exec(t)
      return m ? m[1] === 'true' : null
    } catch { return null }
  }
  const setSwitch = async (on: boolean) => {
    const r = await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: on } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    let since = 0
    await waitFor(async () => {
      if ((await h.mac(`/side?host=${HOST_KEY}`)).judges !== on) { since = 0; return false }
      since ||= Date.now()
      return Date.now() - since >= 2_000
    }, 60_000, `the Mac to ${on ? 'hand' : 'stop handing'} starts to the host`, 200).catch(fail)
  }

  beforeAll(async () => {
    // Not forced: the host's service reads the switch from its copy of the Mac's config.
    h = await startHostJudgeCluster({ hostEnv: { WALNUT_HOST_RUNS_SESSIONS: 'from-copy' } })
    process.stdout.write(`host-judged-switch-lag-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Switch lag run', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-switch-lag: logs at ${writeClusterLogs(h.c, 'host-judged-switch-lag')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('L1: refused as off once, the copy goes now, the start goes once more and runs on the host', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    // Off, and the host's copy says so (its session side stays up: it ran with the switch on).
    await setSwitch(false)
    await waitFor(() => hostCopySays() === false, 60_000, 'the host\'s copy to say off').catch(fail)
    expect((await h.mac(`/side?host=${HOST_KEY}`)).linked).toBe(true)
    // On here, while the copy's next round is held: the host's copy still says off.
    await h.mac('/hold-copy?kind=config&on=1')
    await setSwitch(true)
    expect(hostCopySays()).toBe(false)

    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'LAG one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: LAG one'), 120_000, 'the answer on the Mac').catch(fail)
    expect(hostCopySays()).toBe(true)
    expect((await h.mac(`/row?sid=${sid}`)).row).toMatchObject({ claudeSessionId: sid, judge: 'host', host: HOST_KEY })
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
    // The first answer was the lag's, and the start went exactly once more.
    const mac = h.c.logs().mac
    expect(mac).toContain('host start: the host says its switch is off while this leader says on')
    expect(mac.split('\n').filter((l) => l.includes('host start: asked once more after the host caught up with the switch'))).toHaveLength(1)
    await h.mac('/hold-copy?kind=config&on=0')
  }, 400_000)
})
