/**
 * One host, its leader moving from A to B (deliverable 13: "the channel works whoever dials", and a
 * new leader resumes from its cursor), every piece a real process: the cluster of
 * tests/helpers/host-judge-cluster.ts is A (the Mac: its daemon link to the host through a proxy
 * the test cuts), and B is a standby leader of the same Walnut booted over a copy of A's data made
 * while A was stopped (tests/helpers/standby-leader.ts): A's auth.json (the same Walnut id, the
 * host's door credential record) and A's sessions store (the channel cursor). B has no link to the
 * host's daemon: the host reaches it only by dialing its door. The two leaders' permit numbers are
 * A 1 and B 2 (WALNUT_CLUSTER_PERMIT_NUMBER), as the leader switch's permit system numbers them.
 *
 *   T1 on A     a host-judged session runs; with `session.host_door_urls` naming A's door then
 *               B's, the host holds its credential and dials A's door
 *   T2 A stops  A's link cut and A stopped (its socket open and silent): a turn made on the host
 *               itself goes into its log; B boots over a copy of A's data, the host leaves A's
 *               silent door (no pong) and dials B's, and B resumes from the cursor it copied
 *   T3 on B     B has every fact after its copied cursor once and in order (the gap's turn
 *               included), A had every one up to it (and past it at most what the host wrote to
 *               A's silent socket before leaving it, never one made after B booted), and a send
 *               from B reaches the session
 *   T4 A back   A woken, its daemon link mended: its resume carries (1, e), below the (2, e')
 *               the host saw, and is refused (stale permit): A's cursor does not move and A hears
 *               none of B's turns, while B keeps the host
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from '../../src/lib/sqlite.js'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { factIds, isHostFact, seenAsFacts, startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'
import { copyLeaderData, freePort, type StandbyLeader } from '../helpers/standby-leader.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a host\'s leader moves from A to a standby B over a copy of A\'s data', () => {
  let h: HostJudgeCluster
  let b: { leader: StandbyLeader; probe(p: string): Promise<any> } | null = null
  let hostCwd = ''
  let taskId = ''
  let sid = ''
  let portB = 0
  let copied = 0
  /** The host's head before B boots: every fact the host could have sent A's socket before it left A's door. */
  let headBeforeB = 0

  const eventsOn = async (read: (p: string) => Promise<any>, s: string) => ((await read(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel' && isHostFact(e.name))
  const hostFacts = async (): Promise<{ head: number; permitPair: { permitNumber: number; epoch: number }; recs: HostFactRecord[] }> => h.host('/facts?after=0')
  const resultIn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- A ---\n${h.c.logs().mac.slice(-5000)}\n--- B ---\n${b?.leader.log().slice(-5000) ?? ''}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }

  beforeAll(async () => {
    portB = await freePort()
    h = await startHostJudgeCluster({ linkProxy: true, macEnv: { WALNUT_CLUSTER_PERMIT_NUMBER: '1' }, hostEnv: { WALNUT_HOST_DOOR_PING_MS: '1000' } })
    process.stdout.write(`host-judge-leader-move-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Leader moves under it', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) {
      const file = writeClusterLogs(h.c, 'leader-move')
      fs.appendFileSync(file, `--- B ---\n${b?.leader.log() ?? ''}\n`)
      process.stdout.write(`leader-move: logs at ${file}\n`)
    }
  })
  afterAll(async () => { await h?.stop() }, 180_000)

  it('T1: on A, a host-judged session runs, and the host holds its credential and dials A\'s door', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'A to link the host\'s session channel').catch(fail)
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND on A' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await waitFor(async () => resultIn(await eventsOn(h.mac, sid), 'echo: ROUND on A'), 120_000, 'the first answer on A').catch(fail)
    const doors = [`ws://127.0.0.1:${h.c.macPort}/host-door`, `ws://127.0.0.1:${portB}/host-door`]
    const put = await h.c.mac('PUT', '/api/config', { session: { host_door_urls: doors } })
    expect(put.status, JSON.stringify(put.json)).toBe(200)
    await waitFor(async () => { const d = await h.host('/dialer'); return d.holds && d.linked ? d : null }, 120_000, 'the host to hold its credential and link A\'s door').catch(fail)
    await waitFor(async () => (await h.mac(`/side?host=${HOST_KEY}`)).kind === 'host-dialed', 60_000, 'A to take the dialed socket').catch(fail)
    expect((await h.host('/dialer')).doors).toEqual(doors)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND dialed A' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultIn(await eventsOn(h.mac, sid), 'echo: ROUND dialed A'), 120_000, 'the dialed send\'s answer on A').catch(fail)
    expect((await hostFacts()).permitPair).toMatchObject({ permitNumber: 1 })
  }, 400_000)

  it('T2: A stops; a turn made on the host meanwhile; B over a copy of A\'s data takes the host from its copied cursor', async () => {
    h.c.cutLink()
    h.c.sleepMac()
    // A standby's copy: A's data as A left it (its cursor of this host among it).
    const dataB = path.join(h.c.base, 'mb', 'data')
    copyLeaderData(h.c.macData, dataB)
    const db = new Database(path.join(dataB, 'sessions.sqlite'), { fileMustExist: true })
    try { copied = (db.prepare('SELECT seq FROM session_channel_cursor WHERE host_id = ?').get(HOST_KEY) as { seq: number } | undefined)?.seq ?? 0 } finally { db.close() }
    expect(copied).toBeGreaterThan(0)
    // A turn on the host while no leader reads it: it waits in the host's log.
    const gap = await h.door('POST', '/host-api/sessions/send', { sessionId: sid, taskId, message: 'ROUND gap', busSource: 'ui' })
    expect(gap.json, JSON.stringify(gap.json)).toEqual({ ok: true })
    await waitFor(async () => resultIn((await h.host(`/events?sid=${sid}`)) as ProbeEvent[], 'echo: ROUND gap'), 60_000, 'the gap\'s turn to complete on the host').catch(fail)
    headBeforeB = (await hostFacts()).head
    b = await h.standby({ data: dataB, port: portB, env: { WALNUT_CLUSTER_PERMIT_NUMBER: '2' } })
    expect(b.leader.port).toBe(portB)
    // The host leaves A's silent door and links B's.
    await waitFor(async () => { const s = await b!.probe(`/side?host=${HOST_KEY}`); return s.linked && s.kind === 'host-dialed' }, 180_000, 'the host to link B\'s door').catch(fail)
    await waitFor(async () => (await hostFacts()).permitPair.permitNumber === 2, 60_000, 'the host to hold B\'s standing').catch(fail)
  }, 400_000)

  it('T3: B has every fact after its copied cursor once and in order, A every one up to it, and a send from B reaches the session', async () => {
    const sent = await b!.leader.call('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND on B' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultIn(await eventsOn(b!.probe, sid), 'echo: ROUND on B'), 120_000, 'the answer of B\'s send on B').catch(fail)
    await waitFor(async () => ((await b!.probe(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= (await hostFacts()).head, 60_000, 'B\'s cursor at the host\'s head').catch(fail)
    const all = (await hostFacts()).recs.filter((r) => r.sid === sid && isHostFact(r.name))
    const before = all.filter((r) => r.seq <= copied)
    const after = all.filter((r) => r.seq > copied)
    const onB = await eventsOn(b!.probe, sid)
    expect(seenAsFacts(onB, after), `host: ${factIds(after).join(' ')}`).toEqual(factIds(after))
    expect(resultIn(onB, 'echo: ROUND gap'), 'the gap\'s turn reached B').toBeTruthy()
    // A's part, read once A runs again and has read its old dialed socket to its close: every fact
    // up to its copied cursor once and in order. Past it, only what the host wrote to that socket
    // before its ping found A silent (the gap's turn, on a loaded host: frames A reads on waking),
    // all of it made before B booted; none of B's turns.
    h.c.wakeMac()
    await waitFor(async () => (await h.mac(`/side?host=${HOST_KEY}`)).kind !== 'host-dialed', 60_000, 'A to read its old socket to its close').catch(fail)
    const onA = await eventsOn(h.mac, sid)
    const sentA = all.filter((r) => r.seq <= headBeforeB).slice(0, onA.length)
    expect(onA.length, `A heard ${onA.length}, ${before.length} up to its copy, ${all.filter((r) => r.seq <= headBeforeB).length} before B`).toBeGreaterThanOrEqual(before.length)
    expect(seenAsFacts(onA, sentA), `host: ${factIds(sentA).join(' ')}`).toEqual(factIds(sentA))
    expect(onA.length).toBeLessThanOrEqual(all.filter((r) => r.seq <= headBeforeB).length)
    expect(before.length + after.length).toBe(all.length)
  }, 400_000)

  it('T4: A back with a lower standing is refused: its cursor stays, it hears none of B\'s turns, and B keeps the host', async () => {
    const cursorA = (await h.mac(`/cursor?host=${HOST_KEY}`)).cursor
    h.c.mendLink()
    // A's daemon link is back, and its leader side tries the host again over it.
    await waitFor(async () => (await h.mac(`/link?host=${HOST_KEY}`)).connected, 120_000, 'A\'s daemon link to come back').catch(fail)
    const sent = await b!.leader.call('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND B again' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultIn(await eventsOn(b!.probe, sid), 'echo: ROUND B again'), 120_000, 'B\'s second send answered on B').catch(fail)
    // Several of A's redials (its backoff starts at a second).
    await new Promise((r) => setTimeout(r, 10_000))
    expect((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor).toEqual(cursorA)
    const onA = await eventsOn(h.mac, sid)
    expect(resultIn(onA, 'echo: ROUND on B')).toBeUndefined()
    expect(resultIn(onA, 'echo: ROUND B again')).toBeUndefined()
    expect(await b!.probe(`/side?host=${HOST_KEY}`)).toMatchObject({ linked: true, kind: 'host-dialed' })
    expect((await hostFacts()).permitPair).toMatchObject({ permitNumber: 2 })
  }, 400_000)
})
