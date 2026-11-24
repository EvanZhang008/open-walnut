/**
 * A legacy session at rest is resumed by its host's own service (src/providers/host-resume.ts),
 * every piece a real process: the cluster of tests/helpers/host-judge-cluster.ts, whose Mac turns
 * its switch off and on while it runs.
 *
 *   L1 legacy   the switch off: four sessions start on devbox the legacy way (the Mac runs them
 *               through the host's daemon and parses their lines), answer, and are stopped
 *   L2 off      still off: a send to a stopped legacy session resumes it the legacy way, as before
 *   L3 on       the switch on: a send to the stopped legacy session goes to the host, whose service
 *               resumes the same CLI session (`--resume <id>`); the row is the host's (judge 'host'),
 *               the answer comes back once over the channel, and the Mac parses no line of it any more
 *   L4 refused  the host refuses the resume (its runner says it holds a live session of it, the probe):
 *               the send is delivered the legacy way, once, and the row stays the Mac's
 *   L6 lost     the resume's answer is lost though the host took it (the Mac probe's seam): a send in
 *               the window waits on the Mac (never sent, refused or parked), then every line goes to
 *               the host once its row comes; delivered once, the Mac parses none of it
 *   L7 dropped  the resume never reaches the host and no answer comes: nothing runs anywhere and the
 *               lines wait, the hand-over's mark on disk, until the lost check asks the host's runtime,
 *               hears no CLI runs there, and delivers here the legacy way, once
 *   L5 stays    the switch off again: the session the host resumed stays the host's
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { turnsWith, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'
import { hostJudgeSteps } from '../helpers/host-judge-steps.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a legacy session at rest is resumed by its host\'s service', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sidA = ''
  let sidB = ''
  let sidC = ''
  let sidD = ''

  const { fail, macEvents, channelEvents, resultsOn, macRow, parses, handover, cliArgs, setSwitch, send, stop, noRefusals, ...steps } = hostJudgeSteps(() => h)
  const startLegacy = (title: string, message: string) => steps.startLegacy(title, message, hostCwd)

  beforeAll(async () => {
    // A hand-over with no answer waits this long for the host's row (host-handover.ts), not 15 min.
    h = await startHostJudgeCluster({ macEnv: { WALNUT_HOST_START_LOST_MS: '15000' } })
    process.stdout.write(`host-judge-legacy-resume-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`legacy-resume: logs at ${writeClusterLogs(h.c, 'legacy-resume')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('L1: with the switch off, four sessions start the legacy way, answer and are stopped', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    await setSwitch(false)
    sidA = await startLegacy('Legacy A', 'ROUND a-one')
    sidB = await startLegacy('Legacy B', 'ROUND b-one')
    // C and D for the lost answers (L6, L7): B's refusal holds B legacy for a while.
    sidC = await startLegacy('Legacy C', 'ROUND c-one')
    sidD = await startLegacy('Legacy D', 'ROUND d-one')
    expect(await parses(sidA)).toBeGreaterThan(0)
    await stop(sidA)
    await stop(sidB)
    await stop(sidC)
    await stop(sidD)
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

  it('L6: the resume\'s answer is lost but the host took it; a send in the window waits, then every line goes to the host once', async () => {
    const before = await parses(sidC)
    expect((await h.mac('/lose-answer?mode=taken')).armed).toBe('taken')
    await send(sidC, 'ROUND c-lost')
    await waitFor(() => h.c.logs().mac.includes('host resume: no answer from the host; the session waits for its word'), 120_000, 'the resume whose answer was lost').catch(fail)
    await send(sidC, 'ROUND c-window')
    // The host's CLI answers it (it reaches the CLI in the resumed turn, mid-turn: its answer is the
    // CLI's, the channel's result is that turn's).
    await waitFor(() => turnsWith(h.c, sidC, 'ROUND c-window') > 0, 120_000, 'the line sent in the window, answered on the host').catch(fail)
    await untilFactsStill(h)
    expect(resultsOn(await channelEvents(sidC), 'echo: ROUND c-lost')).toHaveLength(1)
    expect(turnsWith(h.c, sidC, 'ROUND c-lost')).toBe(1)
    expect(turnsWith(h.c, sidC, 'ROUND c-window')).toBe(1)
    expect(cliArgs(sidC) ?? '', 'the resumed CLI').toContain(`--resume ${sidC}`)
    expect(await macRow(sidC)).toMatchObject({ judge: 'host', host: HOST_KEY })
    expect(await handover(sidC)).toEqual({ pending: false, onDisk: false })
    expect(await parses(sidC)).toBe(before)
    noRefusals()
  }, 300_000)

  it('L7: the resume never reached the host and no answer came; the lost check finds no CLI there and delivers here once', async () => {
    expect((await h.mac('/lose-answer?mode=dropped')).armed).toBe('dropped')
    await send(sidD, 'ROUND d-lost')
    await waitFor(async () => (await handover(sidD)).pending, 60_000, 'the unanswered hand-over').catch(fail)
    expect((await handover(sidD)).onDisk).toBe(true)
    await send(sidD, 'ROUND d-window')
    // The window: nothing of it runs on either side, its lines wait on the Mac.
    await new Promise((r) => setTimeout(r, 4_000))
    expect(turnsWith(h.c, sidD, 'ROUND d-lost')).toBe(0)
    expect(cliArgs(sidD)).toBeNull()
    expect(h.c.logs().mac).toContain('host-run session: its lines wait here until its host answers the hand-over')
    expect(await h.mac(`/judge?sid=${sidD}`)).toEqual({ judge: 'host', host: HOST_KEY })
    // The lost check (15 s here): the host's runtime runs no CLI of it, so it is the Mac's again.
    await waitFor(() => turnsWith(h.c, sidD, 'ROUND d-window') > 0, 120_000, 'the legacy delivery after the lost check').catch(fail)
    expect(h.c.logs().mac).toContain('host resume: the host never took a resume whose answer was lost; delivered here as legacy')
    expect((await macRow(sidD))?.judge).toBeUndefined()
    expect(await h.mac(`/judge?sid=${sidD}`)).toEqual({ judge: 'legacy', host: null })
    expect(await handover(sidD)).toEqual({ pending: false, onDisk: false })
    expect(cliArgs(sidD) ?? '').toContain(`--resume ${sidD}`)
    await new Promise((r) => setTimeout(r, 3_000))
    expect(turnsWith(h.c, sidD, 'ROUND d-lost')).toBe(1)
    expect(turnsWith(h.c, sidD, 'ROUND d-window')).toBe(1)
    expect(await channelEvents(sidD)).toEqual([])
    noRefusals()
  }, 300_000)

  it('L5: the switch off again, the session the host resumed stays the host\'s', async () => {
    await setSwitch(false)
    await send(sidA, 'ROUND a-after-off')
    await waitFor(async () => resultsOn(await channelEvents(sidA), 'echo: ROUND a-after-off').length > 0, 120_000, 'the host session to answer after the switch went off').catch(fail)
    expect(await h.mac(`/judge?sid=${sidA}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 200_000)
})
