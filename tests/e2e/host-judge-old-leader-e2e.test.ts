/**
 * A straight downgrade of the leader made safe (src/core/session-channel/old-leader-watch.ts), every
 * piece a real process: the cluster of tests/helpers/host-judge-cluster.ts, with the host's bound
 * shortened (WALNUT_HOST_OLD_LEADER_MS, above the cluster's quiet window and the door's ping).
 *
 *   O1 old leader   a leader from before the session channel (WALNUT_LEADER_SESSION_CHANNELS=0, as in
 *                   host-judge-mixed-versions-e2e M2) answers its host and never opens the channel: the
 *                   host stands down, and a session it runs as its own (started through its door, as a
 *                   new leader had handed it) is judged by nobody there, its CLI answering still; the
 *                   leader's own legacy start and send work. Exactly one judge: the leader.
 *   O2 leader away  a new leader linked over the channel, then asleep (SIGSTOP) for three bounds: the
 *                   host never stands down and keeps judging its session, the feature's point; after
 *                   the wake it still judges.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type HostJudgeClusterOptions, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'
const OLD_LEADER_MS = 15_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function cluster(label: string, opts: HostJudgeClusterOptions) {
  const ctx = { h: null as unknown as HostJudgeCluster, hostCwd: '' }
  beforeAll(async () => {
    ctx.h = await startHostJudgeCluster({ ...opts, hostEnv: { WALNUT_HOST_OLD_LEADER_MS: String(OLD_LEADER_MS), ...(opts.hostEnv ?? {}) } })
    process.stdout.write(`host-judge-old-leader-e2e (${label}): cluster at ${ctx.h.c.base}\n`)
    ctx.hostCwd = fs.realpathSync(path.join(ctx.h.c.base, 'hh', 'work'))
  }, 900_000)
  afterEach(({ task }) => {
    if (ctx.h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`old-leader ${label}: logs at ${writeClusterLogs(ctx.h.c, `old-leader-${label}`)}\n`)
  })
  afterAll(async () => { await ctx.h?.stop() }, 120_000)
  return ctx
}

const say = (h: HostJudgeCluster, why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`

describe.skipIf(!RUN)('an older leader put in while the host runs sessions', () => {
  const ctx = cluster('old', { macSwitch: false, macEnv: { WALNUT_LEADER_SESSION_CHANNELS: '0' } })

  it('O1: the host stands down (exactly one judge, the leader), its own session\'s CLI keeps answering, the legacy path works', async () => {
    const { h, hostCwd } = ctx
    expect((await h.host('/facts?after=0')).running).toBe(true)
    await waitFor(async () => (await h.host('/judging')).standsDown, OLD_LEADER_MS + 60_000, 'the host to stand down').catch((err) => { throw new Error(say(h, String(err))) })
    const j = await h.host('/judging')
    expect(j).toMatchObject({ standsDown: true, watch: true, presence: 'answers', live: false })

    // A session the host runs as its own (as a new leader had handed it before the downgrade).
    const sid = crypto.randomUUID()
    const taskId = 'task-old-leader-own'
    const now = new Date().toISOString()
    const st = await h.door('POST', '/host-api/sessions/start', {
      taskId, message: 'OWN one', cwd: hostCwd, mode: 'bypass', preassignedSessionId: sid, project: 'Acme', attributed: true, attributionSource: 'test',
      startBundle: { task: { id: taskId, title: 'Own on the host', project: 'Acme', status: 'todo', phase: 'TODO', priority: 'none', source: 'local', created_at: now, updated_at: now, tags: [] }, sessionContext: { systemPrompt: 'You are a test session.' }, hintsApplied: true },
    })
    expect(st.json, JSON.stringify(st.json)).toMatchObject({ ok: true, sessionId: sid })
    await waitFor(async () => ((await h.host('/facts?after=0')).recs as HostFactRecord[]).some((r) => r.sid === sid && r.name === 'session:result'), 120_000, 'the own session to answer on the host').catch((err) => { throw new Error(say(h, String(err))) })
    expect((await h.host(`/row?sid=${sid}`)).row).toMatchObject({ judge: 'host', host: HOST_KEY })
    // Its row is the host's own, and the host judges it not: no resend member acts on it.
    expect(await h.host(`/judging?sid=${sid}`)).toMatchObject({ standsDown: true, judgedHere: false })

    // The leader's own path: a start and a send, judged by the leader from the CLI's lines.
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Old leader run', project: 'Acme' })
    const legacy = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND old' })
    expect(legacy.status, JSON.stringify(legacy.json)).toBe(202)
    const lsid = legacy.json.sessionId as string
    await waitFor(() => hostStream(h.c, lsid).some((l) => l.type === 'result' && String(l.result).includes('echo: ROUND old')), 120_000, 'the legacy answer').catch((err) => { throw new Error(say(h, String(err))) })
    expect(await h.mac(`/judge?sid=${lsid}`)).toEqual({ judge: 'legacy', host: null })
    expect((await h.mac(`/parses?sid=${lsid}`)).parses).toBeGreaterThan(0)
    // Still standing down: an older leader never opens the channel.
    expect((await h.host('/judging')).standsDown).toBe(true)
  }, 600_000)
})

describe.skipIf(!RUN)('a new leader that is merely away', () => {
  const ctx = cluster('away', {})

  it('O2: asleep for three bounds, the host keeps judging its session; after the wake too', async () => {
    const { h, hostCwd } = ctx
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return !!(s.linked && s.judges) }, 120_000, 'the Mac to link the host\'s session channel').catch((err) => { throw new Error(say(h, String(err))) })
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Away run', project: 'Acme' })
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND away' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(async () => ((await h.mac(`/events?sid=${sid}`)) as ProbeEvent[]).some((e) => e.source === 'host-channel' && e.name === 'session:result'), 120_000, 'the host-judged answer').catch((err) => { throw new Error(say(h, String(err))) })
    // Present and linked past the bound: nothing changes.
    await sleep(OLD_LEADER_MS + 5_000)
    expect(await h.host(`/judging?sid=${sid}`)).toMatchObject({ standsDown: false, judgedHere: true })

    h.c.sleepMac()
    try {
      await waitFor(async () => (await h.host('/judging')).presence !== 'answers', 60_000, 'the host to read its leader away')
      await sleep(3 * OLD_LEADER_MS)
      expect(await h.host(`/judging?sid=${sid}`)).toMatchObject({ standsDown: false, judgedHere: true })
    } finally {
      h.c.wakeMac()
    }
    await waitFor(async () => (await h.host('/judging')).live, 120_000, 'the Mac back on the channel').catch((err) => { throw new Error(say(h, String(err))) })
    expect(await h.host(`/judging?sid=${sid}`)).toMatchObject({ standsDown: false, judgedHere: true })
  }, 600_000)
})
