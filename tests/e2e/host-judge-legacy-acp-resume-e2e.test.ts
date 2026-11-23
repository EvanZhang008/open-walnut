/**
 * A legacy ACP engine's session at rest is resumed by its host's own service, as a native one is
 * (src/providers/host-resume.ts "ACP"; the native one: host-judge-legacy-resume-e2e.test.ts). Every
 * piece a real process: the cluster of tests/helpers/host-judge-cluster.ts, where both the Mac and
 * the host run ACP engines through a worker built from this checkout and the scripted adapter
 * (tests/providers/mock-acp-agent.mjs), and the Mac turns its switch off and on while it runs.
 *
 *   A1 legacy   the switch off: an ACP session (OpenCode's slot) starts on devbox the legacy way (the
 *               Mac's runner drives the worker in the host's daemon), answers, and is stopped
 *   A2 off      still off: a send to it resumes it the legacy way, as before
 *   A3 on       the switch on: a send to the stopped session goes to the host, whose service attaches
 *               the same session from the same row (its runtime id, its journal) and resumes it in
 *               its own daemon; the row is the host's, the answer comes back once over the channel,
 *               and the Mac holds no ACP object of it any more
 *   A4 next     its next send is a plain send to the host
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a legacy ACP session at rest is resumed by its host\'s service', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sid = ''
  let runtimeId = ''

  const macEvents = async (): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${sid}`)) as ProbeEvent[]
  const channelEvents = async () => (await macEvents()).filter((e) => e.source === 'host-channel')
  const resultsOn = (events: ProbeEvent[], text: string) => events.filter((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-8000)}\n--- replica ---\n${h.c.logs().replica.slice(-8000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const macRow = async () => { const r = await h.c.mac('GET', `/api/sessions/${sid}`); return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null }
  const macAcp = async () => (await h.mac(`/acp?sid=${sid}`)) as { found: boolean; hostJudged: boolean; workerLive: boolean | null }
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
  const send = async (text: string) => {
    const r = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
  }
  const stop = async () => {
    const r = await h.c.mac('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    // At rest: stopped, and the Mac's ACP object of it holds no worker.
    await waitFor(async () => (await macRow())?.process_status === 'stopped' && (await macAcp()).workerLive !== true, 60_000, 'the ACP session to stop').catch(fail)
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ macAcp: true })
    process.stdout.write(`host-judge-legacy-acp-resume-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`legacy-acp-resume: logs at ${writeClusterLogs(h.c, 'legacy-acp-resume')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('A1: with the switch off, an ACP session starts the legacy way, answers and is stopped', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    await setSwitch(false)
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Legacy ACP', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const taskId = t.json.task.id as string
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', engine: 'opencode', message: 'ACP round one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    // An ACP engine names its session at establish: the task's link says it then.
    sid = (st.json.sessionId as string | undefined) || await waitFor(async () => {
      const tk = (await h.c.mac('GET', `/api/tasks/${taskId}`)).json
      const task = tk.task ?? tk
      return (task.session_id ?? task.exec_session_id ?? task.plan_session_id ?? null) as string | null
    }, 120_000, 'the ACP session id').catch(fail)
    await waitFor(async () => resultsOn(await macEvents(), 'ACP round one').length > 0, 120_000, 'the legacy ACP answer').catch(fail)
    const row = await macRow()
    expect(row).toMatchObject({ engine: 'opencode', host: HOST_KEY })
    expect(row?.judge).toBeUndefined()
    runtimeId = String(row?.acpRuntimeId ?? '')
    expect(runtimeId).toMatch(/^acp-/)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'legacy', host: null })
    expect(await channelEvents()).toEqual([])
    await stop()
  }, 400_000)

  it('A2: still off, a send to the stopped ACP session resumes it the legacy way', async () => {
    await send('ACP round off')
    await waitFor(async () => resultsOn(await macEvents(), 'ACP round off').length > 0, 120_000, 'the legacy resume to answer').catch(fail)
    expect((await macRow())?.judge).toBeUndefined()
    expect(await channelEvents()).toEqual([])
    expect(h.c.logs().mac).not.toContain('host resume:')
    await stop()
  }, 300_000)

  it('A3: with the switch on, the host resumes the stopped ACP session from the same row; it is the host\'s', async () => {
    await setSwitch(true)
    await send('ACP round host')
    await waitFor(async () => resultsOn(await channelEvents(), 'ACP round host').length > 0, 120_000, 'the resumed ACP answer over the channel').catch(fail)
    expect(h.c.logs().mac).toContain('host resume: the host resumes the session; it is host-judged from now on')
    // The same session: its id, its engine and its runtime (the worker's journal) on both ends.
    expect(await macRow()).toMatchObject({ claudeSessionId: sid, judge: 'host', host: HOST_KEY, engine: 'opencode', acpRuntimeId: runtimeId })
    expect((await h.host(`/row?sid=${sid}`)).row).toMatchObject({ claudeSessionId: sid, judge: 'host', engine: 'opencode', acpRuntimeId: runtimeId })
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    // The Mac holds no ACP object of it: its lookup answers the host's proxy.
    expect(await macAcp()).toMatchObject({ found: true, hostJudged: true })
    // The host's own runner attached it from its row, with the same runtime, to its own daemon (this
    // machine, never a link to itself), and its worker runs there.
    expect(await h.host(`/acp?sid=${sid}`)).toEqual({ found: true, runtimeId, host: '__local__', workerLive: true })
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:send'), JSON.stringify(onHost.map((e) => e.name))).toBe(true)
    await untilFactsStill(h)
    // Delivered once: one answer on the Mac, none of it the Mac's own runner's.
    expect(resultsOn(await macEvents(), 'ACP round host')).toHaveLength(1)
    expect((await macEvents()).filter((e) => e.name === 'session:started' && e.source === 'host-channel')).toEqual([])
  }, 300_000)

  it('A4: its next send goes to the host as any host-judged session\'s', async () => {
    await send('ACP round next')
    await waitFor(async () => resultsOn(await channelEvents(), 'ACP round next').length > 0, 120_000, 'the next answer over the channel').catch(fail)
    expect(resultsOn(await macEvents(), 'ACP round next')).toHaveLength(1)
    expect((await macRow())?.acpRuntimeId).toBe(runtimeId)
  }, 200_000)
})
