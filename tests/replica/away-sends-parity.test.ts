/**
 * A message from a host's own `walnut` call answered by the host's Walnut server
 * (replica/away-sends.ts, away-replies.ts) writes what the host daemon's own answer writes for
 * the same call (offline-host-core.ts opTaskSend / opReply / holdWrite, and handleLocal while the
 * Mac answers): the same journal records (`row`, `settle`, `delivery`, a held `op`) and the same
 * words into the session, so the Mac's drain takes either the same way. Both run over one copy
 * (two daemons, two journals): the daemon's path through `handle`, the follower's through its
 * route and a `follower.peer` that reaches the real daemon core. Online, the follower leaves
 * exactly the calls handleLocal leaves (needs_leader `server_delivers`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { cleanupJournalDirs, JHOME, journalHost, journalTmpDir, jslice, SID_A, SID_B, TASK_A, TASK_B } from '../helpers/offline-journal-harness.js'
import { createOfflineHost, type HostSlice, type OfflineHostDeps } from '../../src/providers/offline-host-core.js'
import { awaySends, type AwaySendsDeps } from '../../src/replica/away-sends.js'
import type { ReplicaWrite } from '../../src/replica/dispatch.js'
import type { WritePort } from '../../src/replica/write-port.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { writeOpId } from '../../src/lib/op-call-id.js'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const SID_C = 'cccccccc-3333-4333-8333-333333333333'
const SID_D = 'dddddddd-4444-4444-8444-444444444444'
const TASK_C = 'mtaskccc-0003'
const TASK_D = 'mtaskddd-0004'
const CALL = 'oc-0123456789abcdef'

afterEach(() => cleanupJournalDirs())

function slice(over: Partial<HostSlice> = {}): HostSlice {
  const base = jslice()
  return {
    ...base,
    sessions: [...base.sessions, { sid: SID_C, taskId: TASK_C, title: 'Stopped' }, { sid: SID_D, taskId: TASK_D, title: 'Another worker' }],
    tasks: [
      ...base.tasks,
      { id: TASK_C, title: 'Stopped', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
      { id: TASK_D, title: 'Another worker', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
    ],
    ...over,
  }
}

/** One daemon over its own journal; `live` and `prompts` are the CLI facts only it knows. */
function daemon(s: HostSlice) {
  const clock = { now: T0 }
  const h = journalHost(journalTmpDir(), clock, { drains: [...JOURNAL_V2_DRAINS, 'held-op'] })
  const delivered: Array<{ sid: string; text: string; messageId: string }> = []
  const live = new Set([SID_A, SID_B, SID_D])
  const prompts = new Map<string, string>()
  const deps: OfflineHostDeps = {
    ...h.deps,
    isLive: (sid) => live.has(sid),
    pendingPrompt: (sid) => prompts.get(sid) ?? null,
    streamOffset: (sid) => (sid === SID_B ? 4096 : undefined),
    turnActive: (sid) => sid === SID_B,
    deliver: async (sid, text, messageId) => { delivered.push({ sid, text, messageId }); return { ok: true } },
  }
  const host = createOfflineHost(deps)
  host.configure(s)
  return { host, journal: h.journal, delivered, live, prompts, clock }
}

type Daemon = ReturnType<typeof daemon>

/** The follower's route over the same copy, its `follower.peer` and reads going to daemon `d`. */
function follower(d: Daemon, s: HostSlice, o: { online?: boolean } = {}) {
  const peers: Array<Record<string, unknown>> = []
  const tasks = () => s.tasks as unknown as Array<Record<string, unknown> & { id: string }>
  const deps: AwaySendsDeps = {
    port: {} as WritePort,
    actorOf: (req) => ({ kind: 'session', sid: String((req as unknown as { sid: string }).sid) }),
    task: async (id) => tasks().find((t) => t.id === id) ?? null,
    findTask: async (ref) => {
      const exact = tasks().find((t) => t.id === ref)
      if (exact) return { task: exact }
      const hits = ref.length >= 4 ? tasks().filter((t) => t.id.startsWith(ref)) : []
      return hits.length === 1 ? { task: hits[0] } : hits.length > 1 ? { ambiguous: true } : {}
    },
    session: async (sid) => {
      const r = s.sessions.find((x) => x.sid === sid)
      return r ? { title: r.title, taskId: r.taskId, ...(r.acp ? { acp: true } : {}) } : null
    },
    requestCopy: async (id) => (s.requests.find((r) => r.id === id) as unknown as Record<string, unknown>) ?? null,
    // The parent chain (the daemon's reportsUp): these fixtures have no Main or VP.
    goesUp: async (from, to) => {
      for (let t = tasks().find((x) => x.id === from); t?.parent_task_id; t = tasks().find((x) => x.id === t!.parent_task_id)) if (t.parent_task_id === to) return true
      return false
    },
    retiredLead: async () => null,
    hostKey: 'devbox',
    capabilities: () => ['journal-v2', 'follower-gateway-v1', 'follower-peer-v1'],
    request: async (cmd) => {
      if (cmd === 'follower.pending') return d.host.pendingFor(JHOME, 0) as unknown as Record<string, unknown>
      const v = d.host.sessionsOf(JHOME)!
      return { host: v.host, sessions: v.sessions.map((x) => ({ ...x, state: d.live.has(x.sid) ? 'idle' : 'stopped' })) }
    },
    leaderAnswers: () => o.online === true,
    frame: async (t) => t,
    sessionsOfTask: async () => [],
    log: () => {},
  }
  const handler = awaySends(deps)
  async function post(sid: string, body: Record<string, unknown>, opId = writeOpId(CALL, 'POST', '/messages', 0)): Promise<{ status: number; body: any }> {
    const w: ReplicaWrite = {
      opId, away: 'host-write', raw: Buffer.from(''),
      submit: async () => ({ kind: 'refused', code: 'bad_request', message: 'not used' }),
      call: async (cmd, params) => {
        peers.push({ cmd, ...params })
        const r = await d.host.handleFollowerPeer(JHOME, { ...params, opId })
        return r.ok ? { kind: 'applied', reply: r.result } : { kind: 'refused', code: r.error.code, message: r.error.message, detail: r.error.detail, retryAfterMs: r.error.retryAfterMs }
      },
    }
    return new Promise((resolve, reject) => {
      const req = { method: 'POST', path: '/v1/messages', body, replicaWrite: w, headers: {}, sid } as unknown as Request
      let status = 0
      const res = {
        headersSent: false, setHeader: () => {},
        status(x: number) { status = x; return this },
        json(b: unknown) { resolve({ status, body: b }); return this },
      } as unknown as Response
      handler(req, res, () => reject(new Error('passed on')))
    })
  }
  return { post, peers }
}

/** Records as the Mac drains them, with what is minted per run (request ids, op ids, seqs) named alike. */
function shown(d: Daemon): unknown[] {
  const ids = new Map<string, string>()
  const name = (v: string) => { if (!ids.has(v)) ids.set(v, `RQ${ids.size + 1}`); return ids.get(v)! }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return /^rq-[a-f0-9]{6,}$/.test(v) ? name(v) : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return (d.journal.records(JHOME) as unknown as Array<Record<string, unknown>>).map(({ seq: _s, at: _a, opId: _o, rev: _r, v: _v, ...rest }) => walk(rest))
}

const words = (d: Daemon) => d.delivered.map((x) => ({ ...x, text: x.text.replace(/rq-[a-f0-9]{6,}/g, 'RQ') }))

describe('a message from this host: the follower writes what the daemon writes (away)', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['an implicit ask down the team opens a request', SID_A, { to: TASK_B, text: 'build the page', title: 'Build it', messageId: 'qm-fixed-1' }],
    ['a note up to its own leader asks nothing', SID_B, { to: TASK_A, text: 'the page is up', messageId: 'qm-fixed-2' }],
    ['expect_reply false asks nothing', SID_A, { to: TASK_B, text: 'fyi', expect_reply: false, messageId: 'qm-fixed-3' }],
    ['an explicit ask keeps its deadline', SID_B, { to: TASK_A, text: 'which branch?', expect_reply: true, reply_timeout: 120, messageId: 'qm-fixed-4' }],
    ['a task prefix and a session id resolve as the daemon resolves them', SID_A, { to: 'mtaskbbb', text: 'by prefix', messageId: 'qm-fixed-5' }],
    ['a session id', SID_A, { to: SID_D, text: 'by session', messageId: 'qm-fixed-6' }],
  ]
  for (const [name, sid, body] of cases) {
    it(name, async () => {
      const s = slice()
      const a = daemon(s)
      const b = daemon(s)
      const own = await a.host.handle(JHOME, sid, 'tools.call', { name: 'task_send', args: body })
      expect(own.ok).toBe(true)
      const r = await follower(b, s).post(sid, body)
      expect(r.status).toBe(202)
      expect(shown(b)).toEqual(shown(a))
      expect(words(b)).toEqual(words(a))
      expect(Boolean(r.body.requestId)).toBe(Boolean((own as { result: { requestId?: string } }).result.requestId))
    })
  }

  it('the row carries the facts only the daemon has: the stream offset and a turn under way', async () => {
    const s = slice()
    const b = daemon(s)
    await follower(b, s).post(SID_A, { to: TASK_B, text: 'build the page' })
    const row = (b.journal.records(JHOME) as unknown as Array<{ kind: string; row?: Record<string, unknown> }>).find((x) => x.kind === 'row')!.row!
    expect(row).toMatchObject({ afterV: 4096, skipTurnEnds: 1, status: 'pending', fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B })
    // Watched as the daemon's own rows are: a turn end past the offset (after the one it skips) notices.
    expect(row.deadlineAt).toBe(T0 + 6 * 3_600_000)
  })

  it('a reply to the daemon\'s own row and to a copy\'s request settle as the daemon settles them, the score riding', async () => {
    const copy = { id: 'rq-c0ffee000001', fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B, preview: 'review it', status: 'pending' as const, createdAt: '2026-11-20T11:00:00Z', deadlineAt: T0 + 3_600_000 }
    const s = slice({ requests: [copy] })
    const a = daemon(s)
    const b = daemon(s)
    const ask = { to: TASK_B, text: 'build the page', messageId: 'qm-ask-1' }
    const ownAsk = await a.host.handle(JHOME, SID_A, 'tools.call', { name: 'task_send', args: ask })
    const folAsk = await follower(b, s).post(SID_A, ask)
    const reply = (id: string) => ({ in_reply_to: id, text: 'done', result: 'it builds', evidence: ['/tmp/x.log'], score: '8/7/9', messageId: 'qm-reply-1' })
    const ownId = (ownAsk as { result: { requestId: string } }).result.requestId
    const folId = folAsk.body.requestId as string
    expect((await a.host.handle(JHOME, SID_B, 'tools.call', { name: 'task_send', args: reply(ownId) })).ok).toBe(true)
    expect((await follower(b, s).post(SID_B, reply(folId), `${CALL}-0a1b2c3d-1`)).status).toBe(202)
    const toCopy = { ...reply(copy.id), messageId: 'qm-reply-2' }
    expect((await a.host.handle(JHOME, SID_B, 'tools.call', { name: 'task_send', args: toCopy })).ok).toBe(true)
    expect((await follower(b, s).post(SID_B, toCopy, `${CALL}-0a1b2c3d-2`)).status).toBe(202)
    expect(shown(b)).toEqual(shown(a))
    expect(b.journal.records(JHOME)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'settle', requestId: copy.id, status: 'replied', score: expect.objectContaining({ function: 8, ux: 7, ui: 9, taskId: TASK_B }) })]))
  })

  it('one answer to two requests of one asker: one delivery, both settled', async () => {
    const req = (id: string) => ({ id, fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B, preview: 'p', status: 'pending' as const, createdAt: '2026-11-20T11:00:00Z', deadlineAt: T0 + 3_600_000 })
    const s = slice({ requests: [req('rq-aaaaaa000001'), req('rq-aaaaaa000002')] })
    const a = daemon(s)
    const b = daemon(s)
    const body = { in_reply_to: ['rq-aaaaaa000001', 'rq-aaaaaa000002'], text: 'both done', messageId: 'qm-both-1' }
    expect((await a.host.handle(JHOME, SID_B, 'tools.call', { name: 'task_send', args: body })).ok).toBe(true)
    const r = await follower(b, s).post(SID_B, body)
    expect(r.body).toMatchObject({ repliedTo: 'rq-aaaaaa000001', answered: ['rq-aaaaaa000001', 'rq-aaaaaa000002'] })
    expect(shown(b)).toEqual(shown(a))
    expect(words(b)).toEqual(words(a))
  })

  it('a target not running here is held for the Mac, as the daemon holds it', async () => {
    const s = slice()
    const a = daemon(s)
    const b = daemon(s)
    const body = { to: TASK_C, text: 'when you are back' }
    expect(await a.host.handle(JHOME, SID_A, 'tools.call', { name: 'task_send', args: body })).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(a.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'task_send', args: body, callId: CALL })).toMatchObject({ ok: true, result: { held: true } })
    const r = await follower(b, s).post(SID_A, body)
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ queued: true, held: true, messageId: 'qm-host-0123456789abcdef' })
    expect(shown(b)).toEqual(shown(a))
    expect(b.journal.records(JHOME)).toEqual([expect.objectContaining({ kind: 'op', op: 'task_send', callerSid: SID_A, callId: CALL, opId: 'held-0123456789abcdef' })])
    expect(b.delivered).toEqual([])
  })

  it('the server\'s refusals, from the follower\'s copies: a complete parent, the caller itself, a COMPLETE target without force', async () => {
    const s = slice()
    s.tasks = s.tasks.map((t) => (t.id === TASK_A ? { ...t, phase: 'COMPLETE' } : t.id === TASK_D ? { ...t, phase: 'COMPLETE' } : t))
    const b = daemon(s)
    const f = follower(b, s)
    expect((await f.post(SID_B, { to: TASK_A, text: 'report' })).body.error).toMatchObject({ code: 'parent_complete' })
    expect((await f.post(SID_A, { to: TASK_A, text: 'me' })).body.error).toMatchObject({ code: 'self_send' })
    expect((await f.post(SID_B, { to: TASK_D, text: 'again' })).body.error).toMatchObject({ code: 'target_complete' })
    expect(b.delivered).toEqual([])
    expect(b.journal.records(JHOME)).toEqual([])
  })
})

describe('a same-host message while the Mac answers: the follower takes what handleLocal takes', () => {
  /** handleLocal's answer and the follower's for the same call (the daemon sets the message id first, as the gateway does). */
  async function both(sid: string, args: Record<string, unknown>, setup?: (d: Daemon) => void) {
    const s = slice()
    const a = daemon(s)
    const b = daemon(s)
    setup?.(a); setup?.(b)
    const own = await a.host.handleLocal(JHOME, sid, 'tools.call', { name: 'task_send', args: { ...args }, callId: CALL })
    const payload: Record<string, unknown> = { name: 'task_send', args: { ...args }, callId: CALL }
    const candidate = b.host.localCandidate(JHOME, sid, 'tools.call', payload)
    const fol = candidate ? await follower(b, s, { online: true }).post(sid, payload.args as Record<string, unknown>) : null
    return { a, b, own, candidate, fol }
  }

  it('a plain send and a reply: the same online records, nothing that holds the gateway away', async () => {
    const { a, b, own, fol } = await both(SID_A, { to: TASK_B, text: 'build the page' })
    expect(own?.ok).toBe(true)
    expect(fol?.status).toBe(202)
    expect(fol?.body).toMatchObject({ via: 'host', messageId: 'qm-host-0123456789abcdef' })
    expect(shown(b)).toEqual(shown(a))
    expect(words(b)).toEqual(words(a))
    expect((b.journal.records(JHOME) as unknown as Array<{ online?: boolean }>).every((x) => x.online === true)).toBe(true)
    expect(b.host.pendingHandover(JHOME)).toBe(false)
  })

  const leaves: Array<[string, string, Record<string, unknown>, ((d: Daemon) => void)?]> = [
    ['a task prefix (the server resolves it)', SID_A, { to: 'mtaskbbb', text: 'x' }],
    ['a target not running here', SID_A, { to: TASK_C, text: 'x' }],
    ['a target on a permission prompt', SID_A, { to: TASK_B, text: 'x' }, (d) => { d.prompts.set(SID_B, 'Bash') }],
    ['the caller itself', SID_A, { to: TASK_A, text: 'x' }],
    ['an answer to a request this host does not hold', SID_B, { in_reply_to: 'rq-abcdef000000', text: 'x' }],
  ]
  for (const [name, sid, args, setup] of leaves) {
    it(`leaves to the Mac: ${name}`, async () => {
      const { own, candidate, fol, b } = await both(sid, args, setup)
      expect(own).toBeNull()
      // Either the daemon never hands it over, or the follower hands it back: the Mac gets it.
      if (candidate) expect(fol?.body.error).toMatchObject({ code: 'needs_leader', why: 'server_delivers' })
      expect(b.delivered).toEqual([])
      expect(b.journal.records(JHOME)).toEqual([])
    })
  }

  it('the arguments only the Mac answers never reach the follower (the daemon keeps them on its relay)', async () => {
    for (const args of [{ to: TASK_B, text: 'x', hands_on: 'rq-abcdef000000' }, { to: TASK_B, text: 'x', answers_ask: true }, { in_reply_to: 'rq-abcdef000000', text: 'x', result: 'r' }]) {
      const { own, candidate } = await both(SID_A, args)
      expect(own).toBeNull()
      expect(candidate).toBe(false)
    }
  })
})
