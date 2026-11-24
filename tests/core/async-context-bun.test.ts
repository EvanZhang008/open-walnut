/**
 * AsyncLocalStorage on the runtime production runs (Bun), for every async kind the code that relies on
 * it reaches. Two stores carry correctness and run on Bun in production:
 *
 *   - providers/claude-code-session.ts `lineScope`: `run` around a stream line's synchronous handling.
 *     What that handling emits later (a promise or an await resolved from another context, a timer,
 *     a file read, a daemon reply over the ws link) must still read that line (readOffset, the fact
 *     log's told line), and a timer made outside any line must not.
 *   - core/session-channel/person-call.ts: `markPersonRequest` runs a person's HTTP request in a mark
 *     whose `live` ends on the response's 'finish'/'close'; `asPersonCall` runs work in a mark that
 *     ends when it settles; `outsidePersonCall` (`exit`) wraps DaemonConnection's dials (connect,
 *     connectDirect, reconnectNow) so the link's sockets, ssh child processes, ws messages and
 *     reconnect timers never carry a person's mark, while the caller keeps its own after the await.
 *
 * Every kind is read three ways: made inside `run` (must see the store), made inside `exit` within a
 * `run` (must not), made outside (must not). EventEmitter listeners run synchronously in the context
 * of whoever calls `emit`, on Node and Bun alike, never in the context the emitter or the listener was
 * made in: the test pins that. Every wait is on the work's own callback, never a clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { exec, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import timersP from 'node:timers/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'
import { removeTempTree } from '../helpers/temp-home.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

// The ws package as production loads it on Bun (package.json "#ws", bun condition).
import { WebSocket, WebSocketServer } from '../../src/lib/ws-npm.js'
import { asPersonCall, inPersonCall, markPersonRequest, outsidePersonCall } from '../../src/core/session-channel/person-call.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const SELF = fileURLToPath(import.meta.url)
const als = new AsyncLocalStorage<string>()

/** Calls `report` from inside the async kind under test. */
type Schedule = (report: () => void) => void

/** What `als` reads where the kind calls back; resolved by that callback. */
function readAt(schedule: Schedule): Promise<string | undefined> {
  return new Promise((resolve) => schedule(() => resolve(als.getStore())))
}

/** The kind made inside `run`, inside `exit` within a `run`, and outside any store. */
async function threeWays(schedule: Schedule): Promise<Record<'inside' | 'exited' | 'outside', string | undefined>> {
  const inside = await als.run('in', () => readAt(schedule))
  const exited = await als.run('in', () => als.exit(() => readAt(schedule)))
  const outside = await readAt(schedule)
  return { inside, exited, outside }
}

/** A promise settled later from ANOTHER context (a ws reply, another line's handling). */
function settledElsewhere(): Promise<void> {
  return new Promise((resolve) => { als.run('elsewhere', () => setImmediate(resolve)) })
}

let tcp: net.Server
let tcpPort = 0
let wss: WebSocketServer
let wsPort = 0

beforeEach(async () => {
  tcp = net.createServer((sock) => { sock.end('frame') })
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()))
  tcpPort = (tcp.address() as net.AddressInfo).port
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (sock: { send(d: string): void; on(ev: string, fn: (d: unknown) => void): void }) => {
    sock.send('hello')
    sock.on('message', () => sock.send('reply'))
  })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  wsPort = (wss.address() as net.AddressInfo).port
})
afterEach(async () => {
  await new Promise<void>((r) => tcp.close(() => r()))
  await new Promise<void>((r) => wss.close(() => r()))
})

describe('the runtime under test', () => {
  it('is Bun, as in production', () => {
    expect(process.versions.bun, 'this file must run under `bun --bun vitest`').toBeTruthy()
    expect(typeof (globalThis as { Bun?: unknown }).Bun).toBe('object')
  })
})

describe('AsyncLocalStorage on Bun: made inside run sees the store, inside exit or outside does not', () => {
  const kinds: Array<[string, Schedule]> = [
    ['setTimeout', (r) => { setTimeout(r, 0) }],
    ['setInterval, its second tick', (r) => { let n = 0; const t = setInterval(() => { if (++n === 2) { clearInterval(t); r() } }, 0) }],
    ['setImmediate', (r) => { setImmediate(r) }],
    ['queueMicrotask', (r) => { queueMicrotask(r) }],
    ['process.nextTick', (r) => { process.nextTick(r) }],
    ['promise then, settled from another context', (r) => { void settledElsewhere().then(r) }],
    ['await, settled from another context', (r) => { void (async () => { await settledElsewhere(); r() })() }],
    ['await, settled synchronously by an emit from another context', (r) => {
      const e = new EventEmitter()
      void (async () => { await new Promise<void>((res) => e.once('go', () => res())); r() })()
      als.run('elsewhere', () => setImmediate(() => e.emit('go')))
    }],
    ['timers/promises setTimeout', (r) => { void (async () => { await timersP.setTimeout(0); r() })() }],
    ['timers/promises setImmediate', (r) => { void (async () => { await timersP.setImmediate(); r() })() }],
    ['timers/promises setInterval iterator', (r) => { void (async () => { for await (const _ of timersP.setInterval(0)) { r(); break } })() }],
    ['fs.readFile callback', (r) => { fs.readFile(SELF, () => r()) }],
    ['fs.promises readFile', (r) => { void (async () => { await fsp.readFile(SELF); r() })() }],
    ['child_process exec callback', (r) => { exec('echo x', () => r()) }],
    ['child_process spawn exit event', (r) => { spawn('sh', ['-c', 'exit 0']).on('exit', () => r()) }],
    ['child_process spawn stdout data event', (r) => {
      const p = spawn('sh', ['-c', 'echo x']); let done = false
      p.stdout.on('data', () => { if (!done) { done = true; r() } })
    }],
    ['net socket connect event', (r) => { const s = net.connect(tcpPort, '127.0.0.1'); s.on('connect', () => { s.destroy(); r() }) }],
    ['net socket data event', (r) => { const s = net.connect(tcpPort, '127.0.0.1'); s.on('data', () => { s.destroy(); r() }) }],
    ['net socket close event', (r) => { const s = net.connect(tcpPort, '127.0.0.1'); s.on('data', () => {}); s.on('close', () => r()) }],
    ['ws (npm, as on Bun in production) open event', (r) => { const w = new WebSocket(`ws://127.0.0.1:${wsPort}`); w.on('open', () => { w.close(); r() }) }],
    ['ws message event', (r) => { const w = new WebSocket(`ws://127.0.0.1:${wsPort}`); w.once('message', () => { w.close(); r() }) }],
  ]
  for (const [name, schedule] of kinds) {
    it(name, async () => {
      expect(await threeWays(schedule)).toEqual({ inside: 'in', exited: undefined, outside: undefined })
    })
  }

  it('EventEmitter: a listener runs in the context of whoever emits, wherever the emitter or the listener was made', async () => {
    const madeInside = als.run('in', () => { const e = new EventEmitter(); const seen: Array<string | undefined> = []; e.on('x', () => seen.push(als.getStore())); return { e, seen } })
    madeInside.e.emit('x')
    als.run('emitter-caller', () => madeInside.e.emit('x'))
    const madeOutside = new EventEmitter(); const seen: Array<string | undefined> = []
    madeOutside.on('x', () => seen.push(als.getStore()))
    als.run('in', () => madeOutside.emit('x'))
    als.run('in', () => als.exit(() => madeOutside.emit('x')))
    expect(madeInside.seen).toEqual([undefined, 'emitter-caller'])
    expect(seen).toEqual(['in', undefined])
  })

  it('exit around an async dial: after its awaits, and in the timers, sockets and messages it makes then, no store; its caller has the store back', async () => {
    const seen: Record<string, string | undefined> = {}
    await als.run('in', async () => {
      const dial = async (): Promise<void> => {
        seen.afterAwait = (await fsp.readFile(SELF), als.getStore())
        const w = new WebSocket(`ws://127.0.0.1:${wsPort}`)
        await new Promise<void>((r) => w.once('message', () => { seen.message = als.getStore(); r() }))
        // The link's later reconnect timer, made after the awaits.
        await new Promise<void>((r) => setTimeout(() => { seen.reconnectTimer = als.getStore(); r() }, 0))
        w.close()
      }
      await als.exit(dial)
      seen.callerAfter = als.getStore()
    })
    expect(seen).toEqual({ afterAwait: undefined, message: undefined, reconnectTimer: undefined, callerAfter: 'in' })
  })

  it('run around a synchronous handler: what it schedules keeps it after a later run has come and gone', async () => {
    const seen: Array<[string, string | undefined]> = []
    const done: Promise<void>[] = []
    const handle = (line: string): void => {
      done.push(new Promise((r) => setTimeout(() => { seen.push([line, als.getStore()]); r() }, 0)))
      done.push((async () => { await settledElsewhere(); seen.push([`${line} await`, als.getStore()]) })())
    }
    als.run('line-1', () => handle('line-1'))
    als.run('line-2', () => handle('line-2'))
    await Promise.all(done)
    expect(new Map(seen)).toEqual(new Map([['line-1', 'line-1'], ['line-1 await', 'line-1'], ['line-2', 'line-2'], ['line-2 await', 'line-2']]))
  })
})

describe('person-call.ts on Bun: the exact patterns the revoked-host gate relies on', () => {
  it('a real HTTP request: its work sees the mark across awaits and a ws round trip; what outlives the response does not', async () => {
    const seen: Record<string, boolean> = {}
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let leftover!: Promise<void>
    let finished!: Promise<void>
    const server = http.createServer((_req, res) => {
      finished = new Promise((r) => res.once('finish', () => r()))
      markPersonRequest(res, () => {
        void (async () => {
          seen.handler = inPersonCall()
          await fsp.readFile(SELF)
          seen.afterFsAwait = inPersonCall()
          const w = new WebSocket(`ws://127.0.0.1:${wsPort}`)
          await new Promise<void>((r) => w.once('message', () => r()))
          w.send('ask')
          await new Promise<void>((r) => w.once('message', () => r()))
          w.close()
          seen.afterWsReply = inPersonCall()
          // Work that outlives the response: it runs once the test has seen the response finish.
          leftover = released.then(() => { seen.afterResponse = inPersonCall() })
          res.end('ok')
        })()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as net.AddressInfo).port
      await new Promise<void>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); res.on('end', () => resolve()) }).on('error', reject)
      })
      // Bun's ServerResponse must say 'finish', or the mark would never end.
      await finished
      release()
      await leftover
    } finally { server.close() }
    expect(seen).toEqual({ handler: true, afterFsAwait: true, afterWsReply: true, afterResponse: false })
  })

  it('outsidePersonCall inside a person\'s call: the link it dials carries no mark in any of its events, the caller keeps its own', async () => {
    const seen: Record<string, boolean> = {}
    await asPersonCall(async () => {
      await outsidePersonCall(async () => {
        await timersP.setImmediate()
        seen.dialAfterAwait = inPersonCall()
        const ssh = spawn('sh', ['-c', 'echo up'])
        await new Promise<void>((r) => ssh.stdout.once('data', () => { seen.tunnelData = inPersonCall(); r() }))
        const w = new WebSocket(`ws://127.0.0.1:${wsPort}`)
        await new Promise<void>((r) => w.once('message', () => { seen.wsMessage = inPersonCall(); r() }))
        await new Promise<void>((r) => { w.once('close', () => { seen.wsClose = inPersonCall(); r() }); w.close() })
        await new Promise<void>((r) => setTimeout(() => { seen.reconnectTimer = inPersonCall(); r() }, 0))
      })
      seen.callerAfter = inPersonCall()
    })
    expect(seen).toEqual({ dialAfterAwait: false, tunnelData: false, wsMessage: false, wsClose: false, reconnectTimer: false, callerAfter: true })
  })

  it('asPersonCall: the mark holds across its awaits and ends when it settles, also for a timer it left behind', async () => {
    const seen: Record<string, boolean> = {}
    let fire!: () => void
    const fired = new Promise<void>((r) => { fire = r })
    let leftover!: Promise<void>
    await asPersonCall(async () => {
      await fsp.readFile(SELF)
      seen.afterAwait = inPersonCall()
      leftover = new Promise<void>((r) => { void fired.then(() => setTimeout(() => { seen.leftoverTimer = inPersonCall(); r() }, 0)) })
    })
    fire()
    await leftover
    expect(seen).toEqual({ afterAwait: true, leftoverTimer: false })
  })

  it('DaemonConnection: a Connect now inside a person\'s request re-dials outside the mark, as connect() does', async () => {
    const conn = new DaemonConnection('als-probe-host', null)
    const seen: Record<string, boolean> = {}
    // The reconnect attempt itself (the ssh tunnel and the ws dial) is stood in for: what matters
    // here is the context it runs in, which every socket, process and timer it makes inherits.
    Object.assign(conn as unknown as Record<string, unknown>, {
      reconnect: async () => {
        seen.dial = inPersonCall()
        await timersP.setImmediate()
        await new Promise<void>((r) => setTimeout(() => { seen.timerAfterAwait = inPersonCall(); r() }, 0))
      },
    })
    try {
      await asPersonCall(async () => {
        await conn.reconnectNow()
        seen.callerAfter = inPersonCall()
      })
    } finally { conn.disconnect() }
    expect(seen).toEqual({ dial: false, timerAfterAwait: false, callerAfter: true })
  })
})

describe('claude-code-session.ts lineScope on Bun: a fact emitted later by a line\'s handling carries that line', () => {
  const init = (sid: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, cwd: '/tmp', model: 'm', tools: [], mcp_servers: [], permissionMode: 'default' })
  const text = (sid: string, t: string) => JSON.stringify({ type: 'assistant', session_id: sid, message: { id: `msg-${t}`, role: 'assistant', content: [{ type: 'text', text: t }], usage: { input_tokens: 1, output_tokens: 1 } } })
  const result = (sid: string, t: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: t, session_id: sid, total_cost_usd: 0.01 })
  const idle = (sid: string) => JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' })

  function running(taskId: string): ClaudeCodeSession {
    const session = new ClaudeCodeSession(taskId, 'test-project')
    const transport = {
      isRemote: true, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null, fileSize: 0,
      imageCache: new Map(), lastEventAt: 0, tailOffset: 0, writeMessage: async () => true,
      processInbound: (t: string) => t, renameForSession: () => {},
    }
    Object.assign(session as unknown as Record<string, unknown>, { _transport: transport, _active: true, _processStatus: 'running' })
    return session
  }
  function feed(session: ClaudeCodeSession, lines: string[], from = 0): void {
    const s = session as unknown as { handleStreamLine(line: string, v: number): void }
    let v = from
    for (const l of lines) { v += 100; s.handleStreamLine(l, v) }
  }

  beforeEach(async () => {
    bus.clear()
    await removeTempTree(WALNUT_HOME)
    await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  })
  afterEach(async () => {
    bus.clear()
    await timersP.setImmediate()
    await removeTempTree(WALNUT_HOME).catch(() => {})
  })

  it('across every kind the handling can reach, though later lines were read meanwhile; a timer made outside reads the furthest line', async () => {
    const sid = 'als-line'
    const session = running('task-als-line')
    const stamps: Record<string, number> = {}
    const done: Promise<void>[] = []
    const later = (name: string, schedule: Schedule): void => {
      done.push(new Promise<void>((r) => schedule(() => { stamps[name] = session.readOffset; r() })))
    }
    bus.subscribe('als-line', (e) => {
      if (e.name !== EventNames.SESSION_RESULT) return
      stamps.now = session.readOffset
      later('setTimeout', (r) => { setTimeout(r, 0) })
      later('setImmediate', (r) => { setImmediate(r) })
      later('nextTick', (r) => { process.nextTick(r) })
      later('await settled elsewhere', (r) => { void (async () => { await settledElsewhere(); r() })() })
      later('fs callback', (r) => { fs.readFile(SELF, () => r()) })
      later('ws reply', (r) => { const w = new WebSocket(`ws://127.0.0.1:${wsPort}`); w.once('message', () => { w.close(); r() }) })
      later('child exit', (r) => { spawn('sh', ['-c', 'exit 0']).on('exit', () => r()) })
    }, { global: true })
    // 300 is the result's line; the lines after it are read before any of the kinds above calls back.
    feed(session, [init(sid), text(sid, 'a'), result(sid, 'done'), idle(sid), text(sid, 'next')])
    await Promise.all(done)
    const outside = await new Promise<number>((r) => setTimeout(() => r(session.readOffset), 0))
    expect(stamps).toEqual({
      now: 300, setTimeout: 300, setImmediate: 300, nextTick: 300, 'await settled elsewhere': 300,
      'fs callback': 300, 'ws reply': 300, 'child exit': 300,
    })
    expect(outside, 'outside any line: the furthest line read').toBe(500)
  })
})
