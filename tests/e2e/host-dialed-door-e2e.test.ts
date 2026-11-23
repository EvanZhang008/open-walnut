/**
 * A host-judged session over each way a leader links its host (deliverable 9; the third way, the
 * companion's listener, is tests/e2e/companion-host-listener-e2e.test.ts), and a host dialing its
 * leader's door (land 5a; src/core/session-channel/host-door.ts, host-dialer.ts), every piece a real
 * process: the cluster of tests/helpers/host-judge-cluster.ts (the Mac with the switch on; the
 * host's one Walnut service running its own sessions), the Mac's daemon link to the host through a
 * proxy the test cuts.
 *
 *   K1 dialed  over the link the Mac dials (its daemon link): a start, its stream, a send and an
 *              interrupt of a running turn, every fact once and in order
 *   D1 issue   with `session.host_door_urls` naming the Mac's door, the Mac issues the host its door
 *              credential over the daemon link; the host keeps it and dials the door, which takes
 *              the host's socket as its channel link (the leader-dialed one is replaced)
 *   D2 cut     the Mac's daemon link to the host is cut: a session started before keeps streaming
 *              its facts to the Mac over the dialed socket, every fact once and in order, and a
 *              send from the Mac reaches it over the socket's call frames
 *   D3 start   the daemon link still cut: a new start reaches the host over the dialed socket, its
 *              stream reaches the Mac, and an interrupt stops its running turn there
 *
 * Facts are compared by identity as in host-judged-session-cluster-e2e.test.ts: each record of
 * the host's log (seq order, its name and a hash of its data) against the Mac's bus events of the
 * channel.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { logSince, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'
import { channelClassOf } from '../../src/core/session-channel/event-classes.js'

const RUN = !!BUN && process.platform !== 'win32'
const hash = (d: unknown) => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex')

describe.skipIf(!RUN)('a host dials its leader\'s door, every piece a real process', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let sid = ''

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const hostFacts = async (): Promise<{ head: number; recs: HostFactRecord[] }> => h.host('/facts?after=0')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`

  /** Every fact of `s` in the host's log against the Mac's channel events of it, once the log is still and the Mac's cursor at its head. */
  async function sameFacts(s: string): Promise<{ host: string[]; seen: string[] }> {
    let last = -1
    let since = 0
    await waitFor(async () => {
      const head = (await hostFacts()).head
      if (head !== last) { last = head; since = Date.now(); return false }
      return Date.now() - since >= 1_000 && ((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= head
    }, 60_000, 'the host\'s log to be still and the Mac\'s cursor at its head', 200)
    const log = (await hostFacts()).recs.filter((r) => r.sid === s && channelClassOf(r.name) === 'fact')
    const mac = (await channelEvents(s)).filter((e) => channelClassOf(e.name) === 'fact')
    return {
      host: log.map((r) => `${r.name}:${r.refs ? 'cut' : hash(r.data).slice(0, 12)}`),
      seen: mac.map((e, i) => `${e.name}:${log[i]?.refs ? 'cut' : e.hash.slice(0, 12)}`),
    }
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ linkProxy: true })
    process.stdout.write(`host-dialed-door-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Host dialed run', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-dialed: logs at ${writeClusterLogs(h.c, 'host-dialed')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  /** A held turn of `s` (the mock CLI holds it until a file that never comes), stopped by the Mac's interrupt. */
  async function interruptHeld(s: string): Promise<void> {
    const gate = path.join(h.c.base, `never-released-${s}`)
    const sent = await h.c.mac('POST', `/api/v1/sessions/${s}/messages`, { text: `please hold until ${gate}` })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => ((await h.host(`/events?sid=${s}`)) as ProbeEvent[]).some((e) => e.name === 'session:send' && String(e.data?.message ?? '').includes(gate)), 60_000, 'the held turn to reach the host').catch((err) => { throw new Error(say(String(err))) })
    await waitFor(async () => (await h.host(`/row?sid=${s}`)).row?.process_status === 'running', 60_000, 'the held turn to run').catch((err) => { throw new Error(say(String(err))) })
    const stop = await h.c.mac('POST', `/api/v1/sessions/${s}/interrupt`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ status: 'interrupted', sessionId: s })
    await waitFor(async () => resultOn(await channelEvents(s), 'echo: interrupted'), 60_000, 'the held turn to end on the interrupt').catch((err) => { throw new Error(say(String(err))) })
    const onHost = (await h.host(`/events?sid=${s}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:interrupt'), JSON.stringify(onHost.map((e) => e.name))).toBe(true)
    expect(fs.existsSync(gate)).toBe(false)
  }

  it('K1: over the link the Mac dials, a start, its stream, a send and an interrupt each reach the host and every fact the Mac once', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel')
    // A session that runs on the host before anything about the door changes.
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND before' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND before'), 120_000, 'the first answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    expect((await h.mac(`/side?host=${HOST_KEY}`)).kind).toBe('leader-dialed')
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND leader dialed' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND leader dialed'), 120_000, 'the send\'s answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    await interruptHeld(sid)
    expect((await h.mac(`/side?host=${HOST_KEY}`)).kind).toBe('leader-dialed')
    const f = await sameFacts(sid)
    expect(f.seen, `host: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    expect(await h.mac(`/parses?sid=${sid}`)).toEqual({ parses: 0 })
  }, 400_000)

  it('D1: the Mac issues the host its door credential over the daemon link; the host dials the door, whose socket becomes the link', async () => {
    expect(sid).toBeTruthy()
    expect((await h.host('/dialer')).holds).toBe(false)

    // A door that is no allowed URL is refused by the settings write.
    const bad = await h.c.mac('PUT', '/api/config', { session: { host_door_urls: ['ws://203.0.113.7/host-door'] } })
    expect(bad.status, JSON.stringify(bad.json)).toBe(400)
    const door = `ws://127.0.0.1:${h.c.macPort}/host-door`
    const put = await h.c.mac('PUT', '/api/config', { session: { host_door_urls: [door] } })
    expect(put.status, JSON.stringify(put.json)).toBe(200)

    const dialer = await waitFor(async () => { const d = await h.host('/dialer'); return d.holds && d.linked ? d : null }, 120_000, 'the host to hold its credential and link the door').catch((err) => { throw new Error(say(String(err))) })
    expect(dialer.doors).toEqual([door])
    await waitFor(async () => (await h.mac(`/side?host=${HOST_KEY}`)).kind === 'host-dialed', 60_000, 'the Mac to take the host-dialed socket as the link')
    // The credential lives in the Mac's auth.json as a hash and a verify key; the token is in no Mac file.
    const auth = JSON.parse(fs.readFileSync(path.join(h.c.macData, 'auth.json'), 'utf8')) as { devices: Array<Record<string, unknown>> }
    const rec = auth.devices.find((d) => d.issuer === 'leader')
    expect(rec).toMatchObject({ kind: 'machine', issuer: 'leader', hostKey: HOST_KEY })
    expect(String(rec!.name)).toMatch(/^host-/)
    expect(rec).not.toHaveProperty('token')
  }, 400_000)

  it('D2: with the daemon link cut, the session keeps streaming its facts once and in order, and a send from the Mac reaches it over the dialed socket', async () => {
    expect(sid).toBeTruthy()
    // The cut is real: the host's daemon sees the Mac's link close, and the Mac's redials hang unanswered.
    const at = Date.now()
    h.c.cutLink()
    await waitFor(() => (logSince(h.c, at).some((l) => l.msg === 'client disconnected') ? true : null), 30_000, 'the host\'s daemon to see the Mac\'s link close')
    const side = await h.mac(`/side?host=${HOST_KEY}`)
    expect(side, JSON.stringify(side)).toMatchObject({ linked: true, kind: 'host-dialed' })

    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND dialed' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ROUND dialed'), 120_000, 'the answer of a send made with the daemon link cut').catch((err) => { throw new Error(say(String(err))) })
    // The send was taken on the host, by its own runner, with no daemon link to carry it.
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:send' && String(e.data?.message ?? '').includes('ROUND dialed')), JSON.stringify(onHost.map((e) => e.name))).toBe(true)
    // Still the dialed link (the proxy held every redial of the Mac's daemon link silent meanwhile).
    expect((await h.mac(`/side?host=${HOST_KEY}`)).kind).toBe('host-dialed')

    // Every fact of the session, before and after the switch of links and the cut: once, in order.
    const f = await sameFacts(sid)
    expect(f.seen, `host: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    expect(f.host.length).toBeGreaterThan(4)
  }, 400_000)

  it('D3: with the daemon link still cut, a new start reaches the host over the dialed socket, streams to the Mac, and an interrupt stops its turn', async () => {
    expect((await h.mac(`/side?host=${HOST_KEY}`)).kind).toBe('host-dialed')
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Started over the dialed socket', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'ROUND started dialed' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const s2 = st.json.sessionId as string
    await waitFor(async () => resultOn(await channelEvents(s2), 'echo: ROUND started dialed'), 120_000, 'the answer of a start made with the daemon link cut').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${s2}`)).toEqual({ judge: 'host', host: HOST_KEY })
    await interruptHeld(s2)
    expect((await h.mac(`/side?host=${HOST_KEY}`)).kind).toBe('host-dialed')
    for (const s of [sid, s2]) {
      const f = await sameFacts(s)
      expect(f.seen, `${s}\nhost: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    }
    expect(await h.mac(`/parses?sid=${s2}`)).toEqual({ parses: 0 })
    h.c.mendLink()
  }, 400_000)
})
