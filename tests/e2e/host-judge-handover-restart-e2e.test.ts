/**
 * A restart inside the window of a hand-over whose answer is not known yet (src/providers/host-handover.ts
 * "window", "restart"; the resume of a legacy session at rest, host-resume.ts), every piece a real
 * process: the cluster of tests/helpers/host-judge-cluster.ts. In both cases the host got the resume and
 * holds it unacted on (its probe's /hold-start), so the Mac has sent it and heard nothing, and a second
 * line is sent in the window. The in-process window is host-judge-legacy-resume-e2e.test.ts L6 and L7.
 *
 *   W1 legacy        the switch off: two sessions start on devbox the legacy way, answer, and are
 *                    stopped; then the switch on
 *   W2 the Mac       the Mac (the leader) restarts while its mark stands: the restarted leader reads the
 *                    mark back from disk and arms its lost check again, its boot delivers nothing of the
 *                    session here (processNext gated while the hand-over waits), and its first link to
 *                    the host redelivers the waiting lines into the wait, not to the host; then the host
 *                    acts on the resume, its row reaches the restarted Mac and clears the mark, and both
 *                    lines are delivered on the host exactly once
 *   W3 the host      the host's service restarts while it holds the resume, which dies with it: the Mac
 *                    gets no answer (the window stays open), the service's new link redelivers into the
 *                    wait, and the lost check finds the session neither owned nor running there and
 *                    delivers both lines here, the legacy way, exactly once
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { turnsWith, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostJudgeCluster, type LeaderAgain } from '../helpers/host-judge-cluster.js'
import { hostJudgeSteps } from '../helpers/host-judge-steps.js'

const RUN = !!BUN && process.platform !== 'win32'
/** The lost check's wait (host-handover.ts lostStartMs): long enough for W2's window, short for W3's verdict. */
const LOST_MS = 30_000
const WAITS = 'host-run session: its lines wait here until its host answers the hand-over'

describe.skipIf(!RUN)('a restart inside a hand-over\'s window', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sidE = ''
  let sidF = ''

  const { fail, channelEvents, resultsOn, macRow, parses, handover, cliArgs, setSwitch, send, stop, noRefusals, ...steps } = hostJudgeSteps(() => h)
  const macQueue = async (s: string) => (await h.mac(`/queue?sid=${s}`)) as Array<{ id: string; status: string; message: string }>
  const pendingOn = async (s: string) => (await macQueue(s)).filter((m) => m.status === 'pending').map((m) => m.message)
  const hold = async (on?: 0 | 1) => (await h.host(`/hold-start${on === undefined ? '' : `?on=${on}`}`)) as { on: boolean; held: number; waiting: number }

  /** The resume of `s` is out: the host holds it unacted on, the Mac's mark stands, and a second line waits on the Mac. */
  const openWindow = async (s: string, first: string, second: string) => {
    expect((await hold(1)).on).toBe(true)
    const held = (await hold()).held
    await send(s, first)
    await waitFor(async () => (await hold()).held > held, 120_000, 'the resume to reach the host and be held there').catch(fail)
    expect(await handover(s)).toEqual({ pending: true, onDisk: true })
    await send(s, second)
    await waitFor(async () => (await pendingOn(s)).length === 2, 60_000, 'both lines pending on the Mac').catch(fail)
    expect(await pendingOn(s)).toEqual([first, second])
    expect(turnsWith(h.c, s, first)).toBe(0)
    expect(cliArgs(s)).toBeNull()
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ macEnv: { WALNUT_HOST_START_LOST_MS: String(LOST_MS) } })
    process.stdout.write(`host-judge-handover-restart-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (!h || (task.result?.state !== 'fail' && process.env.HOST_JUDGED_KEEP_LOGS !== '1')) return
    const out = writeClusterLogs(h.c, 'handover-restart')
    // The cluster's log names its first Mac only: every leader's, the restarted ones too.
    fs.appendFileSync(out, `--- every Mac leader ---\n${h.macLog()}\n`)
    process.stdout.write(`handover-restart: logs at ${out}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('W1: with the switch off, two sessions start the legacy way, answer and are stopped', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    await setSwitch(false)
    sidE = await steps.startLegacy('Window E', 'ROUND e-one', hostCwd)
    sidF = await steps.startLegacy('Window F', 'ROUND f-one', hostCwd)
    await stop(sidE)
    await stop(sidF)
    await setSwitch(true)
  }, 400_000)

  it('W2: the Mac restarts while the mark stands; the host\'s row clears it on the restarted Mac and each line runs once on the host', async () => {
    await openWindow(sidE, 'ROUND e-lost', 'ROUND e-window')
    let again: LeaderAgain | null = null
    try {
      again = await h.restartMac()
      const log = again.log
      await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked }, 120_000, 'the restarted Mac to link the host\'s session channel').catch(fail)
      // The mark came back from disk and its lost check is armed again; the session is the host's.
      expect(await handover(sidE)).toEqual({ pending: true, onDisk: true })
      expect(await h.mac(`/judge?sid=${sidE}`)).toEqual({ judge: 'host', host: HOST_KEY })
      await waitFor(() => log().includes('host hand-over: hand-overs unanswered before this leader restarted wait for their host again'), 60_000, 'the boot to arm the hand-over again').catch(fail)
      // The first link's redelivery found both lines and let them wait (never sent, never refused).
      await waitFor(() => log().includes('host-run sessions: lines that waited for their host go to it now') && log().includes(WAITS), 60_000, 'the first link\'s redelivery into the wait').catch(fail)
      expect(await pendingOn(sidE)).toEqual(['ROUND e-lost', 'ROUND e-window'])
      expect(turnsWith(h.c, sidE, 'ROUND e-lost')).toBe(0)
      expect(cliArgs(sidE)).toBeNull()
      expect(await parses(sidE)).toBe(0)
      expect(log()).not.toContain('delivered here as legacy')
      noRefusals()
    } finally {
      // The host acts on the resume it held now: its row goes to the restarted Mac.
      await hold(0)
    }
    await waitFor(() => turnsWith(h.c, sidE, 'ROUND e-window') > 0, 120_000, 'the line sent in the window, answered on the host').catch(fail)
    await waitFor(async () => (await handover(sidE)).pending === false, 60_000, 'the host\'s row to clear the mark').catch(fail)
    await waitFor(async () => (await pendingOn(sidE)).length === 0, 60_000, 'no line of it left on the Mac').catch(fail)
    await untilFactsStill(h).catch(fail)
    // Once each, on the host; the restarted Mac parsed none of it and holds no mark.
    expect(turnsWith(h.c, sidE, 'ROUND e-lost')).toBe(1)
    expect(turnsWith(h.c, sidE, 'ROUND e-window')).toBe(1)
    expect(resultsOn(await channelEvents(sidE), 'echo: ROUND e-lost'), 'the resumed turn\'s answer over the channel').toHaveLength(1)
    expect(cliArgs(sidE) ?? '', 'the resumed CLI').toContain(`--resume ${sidE}`)
    expect(await macRow(sidE)).toMatchObject({ judge: 'host', host: HOST_KEY })
    expect(await handover(sidE)).toEqual({ pending: false, onDisk: false })
    expect(await parses(sidE)).toBe(0)
    expect(again!.log()).not.toContain('delivered here as legacy')
    noRefusals()
  }, 400_000)

  it('W3: the host\'s service restarts while it holds the resume; the lost check delivers each line here once', async () => {
    await openWindow(sidF, 'ROUND f-lost', 'ROUND f-window')
    const from = h.macLog().length
    const since = () => h.macLog().slice(from)
    // The held resume dies with the service; its next start has no hold.
    await h.c.restartReplica().catch(fail)
    await waitFor(() => since().includes('host resume: no answer from the host; the session waits for its word'), 120_000, 'the Mac to hear no answer to the resume').catch(fail)
    await waitFor(async () => (await h.host('/judging')).live, 180_000, 'the Mac back on the restarted host\'s channel').catch(fail)
    // The new link's redelivery lets the lines wait: the window holds across the host's restart.
    await waitFor(() => since().includes('host-run sessions: lines that waited for their host go to it now') && since().includes(WAITS), 60_000, 'the new link\'s redelivery into the wait').catch(fail)
    expect(await handover(sidF)).toEqual({ pending: true, onDisk: true })
    expect(turnsWith(h.c, sidF, 'ROUND f-lost')).toBe(0)
    // The lost check: the restarted host does not own the session and runs no CLI of it.
    await waitFor(() => turnsWith(h.c, sidF, 'ROUND f-window') > 0, 180_000, 'the legacy delivery after the lost check').catch(fail)
    await waitFor(async () => (await pendingOn(sidF)).length === 0, 60_000, 'no line of it left on the Mac').catch(fail)
    expect(since()).toContain('host resume: the host never took a resume whose answer was lost; delivered here as legacy')
    expect((await macRow(sidF))?.judge).toBeUndefined()
    expect(await h.mac(`/judge?sid=${sidF}`)).toEqual({ judge: 'legacy', host: null })
    expect(await handover(sidF)).toEqual({ pending: false, onDisk: false })
    expect(cliArgs(sidF) ?? '').toContain(`--resume ${sidF}`)
    expect(turnsWith(h.c, sidF, 'ROUND f-lost')).toBe(1)
    expect(turnsWith(h.c, sidF, 'ROUND f-window')).toBe(1)
    expect(await channelEvents(sidF)).toEqual([])
    noRefusals()
  }, 400_000)
})
