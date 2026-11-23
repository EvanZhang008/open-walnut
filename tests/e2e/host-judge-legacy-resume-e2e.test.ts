/**
 * A legacy session at rest is resumed by its host's own service (src/providers/host-resume.ts),
 * every piece a real process: the cluster of tests/helpers/host-judge-cluster.ts, whose Mac turns
 * its switch off and on while it runs.
 *
 *   L1 legacy   the switch off: two sessions start on devbox the legacy way (the Mac runs them
 *               through the host's daemon and parses their lines), answer, and are stopped
 *   L2 off      still off: a send to a stopped legacy session resumes it the legacy way, as before
 *   L3 on       the switch on: a send to the stopped legacy session goes to the host, whose service
 *               resumes the same CLI session (`--resume <id>`); the row is the host's (judge 'host'),
 *               the answer comes back once over the channel, and the Mac parses no line of it any more
 *   L4 refused  the host refuses the resume (its runner says it holds a live session of it, the probe):
 *               the send is delivered the legacy way, once, and the row stays the Mac's
 *   L5 stays    the switch off again: the session the host resumed stays the host's
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { turnsWith, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a legacy session at rest is resumed by its host\'s service', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sidA = ''
  let sidB = ''

  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${s}`)) as ProbeEvent[]
  const channelEvents = async (s: string) => (await macEvents(s)).filter((e) => e.source === 'host-channel')
  const resultsOn = (events: ProbeEvent[], text: string) => events.filter((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-8000)}\n--- replica ---\n${h.c.logs().replica.slice(-8000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const macRow = async (s: string) => { const r = await h.c.mac('GET', `/api/sessions/${s}`); return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null }
  const parses = async (s: string): Promise<number> => (await h.mac(`/parses?sid=${s}`)).parses as number
  /** The live mock CLI of `sid` on this machine: its command line (null: none runs). */
  const cliArgs = (s: string): string | null => {
    let ps = ''
    try { ps = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }) } catch { return null }
    const mock = path.join(h.c.base, 'bin', 'mock-claude.cjs')
    return ps.split('\n').find((l) => l.includes(mock) && l.includes(s)) ?? null
  }
  const setSwitch = async (on: boolean) => {
    const r = await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: on } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    // Held for two seconds: a host report read just before the write can set the old value again for
    // a moment (leader-side.ts noteHost reads the switch too).
    let since = 0
    await waitFor(async () => {
      if ((await h.mac(`/side?host=${HOST_KEY}`)).judges !== on) { since = 0; return false }
      since ||= Date.now()
      return Date.now() - since >= 2_000
    }, 60_000, `the Mac to ${on ? 'hand' : 'stop handing'} starts to the host`, 200).catch(fail)
  }
  const send = async (s: string, text: string) => {
    const r = await h.c.mac('POST', `/api/v1/sessions/${s}/messages`, { text })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
  }
  const stop = async (s: string) => {
    const r = await h.c.mac('POST', `/api/v1/sessions/${s}/terminate`, { force: true })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    // At rest: stopped, no CLI of it on the machine, and the Mac's runner holds no live process of it.
    await waitFor(async () => (await macRow(s))?.process_status === 'stopped' && !cliArgs(s) && !(await h.mac(`/holds?sid=${s}`)).live, 60_000, `session ${s} to stop and its CLI to end`).catch(fail)
  }
  const startLegacy = async (title: string, message: string): Promise<string> => {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(() => turnsWith(h.c, sid, message) > 0, 120_000, `the legacy session ${title} to answer`).catch(fail)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'legacy', host: null })
    return sid
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judge-legacy-resume-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`legacy-resume: logs at ${writeClusterLogs(h.c, 'legacy-resume')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('L1: with the switch off, two sessions start the legacy way, answer and are stopped', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    await setSwitch(false)
    sidA = await startLegacy('Legacy A', 'ROUND a-one')
    sidB = await startLegacy('Legacy B', 'ROUND b-one')
    expect(await parses(sidA)).toBeGreaterThan(0)
    await stop(sidA)
    await stop(sidB)
  }, 400_000)

  it('L2: still off, a send to a stopped legacy session resumes it the legacy way', async () => {
    const before = await parses(sidA)
    await send(sidA, 'ROUND a-off')
    await waitFor(() => turnsWith(h.c, sidA, 'ROUND a-off') > 0, 120_000, 'the legacy resume to answer').catch(fail)
    expect((await macRow(sidA))?.judge).toBeUndefined()
    expect(await h.mac(`/judge?sid=${sidA}`)).toEqual({ judge: 'legacy', host: null })
    expect(await channelEvents(sidA)).toEqual([])
    // The Mac ran it: it parsed the resumed turn's lines.
    expect(await parses(sidA)).toBeGreaterThan(before)
    expect(h.c.logs().mac).not.toContain('host resume:')
    await stop(sidA)
  }, 300_000)

  it('L3: with the switch on, the host resumes the stopped legacy session; it is the host\'s and the Mac parses none of it', async () => {
    await setSwitch(true)
    const before = await parses(sidA)
    await send(sidA, 'ROUND a-host')
    await waitFor(async () => resultsOn(await channelEvents(sidA), 'echo: ROUND a-host').length > 0, 120_000, 'the resumed answer over the channel').catch(fail)
    // The same CLI session, resumed by the host's runtime.
    expect(cliArgs(sidA) ?? '', 'the resumed CLI').toContain(`--resume ${sidA}`)
    const rec = await macRow(sidA)
    expect(rec).toMatchObject({ claudeSessionId: sidA, judge: 'host', host: HOST_KEY })
    expect(await h.mac(`/judge?sid=${sidA}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect((await h.host(`/row?sid=${sidA}`)).row).toMatchObject({ claudeSessionId: sidA, judge: 'host' })
    // The send was the host's bus event, taken by the host's own runner.
    const onHost = (await h.host(`/events?sid=${sidA}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:send'), JSON.stringify(onHost.map((e) => e.name))).toBe(true)
    await untilFactsStill(h)
    // Delivered once: one turn on the host, one answer on the Mac, and no session:started for a resume.
    expect(turnsWith(h.c, sidA, 'ROUND a-host')).toBe(1)
    expect(resultsOn(await macEvents(sidA), 'echo: ROUND a-host')).toHaveLength(1)
    expect((await macEvents(sidA)).filter((e) => e.name === 'session:started' && e.source === 'host-channel')).toEqual([])
    expect(await parses(sidA)).toBe(before)
    // Its next send goes to the host as any host-judged session's.
    await send(sidA, 'ROUND a-next')
    await waitFor(async () => resultsOn(await channelEvents(sidA), 'echo: ROUND a-next').length > 0, 120_000, 'the next answer over the channel').catch(fail)
    expect(await parses(sidA)).toBe(before)
  }, 300_000)

  it('L4: the host refuses the resume; the send is delivered the legacy way, once', async () => {
    await h.host(`/hold-sid?sid=${sidB}&on=1`)
    try {
      await send(sidB, 'ROUND b-refused')
      await waitFor(() => turnsWith(h.c, sidB, 'ROUND b-refused') > 0, 120_000, 'the legacy resume after the refusal').catch(fail)
      expect(h.c.logs().mac).toMatch(/host resume: the host refused the resume; delivered here as legacy.*not at rest on this host/)
      expect((await macRow(sidB))?.judge).toBeUndefined()
      expect(await h.mac(`/judge?sid=${sidB}`)).toEqual({ judge: 'legacy', host: null })
      expect(cliArgs(sidB) ?? '').toContain(`--resume ${sidB}`)
      // Once: a moment later still one turn of it, and nothing of it on the channel.
      await new Promise((r) => setTimeout(r, 3_000))
      expect(turnsWith(h.c, sidB, 'ROUND b-refused')).toBe(1)
      expect(await channelEvents(sidB)).toEqual([])
    } finally {
      await h.host(`/hold-sid?sid=${sidB}&on=0`)
    }
  }, 300_000)

  it('L5: the switch off again, the session the host resumed stays the host\'s', async () => {
    await setSwitch(false)
    await send(sidA, 'ROUND a-after-off')
    await waitFor(async () => resultsOn(await channelEvents(sidA), 'echo: ROUND a-after-off').length > 0, 120_000, 'the host session to answer after the switch went off').catch(fail)
    expect(await h.mac(`/judge?sid=${sidA}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 200_000)
})
