/**
 * A leader and a host of different versions (deliverable 11), every piece a real process: the
 * cluster of tests/helpers/host-judge-cluster.ts, once per mix.
 *
 *   M1 old host    a new leader (its switch on) and a host whose service does not run its sessions,
 *                  as one from before the switch: the host's switch forced off
 *                  (WALNUT_HOST_RUNS_SESSIONS=0), so it names no session-judge-v1 and serves no
 *                  session route. A start on the leader takes the legacy path (the leader runs it
 *                  through the host's daemon and parses its lines) and works, a send too; nothing
 *                  is issued to the host and nothing goes over a channel.
 *   M2 old leader  a new host (its switch on) and a leader from before the session channel
 *                  (WALNUT_LEADER_SESSION_CHANNELS=0, its switch off): the leader never calls the
 *                  host's session routes and knows no judge 'host'. The host runs nothing on its own
 *                  (its fact log holds no record of the leader's session, its runner raised no event
 *                  of it), and the legacy path works: a start and a send, answered.
 *
 * Neither mix runs a real older release (scripts/release-rehearsal installs one from the registry,
 * with no host service): the older side is the new code with its part of this feature turned off,
 * which is what an older side of it answers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type HostJudgeClusterOptions, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

/** One cluster of a mix, and the reads both mixes make of it. */
function mix(label: string, opts: HostJudgeClusterOptions) {
  const ctx = { h: null as unknown as HostJudgeCluster, hostCwd: '' }
  beforeAll(async () => {
    ctx.h = await startHostJudgeCluster(opts)
    process.stdout.write(`host-judge-mixed-versions-e2e (${label}): cluster at ${ctx.h.c.base}\n`)
    ctx.hostCwd = fs.realpathSync(path.join(ctx.h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (ctx.h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`mixed ${label}: logs at ${writeClusterLogs(ctx.h.c, `mixed-${label}`)}\n`)
  })
  afterAll(async () => { await ctx.h?.stop() }, 120_000)
  return ctx
}

/** A start on the leader for a task on the host, answered through the host's daemon (its stream file there), then a send. */
async function legacyRun(h: HostJudgeCluster, hostCwd: string, word: string): Promise<string> {
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const t = await h.c.mac('POST', '/api/tasks', { title: `Mixed run ${word}`, project: 'Acme' })
  expect(t.status, JSON.stringify(t.json)).toBe(201)
  const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: `ROUND ${word}` })
  expect(st.status, JSON.stringify(st.json)).toBe(202)
  const sid = st.json.sessionId as string
  const answered = (text: string) => hostStream(h.c, sid).some((l) => l.type === 'result' && String(l.result).includes(text))
  await waitFor(() => answered(`echo: ROUND ${word}`), 120_000, 'the legacy start to answer').catch((err) => { throw new Error(say(String(err))) })
  const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: `AGAIN ${word}` })
  expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
  await waitFor(() => answered(`echo: AGAIN ${word}`), 120_000, 'the legacy send to answer').catch((err) => { throw new Error(say(String(err))) })
  // The leader's own judgement: its row has no judge, it parsed the CLI's lines, and no channel spoke of it.
  const row = await h.c.mac('GET', `/api/sessions/${sid}`)
  const rec = (row.json.session ?? row.json) as Record<string, unknown>
  expect(rec).toMatchObject({ claudeSessionId: sid, host: HOST_KEY })
  expect(rec.judge).toBeUndefined()
  expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'legacy', host: null })
  expect((await h.mac(`/parses?sid=${sid}`)).parses).toBeGreaterThan(0)
  expect(((await h.mac(`/events?sid=${sid}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')).toEqual([])
  return sid
}

describe.skipIf(!RUN)('a new leader and an older host', () => {
  const ctx = mix('old-host', { hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '0' } })

  it('M1: the host names no session-judge-v1, so a start takes the legacy path and works; nothing is issued and nothing rides a channel', async () => {
    const { h, hostCwd } = ctx
    // The host's service runs no session side (no fact log, no routes, no dialer) and the leader's side is on.
    expect(await h.host('/facts?after=0')).toEqual({ running: false })
    await waitFor(async () => (await h.mac(`/link?host=${HOST_KEY}`)).connected, 60_000, 'the Mac\'s link to the host')
    const side = await h.mac(`/side?host=${HOST_KEY}`)
    expect(side).toMatchObject({ active: true, linked: false, judges: false })
    // A route the leader would call on a new host answers as an old one does: no session side here.
    const door = await h.door('POST', '/host-api/sessions/send', { sessionId: 'x', message: 'x' })
    expect(door.status).not.toBe(200)
    await legacyRun(h, hostCwd, 'old host')
    expect(await h.host('/dialer')).toEqual({ linked: false, holds: false, doors: [] })
    const auth = JSON.parse(fs.readFileSync(path.join(h.c.macData, 'auth.json'), 'utf8')) as { devices: Array<Record<string, unknown>> }
    expect(auth.devices.filter((d) => d.issuer === 'leader')).toEqual([])
  }, 600_000)
})

describe.skipIf(!RUN)('an older leader and a new host', () => {
  const ctx = mix('old-leader', { macSwitch: false, macEnv: { WALNUT_LEADER_SESSION_CHANNELS: '0' } })

  it('M2: the leader never calls the host\'s session routes; the host runs nothing on its own and the legacy path works', async () => {
    const { h, hostCwd } = ctx
    // The host's side is up (its switch on), the leader's is not there at all.
    const facts0 = (await h.host('/facts?after=0')) as { running: boolean; head: number }
    expect(facts0.running).toBe(true)
    expect((await h.mac(`/side?host=${HOST_KEY}`)).active).toBe(false)
    const sid = await legacyRun(h, hostCwd, 'old leader')
    // The host's runner did nothing of it: no record in its log, no event of its own runner, its copy of the row the leader's.
    const facts = (await h.host('/facts?after=0')) as { running: boolean; recs: HostFactRecord[] }
    expect(facts.recs.filter((r) => r.sid === sid)).toEqual([])
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.filter((e) => e.name === 'session:started' || e.name === 'session:result' || e.name === 'session:send').map((e) => e.name)).toEqual([])
    const row = (await h.host(`/row?sid=${sid}`)).row as Record<string, unknown> | null
    if (row) expect(row.judge).toBeUndefined()
    // No credential reached the host (an older leader issues none), so it dials no door.
    expect(await h.host('/dialer')).toEqual({ linked: false, holds: false, doors: [] })
  }, 600_000)
})
