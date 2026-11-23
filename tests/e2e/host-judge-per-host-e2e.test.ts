/**
 * The host-runs-sessions switch per host (src/core/session-channel/switch.ts), every piece a real
 * process: the cluster of tests/helpers/host-judge-cluster.ts with the experiment OFF on the Mac and
 * the host turned on by its own entry (`hosts.devbox.runs_sessions: true`), and the host's switch not
 * forced, so it reads "on for any host" from its config copy (the copy-only row hosts_run_sessions).
 *
 *   P1 one host on    the copy carries the row and never the field in the hosts row; the host runs
 *                     its session side; a start on it is host-judged
 *   P2 that host off  `runs_sessions: false` (a config write, no restart): the next start there takes
 *                     the legacy path at once, the session the host already runs keeps answering over
 *                     the channel
 *   P3 false wins     the experiment on does not turn that host on; removing the entry makes it follow
 *                     the experiment again
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('the switch per host: one host turned on by its own entry, with the experiment off', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let hostSid = ''
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const judges = async () => !!(await h.mac(`/side?host=${HOST_KEY}`)).judges
  const channelResult = async (sid: string, text: string) => ((await h.mac(`/events?sid=${sid}`)) as ProbeEvent[])
    .some((e) => e.source === 'host-channel' && e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const configCopy = (): string => { try { return fs.readFileSync(path.join(h.c.replicaData, 'cache', 'replica', 'config.json'), 'utf8') } catch { return '' } }

  async function start(word: string): Promise<string> {
    const t = await h.c.mac('POST', '/api/tasks', { title: `Per host ${word}`, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: `ROUND ${word}` })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    return st.json.sessionId as string
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ macSwitch: false, macHostExtra: ['    runs_sessions: true'], hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '' } })
    process.stdout.write(`host-judge-per-host-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    // A host's service starts its session side at its boot: once the copy names it, the next boot does.
    await waitFor(() => configCopy().includes('hosts_run_sessions'), 120_000, 'the copy-only row to reach the host').catch((err) => { throw new Error(say(String(err))) })
    if (!(await h.host('/facts?after=0')).running) {
      const old = await h.waitHostProbe()
      await h.c.restartReplica()
      await h.waitHostProbe(old.pid, 180_000)
    }
    await waitFor(judges, 120_000, 'the Mac to hand starts to the host').catch((err) => { throw new Error(say(String(err))) })
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`per-host: logs at ${writeClusterLogs(h.c, 'per-host')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('P1: the copy says the host is on in its own row, the host runs its session side, and a start there is host-judged', async () => {
    const copy = configCopy()
    expect(copy).toContain('hosts_run_sessions')
    expect(copy).not.toContain('"runs_sessions"')
    expect((await h.host('/facts?after=0')).running).toBe(true)
    hostSid = await start('host one')
    await waitFor(() => channelResult(hostSid, 'ROUND host one'), 120_000, 'the host-judged answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${hostSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 300_000)

  it('P2: runs_sessions false takes the next start back to the legacy path at once; the running session keeps answering', async () => {
    const off = await h.c.mac('PUT', '/api/config', { hosts: { [HOST_KEY]: { runs_sessions: false } } })
    expect(off.status, JSON.stringify(off.json)).toBe(200)
    await waitFor(async () => !(await judges()), 30_000, 'the Mac to stop handing starts to the host').catch((err) => { throw new Error(say(String(err))) })
    const legacy = await start('legacy two')
    await waitFor(() => hostStream(h.c, legacy).some((l) => l.type === 'result' && String(l.result).includes('ROUND legacy two')), 120_000, 'the legacy answer').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${legacy}`)).toEqual({ judge: 'legacy', host: null })
    const sent = await h.c.mac('POST', `/api/v1/sessions/${hostSid}/messages`, { text: 'AGAIN host one' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(() => channelResult(hostSid, 'AGAIN host one'), 120_000, 'the host-judged session to answer after its host went off').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${hostSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 400_000)

  it('P3: false wins over the experiment on; with the entry removed the host follows the experiment', async () => {
    expect((await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: true } })).status).toBe(200)
    // The write is read at once; a few seconds on it still says no for this host.
    await new Promise((r) => setTimeout(r, 3_000))
    expect(await judges()).toBe(false)
    expect((await h.c.mac('PUT', '/api/config', { hosts: { [HOST_KEY]: { runs_sessions: null } } })).status).toBe(200)
    await waitFor(judges, 30_000, 'the host to follow the experiment again').catch((err) => { throw new Error(say(String(err))) })
  }, 120_000)
})
