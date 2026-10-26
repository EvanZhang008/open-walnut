/**
 * A '__local__' dial still running when the pool is reset (disconnectAllDaemons at
 * shutdown) belongs to nobody (src/providers/daemon-connection.ts: connect() and its
 * catch, setPhase('failed')'s setImmediate, the socket's 'message' callback, the
 * offline-journal and trigger continuations, and getDaemonConnectionOrThrow). The REAL
 * connect(), connectWebSocket() (its open, error, close, message and pong callbacks and
 * its open timer), verifyCapabilities() (a hello written to the socket and answered on
 * it), handleMessage(), dispatchTriggerEvent() and setConnected() run. Fakes only at the
 * leaves: the 'ws' module (a socket the test drives: open, frames, error, close),
 * localDaemon.ensureRunning / wsUrl / pid, annotateCredentialFailure, the connected edge's
 * eight leaves, the leader refresh, the handover note (offline-handover's noteHandoverDue)
 * and the trigger sink (registered through trigger-bridge).
 * No daemon, no real socket, no signal, no child process. Fake clocks for setTimeout
 * only (the socket's open timer); setImmediate stays real.
 *
 * The reset lands before or after each step: ensureRunning, the socket's open, the hello,
 * the catch's annotation, the failed phase's setImmediate. Each case pins the whole set
 * an abandoned dial must leave alone: no connected edge, no leaf, no frame reaching
 * handleMessage, no host-connected or phase notice, no failure cached, the newer owner's
 * reconnect cause kept, and only its own socket closed, once. A newer owner connects
 * normally (hello, a command answered, its events), and an old dial settling late (open,
 * error, its open timer, frames on its socket) touches none of it. An event an instance
 * took while it still owned the key (offline-journal, trigger.fired), with the reset or a
 * replacement after it, notes no handover, reaches no sink and pushes no host slice: asserted
 * after awaiting the very promise handleMessage returned for that frame (the event's own
 * chain), with a connected newer owner and its command in flight left alone. This proves the
 * event chain and its push call boundary, not that a push already under way has settled.
 * A rejected import promise itself is NOT VERIFIED: no safe seam expresses it here.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  /** The 'ws' client as connectWebSocket uses it; the test plays the daemon end and the network. */
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static made: FakeWebSocket[] = []
    static born: ((ws: FakeWebSocket) => void) | null = null
    static registering: ((ws: FakeWebSocket, ev: string, fn: Handler) => Handler) | null = null
    readyState = 0
    sent: string[] = []
    closes = 0
    private handlers = new Map<string, Handler[]>()
    constructor(readonly url: string, readonly opts: Record<string, unknown>) { FakeWebSocket.made.push(this); FakeWebSocket.born?.(this) }
    on(ev: string, fn: Handler): this {
      const kept = FakeWebSocket.registering?.(this, ev, fn) ?? fn
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), kept])
      return this
    }
    count(ev: string): number { return this.handlers.get(ev)?.length ?? 0 }
    emit(ev: string, ...args: unknown[]): void { for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...args) }
    send(data: unknown): void { this.sent.push(String(data)) }
    close(): void { this.closes++; if (this.readyState < 2) this.readyState = 2 }
    terminate(): void { this.closes++; this.readyState = 3 }
    ping(): void {}
    open(): void { this.readyState = 1; this.emit('open') }
    fail(err: Error): void { this.emit('error', err) }
    closed(): void { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)) }
    frame(msg: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(msg))) }
    commands(): Array<{ id: number; cmd: string }> { return this.sent.map((s) => JSON.parse(s)) }
  }
  return { FakeWebSocket }
})

vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, WebSocket: fake.FakeWebSocket, default: fake.FakeWebSocket }
})
// daemon-connection imports `#ws`, which bun resolves to src/lib/ws-npm.ts (the npm package by path), not to `ws`.
vi.mock('#ws', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, WebSocket: fake.FakeWebSocket, default: fake.FakeWebSocket }
})
vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/providers/ssh-credential-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, annotateCredentialFailure: vi.fn() }
})
const handover = vi.hoisted(() => ({ notes: [] as string[], rejectNext: false, onNote: null as null | (() => void) }))
vi.mock('../../src/core/offline-handover.js', async (importOriginal) => {
  const mod: Record<string, unknown> = { ...(await importOriginal<Record<string, unknown>>()) }
  // The handover note, a leaf: recorded, then onNote. Reading the export can be made to fail once:
  // the import has fulfilled, and the then rejects while reading it, before the note (then catch,
  // then finally). That is an export read failure, not a rejected import.
  Object.defineProperty(mod, 'noteHandoverDue', {
    enumerable: true,
    get() {
      if (handover.rejectNext) { handover.rejectNext = false; throw new Error('handover export read failed') }
      return (host: string) => { handover.notes.push(host); handover.onNote?.() }
    },
  })
  return mod
})

import {
  DaemonConnection, addOnDaemonHostConnected, addOnDaemonPhaseChange, clearDaemonFailureCache,
  daemonConnectWouldWait, disconnectAllDaemons, getConnectedDaemonConnection, getDaemonConnectState,
  getDaemonConnection, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { clearReconnectCause, getReconnectCause, recordReconnectCause } from '../../src/providers/daemon-reconnect-cause.js'
import { LocalDaemon, localDaemon } from '../../src/providers/local-daemon.js'
import { annotateCredentialFailure } from '../../src/providers/ssh-credential-evidence.js'
import { setTriggerEventSink } from '../../src/core/routines/trigger-bridge.js'
// The connected edge, a connected instance's disconnect and the events import these (trigger-bridge
// above too): loaded here, so those imports resolve from the module cache under the fake setTimeout.
import '../../src/core/host-replica.js'
import '../../src/core/host-server/index.js'
import '../../src/core/offline-handover.js'

type Ws = InstanceType<typeof fake.FakeWebSocket>
const LOCAL = '__local__'
const LEAVES = ['pushBridgeConfig', 'pushDaemonHooks', 'pushTriggers', 'pushHostSlice', 'pushSkillSync', 'startBridgeRepush', 'dialBulkChannel', 'startPing'] as const
const EVENT_LEAVES = ['refreshLeader'] as const
/** Recorded after the reset: the key's newer owner's. standing:false, so it never stands in for a cached error. */
const NEWER_CAUSE = { summary: 'newer owner cause', kind: 'unknown', since: 1, at: 2, standing: false }
const proto = DaemonConnection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
// The real clock, taken before any test fakes setTimeout: only cleanup's deadline uses it.
if (vi.isFakeTimers()) throw new Error('fake timers were installed before the real clock was taken')
const realClock = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
const SETTLE_DEADLINE_MS = 5_000
type Settle = 'pending' | 'fulfilled' | 'rejected'
type OpenTimer = { handle: unknown; ms: unknown; args: unknown[]; run: (...a: unknown[]) => void; ran: number; clearedWith: unknown[] }
type Open = { label: string; owner: DaemonConnection; ws: Ws | null; timer: OpenTimer | null; bindError: string | null; settledHere: boolean }
type Run = (fn: () => unknown) => void
/** The setup steps entered, the last one in progress until 'complete'. */
type Setup = { steps: string[]; offs: Array<() => void> }
type ResetResult = { entered: boolean; done: string[]; failed?: { step: string; error: unknown } }

function timerEnd(o: Open): 'fired' | 'cleared' | 'settled here' | 'unbound' | 'unproven' {
  const t = o.timer
  if (o.bindError || !t) return 'unbound'
  if (t.ran === 1) return o.settledHere ? 'settled here' : 'fired'
  if (t.ran === 0 && t.clearedWith.length === 1 && t.clearedWith[0] === t.handle) return 'cleared'
  return 'unproven'
}

function seams(setup: Setup) {
  const at = (step: string) => { setup.steps.push(step) }
  let ensure: Promise<number> = Promise.resolve(1)
  at('ensureRunning spy'); vi.spyOn(localDaemon, 'ensureRunning').mockImplementation(() => ensure)
  at('wsUrl spy'); vi.spyOn(LocalDaemon.prototype, 'wsUrl', 'get').mockReturnValue('ws://127.0.0.1:1')
  // A live link's close probes the daemon pid with signal 0: never a real pid here.
  at('pid spy'); vi.spyOn(LocalDaemon.prototype, 'pid', 'get').mockReturnValue(null)
  const annotations: Array<() => void> = []
  const ensureReleases: Array<() => void> = []
  let hold = false
  at('annotation mock')
  vi.mocked(annotateCredentialFailure).mockReset().mockImplementation((err) => hold
    ? new Promise((resolve) => { annotations.push(() => resolve(err)) })
    : Promise.resolve(err))
  // A rejection is recorded, never swallowed: the test still awaits the promise itself.
  const originals = new Map<Promise<unknown>, { label: string; state: Settle }>()
  const observe = <T>(p: Promise<T>, kind: string): Promise<T> => {
    if (originals.has(p)) return p
    const rec = { label: `${kind}#${originals.size}`, state: 'pending' as Settle }
    originals.set(p, rec)
    p.then(() => { rec.state = 'fulfilled' }, () => { rec.state = 'rejected' })
    return p
  }
  const pendingLabels = () => [...originals.values()].filter((o) => o.state === 'pending').map((o) => o.label)
  // Call-through spies, read per instance (mock.contexts).
  at('connect spy'); const connects = vi.spyOn(proto, 'connect')
  at('setConnected spy'); const edge = vi.spyOn(proto, 'setConnected')
  // Registered before anyone reads it, so a failing jobsOf still leaves it to cleanup.
  const realHandleMessage = proto.handleMessage
  at('handleMessage spy')
  const handled = vi.spyOn(proto, 'handleMessage').mockImplementation(function (this: DaemonConnection, ...args: unknown[]) {
    const r = realHandleMessage.apply(this, args)
    if (r instanceof Promise) observe(r, 'event')
    return r
  })
  at('handleConnectionLost spy'); const lost = vi.spyOn(proto, 'handleConnectionLost')
  // Bound by position, never guessed from a delay or a count of timers.
  const opens: Open[] = []
  const strays: Ws[] = []
  let building: Open | null = null
  let unhook: (() => void) | null = null
  const realConnectWebSocket = proto.connectWebSocket
  at('connectWebSocket spy')
  vi.spyOn(proto, 'connectWebSocket').mockImplementation(function (this: DaemonConnection, ...args: unknown[]) {
    const rec: Open = { label: 'open (no promise)', owner: this, ws: null, timer: null, bindError: null, settledHere: false }
    opens.push(rec)
    building = rec
    try {
      const p = observe(realConnectWebSocket.apply(this, args) as Promise<void>, 'open')
      rec.label = originals.get(p)!.label
      return p
    } finally {
      // Every way out (a return, a throw): the setTimeout entry restored, the binding let go.
      building = null
      unhook?.()
      if (!rec.timer) rec.bindError ??= rec.ws ? 'no open timer after its socket' : 'no socket built'
    }
  })
  at('socket hooks')
  fake.FakeWebSocket.born = (ws) => {
    const rec = building
    building = null
    if (!rec) { strays.push(ws); return }
    rec.ws = ws
    const g = globalThis as unknown as { setTimeout: (...a: unknown[]) => unknown }
    const entry = g.setTimeout
    const hook = function (this: unknown, fn: (...a: unknown[]) => void, ms?: unknown, ...args: unknown[]) {
      unhook?.()
      const listeners = ['open', 'error', 'close', 'message', 'pong'].map((ev) => ws.count(ev)).join()
      if (listeners !== '1,1,1,1,1') {
        rec.bindError ??= `the first setTimeout after its socket came with listeners ${listeners}`
        return entry.call(this, fn, ms, ...args)
      }
      const timer: OpenTimer = { handle: null, ms, args, ran: 0, clearedWith: [], run: (...a) => { timer.ran++; fn(...a) } }
      timer.handle = entry.call(this, timer.run, ms, ...args)
      rec.timer = timer
      return timer.handle
    }
    g.setTimeout = hook
    unhook = () => {
      unhook = null
      if (g.setTimeout === hook) g.setTimeout = entry
      else rec.bindError ??= 'the setTimeout entry changed under its hook'
    }
  }
  fake.FakeWebSocket.registering = (ws, ev, fn) => {
    const rec = ev === 'open' && ws.count('open') === 1 ? opens.find((o) => o.ws === ws) : undefined
    if (!rec) return fn
    const timer = rec.timer
    if (!timer) { rec.bindError ??= 'its second open listener came before its open timer'; unhook?.(); return fn }
    // An open proves nothing by itself: record the handle this listener hands the real clearTimeout.
    return (...a: unknown[]) => {
      const g = globalThis as unknown as { clearTimeout: (h: unknown) => void }
      const entry = g.clearTimeout
      const seen = function (this: unknown, h: unknown) { timer.clearedWith.push(h); return entry.call(this, h) }
      g.clearTimeout = seen
      try { fn(...a) } finally {
        if (g.clearTimeout === seen) g.clearTimeout = entry
        else rec.bindError ??= 'the clearTimeout entry changed under its hook'
      }
    }
  }
  const leaves = LEAVES.map((name) => { at(`${name} leaf`); return vi.spyOn(proto, name).mockImplementation(() => undefined) })
  const eventLeaves = EVENT_LEAVES.map((name) => { at(`${name} leaf`); return vi.spyOn(proto, name).mockImplementation(() => undefined) })
  // The trigger sink, a leaf; dispatchTriggerEvent itself runs (its import, its check, its call).
  const sink = vi.fn()
  at('trigger sink'); setTriggerEventSink(sink)
  at('handover reset')
  handover.notes.length = 0
  handover.rejectNext = false
  handover.onNote = null
  const hostConnected: string[] = []
  const phases: Array<{ phase: string; error?: string }> = []
  const offs = setup.offs
  at('host-connected listener'); offs.push(addOnDaemonHostConnected((k) => { hostConnected.push(k) }))
  at('phase listener'); offs.push(addOnDaemonPhaseChange((st) => { phases.push({ phase: st.phase, ...(st.error ? { error: st.error } : {}) }) }))
  at('complete')
  const by = (spy: { mock: { contexts: unknown[] } }, c: DaemonConnection) => spy.mock.contexts.filter((x) => x === c).length
  return {
    hostConnected, phases, annotations, sink, observe,
    stateOf: (p: Promise<unknown>) => originals.get(p)?.state,
    originalsOf: (kind: string) => [...originals.values()].filter((o) => o.label.startsWith(`${kind}#`)),
    pending: pendingLabels,
    opens: () => [...opens],
    openOf: (ws: Ws) => opens.find((o) => o.ws === ws)!,
    // A: a parked or unpooled instance too.
    invalidate(run: Run) {
      const mine = new Set<DaemonConnection>([...(connects.mock.contexts as unknown as DaemonConnection[]), ...opens.map((o) => o.owner)])
      for (const conn of mine) run(() => conn.disconnect())
      run(() => disconnectAllDaemons())
    },
    release(run: Run) { for (const r of [...ensureReleases, ...annotations]) run(r) },
    // C: returns what stays unproven.
    settleOpenTimers(run: Run): string[] {
      const unproven = strays.map((_, i) => `a socket no connectWebSocket call built (#${i})`)
      for (const o of opens) {
        const t = o.timer
        if (t && !o.bindError && t.ran === 0 && t.clearedWith.length === 0) {
          run(() => {
            (globalThis.clearTimeout as (h: unknown) => void)(t.handle)
            o.settledHere = true
            t.run(...t.args)
          })
        }
        const end = timerEnd(o)
        if (end === 'unbound' || end === 'unproven') unproven.push(`${o.label}: ${o.bindError ?? `its open timer ran ${t?.ran}, cleared with ${t?.clearedWith.length} handles`}`)
        else run(() => expect(t!.ms).toBe(10_000))
      }
      return unproven
    },
    // D: the deadline only reports what is still pending; it is no evidence of settling.
    async settled(): Promise<string[]> {
      let deadline: unknown
      const late = new Promise<'deadline'>((resolve) => { deadline = realClock.setTimeout(() => resolve('deadline'), SETTLE_DEADLINE_MS) })
      try {
        for (;;) {
          const snapshot = [...originals.keys()]
          const first = await Promise.race([Promise.allSettled(snapshot).then(() => 'settled' as const), late])
          if (first === 'deadline') return pendingLabels().length > 0 ? pendingLabels() : ['(the deadline came first)']
          // Born while it waited: wait for those too.
          if (originals.size === snapshot.length) return pendingLabels()
        }
      } finally {
        realClock.clearTimeout(deadline as ReturnType<typeof setTimeout>)
      }
    },
    // Not entered with a hook in place: the clock's uninstall would delete that global.
    reset(): ResetResult {
      if (unhook || building) return { entered: false, done: [], failed: { step: 'a setTimeout hook still in place', error: null } }
      const steps: Array<[string, () => void]> = [
        ['listeners', () => { for (const off of offs) off(); setTriggerEventSink(null) }],
        ['failure cache', () => clearDaemonFailureCache()],
        ['reconnect cause', () => clearReconnectCause()],
        ['handover', () => { handover.notes.length = 0; handover.rejectNext = false; handover.onNote = null }],
        ['socket hooks', () => { fake.FakeWebSocket.born = null; fake.FakeWebSocket.registering = null }],
        ['real clock', () => vi.useRealTimers()],
        ['spies', () => vi.restoreAllMocks()],
        ['socket list', () => { fake.FakeWebSocket.made.length = 0 }],
      ]
      const done: string[] = []
      for (const [step, fn] of steps) {
        try { fn() } catch (error) { return { entered: true, done, failed: { step, error } } }
        done.push(step)
      }
      return { entered: true, done }
    },
    /** Every instance a connect() ran on, a parked or unpooled one included. */
    dialers: () => [...new Set(connects.mock.contexts)] as unknown as DaemonConnection[],
    handledCalls: () => handled.mock.calls.length,
    /**
     * The promises handleMessage returned on `conn` for exactly these frames, from call index
     * `from`: its calls since then must be these frames' raw text, in order, no more and no fewer,
     * and each must have returned a Promise (a throw, or no Promise, fails here). Each was registered
     * when handleMessage returned it.
     */
    jobsOf(conn: DaemonConnection, from: number, frames: Array<Record<string, unknown>>): Array<Promise<void>> {
      const mine = handled.mock.calls.map((args, i) => ({ i, raw: args[0], result: handled.mock.results[i] }))
        .filter(({ i }) => i >= from && handled.mock.contexts[i] === conn)
      expect(mine.map(({ raw }) => raw)).toEqual(frames.map((f) => JSON.stringify(f)))
      return mine.map(({ result }) => {
        expect(result.type).toBe('return')
        expect(result.value).toBeInstanceOf(Promise)
        return observe(result.value as Promise<void>, 'event')
      })
    },
    holdAnnotations() { hold = true },
    holdEnsure() {
      let release!: () => void
      ensure = new Promise<number>((r) => { release = () => r(1) })
      ensureReleases.push(release)
      return () => release()
    },
    /** The instance whose connect() the pool ran nth. */
    dialer: (n: number) => connects.mock.contexts[n] as unknown as DaemonConnection,
    /** setConnected(true) calls this instance made: the connected edge. */
    edgesOf: (c: DaemonConnection) => edge.mock.calls.filter((call, i) => edge.mock.contexts[i] === c && call[0] === true).length,
    handledOf: (c: DaemonConnection) => by(handled, c),
    lostOf: (c: DaemonConnection) => by(lost, c),
    leafCounts: (c: DaemonConnection) => LEAVES.map((name, i) => [name, by(leaves[i], c)]),
    eventLeafCounts: (c: DaemonConnection) => EVENT_LEAVES.map((name, i) => [name, by(eventLeaves[i], c)]),
    mark: () => ({ hostConnected: hostConnected.length, phases: phases.length, sink: sink.mock.calls.length, notes: handover.notes.length }),
  }
}
type Seams = ReturnType<typeof seams>
let current: Seams | null = null
/** Who answers for the fake clock: this file's hooks (no world took it), a world, or nobody. */
let clock: 'hooks' | 'world' | 'real' = 'real'
/** The file lock; `at` says how far things got: a setup stopped part way, a world not reset, a reset stopped after `done`. */
let failedWorld: { test: string; at: string; labels: string[]; errors: unknown[]; world?: Seams; setup?: Setup; done?: string[] } | null = null
function lockFile(f: Omit<NonNullable<typeof failedWorld>, 'test'>): Error {
  failedWorld = { test: expect.getState().currentTestName ?? '(unknown test)', ...f }
  return new Error(`cleanup FAIL (${f.at}), ${f.errors.length} errors: ${f.labels.join('; ')}`, { cause: f.errors })
}
function refuseAfterFailedWorld() {
  if (failedWorld) throw new Error(`an earlier test (${failedWorld.test}) locked this file (${failedWorld.at}): ${failedWorld.labels.join('; ')}`)
}
const start = () => {
  refuseAfterFailedWorld()
  expect(current).toBeNull()
  expect(clock).toBe('hooks')
  const setup: Setup = { steps: [], offs: [] }
  try {
    current = seams(setup)
  } catch (err) {
    lockFile({ at: `setup stopped in ${setup.steps.at(-1) ?? 'its first step'}`, labels: setup.steps, errors: [err], setup })
    throw err
  }
  clock = 'world'
  return current
}
/** E runs only when A, B, C and D raised nothing and C and D proved everything done. */
async function end(w: Seams): Promise<void> {
  const errors: unknown[] = []
  const run: Run = (fn) => { try { fn() } catch (err) { errors.push(err) } }
  const open: string[] = []
  run(() => w.invalidate(run))
  run(() => w.release(run))
  run(() => { open.push(...w.settleOpenTimers(run)) })
  try { open.push(...await w.settled()) } catch (err) { errors.push(err) }
  if (errors.length > 0 || open.length > 0) throw lockFile({ at: 'not reset', labels: open, errors, world: w })
  // A hook that timed out while this end waited may have locked the file meanwhile.
  refuseAfterFailedWorld()
  let r: ResetResult
  try { r = w.reset() } catch (err) { throw lockFile({ at: 'reset threw outside its steps', labels: [], errors: [err], world: w }) }
  if (r.failed) {
    const at = r.entered ? `reset stopped at ${r.failed.step}` : `not reset: ${r.failed.step}`
    throw lockFile({ at, labels: [], errors: r.failed.error === null ? [] : [r.failed.error], world: w, done: r.done })
  }
  clock = 'real'
  if (current === w) current = null
}

const sockets = (): Ws[] => fake.FakeWebSocket.made
const turn = () => new Promise((r) => setImmediate(r))
/** Lets connect() pass its awaits (a dynamic import, the ensure, the socket, the hello). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await turn()
  expect(cond()).toBe(true)
}
/**
 * setPhase('failed') announces from a setImmediate: past it. setImmediate callbacks run in the order
 * they were queued, so once one queued here has run, every one queued before it has run too.
 */
const settle = async () => { for (let i = 0; i < 3; i++) await turn() }
/** A dial's promise, registered at once (it may reject while the test awaits something else). */
const dial = () => {
  expect(current).not.toBeNull()
  return current!.observe(getDaemonConnection(LOCAL, { hostname: LOCAL }), 'dial')
}
const helloOf = (ws: Ws) => ws.commands().find((c) => c.cmd === 'hello')
/** The daemon's hello answer: every required capability, and no instanceId, so the edge asks no cron metadata. */
function answerHello(ws: Ws) {
  const hello = helloOf(ws)
  expect(hello).toBeDefined()
  ws.frame({ id: hello!.id, ok: true, capabilities: [...REQUIRED_DAEMON_CAPABILITIES], version: 'test', runtime: 'node' })
}
/** What a daemon may still send on a socket it has not seen close: a reply, then the three events keyed by host. */
function lateFrames(ws: Ws, replyId: number) {
  ws.frame({ id: replyId, ok: true })
  ws.frame({ ev: 'offline-journal' })
  ws.frame({ ev: 'leader-lost' })
  ws.frame({ ev: 'trigger.fired', id: 'trig-old' })
}
const wsOf = (c: DaemonConnection) => (c as unknown as { ws: Ws | null }).ws
const pingOf = (c: DaemonConnection) => (c as unknown as { pingTimer: unknown }).pingTimer

/** Everything an abandoned dial must not have done (`handled`: frames it took before the reset). */
function expectInert(s: Seams, conn: DaemonConnection, mark: ReturnType<Seams['mark']>, handled = 0) {
  expect(conn.connected).toBe(false)
  expect(s.edgesOf(conn)).toBe(0)
  expect(s.leafCounts(conn)).toEqual(LEAVES.map((n) => [n, 0]))
  expect(s.eventLeafCounts(conn)).toEqual(EVENT_LEAVES.map((n) => [n, 0]))
  expect(s.handledOf(conn)).toBe(handled)
  expect(s.lostOf(conn)).toBe(0)
  expect(wsOf(conn)).toBeNull()
  expect(pingOf(conn)).toBeNull()
  expect(s.hostConnected.slice(mark.hostConnected)).toEqual([])
  expect(s.phases.slice(mark.phases)).toEqual([])
  expect(s.sink.mock.calls.slice(mark.sink)).toEqual([])
  expect(handover.notes.slice(mark.notes)).toEqual([])
}
/** The key after an abandoned dial on a cold pool: no failure cached, the newer cause kept. */
function expectKeyCold() {
  expect(daemonConnectWouldWait(LOCAL)).toBe('cold')
  const st = getDaemonConnectState(LOCAL)
  expect(st.error).toBeUndefined()
  expect(st.retryInMs).toBeUndefined()
  expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
}

beforeEach(() => {
  refuseAfterFailedWorld()
  // A previous afterEach that timed out leaves both behind.
  if (clock !== 'real' || current) throw lockFile({ at: `a test left the clock ${clock}${current ? ' and its world' : ''}`, labels: [], errors: [] })
  try { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) } catch (err) {
    throw lockFile({ at: 'fake clock install', labels: [], errors: [err] })
  }
  clock = 'hooks'
})
afterEach(async () => {
  refuseAfterFailedWorld()
  if (current) return end(current)
  if (clock === 'real') return
  // Only the clock beforeEach installed and no world took (a source-only test).
  if (clock !== 'hooks') throw lockFile({ at: `the clock is held by a world that is gone (${clock})`, labels: [], errors: [] })
  try { vi.useRealTimers() } catch (err) { throw lockFile({ at: 'fake clock uninstall', labels: [], errors: [err] }) }
  clock = 'real'
})

describe('the reset lands while a __local__ dial runs', () => {
  it('before its socket opens: the open closes only its own socket, no hello goes out', async () => {
    const s = start()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    // The real connectWebSocket: its callbacks on the socket (two on open: the link and the timer).
    expect(ws0.url).toBe('ws://127.0.0.1:1')
    expect(['open', 'error', 'close', 'message', 'pong', 'unexpected-response'].map((ev) => ws0.count(ev))).toEqual([2, 1, 1, 1, 1, 0])
    disconnectAllDaemons()
    expect(ws0.closes).toBe(0)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    ws0.open()
    await expect(old).rejects.toThrow(/closed while it connected/)
    lateFrames(ws0, 1)
    ws0.closed()
    await settle()
    expect(ws0.sent).toEqual([])
    expect(ws0.closes).toBe(1)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })

  it('right after its socket opens, before connect() resumes: the reset closes it once, no hello goes out', async () => {
    const s = start()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    ws0.open()
    // Same tick: the open's continuation has not run.
    disconnectAllDaemons()
    expect(ws0.closes).toBe(1)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    await expect(old).rejects.toThrow(/closed while it connected/)
    lateFrames(ws0, 1)
    ws0.closed()
    await settle()
    expect(ws0.sent).toEqual([])
    expect(ws0.closes).toBe(1)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })

  it('after its hello went out, before the answer: the answer and the keyed events on its socket never reach handleMessage', async () => {
    const s = start()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    ws0.open()
    await until(() => helloOf(ws0) !== undefined)
    disconnectAllDaemons()
    expect(ws0.closes).toBe(1)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    answerHello(ws0)
    lateFrames(ws0, helloOf(ws0)!.id)
    ws0.closed()
    await expect(old).rejects.toThrow(/closed while it connected/)
    await settle()
    expect(ws0.commands().map((c) => c.cmd)).toEqual(['hello'])
    expect(ws0.closes).toBe(1)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })

  it('after its hello was answered, before connect() resumes: no connected edge', async () => {
    const s = start()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    ws0.open()
    await until(() => helloOf(ws0) !== undefined)
    answerHello(ws0)
    // Same tick: the hello's continuation has not run.
    disconnectAllDaemons()
    expect(ws0.closes).toBe(1)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    await expect(old).rejects.toThrow(/closed while it connected/)
    lateFrames(ws0, 99)
    ws0.closed()
    await settle()
    expect(ws0.closes).toBe(1)
    // One frame reached it, before the reset: the hello answer.
    expectInert(s, oldConn, mark, 1)
    expectKeyCold()
  })

  it('during ensureRunning: no socket is built', async () => {
    const s = start()
    const release = s.holdEnsure()
    const old = dial()
    await until(() => vi.mocked(localDaemon.ensureRunning).mock.calls.length === 1)
    const oldConn = s.dialer(0)
    disconnectAllDaemons()
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    release()
    await expect(old).rejects.toThrow(/closed while it connected/)
    await settle()
    expect(sockets()).toHaveLength(0)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })
})

describe('a failing __local__ dial and the reset (connect()\'s catch)', () => {
  it('the reset before its socket fails: the catch ends at once, no annotation, no failed phase', async () => {
    const s = start()
    s.holdAnnotations()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    disconnectAllDaemons()
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    ws0.fail(new Error('ECONNREFUSED'))
    await expect(old).rejects.toThrow(/WebSocket connection failed: ECONNREFUSED/)
    await settle()
    expect(annotateCredentialFailure).not.toHaveBeenCalled()
    expect(oldConn.connectPhase).toBe('idle')
    expect(oldConn.reconnectPending).toBe(false)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })

  it('the reset while the catch awaits the annotation: after it, no failed phase, no reconnect, nothing cached or announced', async () => {
    const s = start()
    s.holdAnnotations()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    ws0.fail(new Error('ECONNREFUSED'))
    await until(() => s.annotations.length === 1)
    disconnectAllDaemons()
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    s.annotations[0]()
    await expect(old).rejects.toThrow(/WebSocket connection failed: ECONNREFUSED/)
    await settle()
    expect(oldConn.connectPhase).toBe('idle')
    expect(oldConn.reconnectPending).toBe(false)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })

  it('control, no reset: one failed notice, after the annotation and the cache write; a reset after its setImmediate adds nothing', async () => {
    const s = start()
    s.holdAnnotations()
    const attempt = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const conn = s.dialer(0)
    const mark = s.mark()
    ws0.fail(new Error('ECONNREFUSED'))
    await until(() => s.annotations.length === 1)
    await settle()
    expect(s.phases.slice(mark.phases)).toEqual([])
    s.annotations[0]()
    await expect(attempt).rejects.toThrow(/WebSocket connection failed: ECONNREFUSED/)
    await settle()
    expect(conn.connectPhase).toBe('failed')
    expect(s.phases.slice(mark.phases)).toEqual([{ phase: 'failed', error: expect.stringMatching(/ECONNREFUSED/) }])
    expect(daemonConnectWouldWait(LOCAL)).toBe('fails-fast')
    disconnectAllDaemons()
    await settle()
    expect(s.phases.slice(mark.phases)).toHaveLength(1)
  })
})

describe('setPhase(\'failed\') announces from a setImmediate, for the owner at delivery', () => {
  it('control: a pooled instance\'s uncached failed phase speaks once, from the setImmediate', async () => {
    const s = start()
    const conn = new DaemonConnection(LOCAL, { hostname: LOCAL })
    setPooledConnectionForTest(LOCAL, conn)
    const mark = s.mark()
    conn.setPhaseForTest('failed')
    expect(s.phases.slice(mark.phases)).toEqual([])
    await settle()
    expect(s.phases.slice(mark.phases)).toEqual([{ phase: 'failed' }])
  })

  it('the pool lets go between the schedule and the setImmediate: it says nothing', async () => {
    const s = start()
    const conn = new DaemonConnection(LOCAL, { hostname: LOCAL })
    setPooledConnectionForTest(LOCAL, conn)
    const mark = s.mark()
    conn.setPhaseForTest('failed')
    disconnectAllDaemons()
    await settle()
    expect(s.phases.slice(mark.phases)).toEqual([])
  })

  it('the reset right after connect()\'s catch set failed: its setImmediate says nothing, the pool caches nothing', async () => {
    const s = start()
    const realSetPhase = proto.setPhase
    vi.spyOn(proto, 'setPhase').mockImplementation(function (this: DaemonConnection, phase: unknown) {
      realSetPhase.call(this, phase)
      // After the schedule, before the setImmediate runs; the newer owner's cause comes with it.
      if (phase === 'failed') { disconnectAllDaemons(); recordReconnectCause(LOCAL, NEWER_CAUSE) }
    })
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    const mark = s.mark()
    ws0.fail(new Error('ECONNREFUSED'))
    await expect(old).rejects.toThrow(/WebSocket connection failed: ECONNREFUSED/)
    await settle()
    // Set while it still owned the key (both checks passed); never announced.
    expect(oldConn.connectPhase).toBe('failed')
    expect(oldConn.reconnectPending).toBe(false)
    expectInert(s, oldConn, mark)
    expectKeyCold()
  })
})

/** An old dial abandoned by the reset (`stage`: how far it got), then a newer owner connected for real. */
async function freshOverOld(s: Seams, stage: 'opening' | 'hello') {
  const old = dial()
  await until(() => sockets().length === 1)
  const ws0 = sockets()[0]
  const oldConn = s.dialer(0)
  if (stage === 'hello') {
    ws0.open()
    await until(() => helloOf(ws0) !== undefined)
  }
  disconnectAllDaemons()
  const fresh = dial()
  await until(() => sockets().length === 2)
  const ws1 = sockets()[1]
  const freshConn = s.dialer(1)
  expect(freshConn).not.toBe(oldConn)
  ws1.open()
  await until(() => helloOf(ws1) !== undefined)
  answerHello(ws1)
  await expect(fresh).resolves.toBe(freshConn)
  return { old, ws0, oldConn, ws1, freshConn }
}
type World = Awaited<ReturnType<typeof freshOverOld>>

describe('the newer owner', () => {
  it('connects normally: the real hello, a command answered, its events handled, every edge leaf once', async () => {
    const s = start()
    const { ws1, freshConn } = await freshOverOld(s, 'opening')
    expect(s.edgesOf(freshConn)).toBe(1)
    expect(s.leafCounts(freshConn)).toEqual(LEAVES.map((n) => [n, 1]))
    expect(s.hostConnected).toEqual([LOCAL])
    expect(getConnectedDaemonConnection(LOCAL)).toBe(freshConn)
    expect(daemonConnectWouldWait(LOCAL)).toBe('connected')
    const reply = s.observe(freshConn.send('echo', { x: 1 }), 'send:echo')
    const echo = ws1.commands().find((c) => c.cmd === 'echo')!
    ws1.frame({ id: echo.id, ok: true, value: 'answered' })
    await expect(reply).resolves.toMatchObject({ ok: true, value: 'answered' })
    ws1.frame({ ev: 'trigger.fired', id: 'trig-new' })
    ws1.frame({ ev: 'leader-lost' })
    ws1.frame({ ev: 'offline-journal' })
    expect(s.eventLeafCounts(freshConn)).toEqual([['refreshLeader', 1]])
    // The trigger reaches the sink after its import; offline-journal notes the handover, then
    // pushes the host slice again.
    await until(() => s.leafCounts(freshConn)[3][1] === 2 && s.sink.mock.calls.length === 1)
    expect(s.sink.mock.calls).toEqual([[LOCAL, expect.objectContaining({ ev: 'trigger.fired', type: 'trigger.fired', id: 'trig-new' })]])
    expect(handover.notes).toEqual([LOCAL])
    // The hello answer, the echo, three events.
    expect(s.handledOf(freshConn)).toBe(5)
    expect(ws1.closes).toBe(0)
  })

  const LATE: Record<string, { stage: 'opening' | 'hello'; act(w: World): void; rejects: RegExp; closes: number }> = {
    'opens': { stage: 'opening', act: (w) => w.ws0.open(), rejects: /closed while it connected/, closes: 1 },
    'fails': { stage: 'opening', act: (w) => w.ws0.fail(new Error('old refused')), rejects: /old refused/, closes: 0 },
    'times out (its open timer)': { stage: 'opening', act: () => { vi.advanceTimersByTime(10_000) }, rejects: /WebSocket connection timeout/, closes: 1 },
    'answers its hello and sends events': { stage: 'hello', act: (w) => { answerHello(w.ws0); lateFrames(w.ws0, 1) }, rejects: /closed while it connected/, closes: 1 },
  }
  it.each(Object.keys(LATE))('the old dial %s after it connected: its socket, command, notices, cache and cause stay its own', async (kind) => {
    const late = LATE[kind]
    const s = start()
    const w = await freshOverOld(s, late.stage)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const held = s.observe(w.freshConn.send('held', {}), 'send:held')
    const mark = s.mark()
    const leavesBefore = s.leafCounts(w.freshConn)
    late.act(w)
    await expect(w.old).rejects.toThrow(late.rejects)
    // The old socket's close event, however it ended.
    w.ws0.closed()
    await settle()
    expect(w.freshConn.connected).toBe(true)
    expect(getConnectedDaemonConnection(LOCAL)).toBe(w.freshConn)
    expect(w.ws1.closes).toBe(0)
    expect(s.lostOf(w.freshConn)).toBe(0)
    expect(s.edgesOf(w.freshConn)).toBe(1)
    expect(s.leafCounts(w.freshConn)).toEqual(leavesBefore)
    expect(s.eventLeafCounts(w.freshConn)).toEqual(EVENT_LEAVES.map((n) => [n, 0]))
    expect(daemonConnectWouldWait(LOCAL)).toBe('connected')
    expect(getDaemonConnectState(LOCAL).error).toBeUndefined()
    expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
    // Its command in flight is still pending on its own socket, and answered there.
    const cmd = w.ws1.commands().find((c) => c.cmd === 'held')!
    w.ws1.frame({ id: cmd.id, ok: true })
    await expect(held).resolves.toMatchObject({ ok: true })
    expectInert(s, w.oldConn, mark)
    expect(w.ws0.closes).toBe(late.closes)
  })

  it.each(['opens', 'fails'] as const)('its own failure is cached; the old dial %s late: the cache, its one notice and the cause stay', async (late) => {
    const s = start()
    const old = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const oldConn = s.dialer(0)
    disconnectAllDaemons()
    const fresh = dial()
    await until(() => sockets().length === 2)
    const ws1 = sockets()[1]
    expect(s.dialer(1)).not.toBe(oldConn)
    ws1.fail(new Error('fresh refused'))
    await expect(fresh).rejects.toThrow(/fresh refused/)
    await settle()
    expect(daemonConnectWouldWait(LOCAL)).toBe('fails-fast')
    const cached = getDaemonConnectState(LOCAL).error
    expect(cached).toMatch(/fresh refused/)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const mark = s.mark()
    if (late === 'opens') ws0.open()
    else ws0.fail(new Error('old refused'))
    await expect(old).rejects.toThrow(late === 'opens' ? /closed while it connected/ : /old refused/)
    ws0.closed()
    await settle()
    expect(daemonConnectWouldWait(LOCAL)).toBe('fails-fast')
    expect(getDaemonConnectState(LOCAL).error).toBe(cached)
    expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
    // The newer owner's failure only: the old one's catch ended before its annotation.
    expect(annotateCredentialFailure).toHaveBeenCalledTimes(1)
    expectInert(s, oldConn, mark)
    expect(ws0.closes).toBe(late === 'opens' ? 1 : 0)
  })

  it('without a reset nothing changes: one dial, its callers share it, every edge leaf once', async () => {
    const s = start()
    const a = dial()
    const b = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    ws0.open()
    await until(() => helloOf(ws0) !== undefined)
    answerHello(ws0)
    const conn = await a
    await expect(b).resolves.toBe(conn)
    expect(sockets()).toHaveLength(1)
    expect(s.edgesOf(conn)).toBe(1)
    expect(s.leafCounts(conn)).toEqual(LEAVES.map((n) => [n, 1]))
    expect(s.hostConnected).toEqual([LOCAL])
    expect(ws0.closes).toBe(0)
    expect(daemonConnectWouldWait(LOCAL)).toBe('connected')
  })
})

/** A __local__ instance connected for real (dial, open, the hello answered). */
async function connectedOwner() {
  const n = sockets().length
  const attempt = dial()
  await until(() => sockets().length === n + 1)
  const ws = sockets()[n]
  ws.open()
  await until(() => helloOf(ws) !== undefined)
  answerHello(ws)
  return { conn: await attempt, ws }
}
const pushesOf = (s: Seams, c: DaemonConnection) => s.leafCounts(c)[3][1] as number

/**
 * F1: the newer owner Y connected for real with a command in flight on its socket, then parked out of
 * the pool (pool seam, no disconnect: still connected); then X connected for real and pooled. A
 * controlled fixture, not a production reconnect.
 */
async function parkedNextThenOwner(s: Seams) {
  const y = await connectedOwner()
  const held = s.observe(y.conn.send('held', {}), 'send:held')
  const heldCmd = y.ws.commands().find((c) => c.cmd === 'held')
  expect(heldCmd).toBeDefined()
  setPooledConnectionForTest(LOCAL, null)
  expect(y.conn.connected).toBe(true)
  expect(getConnectedDaemonConnection(LOCAL)).toBeNull()
  const x = await connectedOwner()
  expect(x.conn).not.toBe(y.conn)
  expect(getConnectedDaemonConnection(LOCAL)).toBe(x.conn)
  return { x, y, held, heldId: heldCmd!.id }
}
/** The pool lets go of the owner: a reset (its disconnect), or a replacement (it just leaves the pool); `next` is installed after. */
function loseOwner(how: 'reset' | 'replaced', next?: DaemonConnection) {
  if (how === 'reset') disconnectAllDaemons()
  if (next) setPooledConnectionForTest(LOCAL, next)
  else expect(how).toBe('reset')
}
const JOURNAL = { ev: 'offline-journal' }
const TRIGGER = { ev: 'trigger.fired', id: 'trig-old' }

describe('an event the owned instance took, then the pool lets go of it (awaiting the event\'s own chain)', () => {
  it('R1 offline-journal and trigger.fired, a reset in the same tick, no newer owner: no note, no sink delivery, no host-slice push', async () => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const before = s.mark()
    const from = s.handledCalls()
    ws.frame(JOURNAL)
    ws.frame(TRIGGER)
    const jobs = s.jobsOf(x, from, [JOURNAL, TRIGGER])
    loseOwner('reset')
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const after = s.mark()
    await Promise.all(jobs)
    expect(handover.notes.slice(before.notes)).toEqual([])
    expect(s.sink.mock.calls.slice(before.sink)).toEqual([])
    expect(pushesOf(s, x)).toBe(1)
    expect(s.eventLeafCounts(x)).toEqual([['refreshLeader', 0]])
    expect(s.phases.slice(after.phases)).toEqual([])
    expect(s.hostConnected.slice(after.hostConnected)).toEqual([])
    expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
    expect(daemonConnectWouldWait(LOCAL)).toBe('cold')
  })

  it.each([['R2', 'reset'], ['R3', 'replaced']] as const)('%s offline-journal and trigger.fired, then %s with a connected newer owner installed: its socket, command, notices, leaves and cause stay its own', async (_row, how) => {
    const s = start()
    const { x, y, held, heldId } = await parkedNextThenOwner(s)
    const yLeaves = s.leafCounts(y.conn)
    const yHandled = s.handledOf(y.conn)
    const before = s.mark()
    const from = s.handledCalls()
    x.ws.frame(JOURNAL)
    x.ws.frame(TRIGGER)
    const jobs = s.jobsOf(x.conn, from, [JOURNAL, TRIGGER])
    loseOwner(how, y.conn)
    recordReconnectCause(LOCAL, NEWER_CAUSE)
    const after = s.mark()
    await Promise.all(jobs)
    expect(handover.notes.slice(before.notes)).toEqual([])
    expect(s.sink.mock.calls.slice(before.sink)).toEqual([])
    expect(pushesOf(s, x.conn)).toBe(1)
    expect(s.eventLeafCounts(x.conn)).toEqual([['refreshLeader', 0]])
    expect(x.ws.closes).toBe(how === 'reset' ? 1 : 0)
    expect(y.conn.connected).toBe(true)
    expect(getConnectedDaemonConnection(LOCAL)).toBe(y.conn)
    expect(y.ws.closes).toBe(0)
    expect(s.lostOf(y.conn)).toBe(0)
    expect(s.leafCounts(y.conn)).toEqual(yLeaves)
    expect(s.handledOf(y.conn)).toBe(yHandled)
    expect(s.phases.slice(after.phases)).toEqual([])
    expect(s.hostConnected.slice(after.hostConnected)).toEqual([])
    expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
    expect(daemonConnectWouldWait(LOCAL)).toBe('connected')
    expect(s.stateOf(held)).toBe('pending')
    // Only now, and only on its own socket, by its own id.
    y.ws.frame({ id: heldId, ok: true })
    await expect(held).resolves.toMatchObject({ ok: true })
    expect(s.handledOf(y.conn)).toBe(yHandled + 1)
  })

  it.each([['R4', 'reset'], ['R5', 'replaced']] as const)('%s offline-journal noted while owned, then %s from a microtask before its finally: the note once, and the finally pushes nothing', async (_row, how) => {
    const s = start()
    const { x, y, held, heldId } = await parkedNextThenOwner(s)
    const yLeaves = s.leafCounts(y.conn)
    const before = s.mark()
    const from = s.handledCalls()
    let ownedAtNote: boolean | null = null
    let after: ReturnType<Seams['mark']> | null = null
    // Queued inside the then, so it runs after the note and before the catch pass-through and the finally.
    handover.onNote = () => {
      handover.onNote = null
      ownedAtNote = getConnectedDaemonConnection(LOCAL) === x.conn
      queueMicrotask(() => { loseOwner(how, y.conn); recordReconnectCause(LOCAL, NEWER_CAUSE); after = s.mark() })
    }
    x.ws.frame(JOURNAL)
    const jobs = s.jobsOf(x.conn, from, [JOURNAL])
    await Promise.all(jobs)
    expect(ownedAtNote).toBe(true)
    expect(after).not.toBeNull()
    expect(handover.notes.slice(before.notes)).toEqual([LOCAL])
    // The then's guard let the note through; only the finally's guard keeps the push out.
    expect(pushesOf(s, x.conn)).toBe(1)
    expect(getConnectedDaemonConnection(LOCAL)).toBe(y.conn)
    expect(y.ws.closes).toBe(0)
    expect(s.leafCounts(y.conn)).toEqual(yLeaves)
    expect(s.phases.slice(after!.phases)).toEqual([])
    expect(getReconnectCause(LOCAL)?.summary).toBe('newer owner cause')
    expect(s.stateOf(held)).toBe('pending')
    y.ws.frame({ id: heldId, ok: true })
    await expect(held).resolves.toMatchObject({ ok: true })
  })

  it.each([['R6', 'no reset', 2], ['R7', 'a reset in the same tick', 1]] as const)('%s the handover export read fails after the import fulfilled (the then rejects before the note; catch, then finally), %s: no note, pushes %i', async (_row, when, pushes) => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const before = s.mark()
    const from = s.handledCalls()
    handover.rejectNext = true
    ws.frame(JOURNAL)
    const jobs = s.jobsOf(x, from, [JOURNAL])
    if (when !== 'no reset') loseOwner('reset')
    await Promise.all(jobs)
    // A fixture check (the failing read happened), not the proof of settlement: that is the await above.
    expect(handover.rejectNext).toBe(false)
    expect(handover.notes.slice(before.notes)).toEqual([])
    expect(pushesOf(s, x)).toBe(pushes)
  })

  it('R8 control, no reset: the note, the sink delivery and the push all happen', async () => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const before = s.mark()
    const from = s.handledCalls()
    const trigger = { ev: 'trigger.fired', id: 'trig-1' }
    ws.frame(JOURNAL)
    ws.frame(trigger)
    await Promise.all(s.jobsOf(x, from, [JOURNAL, trigger]))
    expect(handover.notes.slice(before.notes)).toEqual([LOCAL])
    expect(s.sink.mock.calls.slice(before.sink)).toEqual([[LOCAL, expect.objectContaining({ ev: 'trigger.fired', type: 'trigger.fired', id: 'trig-1' })]])
    expect(pushesOf(s, x)).toBe(2)
  })
})

const LEADER_LOST = { ev: 'leader-lost' }
function expectEnded(s: Seams) {
  expect(s.pending()).toEqual([])
  expect(current).toBeNull()
  expect(failedWorld).toBeNull()
  expect(clock).toBe('real')
  expect(getConnectedDaemonConnection(LOCAL)).toBeNull()
  expect(daemonConnectWouldWait(LOCAL)).toBe('cold')
}

describe('cleanup settles what a test leaves behind (end() called by the test itself)', () => {
  it('C1 stopped before its socket opened: its own open timer, cancelled and run once here, ends the open and the dial', async () => {
    const s = start()
    const d = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const o = s.openOf(ws0)
    await end(s)
    await expect(d).rejects.toThrow(/WebSocket connection timeout/)
    expect(s.stateOf(d)).toBe('rejected')
    expect(s.originalsOf('open').map((x) => x.state)).toEqual(['rejected'])
    expect(timerEnd(o)).toBe('settled here')
    expect(o.timer!.ran).toBe(1)
    expect(ws0.closes).toBe(1)
    expectEnded(s)
  })

  it('C2 a raw mismatch fails jobsOf; the event the frame started was registered when it returned, and settles', async () => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const from = s.handledCalls()
    ws.frame(JOURNAL)
    expect(() => s.jobsOf(x, from, [TRIGGER])).toThrow(/deeply equal/)
    expect(s.originalsOf('event').map((e) => e.state)).toEqual(['pending'])
    await end(s)
    expect(s.originalsOf('event').map((e) => e.state)).toEqual(['fulfilled'])
    expect(timerEnd(s.openOf(ws))).toBe('cleared')
    expectEnded(s)
  })

  it('C3 a frame whose handleMessage returns nothing (leader-lost, a void return, not a throw) fails jobsOf at its result; nothing is registered', async () => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const from = s.handledCalls()
    ws.frame(LEADER_LOST)
    expect(() => s.jobsOf(x, from, [LEADER_LOST])).toThrow(/instance of Promise/)
    expect(s.originalsOf('event')).toEqual([])
    await end(s)
    expectEnded(s)
  })

  it('C4 a later void result fails jobsOf there; the earlier event was registered when it returned, and settles', async () => {
    const s = start()
    const { conn: x, ws } = await connectedOwner()
    const from = s.handledCalls()
    ws.frame(JOURNAL)
    ws.frame(LEADER_LOST)
    expect(() => s.jobsOf(x, from, [JOURNAL, LEADER_LOST])).toThrow(/instance of Promise/)
    expect(s.originalsOf('event').map((e) => e.state)).toEqual(['pending'])
    await end(s)
    expect(s.originalsOf('event').map((e) => e.state)).toEqual(['fulfilled'])
    expectEnded(s)
  })

  it('C5 ensureRunning held: released after the instance was let go, the dial ends before any socket', async () => {
    const s = start()
    s.holdEnsure()
    const d = dial()
    await until(() => vi.mocked(localDaemon.ensureRunning).mock.calls.length === 1)
    await end(s)
    await expect(d).rejects.toThrow(/closed while it connected/)
    expect(s.opens()).toEqual([])
    expectEnded(s)
  })

  it('C6 the annotation held after the socket failed: released after the instance was let go, the dial ends; the open timer still set is run once here', async () => {
    const s = start()
    s.holdAnnotations()
    const d = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    const o = s.openOf(ws0)
    const mark = s.mark()
    ws0.fail(new Error('ECONNREFUSED'))
    await until(() => s.annotations.length === 1)
    await end(s)
    await expect(d).rejects.toThrow(/WebSocket connection failed: ECONNREFUSED/)
    expect(s.originalsOf('open').map((x) => x.state)).toEqual(['rejected'])
    expect(timerEnd(o)).toBe('settled here')
    expect(ws0.closes).toBe(1)
    expect(s.phases.slice(mark.phases)).toEqual([])
    expectEnded(s)
  })

  it('C7 opened, its hello unanswered: the instance let go rejects the hello, the dial ends; its open listener cleared the exact timer', async () => {
    const s = start()
    const d = dial()
    await until(() => sockets().length === 1)
    const [ws0] = sockets()
    ws0.open()
    await until(() => helloOf(ws0) !== undefined)
    await end(s)
    await expect(d).rejects.toThrow(/closed while it connected/)
    expect(s.originalsOf('open').map((x) => x.state)).toEqual(['fulfilled'])
    expect(timerEnd(s.openOf(ws0))).toBe('cleared')
    expect(ws0.closes).toBe(1)
    expectEnded(s)
  })

  it('C8 F1 with its held command unanswered: the parked owner let go rejects it; both dials and both opens had settled', async () => {
    const s = start()
    const { x, y, held } = await parkedNextThenOwner(s)
    await end(s)
    await expect(held).rejects.toThrow(/connection closed/)
    expect(s.originalsOf('dial').map((o) => o.state)).toEqual(['fulfilled', 'fulfilled'])
    expect(s.originalsOf('open').map((o) => o.state)).toEqual(['fulfilled', 'fulfilled'])
    expect([timerEnd(s.openOf(y.ws)), timerEnd(s.openOf(x.ws))]).toEqual(['cleared', 'cleared'])
    expectEnded(s)
  })

  it('C9 the failing export read armed, no frame sent: no event, and the reset disarms it', async () => {
    const s = start()
    await connectedOwner()
    handover.rejectNext = true
    await end(s)
    expect(s.originalsOf('event')).toEqual([])
    expect(handover.rejectNext).toBe(false)
    expectEnded(s)
  })
})

describe('src/providers/daemon-connection.ts keeps the guards where they act', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'providers', 'daemon-connection.ts'), 'utf8')

  it('the main socket\'s message callback drops a local frame before handleMessage', () => {
    const at = src.indexOf("      ws.on('message', (data) => {")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('\n      })\n', at))
    const guard = body.indexOf("if (this.hostKey === '__local__' && (this.ws !== ws || this.localDialAbandoned())) return")
    expect(guard).toBeGreaterThan(0)
    expect(body.indexOf('this.handleMessage(')).toBeGreaterThan(guard)
  })

  it('connect()\'s catch asks for the owner before and after the annotation, both before the failed phase', () => {
    const annotate = src.indexOf('const annotated = this.sshTarget && !this.isCloudTunnel ? await annotateCredentialFailure(')
    expect(annotate).toBeGreaterThan(0)
    const before = src.lastIndexOf('if (this.localDialAbandoned()) {', annotate)
    const after = src.indexOf('if (this.localDialAbandoned()) {', annotate)
    const failed = src.indexOf("this.setPhase('failed')", annotate)
    expect(before).toBeGreaterThan(src.lastIndexOf('} catch (err) {', annotate))
    expect(after).toBeGreaterThan(annotate)
    expect(failed).toBeGreaterThan(after)
  })

  it('the offline-journal branch returns its whole chain, which asks for the owner before the note and before the push', () => {
    const at = src.indexOf("        return import('../core/offline-handover.js')\n")
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at).split('\n').slice(1, 4)).toEqual([
      '          .then(({ noteHandoverDue }) => { if (!this.localDialAbandoned()) noteHandoverDue(this.hostKey) })',
      '          .catch(() => {})',
      '          .finally(() => { if (!this.localDialAbandoned()) this.pushHostSlice() })',
    ])
  })

  it('a trigger event: the branch returns the dispatch, which returns its job and asks for the owner after its import, before the sink', () => {
    expect(src).toContain("if (event.ev === 'trigger.checked' || event.ev === 'trigger.fired') {\n        return this.dispatchTriggerEvent(event)\n      }")
    expect(src).toContain('private dispatchTriggerEvent(event: DaemonEvent): Promise<void> {\n    return (async () => {')
    expect(src).toContain('private handleMessage(raw: string): Promise<void> | void {')
    const at = src.indexOf("const { getTriggerEventSink } = await import('../core/routines/trigger-bridge.js')")
    expect(at).toBeGreaterThan(0)
    const guard = src.indexOf('if (this.localDialAbandoned()) return', at)
    expect(guard).toBeGreaterThan(at)
    expect(src.indexOf('const sink = getTriggerEventSink()', at)).toBeGreaterThan(guard)
  })

  it('the main socket\'s callback stays synchronous fire-and-forget', () => {
    const at = src.indexOf("      ws.on('message', (data) => {")
    const body = src.slice(at, src.indexOf('\n      })\n', at))
    expect(body.endsWith("\n        this.handleMessage(typeof data === 'string' ? data : data.toString())")).toBe(true)
    expect(body).not.toMatch(/\bawait\b|async|\.then\(|\.catch\(/)
  })

  it('the failed phase\'s setImmediate asks for the owner when it runs', () => {
    expect(src).toMatch(/const t = setImmediate\(\(\) => \{\n\s*if \(this\._phase === 'failed' && !failureCache\.has\(this\.hostKey\) && !this\.localDialAbandoned\(\)\) notifyDaemonPhaseChange\(this\.hostKey\)/)
  })
})
