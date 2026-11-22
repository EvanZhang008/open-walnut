/**
 * The Mac leaves in the middle of a same-host send's hand-off, end to end, every piece a real
 * process (tests/helpers/replica-cluster.ts), the Mac's link to the host daemon run through a TCP
 * proxy the test closes for real (`linkProxy`: the daemon sees the socket close, the Mac's redials
 * hang unanswered until it is mended), with `host_call_entry` on, so the host daemon hands a send
 * between two of its sessions to its own Walnut server while the Mac answers (follower-gateway-core.ts
 * handOff, `online`) after it claimed the message id (offline-host-core.ts openOnline).
 *
 *   cut 1      after the claim, before the follower delivers: the follower is SIGSTOPped before the
 *              send, the daemon logs the hand-off, the link is cut, the follower resumes and delivers
 *   cut 1, late  the same, and the follower stays stopped past the hand-off's time: the daemon ends
 *              the hand-off with no leader to relay to, then the follower resumes
 *   cut 2      after the delivery, before the acks: the Mac SIGSTOPped too (so it drains nothing; still
 *              the leader within its quiet window), the stopped follower is stepped a few ms at a time
 *              until the daemon has written the delivery while the caller is still unanswered, then the
 *              link is cut and the Mac woken; the hand-off ends (its timer, or the follower's socket
 *              dropped) and answers from the claim's write, relaying nothing
 *   ask        cut 1 for a send asking a reply: one request on the Mac, and B's reply, once
 *
 * Each ends with the message in B's stream once, one delivery record in the host's journal while the
 * Mac is cut off (acked once it is back and drained, then compacted away), B's transcript on the Mac
 * holding it once, and the Mac's request rows as asked; a second cut and return changes nothing.
 *
 * Twins: as tests/e2e/replica-cluster-e2e.test.ts (REPLICA_CLUSTER_TWINS picks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, sleep, startReplicaCluster, waitFor, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'
import {
  deliveries, delivered, gatewayCall, hostJournal, keepLogsOnFailure, logSince, replicaKnowsDefaultHost, turnsWith, userRowsWith, type GatewayAnswer,
} from '../helpers/replica-cluster-reads.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const HANDED = 'gateway: handed to this host\'s Walnut server'
const UNANSWERED = 'gateway: this host\'s Walnut server did not answer a same-host send, relayed to the leader'
const show = (label: string, v: unknown) => process.stdout.write(`replica-cluster-handoff-cut-e2e: ${label} ${JSON.stringify(v).slice(0, 1500)}\n`)
const okOf = (r: GatewayAnswer, what: string) => { expect(r.ok, `${what}: ${JSON.stringify(r).slice(0, 2000)}`).toBe(true); return r.result as Record<string, any> }

/** The host journal's delivery records of message `mid` (the Mac acks them once drained, and a compaction then drops them). */
const recordsOf = (c: ReplicaCluster, mid: string) => hostJournal(c).filter((r) => r.kind === 'delivery' && r.messageId === mid)

/** The seqs the Mac acked in the host's journal (its `{ack:[...]}` lines, until a compaction). */
function ackedSeqs(c: ReplicaCluster): Set<number> {
  const dir = path.join(c.base, 'hd', 'offline-host')
  const out = new Set<number>()
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => /^journal-.*\.ndjson$/.test(n)) } catch { return out }
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      try { const o = JSON.parse(line) as { ack?: unknown }; if (Array.isArray(o.ack)) for (const s of o.ack) if (typeof s === 'number') out.add(s) } catch { /* partial */ }
    }
  }
  return out
}

/** The Mac's request rows (session-requests.json), read on disk. */
function macRequests(c: ReplicaCluster): Array<Record<string, any>> {
  try { return (JSON.parse(fs.readFileSync(path.join(c.macData, 'session-requests.json'), 'utf8')) as { requests?: Array<Record<string, any>> }).requests ?? [] } catch { return [] }
}

describe.each(TWINS)('the Mac leaves mid hand-off of a same-host send (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let hostCwd = ''
  const a = { task: '', sid: '' }
  const b = { task: '', sid: '' }
  /** Every message the cases sent: its words, its id, whether it asked a reply. */
  const sent: Array<{ case: string; text: string; mid: string; requestId?: string }> = []

  async function startSession(title: string, words: string): Promise<{ task: string; sid: string }> {
    const made = await c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const st = await c.mac('POST', `/api/v1/tasks/${made.json.task.id}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: words })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(() => turnsWith(c, sid, words) > 0, 120_000, `${title} to answer`)
    return { task: made.json.task.id as string, sid }
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ twin, linkProxy: true, macConfigExtra: ['experimental:', '  host_call_entry: true'] })
    process.stdout.write(`replica-cluster-handoff-cut-e2e: ${twin} cluster at ${c.base}\n`)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: 'devbox', default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    // The experiment reaches the follower in its config copy; it says it takes online sends at its next report (5 s).
    await waitFor(() => { try { return fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'config.json'), 'utf8').includes('host_call_entry') } catch { return false } }, 120_000, 'the experiment in the follower\'s config copy')
    await sleep(12_000)
    Object.assign(a, await startSession('Cut caller', 'hello caller'))
    Object.assign(b, await startSession('Cut target', 'hello target'))
    await waitFor(() => { const h = (c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {}; return h[a.sid] && h[b.sid] ? true : null }, 120_000, 'the copies to hold both sessions')
    await waitFor(() => (replicaKnowsDefaultHost(c, 'Acme', 'devbox') ? true : null), 60_000, 'the follower\'s copy to hold the project\'s default host')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  /** A send from A to B by the gateway socket, the follower paused first, resolved once the daemon handed it over. */
  async function sendHandedToPausedFollower(text: string, ask: boolean): Promise<{ call: Promise<GatewayAnswer>; settled: () => boolean; from: number; seqMark: number }> {
    const seqMark = hostJournal(c).reduce((m, r) => Math.max(m, r.seq as number), 0)
    c.pauseReplica()
    const from = Date.now()
    let done = false
    const call = gatewayCall(c, a.sid, 'task_send', { to: b.task, text, expect_reply: ask }).finally(() => { done = true })
    await waitFor(() => (logSince(c, from).some((l) => l.msg === HANDED && l.op === 'task_send' && l.callerSid === a.sid) ? true : null), 20_000, 'the daemon to hand the send over')
    expect(deliveries(c, b.sid, text), 'nothing delivered while the follower is stopped').toBe(0)
    expect(done, 'the caller waits on the follower').toBe(false)
    return { call, settled: () => done, from, seqMark }
  }

  /** Cut the Mac's link and wait for the daemon to see it close. */
  async function cut(): Promise<number> {
    const at = Date.now()
    c.cutLink()
    await waitFor(() => (logSince(c, at).some((l) => l.msg === 'client disconnected') ? true : null), 15_000, 'the daemon to see the Mac\'s link close')
    return at
  }

  /** A case starts with the link up and the Mac back (an earlier case that failed may have left it cut). */
  async function ensureBack(): Promise<void> {
    if (c.asleep()) c.wakeMac()
    c.mendLink()
    await c.waitBack(token, 120_000)
  }

  /** One delivery record of `mid` in the host's journal, kept for the Mac while it is cut off. */
  async function oneRecord(mid: string): Promise<void> {
    await waitFor(() => (recordsOf(c, mid).length > 0 ? true : null), 15_000, `the delivery record of ${mid}`)
    expect(recordsOf(c, mid), `the delivery records of ${mid}`).toHaveLength(1)
  }

  /** Mend the link; the Mac redials, takes the host back and drains it (each delivery record of `mids` acked, or compacted away). */
  async function mendAndDrain(mids: string[]): Promise<void> {
    c.mendLink()
    await c.waitBack(token, 120_000)
    await waitFor(() => {
      const acked = ackedSeqs(c)
      return hostJournal(c).filter((r) => r.kind === 'delivery' && mids.includes(String(r.messageId))).every((r) => acked.has(r.seq as number)) ? true : null
    }, 120_000, 'the Mac to drain the host\'s delivery records').catch((e: Error) => {
      e.message += ` (journal ${JSON.stringify(hostJournal(c).slice(-12).map((r) => [r.seq, r.kind, r.messageId, r.online]))}, acked ${[...ackedSeqs(c)].slice(-20)})`
      throw e
    })
  }

  /** What the host and the Mac hold of one message, counted. */
  async function holdsOf(m: { text: string; mid: string; requestId?: string }): Promise<Record<string, unknown>> {
    const transcript = await c.mac('GET', `/api/v1/sessions/${b.sid}/transcript?fresh=1`)
    const rows = macRequests(c)
    return {
      stream: deliveries(c, b.sid, m.text),
      macTranscript: userRowsWith(transcript.json, m.text),
      macRequests: rows.filter((r) => r.fromSessionId === a.sid && JSON.stringify(r).includes(m.text.slice(0, 40))).length,
      ...(m.requestId ? { request: rows.filter((r) => r.id === m.requestId).map((r) => r.status) } : {}),
    }
  }

  /** Each message: once in B's stream, once in the Mac's transcript of B, its request rows as asked. */
  async function expectOnce(m: { case: string; text: string; mid: string; requestId?: string }, requestStatus?: string): Promise<Record<string, unknown>> {
    const want = { stream: 1, macTranscript: 1, macRequests: m.requestId ? 1 : 0, ...(m.requestId ? { request: [requestStatus] } : {}) }
    let seen: Record<string, unknown> = {}
    await waitFor(async () => { seen = await holdsOf(m); return JSON.stringify(seen) === JSON.stringify(want) ? true : null }, 60_000, `${m.case}: the message once`)
      .catch((e: Error) => { e.message += ` (holds ${JSON.stringify(seen)}, want ${JSON.stringify(want)})`; throw e })
    show(`${m.case} holds`, seen)
    return seen
  }

  it('with the link up, a same-host send is the follower\'s (online)', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    const from = Date.now()
    const text = 'warm up note for the target'
    okOf(await gatewayCall(c, a.sid, 'task_send', { to: b.task, text, expect_reply: false }), 'online send')
    await waitFor(() => delivered(c, b.sid, text), 60_000, 'the online send to reach B')
    expect(logSince(c, from).some((l) => l.msg === HANDED && l.op === 'task_send' && l.callerSid === a.sid), 'the follower took it').toBe(true)
  }, 300_000)

  it('cut 1: the link drops after the claim, before the follower delivers; it delivers once', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    await ensureBack()
    const text = 'cut one note: the venue list moved'
    let paused = true
    try {
      const h = await sendHandedToPausedFollower(text, false)
      await cut()
      c.resumeReplica()
      paused = false
      const r = okOf(await h.call, 'cut 1 send')
      show('cut 1 answer', r)
      expect(String(r.messageId ?? '')).toMatch(/^qm-/)
      sent.push({ case: 'cut 1', text, mid: String(r.messageId) })
      await waitFor(() => delivered(c, b.sid, text), 60_000, 'the message to reach B')
      await oneRecord(String(r.messageId))
      show('cut 1 daemon lines', logSince(c, h.from).filter((l) => /gateway|follower/.test(String(l.msg))).map((l) => l.msg))
    } finally { if (paused) c.resumeReplica() }
    await mendAndDrain([sent.at(-1)!.mid])
    await expectOnce(sent.at(-1)!)
  }, 600_000)

  it('cut 1, late: the follower stays stopped past the hand-off\'s time with the Mac gone; the message is still delivered once', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    await ensureBack()
    const text = 'cut one late note: the caterer called'
    let paused = true
    let answer: GatewayAnswer | null = null
    try {
      const h = await sendHandedToPausedFollower(text, false)
      await cut()
      answer = await h.call
      show('cut 1 late answer', answer)
      show('cut 1 late daemon lines', logSince(c, h.from).filter((l) => /gateway|follower|offline host/.test(String(l.msg))).map((l) => [l.msg, l.why ?? l.code ?? '']))
      c.resumeReplica()
      paused = false
    } finally { if (paused) c.resumeReplica() }
    const r = okOf(answer!, 'cut 1 late send')
    sent.push({ case: 'cut 1 late', text, mid: String(r.messageId) })
    await waitFor(() => delivered(c, b.sid, text), 60_000, 'the message to reach B')
    await oneRecord(String(r.messageId))
    await mendAndDrain([sent.at(-1)!.mid])
    await expectOnce(sent.at(-1)!)
  }, 600_000)

  it('cut 2: the link drops after the delivery, before the follower\'s answer and the Mac\'s drain; the hand-off answers from the claim, once', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    await ensureBack()
    let reached = false
    // A step can let the follower both deliver and answer; that try is a plain send, checked once
    // like the rest, and the cut is tried again with new words.
    for (let attempt = 1; attempt <= 3 && !reached; attempt++) {
      const text = `cut two note ${attempt}: the tables are booked`
      let paused = true
      // The Mac stopped too (still the leader within its quiet window, so the send is handed over
      // online), so it cannot drain the delivery before the cut: neither the follower's answer nor
      // the Mac's ack of the record comes before the link drops.
      c.sleepMac()
      let macStopped = true
      try {
        const h = await sendHandedToPausedFollower(text, false)
        const deliveredHere = () => hostJournal(c).some((r) => (r.seq as number) > h.seqMark && r.kind === 'delivery' && r.toSessionId === b.sid)
        const steps = await c.stepReplica({ sliceMs: 3, gapMs: 25, maxSteps: 400, until: () => deliveredHere() || h.settled() })
        reached = deliveredHere() && !h.settled()
        show(`cut 2 attempt ${attempt}`, { steps, delivered: deliveredHere(), settled: h.settled() })
        if (reached) {
          expect(delivered(c, b.sid, text), 'the daemon wrote it into B').toBe(true)
          const cutAt = await cut()
          c.wakeMac()
          macStopped = false
          const r = okOf(await h.call, 'cut 2 send')
          show('cut 2 answer', r)
          const lines = logSince(c, cutAt)
          show('cut 2 daemon lines', lines.filter((l) => /gateway|follower|offline host/.test(String(l.msg))).map((l) => [l.msg, l.why ?? '']))
          expect(lines.some((l) => l.msg === UNANSWERED), 'the hand-off ended unanswered').toBe(true)
          expect(lines.filter((l) => l.msg === 'gateway: relaying to primary server'), 'nothing relayed').toHaveLength(0)
          await oneRecord(String(r.messageId))
          sent.push({ case: 'cut 2', text, mid: String(r.messageId) })
        } else {
          c.resumeReplica()
          paused = false
          c.wakeMac()
          macStopped = false
          const r = okOf(await h.call, 'cut 2 send, missed')
          sent.push({ case: `cut 2 missed ${attempt}`, text, mid: String(r.messageId) })
          await waitFor(() => delivered(c, b.sid, text), 60_000, 'the message to reach B')
          continue
        }
        c.resumeReplica()
        paused = false
      } finally {
        if (paused) c.resumeReplica()
        if (macStopped) c.wakeMac()
      }
    }
    expect(reached, 'the follower was stopped between the delivery and its answer').toBe(true)
    // The follower's late answer is stale: B still holds it once.
    await sleep(3_000)
    await mendAndDrain(sent.filter((m) => m.case.startsWith('cut 2')).map((m) => m.mid))
    for (const m of sent.filter((x) => x.case.startsWith('cut 2'))) await expectOnce(m)
  }, 900_000)

  it('ask: the link drops after the claim of a send asking a reply; one request on the Mac, and one reply', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    await ensureBack()
    const gate = path.join(hostCwd, 'gate-ask')
    const text = `cut ask: please check the seating please hold until ${gate}`
    let paused = true
    try {
      const h = await sendHandedToPausedFollower(text, true)
      await cut()
      c.resumeReplica()
      paused = false
      const r = okOf(await h.call, 'ask send')
      show('ask answer', r)
      const requestId = String(r.requestId ?? r.request_id ?? '')
      expect(requestId, 'it asks a reply').toMatch(/^rq-[a-f0-9]{6,}$/)
      sent.push({ case: 'ask', text, mid: String(r.messageId), requestId })
      await waitFor(() => delivered(c, b.sid, text), 60_000, 'the ask to reach B')
      await oneRecord(String(r.messageId))
    } finally { if (paused) c.resumeReplica() }
    const m = sent.at(-1)!
    await mendAndDrain([m.mid])
    await expectOnce(m, 'pending')
    // B answers with the Mac back: replied once, A reads it once.
    const reply = 'the seating is checked'
    okOf(await gatewayCall(c, b.sid, 'task_send', { to: a.task, in_reply_to: m.requestId, text: reply, result: 'Checked.' }), 'the reply')
    await waitFor(() => (macRequests(c).find((x) => x.id === m.requestId)?.status === 'replied' ? true : null), 60_000, 'the request replied on the Mac')
    await waitFor(() => delivered(c, a.sid, reply), 60_000, 'the reply to reach A')
    fs.writeFileSync(gate, '')
    await waitFor(() => turnsWith(c, b.sid, `released ${gate}`) > 0, 60_000, 'B\'s turn on the ask to end')
    expect(deliveries(c, a.sid, reply)).toBe(1)
    await expectOnce(m, 'replied')
  }, 600_000)

  it('a second cut and return changes nothing', async () => {
    keepLogsOnFailure(() => c, `handoff-cut-${twin}`)
    await ensureBack()
    expect(sent.length).toBeGreaterThanOrEqual(4)
    const status = (m: (typeof sent)[number]) => (m.requestId ? 'replied' : undefined)
    const before = await Promise.all(sent.map((m) => holdsOf(m)))
    for (const [i, m] of sent.entries()) expect(before[i], m.case).toMatchObject({ stream: 1, macTranscript: 1, ...(m.requestId ? { request: [status(m)] } : {}) })
    await cut()
    await sleep(3_000)
    await mendAndDrain(sent.map((m) => m.mid))
    await sleep(5_000)
    expect(await Promise.all(sent.map((m) => holdsOf(m)))).toEqual(before)
    expect(deliveries(c, a.sid, 'the seating is checked')).toBe(1)
  }, 600_000)
})
