/**
 * A host runs and judges its own sessions, every piece a real process
 * (docs/plan/one-service-every-host.md, phase 2): the cluster of tests/helpers/replica-cluster.ts
 * (a Mac server with its daemon, the host daemon twin, the replica that daemon supervises) with the
 * switch on at both ends (tests/helpers/host-judge-cluster.ts). The CLI is the cluster's mock
 * (tests/helpers/replica-mock-cli.cjs), run on the host by the replica's in-process runtime.
 *
 * In order, on one cluster:
 *   S1 start     a start on the Mac for a task on devbox goes to the host's service, which runs
 *                it; the Mac keeps the row (judge 'host', host devbox), hears session:started and
 *                session:result from the channel, links the task and moves it on; it parses no
 *                CLI line of that session
 *   S2 send      a message sent on the Mac reaches the host; its answer comes back as a fact
 *   S3 latency   each fact of a linked live turn is on the Mac's bus within 1000 ms of its append
 *                on the host
 *   S4 away      the Mac stopped past its quiet window: a send made on the host completes there;
 *                after the wake its facts arrive once, in order, late when older than lateMs
 *   S5 restart   the host's service restarted in the middle of a turn: the Mac resumes from its
 *                cursor, nothing lost, nothing twice
 *   S6 off       the switch off on the Mac: a new start on the same host takes the legacy path
 *   S7 tasks     through all of the above the host tried no task write of a session it runs (the
 *                Mac does their task side from the facts): no refused or failed write in its log
 *
 * Facts are compared by identity: each record of the host's log (seq order, its name and a hash
 * of its data) against the Mac's bus events of the channel (order of emit, the same two).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'
import { channelClassOf } from '../../src/core/session-channel/event-classes.js'

const RUN = !!BUN && process.platform !== 'win32'
/** The channel's default (channel.ts attachLeaderChannel lateMs). */
const LATE_MS = 60_000

const hash = (d: unknown) => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex')

describe.skipIf(!RUN)('a host runs and judges its sessions, every piece a real process', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let token = ''
  let taskId = ''
  let sid = ''

  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${s}`)) as ProbeEvent[]
  const channelEvents = async (s: string) => (await macEvents(s)).filter((e) => e.source === 'host-channel')
  const hostFacts = async (after = 0): Promise<{ head: number; logId: string; recs: HostFactRecord[] }> => h.host(`/facts?after=${after}`)
  /** The records of `s` the Mac re-emits on its bus (the fact class; rows and live state are applied, not emitted). */
  const factsOf = (recs: HostFactRecord[], s: string) => recs.filter((r) => r.sid === s && channelClassOf(r.name) === 'fact')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`

  /**
   * Every fact of `s` in the host's log against the Mac's channel events of it, whole session: the
   * same names and data in the same order (`seen` equals `host`) is each fact once and in order.
   * When they are equal, `log[i]` and `mac[i]` are the same fact on both ends.
   */
  async function sameFacts(s: string) {
    const log = factsOf((await hostFacts(0)).recs, s)
    const mac = (await channelEvents(s)).filter((e) => channelClassOf(e.name) === 'fact')
    const host = log.map((r) => `${r.name}:${r.refs ? 'cut' : hash(r.data).slice(0, 12)}`)
    const seen = mac.map((e, i) => `${e.name}:${log[i]?.refs ? 'cut' : e.hash.slice(0, 12)}`)
    return { log, mac, host, seen }
  }
  /** The host's log still for a second, and the Mac's cursor at its head: both ends hold the same records. */
  async function quiet(): Promise<void> {
    let last = -1
    let since = 0
    await waitFor(async () => {
      const head = (await hostFacts(0)).head
      if (head !== last) { last = head; since = Date.now(); return false }
      return Date.now() - since >= 1_000 && ((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= head
    }, 60_000, 'the host\'s log to be still and the Mac\'s cursor at its head', 200)
  }
  /** The Mac's copy of each fact after `afterSeq`, the two ends asserted equal first. */
  async function factsAfter(s: string, afterSeq: number) {
    await quiet()
    const f = await sameFacts(s)
    expect(f.seen, `host: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    return f.log.map((r, i) => ({ r, e: f.mac[i]! })).filter((x) => x.r.seq > afterSeq)
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ twin: 'source' })
    process.stdout.write(`host-judged-session-cluster-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    token = await h.c.pairDevice('marina-phone')
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Host judged run', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)

  // A failed step keeps the cluster's logs; HOST_JUDGED_KEEP_LOGS=1 keeps them for every step (to read the host's warnings).
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged: logs at ${writeClusterLogs(h.c, 'host-judged')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('S1: a start on the Mac for devbox runs on the host; the Mac keeps the row, hears its facts, links the task and parses no line', async () => {
    // The host's service names session-judge-v1 and the Mac's channel to it is linked.
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel')
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    expect(sid).toBeTruthy()
    const events = await waitFor(async () => { const e = await channelEvents(sid); return resultOn(e, 'echo: ROUND one') ? e : null }, 120_000, 'the answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    // session:started is the Mac's own for a start it handed on (its runner says it for its own starts too); the rest are the host's facts.
    const started = (await macEvents(sid)).filter((e) => e.name === 'session:started')
    expect(started, JSON.stringify(started)).toHaveLength(1)
    expect(started[0]!.data).toMatchObject({ sessionId: sid, taskId, host: HOST_KEY })
    const names = events.map((e) => e.name)
    const hostNames = ((await h.host(`/events?sid=${sid}`)) as ProbeEvent[]).map((e) => `${e.name}(${e.source})`)
    const logNames = (await hostFacts(0)).recs.filter((r) => r.sid === sid).map((r) => r.name)
    expect(names, `mac: ${names.join(', ')}\nhost bus: ${hostNames.join(', ')}\nhost log: ${logNames.join(', ')}`).toContain('session:result')
    expect(started[0]!.at).toBeLessThanOrEqual(resultOn(events, 'echo: ROUND one')!.at)
    // The row: the host's, as the channel applied it.
    const row = await h.c.mac('GET', `/api/sessions/${sid}`)
    expect(row.status, JSON.stringify(row.json)).toBe(200)
    const rec = (row.json.session ?? row.json) as Record<string, unknown>
    expect(rec).toMatchObject({ claudeSessionId: sid, judge: 'host', host: HOST_KEY, taskId })
    expect((await h.mac(`/judge?sid=${sid}`))).toEqual({ judge: 'host', host: HOST_KEY })
    // The task: linked to the session and moved on from TODO by the Mac.
    const task = await waitFor(async () => {
      const r = await h.c.mac('GET', `/api/tasks/${taskId}`)
      const tk = r.json.task ?? r.json
      return JSON.stringify(tk).includes(sid) && tk.phase !== 'TODO' ? tk : null
    }, 30_000, 'the task to be linked and moved on')
    expect(JSON.stringify(task)).toContain(sid)
    // Run on the host: its stream is in the replica's runtime, never in the host daemon's dir.
    expect(hostStream(h.c, sid)).toEqual([])
    // Parsed on the host only.
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
  }, 300_000)

  it('S2: a second message sent on the Mac reaches the host, and its answer comes back as a fact', async () => {
    expect(sid).toBeTruthy()
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND two' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND two'), 120_000, 'the second answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    // The send was the host's bus event, taken by the host's own runner.
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:send' && String(e.data?.message ?? '').includes('ROUND two')), JSON.stringify(onHost.map((e) => e.name))).toBe(true)
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
  }, 180_000)

  it('S3: while linked, each fact of a live turn is on the Mac\'s bus within 1000 ms of its append on the host', async () => {
    const before = (await hostFacts(0)).head
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND latency' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND latency'), 60_000, 'the latency turn on the Mac')
    const pairs = await factsAfter(sid, before)
    expect(pairs.length).toBeGreaterThan(2)
    const gaps = pairs.map(({ r, e }) => ({ name: r.name, ms: e.at - r.at }))
    process.stdout.write(`host-judged S3 gaps (ms): ${JSON.stringify(gaps)}\n`)
    for (const g of gaps) expect(g.ms, `${g.name} took ${g.ms} ms`).toBeLessThan(1000)
  }, 120_000)

  it('S4: with the Mac stopped past its quiet window, a send made on the host completes there; after the wake its facts arrive once, in order, late when older than lateMs', async () => {
    const before = (await hostFacts(0)).head
    h.c.sleepMac()
    try {
      await h.c.waitAway(token)
      // The host's own route, as a person on the host would reach it while the Mac is away (a person's
      // source: the line goes in as typed; any other source's line is framed as Walnut's there).
      const sent = await h.door('POST', '/host-api/sessions/send', { sessionId: sid, taskId, message: 'ROUND away', busSource: 'ui' })
      expect(sent.json, JSON.stringify(sent.json)).toEqual({ ok: true })
      await waitFor(async () => resultOn((await h.host(`/events?sid=${sid}`)) as ProbeEvent[], 'echo: ROUND away'), 60_000, 'the away turn to complete on the host')
      const away = factsOf((await hostFacts(before)).recs, sid)
      expect(away.some((r) => r.name === 'session:result')).toBe(true)
      // Away past lateMs: what the Mac reads back then is late.
      const newest = Math.max(...away.map((r) => r.at))
      await waitFor(() => Date.now() - newest > LATE_MS + 3_000, LATE_MS + 60_000, 'the away records to age past lateMs', 1_000)
    } finally {
      if (h.c.asleep()) h.c.wakeMac()
    }
    const woke = Date.now()
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND away'), 120_000, 'the away answer on the Mac after the wake').catch((err) => { throw new Error(say(String(err))) })
    // Once each, in the host's order (the whole session: the turns before the stop too).
    const pairs = await factsAfter(sid, before)
    // The away turn's facts came after the wake; late exactly when older than lateMs at their apply.
    const away = pairs.filter(({ e }) => e.at >= woke - 50)
    expect(away.some(({ r }) => r.name === 'session:result')).toBe(true)
    const marks = away.map(({ r, e }) => ({ name: r.name, ageMs: e.at - r.at, late: e.late }))
    process.stdout.write(`host-judged S4 marks: ${JSON.stringify(marks)}\n`)
    for (const m of marks) expect(m.late, `${m.name} applied ${m.ageMs} ms after it happened`).toBe(m.ageMs > LATE_MS)
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
  }, 400_000)

  it('S5: the host\'s service restarted in the middle of a turn: the Mac resumes from its cursor, nothing lost and nothing twice', async () => {
    const gate = path.join(h.c.base, 'gate-s5')
    const before = (await hostFacts(0)).head
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: `please hold until ${gate}` })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    // The turn runs on the host (its line went in) before the restart.
    await waitFor(async () => factsOf((await hostFacts(before)).recs, sid).length > 0, 60_000, 'the held turn to start on the host')
    const old = await h.waitHostProbe()
    await h.c.restartReplica()
    await h.waitHostProbe(old.pid, 180_000)
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges }, 120_000, 'the Mac to link the restarted host again')
    fs.writeFileSync(gate, 'go')
    await waitFor(async () => resultOn(await channelEvents(sid), `echo: released ${gate}`), 180_000, 'the held turn\'s answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    const pairs = await factsAfter(sid, before)
    expect(pairs.some(({ r }) => r.name === 'session:result' && String(r.data?.result ?? '').includes('released'))).toBe(true)
  }, 600_000)

  it('S6: the switch off on the Mac: a new start on the same host takes the legacy path; the session the host already runs still reports', async () => {
    const off = await h.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: false } })
    expect(off.status, JSON.stringify(off.json)).toBe(200)
    await waitFor(async () => !(await h.mac(`/side?host=${HOST_KEY}`)).judges, 30_000, 'the Mac to stop handing starts to the host')
    expect((await h.mac(`/side?host=${HOST_KEY}`)).linked).toBe(true)
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Legacy run after the switch', project: 'Acme' })
    expect(t.status).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND legacy' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const legacySid = st.json.sessionId as string
    // Run by the host daemon for the Mac, as before: its stream is in the daemon's dir.
    await waitFor(() => hostStream(h.c, legacySid).some((l) => l.type === 'result' && String(l.result).includes('ROUND legacy')), 120_000, 'the legacy session to answer').catch((err) => { throw new Error(say(String(err))) })
    const row = await h.c.mac('GET', `/api/sessions/${legacySid}`)
    const rec = (row.json.session ?? row.json) as Record<string, unknown>
    expect(rec).toMatchObject({ claudeSessionId: legacySid, host: HOST_KEY })
    expect(rec.judge).toBeUndefined()
    expect(await h.mac(`/judge?sid=${legacySid}`)).toEqual({ judge: 'legacy', host: null })
    expect((await channelEvents(legacySid))).toEqual([])
    // The session the host already runs keeps going there.
    const again = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND after off' })
    expect(again.status, JSON.stringify(again.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND after off'), 120_000, 'the host session to answer after the switch went off')
  }, 300_000)

  it('S7: the host tried no task write of a session it runs: no refused or failed one in its whole log', () => {
    const tried = h.c.logs({ whole: true }).replica.split('\n').filter((l) => TASK_WRITE_TRIED.test(l)).map((l) => l.slice(0, 300))
    expect(tried).toEqual([])
  })
})

/** A task write the host made or tried for one of its sessions, as its log says it (the store is a read-only copy there). */
const TASK_WRITE_TRIED = /readonly database|phase update (failed|FAILED)|failed to (link session|update task phase|clear session|apply session)|session_links_on_leader|task_writes_need_mac|no_caller_session|linking it to its task failed/
