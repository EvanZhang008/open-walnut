/**
 * The rest of a host-run session's life, every piece a real process
 * (docs/plan/one-service-every-host.md, phase 2): the cluster of tests/helpers/host-judge-cluster.ts
 * with the switch on at both ends. The CLI is the cluster's mock; ACP engines run the scripted ACP
 * adapter through a worker built from this checkout, and Codex its direct app-server path against
 * the scripted app-server (both on the host, through the runtime of the host's one Walnut service).
 *
 * In order, on one cluster:
 *   L1 legacy    a session started with the switch off, its CLI still running, stays the leader's
 *                after it goes on (no live session is handed over): its next turn runs in the host
 *                daemon as before, and the channel says nothing of it. One at rest is resumed by the
 *                host instead (host-judge-legacy-resume-e2e.test.ts)
 *   L2 acp       an ACP engine (OpenCode's slot) starts, answers and takes a second message on the
 *                host; the Mac keeps the row (judge 'host', its engine), hears its facts, parses no
 *                line, and its runner answers the session through the proxy
 *   L3 codex     Codex on its direct app-server path, the same way
 *   L4 subagent  a Walnut subagent of a host-run session runs on that host as a session the host
 *                judges; its answer comes back to the Mac's registry, and the parent's Background
 *                panel on the Mac lists it
 *   L5 stop      a stop asked on the Mac is carried out by the host; the archive the Mac writes
 *                reaches the host's row; a delete on the Mac takes the host's row and the Mac's mark
 *                of it goes once the host answers
 *   L6 offline   a delete made while the host is down is done by the host at its next link
 *   L7 transfer  a task's work moved from a session the Mac runs to the host starts there as a
 *                session the host judges, and the old session is stopped
 *   L8 transfer  the same from a session the host judges, to another folder there: the new one is
 *                the host's again, and the old one's stop is carried out by the host
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a host-run session\'s whole life, every piece a real process', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let parentSid = ''

  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${s}`)) as ProbeEvent[]
  const channelEvents = async (s: string) => (await macEvents(s)).filter((e) => e.source === 'host-channel')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const macRow = async (sid: string): Promise<Record<string, any> | null> => {
    const r = await h.c.mac('GET', `/api/sessions/${sid}`)
    return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null
  }
  const hostRow = async (sid: string): Promise<Record<string, any> | null> => (await h.host(`/row?sid=${sid}`)).row ?? null
  const linked = async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return !!(s.linked && s.judges) }

  /** A task and its session on `host`, started on the Mac; the session's id once the task names it. */
  async function startTask(title: string, body: Record<string, unknown>): Promise<{ taskId: string; sid: string }> {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const taskId = t.json.task.id as string
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', ...body })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    // An ACP engine names its session at establish: the task's link says it then.
    const sid = (st.json.sessionId as string | undefined) || await waitFor(async () => {
      const r = await h.c.mac('GET', `/api/tasks/${taskId}`)
      const tk = r.json.task ?? r.json
      return (tk.session_id ?? tk.exec_session_id ?? tk.plan_session_id ?? null) as string | null
    }, 120_000, `the session of ${title}`).catch((err) => { throw new Error(say(String(err))) })
    return { taskId, sid }
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judged-session-lifecycle-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    await waitFor(linked, 120_000, 'the Mac to link the host\'s session channel')
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-lifecycle: logs at ${writeClusterLogs(h.c, 'host-judged-lifecycle')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('L1: a session started with the switch off stays the leader\'s after it goes on', async () => {
    expect((await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: false } })).status).toBe(200)
    await waitFor(async () => !(await h.mac(`/side?host=${HOST_KEY}`)).judges, 30_000, 'the Mac to stop handing starts to the host')
    const { sid } = await startTask('Legacy before the switch', { message: 'ROUND legacy one' })
    await waitFor(() => hostStream(h.c, sid).some((l) => l.type === 'result' && String(l.result).includes('ROUND legacy one')), 120_000, 'the legacy answer').catch((err) => { throw new Error(say(String(err))) })
    expect((await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: true } })).status).toBe(200)
    await waitFor(linked, 60_000, 'the Mac to hand starts to the host again')
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND legacy two' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(() => hostStream(h.c, sid).some((l) => l.type === 'result' && String(l.result).includes('ROUND legacy two')), 120_000, 'the legacy session\'s next answer, in the host daemon').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'here', host: null })
    expect((await macRow(sid))?.judge).toBeUndefined()
    expect(await channelEvents(sid)).toEqual([])
    expect(await hostRow(sid).then((r) => r?.judge)).toBeUndefined()
  }, 400_000)

  it('L2: an ACP engine runs on the host: started, sent to and judged there; the Mac answers it through the proxy', async () => {
    const { sid } = await startTask('Host judged ACP', { engine: 'opencode', message: 'ACP round one' })
    await waitFor(async () => resultOn(await channelEvents(sid), 'hello from mock-acp'), 120_000, 'the ACP answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    expect(await macRow(sid)).toMatchObject({ claudeSessionId: sid, judge: 'host', host: HOST_KEY, engine: 'opencode' })
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ACP round two' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'ACP round two'), 120_000, 'the second ACP answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    // The Mac's runner answers it with the proxy, from the live state the host mirrors.
    const acp = await waitFor(async () => { const a = await h.mac(`/acp?sid=${sid}`); return a.workerLive ? a : null }, 30_000, 'the mirrored ACP state')
    expect(acp).toMatchObject({ found: true, hostJudged: true, kind: 'acp', workerLive: true })
    // A mode change on the Mac is the host's to keep and apply: its row says it, and the Mac's copy.
    const m = await h.c.mac('PATCH', `/api/sessions/${sid}`, { mode: 'plan' })
    expect(m.status, JSON.stringify(m.json)).toBe(200)
    await waitFor(async () => (await hostRow(sid))?.mode === 'plan' && (await macRow(sid))?.mode === 'plan', 60_000, 'the ACP session\'s mode on both ends').catch((err) => { throw new Error(say(String(err))) })
    // Run on the host: nothing of it in the host daemon.
    expect(hostStream(h.c, sid)).toEqual([])
  }, 300_000)

  it('L3: Codex on its direct app-server path runs on the host the same way', async () => {
    const { sid } = await startTask('Host judged Codex', { engine: 'codex', message: 'CODEX round one' })
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: '), 120_000, 'the Codex answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    expect(await macRow(sid)).toMatchObject({ judge: 'host', host: HOST_KEY, engine: 'codex' })
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
  }, 300_000)

  it('L4: a Walnut subagent of a host-run session runs on that host, judged there; the Mac\'s registry hears it and the panel lists it', async () => {
    const parent = await startTask('Host judged parent', { message: 'ROUND parent' })
    parentSid = parent.sid
    await waitFor(async () => resultOn(await channelEvents(parentSid), 'echo: ROUND parent'), 120_000, 'the parent\'s answer').catch((err) => { throw new Error(say(String(err))) })
    const r = await h.c.mac('POST', '/api/v1/subagents', { prompt: 'SUBAGENT check the build', wait_ms: 120_000 }, { 'x-walnut-caller-sid': parentSid })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ state: 'completed', host: HOST_KEY })
    // The mock CLI echoes the line as it came: the subagent's first message, framed as Walnut's.
    expect(String(r.json.answer)).toMatch(/^echo: [\s\S]*SUBAGENT check the build/)
    const id = r.json.id as string
    // Its panel on the Mac: the parent's ledger with the subagent's row.
    const panel = await h.c.mac('GET', `/api/v1/sessions/${parentSid}/workflow`)
    expect(panel.status, JSON.stringify(panel.json)).toBe(200)
    const row = (panel.json.tasks as Array<{ taskId: string; taskType: string; walnutSessionId?: string }>).find((t) => t.taskId === id)
    expect(row, JSON.stringify(panel.json)).toMatchObject({ taskType: 'walnut_subagent' })
    // Its session was the host's: started there, judged there, its facts heard through the channel.
    expect(row!.walnutSessionId).toBeTruthy()
    expect(await h.mac(`/judge?sid=${row!.walnutSessionId}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect(resultOn(await channelEvents(row!.walnutSessionId!), 'SUBAGENT check the build')).toBeTruthy()
  }, 300_000)

  it('L5: a stop on the Mac is the host\'s; the archive reaches the host\'s row; a delete takes the host\'s row and the mark goes', async () => {
    const { taskId, sid } = await startTask('Host judged to delete', { message: 'ROUND delete me' })
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND delete me'), 120_000, 'its answer').catch((err) => { throw new Error(say(String(err))) })
    // Its mode: the host's row and live CLI take it, the Mac's task moves it to the plan slot.
    const m = await h.c.mac('PATCH', `/api/sessions/${sid}`, { mode: 'plan', title: 'Renamed on the Mac' })
    expect(m.status, JSON.stringify(m.json)).toBe(200)
    await waitFor(async () => (await hostRow(sid))?.mode === 'plan' && (await macRow(sid))?.mode === 'plan', 60_000, 'the mode on both ends').catch((err) => { throw new Error(say(String(err))) })
    expect((await macRow(sid))?.title).toBe('Renamed on the Mac')
    const task = (await h.c.mac('GET', `/api/tasks/${taskId}`)).json
    expect((task.task ?? task).plan_session_id).toBe(sid)
    const stop = await h.c.mac('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(stop.status, JSON.stringify(stop.json)).toBeLessThan(300)
    expect(stop.json).toMatchObject({ status: 'terminated' })
    await waitFor(async () => (await macRow(sid))?.process_status === 'stopped', 60_000, 'the Mac to read it stopped').catch((err) => { throw new Error(say(String(err))) })
    expect((await hostRow(sid))?.process_status).toBe('stopped')
    const arch = await h.c.mac('PATCH', `/api/sessions/${sid}`, { archived: true, archive_reason: 'done' })
    expect(arch.status, JSON.stringify(arch.json)).toBe(200)
    await waitFor(async () => (await hostRow(sid))?.archived === true, 60_000, 'the archive to reach the host\'s row').catch((err) => { throw new Error(say(String(err))) })
    expect(await hostRow(sid)).toMatchObject({ judge: 'host', host: HOST_KEY, archived: true, archive_reason: 'done', process_status: 'stopped' })
    expect((await h.mac(`/delete?sid=${sid}`)).removed).toBe(1)
    await waitFor(async () => (await hostRow(sid)) === null, 60_000, 'the host to drop its row').catch((err) => { throw new Error(say(String(err))) })
    await waitFor(async () => !(await h.mac(`/drops?host=${HOST_KEY}`)).sids.includes(sid), 60_000, 'the Mac\'s mark to go')
    expect(await macRow(sid)).toBeNull()
  }, 300_000)

  it('L6: a delete made while the host is down is done by the host at its next link', async () => {
    const { sid } = await startTask('Host judged, deleted while down', { message: 'ROUND down' })
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND down'), 120_000, 'its answer').catch((err) => { throw new Error(say(String(err))) })
    const old = await h.waitHostProbe()
    const restarting = h.c.restartReplica()
    await waitFor(async () => !(await linked()), 60_000, 'the link to drop')
    expect((await h.mac(`/delete?sid=${sid}`)).removed).toBe(1)
    const marked = (await h.mac(`/drops?host=${HOST_KEY}`)).sids as string[]
    await restarting
    await h.waitHostProbe(old.pid, 180_000)
    await waitFor(linked, 120_000, 'the Mac to link the restarted host')
    expect(marked).toContain(sid)
    await waitFor(async () => (await hostRow(sid)) === null, 60_000, 'the host to drop its row at its next link').catch((err) => { throw new Error(say(String(err))) })
    await waitFor(async () => !(await h.mac(`/drops?host=${HOST_KEY}`)).sids.includes(sid), 60_000, 'the Mac\'s mark to go')
    // The host's log keeps the drop: the session's records end with it.
    const recs = ((await h.host('/facts?after=0')).recs as Array<{ sid: string; name: string }>).filter((x) => x.sid === sid)
    expect(recs.at(-1)?.name).toBe('drop')
  }, 400_000)

  /** A transfer of the task's work to the host, waited to its end. */
  async function transferToHost(taskId: string, message: string, cwd = hostCwd): Promise<Record<string, any>> {
    const xf = await h.c.mac('POST', `/api/v1/tasks/${taskId}/transfer`, { host: HOST_KEY, cwd, mode: 'carry', message, wait_ms: 120_000 })
    expect(xf.status, JSON.stringify(xf.json)).toBeLessThan(300)
    return xf.json.state === 'done' ? xf.json : await waitFor(async () => {
      const j = await h.c.mac('GET', `/api/v1/transfers/${xf.json.transferId}?wait_ms=5000`)
      return ['done', 'error', 'unconfirmed'].includes(j.json.state) ? j.json : null
    }, 180_000, 'the transfer to end')
  }

  it('L7: work moved from a session the Mac runs to the host starts there as the host\'s session; the old one is stopped', async () => {
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Moves to devbox', project: 'Acme' })
    const taskId = t.json.task.id as string
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { mode: 'bypass', message: 'ROUND on the Mac' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const fromSid = st.json.sessionId as string
    await waitFor(async () => (await macEvents(fromSid)).some((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes('ROUND on the Mac')), 120_000, 'the Mac session\'s answer').catch((err) => { throw new Error(say(String(err))) })
    const done = await transferToHost(taskId, 'ROUND after the move')
    expect(done.state, JSON.stringify(done)).toBe('done')
    const toSid = done.sessionId as string
    expect(toSid).toBeTruthy()
    await waitFor(async () => resultOn(await channelEvents(toSid), 'echo: '), 120_000, 'the moved session\'s answer from the host').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${toSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect(await macRow(toSid)).toMatchObject({ judge: 'host', host: HOST_KEY })
    // The old session stays the Mac's, stopped by the transfer.
    expect(await h.mac(`/judge?sid=${fromSid}`)).toEqual({ judge: 'here', host: null })
    await waitFor(async () => (await macRow(fromSid))?.process_status === 'stopped', 60_000, 'the old session to stop')
  }, 400_000)

  it('L8: work moved from a session the host runs to a new one there is again the host\'s; the old one is stopped by the host', async () => {
    const { taskId, sid: fromSid } = await startTask('Host judged, moved again', { message: 'ROUND before the second move' })
    await waitFor(async () => resultOn(await channelEvents(fromSid), 'echo: ROUND before the second move'), 120_000, 'its answer').catch((err) => { throw new Error(say(String(err))) })
    // Another folder on the same host: a move to where it already is changes nothing.
    const otherCwd = path.join(hostCwd, 'second')
    fs.mkdirSync(otherCwd, { recursive: true })
    const done = await transferToHost(taskId, 'ROUND after the second move', otherCwd)
    expect(done.state, JSON.stringify(done)).toBe('done')
    const toSid = done.sessionId as string
    expect(toSid).toBeTruthy()
    expect(toSid).not.toBe(fromSid)
    await waitFor(async () => resultOn(await channelEvents(toSid), 'echo: '), 120_000, 'the new session\'s answer from the host').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${toSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect(await hostRow(toSid)).toMatchObject({ judge: 'host', host: HOST_KEY })
    // The old session was the host's: its stop is the host's too, and both ends read it stopped.
    await waitFor(async () => (await hostRow(fromSid))?.process_status === 'stopped' && (await macRow(fromSid))?.process_status === 'stopped', 60_000, 'the old session to stop on both ends').catch((err) => { throw new Error(say(String(err))) })
    expect((await h.mac(`/parses?sid=${toSid}`)).parses).toBe(0)
  }, 400_000)
})
