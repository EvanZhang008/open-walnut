/**
 * A message between two sessions of one Walnut on one host is delivered by that
 * host's daemon even while the server answers (offline-host-core.ts
 * `handleLocal`, docs/plan/daemon-first-hosts.md "Same-host messages").
 *
 * Pinned:
 *   - what the host takes: an exact task id, an exact or 8+ session id, a
 *     printed `Title [8hex]` handle, both sessions of this Walnut, running here;
 *     the envelope and the reply are byte for byte the server's own;
 *   - what it leaves to the server (null = relay, nothing delivered): a task
 *     prefix or a title, a target or asker not running here, a task with two
 *     live sessions, an environment or lane session, a target on a permission
 *     prompt, a completed parent, an args file, a caller that is not a session
 *     of this Walnut here, any other op, an old twin without the prompt hook;
 *   - the message id the host picked rides the relayed payload, so a server
 *     that delivers it again writes it once;
 *   - the journal: every record is `online`, so nothing else waits for it, and
 *     the server is nudged; the server owns the row once it took it;
 *   - the server's throttle rules (10 a minute per sender, the same text twice).
 * Real files in a temp dir; delivery is a recorder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice, type OfflineHostDeps, type OfflineRecord } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { buildPeerWrapper } from '../../src/core/peers/peer-wrapper.js'
import { sessionHandle } from '../../src/core/peers/walnut-message-tag.js'
import { buildReplyTrailer, buildReplyDeliveryText, type SessionRequest } from '../../src/core/session-requests.js'

const HOME = '/fixture/walnut-home'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const D = 'dddddddd-4444-4444-8444-444444444444'
const E = 'eeeeeeee-5555-4555-8555-555555555555'
const TASK_A = 'mtaskaaa-0001'
const TASK_B = 'mtaskbbb-0002'

function slice(overrides: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.parse('2026-10-07T10:00:00Z'), host: 'devbox',
    sessions: [
      { sid: A, taskId: TASK_A, title: 'Leader: ship the release' },
      { sid: B, taskId: TASK_B, title: 'Worker: build the page' },
      { sid: C, taskId: 'mtaskccc-0003', title: 'Stopped sibling' },
      { sid: D, taskId: 'mtaskddd-0004', title: 'Twin one' },
      { sid: E, taskId: 'mtaskddd-0004', title: 'Twin two' },
    ],
    tasks: [
      { id: TASK_A, title: 'Leader: ship the release', phase: 'IN_PROGRESS', project: 'Acme' },
      { id: TASK_B, title: 'Worker: build the page', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
      { id: 'mtaskccc-0003', title: 'Stopped sibling', phase: 'NEED_ACTION', project: 'Acme' },
      { id: 'mtaskddd-0004', title: 'Two sessions', phase: 'IN_PROGRESS', project: 'Acme' },
    ],
    requests: [],
    ...overrides,
  }
}

interface Harness {
  host: ReturnType<typeof createOfflineHost>
  delivered: Array<{ sid: string; text: string; messageId: string }>
  live: Set<string>
  prompts: Map<string, string>
  clock: { now: number }
  dir: string
  deps: OfflineHostDeps
  pings: string[]
  failDelivery: { reason: string | null }
  /** Whether a server of this Walnut is connected and answering (the daemon's gateway test). */
  serverUp: { v: boolean }
}

let dirs: string[] = []

function harness(dir?: string, opts: { noPromptHook?: boolean } = {}): Harness {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'host-local-send-'))
  dirs.push(d)
  const delivered: Harness['delivered'] = []
  const live = new Set([A, B, D, E])
  const prompts = new Map<string, string>()
  const clock = { now: Date.parse('2026-10-07T12:00:00Z') }
  const pings: string[] = []
  const failDelivery = { reason: null as string | null }
  const serverUp = { v: true }
  const deps: OfflineHostDeps = {
    fs, path, dir: d,
    now: () => clock.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (v) => createHash('sha1').update(v).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(),
    log: () => {},
    isLive: (sid) => live.has(sid),
    turnActive: () => false,
    ...(opts.noPromptHook ? {} : { pendingPrompt: (sid: string) => prompts.get(sid) ?? null }),
    streamOffset: () => undefined,
    deliver: async (sid, text, messageId) => {
      if (failDelivery.reason) return { ok: false, reason: failDelivery.reason }
      delivered.push({ sid, text, messageId })
      return { ok: true }
    },
    onJournal: (home) => { pings.push(home) },
    serverAnswers: () => serverUp.v,
  }
  const host = createOfflineHost(deps)
  host.configure(slice())
  return { host, delivered, live, prompts, clock, dir: d, deps, pings, failDelivery, serverUp }
}

function send(h: Harness, sid: string, args: Record<string, unknown>, name = 'task_send') {
  const payload: Record<string, unknown> = { name, args }
  return { payload, result: h.host.handleLocal(HOME, sid, 'tools.call', payload) }
}

function records(h: Harness): OfflineRecord[] {
  return h.host.drain(HOME).records
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('a same-host message while the server answers: the host delivers it', () => {
  it('by exact task id: the server\'s envelope, the server\'s answer shape, a nudge, and nothing held back', async () => {
    const h = harness()
    // Non-ASCII text (an accented letter and a CJK character) survives as is.
    const text = 'Please rebuild the page. Unicode stays: \u00e9\u4e2d'
    const { payload, result } = send(h, A, { to: TASK_B, text, title: 'Rebuild the page' })
    const r = await result
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    const requestId = String(r.result.requestId)
    expect(requestId).toMatch(/^rq-[a-f0-9]{12}$/)
    const envelope = buildPeerWrapper(text, {
      title: 'Leader: ship the release', shortId: A.slice(0, 8), sessionId: A, taskId: TASK_A, host: 'devbox', requestId,
    }, { title: 'Rebuild the page' })
    expect(h.delivered).toEqual([{ sid: B, text: `${envelope}\n${buildReplyTrailer({ id: requestId } as SessionRequest)}`, messageId: expect.stringMatching(/^qm-host-[a-f0-9]{16}$/) }])
    expect(r.result).toMatchObject({
      delivery: 'queued', via: 'host', targetSessionId: B, targetTitle: 'Worker: build the page', targetTaskId: TASK_B,
      target: { handle: sessionHandle('Worker: build the page', B), sessionId: B, taskId: TASK_B },
      messageId: h.delivered[0].messageId,
    })
    expect(String(r.result.outcome)).toContain('delivered on this host')
    expect(String(r.result.outcome)).not.toMatch(/not reachable|offline/i)
    expect(String(r.result.next)).toContain(requestId)
    expect(r.result.offline).toBeUndefined()
    // The id it picked is on the payload too (what a relay would carry).
    expect((payload.args as Record<string, unknown>).messageId).toBe(h.delivered[0].messageId)
    // Journaled for the server, online: other calls are not held back for it.
    expect(h.pings).toEqual([HOME, HOME])
    expect(h.host.hasRecords(HOME)).toBe(true)
    expect(h.host.pendingHandover(HOME)).toBe(false)
    const rec = records(h)
    expect(rec.map((x) => `${x.kind}:${x.online === true}`)).toEqual(['row:true', 'delivery:true'])
    expect(rec[0]).toMatchObject({ kind: 'row', row: { id: requestId, fromSessionId: A, toSessionId: B, toTaskId: TASK_B, status: 'pending' } })
    expect(rec[1]).toMatchObject({ kind: 'delivery', fromSessionId: A, toSessionId: B, toTaskId: TASK_B, requestId, messageId: h.delivered[0].messageId })
  })

  it('by exact session id, an 8+ prefix, and a printed handle; a caller-given message id is kept', async () => {
    const h = harness()
    for (const to of [B, B.slice(0, 8), `Worker: build the page [${B.slice(0, 8)}]`]) {
      const r = await send(h, A, { to, text: `hello via ${to}`, expect_reply: false, messageId: `qm-given-${h.delivered.length}` }).result
      expect(r?.ok).toBe(true)
    }
    expect(h.delivered.map((d) => [d.sid, d.messageId])).toEqual([[B, 'qm-given-0'], [B, 'qm-given-1'], [B, 'qm-given-2']])
    // expect_reply false: deliveries only, no rows.
    expect(records(h).map((x) => x.kind)).toEqual(['delivery', 'delivery', 'delivery'])
  })

  it('a reply to a request this host opened: the server\'s reply text, the row settled, delivered to the asker', async () => {
    const h = harness()
    const asked = await send(h, A, { to: TASK_B, text: 'Is the page done?' }).result
    const requestId = String(asked?.ok && asked.result.requestId)
    const r = await send(h, B, { in_reply_to: requestId, text: 'Yes: deployed.', title: 'Done' }).result
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    const row = { id: requestId, preview: 'Is the page done?' } as SessionRequest
    expect(h.delivered[1]).toMatchObject({ sid: A, text: buildReplyDeliveryText(row, {
      title: 'Worker: build the page', shortId: B.slice(0, 8), sessionId: B, taskId: TASK_B, host: 'devbox',
    }, 'Yes: deployed.', { title: 'Done' }) })
    expect(r.result).toMatchObject({ delivery: 'queued', via: 'host', repliedTo: requestId, targetSessionId: A, targetTaskId: TASK_A })
    const rec = records(h)
    expect(rec.map((x) => x.kind)).toEqual(['row', 'delivery', 'row', 'delivery'])
    expect(rec[2]).toMatchObject({ kind: 'row', online: true, row: { id: requestId, status: 'replied' } })
    expect(rec[3]).toMatchObject({ kind: 'delivery', online: true, reply: true, requestId, toSessionId: A })
  })

  it('a reply to the server\'s own request (the copy): delivered here and the settle journaled; a second answer is the server\'s', async () => {
    const h = harness()
    h.host.configure(slice({ hash: 'h2', requests: [{ id: 'rq-0123456789ab', fromSessionId: A, toSessionId: B, toTaskId: TASK_B, preview: 'Status?', status: 'pending', createdAt: '2026-10-07T11:00:00Z', deadlineAt: Date.parse('2026-10-07T13:00:00Z') }] }))
    const r = await send(h, B, { in_reply_to: 'rq-0123456789ab', text: 'Green.' }).result
    expect(r?.ok && r.result.repliedTo).toBe('rq-0123456789ab')
    expect(h.delivered.map((d) => d.sid)).toEqual([A])
    expect(records(h).map((x) => `${x.kind}:${x.online}`)).toEqual(['settle:true', 'delivery:true'])
    expect(await send(h, B, { in_reply_to: 'rq-0123456789ab', text: 'Still green.' }).result).toBeNull()
  })
})

describe('what the host leaves to the server (null: relay, nothing delivered)', () => {
  it.each([
    ['a task prefix', { to: 'mtaskbbb', text: 'x' }, A],
    ['a title', { to: 'Worker: build', text: 'x' }, A],
    ['a short session prefix', { to: B.slice(0, 7), text: 'x' }, A],
    ['a task with no live session here', { to: 'mtaskccc-0003', text: 'x' }, A],
    ['a session not running here', { to: C, text: 'x' }, A],
    ['a task with two live sessions', { to: 'mtaskddd-0004', text: 'x' }, A],
    ['one of two live sessions of a task, by its id', { to: D, text: 'x' }, A],
    ['the caller itself', { to: TASK_A, text: 'x' }, A],
    ['a session of another host or Walnut', { to: 'ffffffff-6666-4666-8666-666666666666', text: 'x' }, A],
    ['an empty text', { to: TASK_B, text: '   ' }, A],
    ['a caller that is no session of this Walnut here', { to: TASK_B, text: 'x' }, 'external'],
    ['a reply to a request this host does not hold', { in_reply_to: 'rq-ffffffffffff', text: 'x' }, B],
  ] as const)('%s', async (_label, args, caller) => {
    const h = harness()
    const { payload, result } = send(h, caller, { ...args })
    expect(await result).toBeNull()
    expect(h.delivered).toEqual([])
    expect(h.host.hasRecords(HOME)).toBe(false)
    // The id rides the payload the caller relays, whenever this host's session sent text.
    if (caller !== 'external' && String(args.text).trim()) expect((payload.args as Record<string, unknown>).messageId).toMatch(/^qm-host-/)
  })

  it('a target waiting on a permission prompt (the server parks the message until the human answers)', async () => {
    const h = harness()
    h.prompts.set(B, 'Bash')
    expect(await send(h, A, { to: TASK_B, text: 'x' }).result).toBeNull()
    expect(h.delivered).toEqual([])
  })

  it('an environment or lane session, by task or by id', async () => {
    const h = harness()
    h.host.configure(slice({ hash: 'h3', sessions: [{ sid: A, taskId: TASK_A, title: 'Leader' }, { sid: B, taskId: TASK_B, title: 'Triage', aside: true }] }))
    expect(await send(h, A, { to: TASK_B, text: 'x' }).result).toBeNull()
    expect(await send(h, A, { to: B, text: 'x' }).result).toBeNull()
  })

  it('a worker\'s message to its completed parent (the server says why)', async () => {
    const h = harness()
    h.host.configure(slice({ hash: 'h4', tasks: slice().tasks.map((t) => (t.id === TASK_A ? { ...t, phase: 'COMPLETE' } : t)) }))
    expect(await send(h, B, { to: TASK_A, text: 'report' }).result).toBeNull()
  })

  it('a reply whose asker is not running here, waits on a prompt, or that the caller does not owe', async () => {
    const h = harness()
    const asked = await send(h, A, { to: TASK_B, text: 'Ping?' }).result
    const id = String(asked?.ok && asked.result.requestId)
    expect(await send(h, D, { in_reply_to: id, text: 'not mine' }).result).toBeNull()
    h.prompts.set(A, 'Edit')
    expect(await send(h, B, { in_reply_to: id, text: 'pong' }).result).toBeNull()
    h.prompts.clear()
    h.live.delete(A)
    expect(await send(h, B, { in_reply_to: id, text: 'pong' }).result).toBeNull()
    expect(h.delivered.map((d) => d.sid)).toEqual([B])
  })

  it('other ops, an args file, another capability, and an old twin without the prompt hook', async () => {
    const h = harness()
    expect(await h.host.handleLocal(HOME, A, 'tools.call', { name: 'task_get', args: { id: TASK_B } })).toBeNull()
    expect(await h.host.handleLocal(HOME, A, 'tools.call', { name: 'task_send', argsFile: '/tmp/args.json' })).toBeNull()
    expect(await h.host.handleLocal(HOME, A, 'tools.list', { name: 'task_send', args: { to: TASK_B, text: 'x' } })).toBeNull()
    expect(await h.host.handleLocal('/other/home', A, 'tools.call', { name: 'task_send', args: { to: TASK_B, text: 'x' } })).toBeNull()
    const old = harness(undefined, { noPromptHook: true })
    expect(await send(old, A, { to: TASK_B, text: 'x' }).result).toBeNull()
    expect([...h.delivered, ...old.delivered]).toEqual([])
  })

  it('a delivery that fails leaves no row and no record behind', async () => {
    const h = harness()
    h.failDelivery.reason = 'pipe closed'
    expect(await send(h, A, { to: TASK_B, text: 'x' }).result).toBeNull()
    expect(h.host.hasRecords(HOME)).toBe(false)
    // The row it made for the envelope went with it: no notice ever comes for it.
    h.failDelivery.reason = null
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'done' }), 5)
    expect(await h.host.sweep()).toBe(0)
    expect(h.delivered).toEqual([])
  })
})

describe('the server\'s throttle, applied by the host', () => {
  it('10 messages a minute per sender, then throttled with a retry time; the window frees them', async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) expect((await send(h, A, { to: TASK_B, text: `step ${i}`, expect_reply: false }).result)?.ok).toBe(true)
    const over = await send(h, A, { to: TASK_B, text: 'step 10', expect_reply: false }).result
    expect(over?.ok).toBe(false)
    expect(!over?.ok && over?.error).toMatchObject({ code: 'throttled', retryAfterMs: expect.any(Number) })
    h.clock.now += 61_000
    expect((await send(h, A, { to: TASK_B, text: 'step 11', expect_reply: false }).result)?.ok).toBe(true)
  })

  it('the same text to the same session twice within 5 minutes is refused; another text or session is not', async () => {
    const h = harness()
    expect((await send(h, A, { to: TASK_B, text: 'same', expect_reply: false }).result)?.ok).toBe(true)
    const again = await send(h, A, { to: TASK_B, text: 'same', expect_reply: false }).result
    expect(!again?.ok && again?.error.code).toBe('throttled')
    expect((await send(h, A, { to: TASK_B, text: 'different', expect_reply: false }).result)?.ok).toBe(true)
    h.clock.now += 301_000
    expect((await send(h, A, { to: TASK_B, text: 'same', expect_reply: false }).result)?.ok).toBe(true)
  })
})

describe('who owns the request afterwards', () => {
  it('while the server answers, it speaks for the request: no notice from here, drained or not', async () => {
    const h = harness()
    const asked = await send(h, A, { to: TASK_B, text: 'Build it', reply_timeout: 60 }).result
    expect(asked?.ok).toBe(true)
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Built.' }), 999)
    h.clock.now += 61_000
    expect(await h.host.sweep()).toBe(0)
    expect(h.delivered.map((d) => d.sid)).toEqual([B])
    // The turn end it let pass is spent: a server that leaves later does not
    // make that old turn end speak.
    h.serverUp.v = false
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Built.' }), 999)
    expect(h.delivered.map((d) => d.sid)).toEqual([B])
  })

  it('a server gone before it took the row leaves it to the host: the next turn end is noticed here', async () => {
    const h = harness()
    const asked = await send(h, A, { to: TASK_B, text: 'Build it' }).result
    const id = String(asked?.ok && asked.result.requestId)
    h.serverUp.v = false
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Built.' }), 999)
    expect(h.delivered.map((d) => d.sid)).toEqual([B, A])
    expect(h.delivered[1].text).toContain(id)
    expect(h.delivered[1].text).toContain('Built.')
    // Journaled as the server would have settled it; that one is an offline record.
    const rec = records(h)
    expect(rec.map((x) => x.kind)).toEqual(['row', 'delivery', 'row', 'delivery'])
    expect(rec[2]).toMatchObject({ kind: 'row', row: { id, status: 'notified' } })
  })

  it('a server gone before it took the row: the deadline is noticed here too', async () => {
    const h = harness()
    await send(h, A, { to: TASK_B, text: 'Build it', reply_timeout: 60 }).result
    h.serverUp.v = false
    h.clock.now += 61_000
    expect(await h.host.sweep()).toBe(1)
    expect(h.delivered.map((d) => d.sid)).toEqual([B, A])
  })

  it('the server, once it took it: the drained row is never noticed here', async () => {
    const h = harness()
    const asked = await send(h, A, { to: TASK_B, text: 'Build it' }).result
    expect(asked?.ok).toBe(true)
    const drained = h.host.drain(HOME)
    // Drained, not yet acked: the server is taking it, the host stays quiet.
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Built.' }), 999)
    h.host.ack(HOME, Math.max(...drained.records.map((r) => r.seq)))
    await h.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Built again.' }), 1999)
    expect(h.delivered.map((d) => d.sid)).toEqual([B])
    expect(h.host.hasRecords(HOME)).toBe(false)
  })

  it('the records survive a daemon restart, still online', async () => {
    const h = harness()
    await send(h, A, { to: TASK_B, text: 'Persist me' }).result
    const restarted = harness(h.dir)
    expect(restarted.host.pendingHandover(HOME)).toBe(false)
    expect(restarted.host.hasRecords(HOME)).toBe(true)
    expect(records(restarted).every((r) => r.online === true)).toBe(true)
  })
})

describe('the source twin runs it from its text', () => {
  it('rebuilt under strict mode, it delivers the same envelope', async () => {
    const rebuild = <T>(fn: T): T => new Function('"use strict"; return ' + String(fn))() as T
    const h = harness()
    const copy = rebuild(createOfflineHost)({ ...h.deps, kit: rebuild(createEnvelopeKit)() })
    copy.configure(slice())
    const r = await copy.handleLocal(HOME, A, 'tools.call', { name: 'task_send', args: { to: TASK_B, text: 'from the copy', expect_reply: false } })
    expect(r?.ok).toBe(true)
    expect(h.delivered[0].text).toBe(buildPeerWrapper('from the copy', {
      title: 'Leader: ship the release', shortId: A.slice(0, 8), sessionId: A, taskId: TASK_A, host: 'devbox',
    }))
  })
})
