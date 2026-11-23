/**
 * A restart of the host's service between two turns of a host-judged session (every leader deploy
 * restarts it), every piece a real process: the cluster of tests/helpers/host-judge-cluster.ts.
 *
 * Found by the release rehearsal (2026-11-23, scripts/release-rehearsal/host-judged-rollback.mjs):
 * after the restart, the host's runner attached to the live CLI again, its read of the session's
 * stream was refused (the daemon took the host server's own data dir, the home its start named, for
 * another Walnut), so it guessed from the task phase that the turn had been handled, and with no
 * watermark it dropped the next turn's result as a replay. The CLI answered; the leader never heard
 * the turn end, so the task phase, triage, notices and the queue never moved for it.
 *
 *   S1  a host-judged session answers its first turn; the task goes to the person on the Mac and on
 *       the host's own copy (the condition that made the guess say "handled")
 *   S2  the host's service restarts; a send's turn ends on the host once, its session:result is in
 *       the host's fact log once and reaches the Mac over the channel once, the Mac's task moves on,
 *       and the host read its own session's stream (no refused read, no replay suppression)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { turnsWith, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'
const AFTER = 'ROUND after the restart'
const HANDED_BACK = new Set(['NEED_ACTION', 'AWAIT', 'WAITING', 'COMPLETE'])

describe.skipIf(!RUN)('a host-judged session across a restart of its host\'s service', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sid = ''
  let taskId = ''

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const resultsWith = (events: ProbeEvent[], text: string) => events.filter((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-8000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const macPhase = async () => { const r = await h.c.mac('GET', `/api/tasks/${taskId}`); return String((r.json.task ?? r.json)?.phase ?? '') }
  const hostPhase = async () => String((await h.host(`/task?id=${taskId}`)).phase ?? '')
  /** The host server's own log lines (its run dir, JSON lines) of `s` from `from` on. */
  const hostServerLog = (s: string, from: number): string[] => {
    const run = path.join(path.dirname(h.c.replicaData), 'run')
    let names: string[] = []
    try { names = fs.readdirSync(run).filter((n) => /^open-walnut-.*\.log$/.test(n)) } catch { /* none yet */ }
    return names.flatMap((n) => fs.readFileSync(path.join(run, n), 'utf8').split('\n'))
      .filter((l) => l.includes(s) && Date.parse(String((() => { try { return JSON.parse(l).time } catch { return '' } })())) >= from)
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judge-service-restart-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`service-restart: logs at ${writeClusterLogs(h.c, 'service-restart')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('S1: a host-judged session answers, and its task waits on the person on the Mac and on the host', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Across a service restart', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND before the restart' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId
    await waitFor(async () => resultsWith(await channelEvents(sid), 'echo: ROUND before the restart').length > 0, 120_000, 'the first answer on the Mac').catch(fail)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    await waitFor(async () => HANDED_BACK.has(await macPhase()), 60_000, 'the Mac\'s task to wait on the person').catch(fail)
    // The host's own copy too: what the host's runner reads when it attaches again.
    await waitFor(async () => HANDED_BACK.has(await hostPhase()), 60_000, 'the host\'s copy of the task to wait on the person').catch(fail)
  }, 400_000)

  it('S2: after the restart, the next turn\'s end reaches the Mac exactly once, read from the stream, never dropped as a replay', async () => {
    const logFrom = Date.now()
    await h.c.restartReplica().catch(fail)
    await waitFor(async () => (await h.host('/judging')).live, 180_000, 'the Mac back on the restarted host\'s channel').catch(fail)
    expect(HANDED_BACK.has(await hostPhase()), 'the host\'s copy still reads the turn handled').toBe(true)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: AFTER })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultsWith(await channelEvents(sid), `echo: ${AFTER}`).length > 0, 120_000, 'the turn end after the restart on the Mac').catch(fail)
    await untilFactsStill(h).catch(fail)
    // Once on the host (one turn), once in its log, once on the Mac.
    expect(turnsWith(h.c, sid, AFTER), 'turns on the host').toBe(1)
    const recs = (await h.host('/facts?after=0')).recs as HostFactRecord[]
    expect(recs.filter((r) => r.sid === sid && r.name === 'session:result' && String(r.data?.result ?? '').includes(AFTER)), 'session:result in the host\'s log').toHaveLength(1)
    expect(resultsWith(await channelEvents(sid), `echo: ${AFTER}`), 'session:result on the Mac').toHaveLength(1)
    await waitFor(async () => HANDED_BACK.has(await macPhase()), 60_000, 'the Mac\'s task to move on with the turn').catch(fail)
    // The host read its own session's stream after the restart, and no result was swallowed.
    const since = hostServerLog(sid, logFrom)
    expect(since.length, 'the host server logged the session after the restart').toBeGreaterThan(0)
    expect(since.filter((l) => l.includes('suppressing replayed result')), 'replay suppression').toEqual([])
    // Its stream was read: a fold with no anchor may still leave the phase to judge, a refused read may not.
    expect(since.filter((l) => l.includes('falls back to phase proxy') && /"reason":"(no-stream-file|stream-stat-failed|stream-read-failed)"/.test(l)), 'its own stream unread').toEqual([])
  }, 500_000)
})
