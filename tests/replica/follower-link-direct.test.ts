/**
 * The follower link of a host's one Walnut service (src/core/link/follower-link-direct.ts) over a
 * scripted seat: how a command maps to the runtime's functions, the frame each answer becomes
 * (the shape a socket carries, so write-port.ts, dispatch.ts and the away-* files keep their
 * retry rules), the states it passes through, and the events and streams that ride the one
 * in-process client. The same link over a real runtime, next to the socket link, is
 * tests/replica/follower-link-both.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectFollowerLink, FOLLOWER_CALLS } from '../../src/core/link/follower-link-direct.js'
import type { FollowerLink } from '../../src/core/link/follower-link.js'
import { wasNotSent } from '../../src/host-server/daemon-link.js'
import type { DaemonClient, DaemonFrame, FollowerSeat } from '../../src/providers/daemon-runtime-types.js'

const HOME = '/acme/home'
const WALNUT = 'w-acme'
const VIEW = {
  walnutId: WALNUT, home: HOME, epoch: 3, holder: 'primary', backup: false, primaryConnected: true, primaryHeardAgoMs: 120,
  takeoverMs: 12_000, quietMs: 6_000, bridge: { connected: false, companion: null }, settings: { expose: { enabled: false } },
  journal: { drainable: 2 },
}

interface Rig {
  link: FollowerLink
  seat: FollowerSeat
  client: DaemonClient & { sent: DaemonFrame[]; asked: Array<{ cmd: string; params: Record<string, unknown> }>; closed: number }
  frame: (f: DaemonFrame) => void
  closeFromRuntime: () => void
  events: Array<Record<string, unknown>>
  attachedWith: Array<{ home: string; hello: Record<string, unknown> }>
  /** `seated`: the home the attached client holds the seat of now (seatedAs), null once another follower took it. */
  set: { present: boolean; view: Record<string, unknown> | null; seated: string | null }
}

const links: FollowerLink[] = []
afterEach(() => { for (const l of links.splice(0)) l.stop() })

function rig(over: Partial<Record<keyof FollowerSeat, (...a: never[]) => unknown>> = {}, linkOver: { pollMs?: number; liveView?: boolean } = {}): Rig {
  const set: Rig['set'] = { present: true, view: VIEW, seated: null }
  const events: Array<Record<string, unknown>> = []
  const attachedWith: Rig['attachedWith'] = []
  let onFrame: (f: DaemonFrame) => void = () => {}
  let onClose: (() => void) | undefined
  const client = {
    sent: [] as DaemonFrame[], asked: [] as Array<{ cmd: string; params: Record<string, unknown> }>, closed: 0,
    send(f: DaemonFrame) { client.sent.push(f) },
    async request(cmd: string, params: Record<string, unknown> = {}) {
      client.asked.push({ cmd, params })
      if (cmd === 'hello') return { ok: true, capabilities: ['replica-ops-v1', 'replica-reads-v1'] }
      return { ok: true, echoed: cmd }
    },
    close() { client.closed++ },
  }
  const fn = (name: keyof FollowerSeat, dflt: (...a: never[]) => unknown) => over[name] ?? dflt
  const seat = {
    view: vi.fn(fn('view', () => set.view)),
    sessions: vi.fn(fn('sessions', () => ({ host: 'devbox', asOf: 5, sessions: [] }))),
    slice: vi.fn(fn('slice', () => ({ host: 'devbox', asOf: 5, tasks: [], sessions: [], requests: [], boards: [], boardOf: {} }))),
    triggers: vi.fn(fn('triggers', () => ({ triggers: [] }))),
    pending: vi.fn(fn('pending', () => ({ records: [], seq: 0 }))),
    triggerTest: vi.fn(fn('triggerTest', () => ({ ok: true, result: { tested: true } }))),
    send: vi.fn(fn('send', () => ({ ok: true, result: { delivered: true } }))),
    permission: vi.fn(fn('permission', () => ({ ok: true, result: { status: 'resolved' } }))),
    peer: vi.fn(fn('peer', () => ({ ok: true, result: {} }))),
    op: vi.fn(fn('op', () => ({ ok: true, result: { kind: 'task-update', seq: 1 } }))),
    start: vi.fn(fn('start', () => ({ ok: true, result: { sid: 's1' } }))),
    attach: vi.fn((home: string, hello: Record<string, unknown>, f: (x: DaemonFrame) => void, c?: () => void) => {
      attachedWith.push({ home, hello }); onFrame = f; onClose = c
      set.seated = home
      return client as unknown as DaemonClient
    }),
    seatedAs: vi.fn(fn('seatedAs', (c: unknown) => (c === client ? set.seated : null))),
  } as unknown as FollowerSeat
  const link = createDirectFollowerLink({
    walnutId: WALNUT, home: HOME, host: 'devbox', pollMs: 15, openTimeoutMs: 200, answersLocal: true, deliversTriggers: true,
    answersOnline: () => true, helloExtra: () => ({ callSocket: '/run/entry.sock' }),
    onEvent: (e) => events.push(e),
    log: () => {},
    seat: () => (set.present ? seat : null),
    ...linkOver,
  })
  links.push(link)
  return { link, seat, client, frame: (f) => onFrame(f), closeFromRuntime: () => onClose?.(), events, attachedWith, set }
}

async function until(what: string, fn: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function following(over?: Parameters<typeof rig>[0], linkOver?: Parameters<typeof rig>[1]): Promise<Rig> {
  const r = rig(over, linkOver)
  r.link.start()
  await until('following', () => r.link.linkState() === 'following' && r.link.capabilities() !== null)
  return r
}

describe('the states', () => {
  it('has no daemon until the runtime runs, does not know the Walnut until its leader described it, then follows and seats itself once', async () => {
    const r = rig()
    r.set.present = false
    const states: string[] = []
    r.link.on('state', (s) => states.push(String(s)))
    r.link.start()
    await until('no-daemon', () => r.link.linkState() === 'no-daemon')
    expect(r.link.state()).toBe('down')
    await expect(r.link.request('follower.sessions')).rejects.toSatisfy((e: Error) => wasNotSent(e))
    r.set.present = true
    r.set.view = null
    await until('unknown-walnut', () => r.link.linkState() === 'unknown-walnut', 3_000)
    expect(r.seat.attach).not.toHaveBeenCalled()
    expect(r.link.lastError()).toMatch(/does not know that Walnut/)
    r.set.view = { ...VIEW, walnutId: 'w-other' }
    await new Promise((x) => setTimeout(x, 40))
    expect(r.link.linkState()).toBe('unknown-walnut')
    r.set.view = VIEW
    await until('following', () => r.link.linkState() === 'following', 3_000)
    expect(r.link.state()).toBe('up')
    expect(states).toEqual(['no-daemon', 'unknown-walnut', 'following'])
    // Seated once, with what follower.hello would have said.
    expect(r.attachedWith).toEqual([{ home: HOME, hello: { answersLocal: true, deliversTriggers: true, answersOnline: true, callSocket: '/run/entry.sock' } }])
    await until('capabilities', () => r.link.capabilities() !== null)
    expect(r.link.capabilities()).toEqual(['replica-ops-v1', 'replica-reads-v1'])
    expect(r.link.lastError()).toBeNull()
  })

  it('keeps the view the runtime gave, as the socket link shapes it, and tells each one', async () => {
    const r = rig()
    const views: unknown[] = []
    r.link.on('view', (v) => views.push(v))
    r.link.start()
    await until('two views', () => views.length >= 2)
    const v = r.link.view()!
    expect(v.view).toMatchObject({ walnutId: WALNUT, home: HOME, epoch: 3, holder: 'primary', quietMs: 6_000, drainablePending: 2, settings: { expose: { enabled: false } } })
    expect(Date.now() - v.at).toBeLessThan(1_000)
    expect(r.link.heard()).toBeLessThan(1_000)
    // A poll the drain refuses keeps what is known.
    r.seat.view = (() => { throw new Error('Daemon is shutting down; retry after reconnecting') }) as never
    await new Promise((x) => setTimeout(x, 50))
    expect(r.link.linkState()).toBe('following')
    expect(r.link.view()).not.toBeNull()
  })

  // a3b land 2 review L2: a close while a poll was armed started a second poll chain.
  it('keeps one poll chain through a close of its client', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      r.link.start()
      await vi.advanceTimersByTimeAsync(50)
      expect(r.link.linkState()).toBe('following')
      for (let i = 0; i < 3; i++) {
        r.closeFromRuntime()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(r.link.linkState()).toBe('following')
      }
      const views = r.seat.view as unknown as { mock: { calls: unknown[] } }
      const before = views.mock.calls.length
      await vi.advanceTimersByTimeAsync(150)
      // One chain polls every 15 ms: 10 views in 150 ms (two chains would be 20, four 40).
      expect(views.mock.calls.length - before).toBeLessThanOrEqual(11)
      r.link.stop()
    } finally { vi.useRealTimers() }
  })

  it('goes down when the runtime closes its client, and seats again at its next tick', async () => {
    const r = await following()
    r.closeFromRuntime()
    expect(r.link.linkState()).toBe('no-daemon')
    expect(r.client.closed).toBe(1)
    await expect(r.link.request('follower.sessions')).rejects.toSatisfy((e: Error) => wasNotSent(e))
    await until('seated again', () => r.attachedWith.length === 2 && r.link.linkState() === 'following', 3_000)
  })
})

describe('request(): the follower\'s own commands are calls of the seat', () => {
  const CASES: Array<[string, keyof FollowerSeat]> = [
    ['follower.status', 'view'], ['follower.sessions', 'sessions'], ['follower.slice', 'slice'], ['follower.triggers', 'triggers'], ['follower.pending', 'pending'],
    ['follower.send', 'send'], ['follower.permission', 'permission'], ['follower.peer', 'peer'], ['follower.op', 'op'],
    ['follower.trigger.test', 'triggerTest'], ['follower.start', 'start'],
  ]
  it.each(CASES)('%s calls seat.%s(home, params) and sends no frame', async (cmd, fn) => {
    const r = await following()
    const asked = r.client.asked.length
    const reply = await r.link.request(cmd, { sid: 's1', args: { a: [1, { b: 2 }] }, dropped: undefined })
    expect(reply.ok).toBe(true)
    const call = (r.seat[fn] as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!
    expect(call[0]).toBe(HOME)
    if (fn !== 'view' && fn !== 'sessions' && fn !== 'slice') expect(call[1]).toEqual({ sid: 's1', args: { a: [1, { b: 2 }] }, cmd })
    expect(r.client.sent).toEqual([])
    expect(r.client.asked.length).toBe(asked)
  })

  it('answers the frame a socket would carry: an answer\'s result under ok, a refusal with its errorKind, a plain read under ok', async () => {
    const r = await following({
      op: (async (_h: string, cmd: { n: number }) => cmd.n === 1
        ? { ok: false, error: 'follower.op: your Mac answers again; write through it', extra: { errorKind: 'leader_answers' } }
        : cmd.n === 2
          ? { ok: false, error: 'follower.op: this daemon no longer owns its directory', extra: { errorKind: 'journal_unwritable', detail: { why: 'not_owner' } } }
          : cmd.n === 3
            ? { ok: false, error: 'follower.op: x', extra: { errorKind: 'needs_leader', detail: { why: 'daemon_needs_upgrade' }, retryAfterMs: 500 } }
            : { ok: true, result: { kind: 'task-update', seq: 7 } }) as never,
    })
    expect(await r.link.request('follower.op', { n: 1 })).toEqual({ ok: false, error: 'follower.op: your Mac answers again; write through it', errorKind: 'leader_answers' })
    expect(await r.link.request('follower.op', { n: 2 })).toEqual({ ok: false, error: 'follower.op: this daemon no longer owns its directory', errorKind: 'journal_unwritable', detail: { why: 'not_owner' } })
    expect(await r.link.request('follower.op', { n: 3 })).toEqual({ ok: false, error: 'follower.op: x', errorKind: 'needs_leader', detail: { why: 'daemon_needs_upgrade' }, retryAfterMs: 500 })
    expect(await r.link.request('follower.op', { n: 4 })).toEqual({ ok: true, kind: 'task-update', seq: 7 })
    expect(await r.link.request('follower.sessions')).toEqual({ ok: true, host: 'devbox', asOf: 5, sessions: [] })
  })

  it('answers follower.status with the daemon\'s unknown_walnut refusal while the leader is not described', async () => {
    const r = await following()
    r.set.view = null
    expect(await r.link.request('follower.status')).toMatchObject({ ok: false, errorKind: 'unknown_walnut' })
  })

  it('answers a call the drain refused (once its timeout is spent), or a handler that threw, as handleCommand does', async () => {
    const r = await following({ op: (() => { throw new Error('Daemon is shutting down; retry after reconnecting') }) as never, send: (async () => { throw new Error('boom') }) as never })
    expect(await r.link.request('follower.op', {}, 200)).toEqual({ ok: false, error: 'internal daemon error handling follower.op: Daemon is shutting down; retry after reconnecting' })
    expect(await r.link.request('follower.send', {})).toEqual({ ok: false, error: 'internal daemon error handling follower.send: boom' })
    expect((r.seat.send as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
  })

  // a3b land 2 review M3: a service.update pauses the runtime's drain up to 45 s, and an update that
  // fails resumes it. A write in that window waits for the runtime, as on the socket link; it does
  // not come back as a refusal dispatch.ts answers 409 with no retryAfter.
  it('sends a call the drain refused again once the runtime answers, inside the caller\'s timeout', async () => {
    const paused = { on: true }
    const drained = () => { if (paused.on) throw new Error('Daemon is shutting down; retry after reconnecting') }
    const r = await following()
    ;(r.seat.op as unknown as { mockImplementation(f: unknown): void }).mockImplementation(() => { drained(); return { ok: true, result: { kind: 'task-update', seq: 9 } } })
    ;(r.seat.view as unknown as { mockImplementation(f: unknown): void }).mockImplementation(() => { drained(); return VIEW })
    const at = Date.now()
    const pending = r.link.request('follower.op', { n: 1 }, 10_000)
    setTimeout(() => { paused.on = false }, 120)
    expect(await pending).toEqual({ ok: true, kind: 'task-update', seq: 9 })
    // Woken by the runtime's first view after the pause, not by the one-second retry.
    expect(Date.now() - at).toBeLessThan(900)
    expect((r.seat.op as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2)
  })

  it('a write the drain refuses with no timeout left is answered as refused, never resent past it', async () => {
    const r = await following({ op: (() => { throw new Error('Daemon is shutting down; retry after reconnecting') }) as never })
    const at = Date.now()
    expect(await r.link.request('follower.op', {}, 1_500)).toMatchObject({ ok: false, error: expect.stringMatching(/shutting down/) })
    expect(Date.now() - at).toBeLessThan(2_500)
  })

  it('hands the runtime a copy: what the caller changes afterwards is not what was asked', async () => {
    let seen: { args?: { v: number } } | null = null
    const r = await following({ op: (async (_h: string, cmd: { args?: { v: number } }) => { await new Promise((x) => setTimeout(x, 20)); seen = cmd; return { ok: true, result: {} } }) as never })
    const params = { args: { v: 1 } }
    const pending = r.link.request('follower.op', params)
    params.args.v = 2
    await pending
    expect(seen).toMatchObject({ args: { v: 1 } })
  })

  it('rejects like the socket link: not sent for no link, a frame-key parameter, a frame over the cap; timed out for a call that does not answer', async () => {
    const r = await following({ op: (() => new Promise(() => {})) as never })
    await expect(r.link.request('follower.sessions', { id: 5 })).rejects.toSatisfy((e: Error) => wasNotSent(e) && /frame key/.test(e.message))
    await expect(r.link.request('follower.sessions', { cmd: 'x' })).rejects.toSatisfy((e: Error) => wasNotSent(e))
    await expect(r.link.request('follower.send', { text: 'x'.repeat(40 * 1024 * 1024) })).rejects.toSatisfy((e: Error) => wasNotSent(e))
    await expect(r.link.request('follower.op', {}, 30)).rejects.toThrow('follower.op timed out')
    expect(r.link.linkState()).toBe('following')
  })
})

describe('everything else rides the one in-process client', () => {
  it('sends the other commands to the runtime as a socket would (reads, follower.gateway, gateway-result, follower.trigger.deliver), their reply as it came', async () => {
    const r = await following()
    for (const cmd of ['read-history', 'follower.gateway', 'gateway-result', 'follower.trigger.deliver', 'fs.read']) {
      expect(await r.link.request(cmd, { sid: 's1' })).toEqual({ ok: true, echoed: cmd })
    }
    expect(r.client.asked.filter((a) => a.cmd !== 'hello').map((a) => a.cmd)).toEqual(['read-history', 'follower.gateway', 'gateway-result', 'follower.trigger.deliver', 'fs.read'])
    expect(r.client.asked.find((a) => a.cmd === 'read-history')!.params).toEqual({ sid: 's1' })
  })

  it('tells a request cut by the runtime\'s close as the socket link does (closed)', async () => {
    const r = await following()
    r.client.request = (async () => ({ ok: false, error: 'client closed' })) as never
    expect(await r.link.request('read-history', {})).toEqual({ ok: false, error: 'closed' })
  })

  it('reports in one frame and stops by closing the client', async () => {
    const r = await following()
    r.link.report({ answersOnline: true, port: 1 })
    expect(r.client.sent).toEqual([{ cmd: 'follower.report', report: { answersOnline: true, port: 1 } }])
    r.link.stop()
    expect(r.client.closed).toBe(1)
    r.link.report({ again: true })
    expect(r.client.sent).toHaveLength(1)
  })

  it('hands the daemon\'s events to the server, and its stream frames to the streams', async () => {
    const r = await following()
    r.frame({ ev: 'gateway-request', relayId: 'r1' })
    r.frame({ ev: 'trigger-delivery', fire: { id: 't' } })
    r.frame({ ev: 'stream-data', sid: 'zzz', d: '' })
    r.frame({ id: 3, ok: true })
    expect(r.events).toEqual([{ ev: 'gateway-request', relayId: 'r1' }, { ev: 'trigger-delivery', fire: { id: 't' } }])
    expect(r.link.heard()).toBeLessThan(1_000)
  })

  it('opens a stream to the leader through the client, takes the leader\'s, and refuses to open one to a follower', async () => {
    const r = await following()
    const opening = r.link.openStream('primary', 'web')
    await until('stream.open sent', () => r.client.sent.some((f) => f.cmd === 'stream.open'))
    const open = r.client.sent.find((f) => f.cmd === 'stream.open')!
    expect(open).toMatchObject({ cmd: 'stream.open', to: 'primary', purpose: 'web' })
    r.frame({ ev: 'stream-accept', sid: open.sid })
    const stream = await opening
    stream.write('hello')
    await until('data sent', () => r.client.sent.some((f) => f.cmd === 'stream.data'))
    stream.destroy()
    await expect(r.link.openStream('follower', 'web')).rejects.toThrow(/primary or the companion/)
    r.link.stop()
    await expect(r.link.openStream('primary', 'web')).rejects.toThrow(/not linked/)
  })

  it('plugs in the stream the leader opens to this server through the daemon, or refuses it', async () => {
    const accepted: string[] = []
    const r = rig()
    r.link.stop()
    const link = createDirectFollowerLink({
      walnutId: WALNUT, home: HOME, host: 'devbox', pollMs: 15, log: () => {},
      accept: (info) => (info.from === 'primary' ? (s) => { accepted.push(info.sid); s.destroy() } : null),
      seat: () => r.seat,
    })
    links.push(link)
    link.start()
    await until('following', () => link.linkState() === 'following')
    r.frame({ ev: 'stream-open', sid: 'rA1', from: 'primary', home: HOME })
    r.frame({ ev: 'stream-open', sid: 'rB2', from: 'companion', home: HOME })
    expect(accepted).toEqual(['rA1'])
    expect(r.client.sent.filter((f) => f.cmd === 'stream.accept').map((f) => f.sid)).toEqual(['rA1'])
    expect(r.client.sent.filter((f) => f.cmd === 'stream.close').map((f) => f.sid)).toContain('rB2')
  })
})

describe('the table is the follower\'s whole command set', () => {
  const standalone = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
  /** The follower.* commands the daemon dispatches: each is a call of the seat, or travels the client with a reason. */
  const DISPATCHED = [...standalone.matchAll(/case '(follower\.[a-z.]+)'/g)].map((m) => m[1]!)
  const BY_CLIENT: Record<string, string> = {
    'follower.hello': 'the seat is the hello: attach() seats this server with no frame',
    'follower.report': 'it changes the follower socket\'s own state (answersOnline, callSocket): link.report sends it on the client',
    'follower.gateway': 'a line of the host call entry: checked against the follower socket and answered when the call is, not a call of the entry',
    'follower.trigger.deliver': 'answers the offer made to the follower socket: it needs that socket',
  }
  it('every follower.* command the daemon handles is a call of the seat, or goes by the client for a stated reason', () => {
    expect(DISPATCHED.length).toBeGreaterThanOrEqual(14)
    for (const cmd of DISPATCHED) {
      expect(cmd in FOLLOWER_CALLS || cmd in BY_CLIENT, `${cmd} is neither in FOLLOWER_CALLS nor a command that goes by the client`).toBe(true)
    }
    for (const cmd of Object.keys(FOLLOWER_CALLS)) expect(DISPATCHED, `${cmd} is not a command the daemon handles`).toContain(cmd)
  })
})

// Review A3b S56-L3 and L5: the seat the link holds can be taken, and a declared move moves its home.
describe('the seat it holds', () => {
  it('takes the seat back when another follower took it (a socket hello with this Walnut\'s token)', async () => {
    const r = await following()
    expect(r.attachedWith).toHaveLength(1)
    r.set.seated = null
    await until('seated again', () => r.attachedWith.length === 2)
    expect(r.client.closed).toBe(1)
    expect(r.attachedWith[1]).toMatchObject({ home: HOME })
    expect(r.link.linkState()).toBe('following')
    // Seated, it stays as it is: no more attaches.
    await new Promise((x) => setTimeout(x, 60))
    expect(r.attachedWith).toHaveLength(2)
  })

  it('calls and polls with the home the seat holds now, after a declared move made the started home its alias', async () => {
    const FIRST = '/acme/first-home'
    const r = await following()
    r.set.seated = FIRST
    await until('a poll with the seat\'s home', () => (r.seat.view as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === FIRST))
    expect(await r.link.request('follower.sessions')).toMatchObject({ ok: true })
    expect((r.seat.sessions as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe(FIRST)
    await r.link.request('follower.op', { op: { kind: 'task-update' } })
    expect((r.seat.op as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe(FIRST)
    // Still the one seat: a moved home is no lost seat.
    expect(r.attachedWith).toHaveLength(1)
  })
})

describe('one presence (a service without a copy)', () => {
  it('liveView: the view is the seat\'s at the moment it is read, not one poll old', async () => {
    const live = await following(undefined, { pollMs: 60_000, liveView: true })
    const polled = await following(undefined, { pollMs: 60_000 })
    expect(live.link.view()?.view.primaryConnected).toBe(true)
    expect(polled.link.view()?.view.primaryConnected).toBe(true)
    live.set.view = { ...VIEW, primaryConnected: false }
    polled.set.view = { ...VIEW, primaryConnected: false }
    await vi.waitFor(() => expect(live.link.view()?.view.primaryConnected).toBe(false), { timeout: 2_000, interval: 50 })
    // The polled link still holds the view of its last poll (a minute away).
    expect(polled.link.view()?.view.primaryConnected).toBe(true)
    // Read again at most every 200 ms: a second read at once asks the seat no more.
    const asked = (live.seat.view as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    live.link.view()
    expect((live.seat.view as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(asked)
    // Paused for a swap (the seat answers no view): once it was asked again, the last view stands.
    live.set.view = null
    await vi.waitFor(() => { live.link.view(); expect((live.seat.view as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(asked) }, { timeout: 2_000, interval: 50 })
    expect(live.link.view()?.view.primaryConnected).toBe(false)
  })
})
