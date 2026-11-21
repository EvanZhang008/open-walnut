/**
 * The socket-shaped link to an in-process daemon (in-process-daemon-socket.ts), against a fake
 * InProcessConnect: it opens on a microtask, hands command objects over, emits the runtime's
 * frames as 'frame', answers a ping with its payload, and closes once from either side.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  InProcessDaemonSocket,
  IN_PROCESS_DAEMON_URL,
  isInProcessDaemonSocket,
  type InProcessConnect,
} from '../../src/providers/in-process-daemon-socket.js'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A runtime that records what its one client was sent and lets the test answer or close it. */
function fakeRuntime(opts: { refuse?: Error; clientCloseThrows?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const runtime = {
    connects: 0,
    clientCloses: 0,
    sent,
    emitFrame: (_f: Record<string, unknown>) => {},
    closeFromRuntime: () => {},
  }
  const connect: InProcessConnect = (onFrame, onClose) => {
    runtime.connects++
    if (opts.refuse) throw opts.refuse
    runtime.emitFrame = onFrame
    runtime.closeFromRuntime = onClose
    return {
      send: (frame) => { sent.push(frame) },
      close: () => { runtime.clientCloses++; if (opts.clientCloseThrows) throw new Error('already closed') },
    }
  }
  return { runtime, connect }
}

/** A socket with every event it emits recorded. */
function open(connect: InProcessConnect) {
  const socket = new InProcessDaemonSocket(connect)
  const events: Array<{ name: string; args: unknown[] }> = []
  for (const name of ['open', 'frame', 'pong', 'close', 'error']) {
    socket.on(name, (...args: unknown[]) => { events.push({ name, args }) })
  }
  const named = (name: string) => events.filter((e) => e.name === name)
  return { socket, events, named }
}

describe('InProcessDaemonSocket', () => {
  it('names its url and is told apart from other sockets', () => {
    expect(IN_PROCESS_DAEMON_URL).toBe('inproc://local-daemon')
    const { connect } = fakeRuntime()
    const socket = new InProcessDaemonSocket(connect)
    expect(isInProcessDaemonSocket(socket)).toBe(true)
    expect(isInProcessDaemonSocket({ readyState: 1 })).toBe(false)
    expect(isInProcessDaemonSocket(null)).toBe(false)
    socket.close()
  })

  it('opens on a microtask after construction, so listeners added first see open', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    expect(socket.readyState).toBe(0)
    expect(runtime.connects).toBe(0)
    expect(socket.bufferedAmount).toBe(0)
    await Promise.resolve()
    expect(runtime.connects).toBe(1)
    expect(socket.readyState).toBe(1)
    expect(named('open')).toHaveLength(1)
  })

  it('sendFrame hands the object over as it is', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket } = open(connect)
    await settle()
    const frame = { id: 1, cmd: 'status' }
    socket.sendFrame(frame)
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toBe(frame)
  })

  it('sendFrame before open or after close throws', async () => {
    const { connect } = fakeRuntime()
    const { socket } = open(connect)
    expect(() => socket.sendFrame({ id: 1 })).toThrow('in-process daemon link is closed')
    await settle()
    socket.close()
    expect(() => socket.sendFrame({ id: 2 })).toThrow('in-process daemon link is closed')
  })

  it('send parses text or a Buffer once and hands the object over; other text is ignored', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket } = open(connect)
    await settle()
    socket.send(JSON.stringify({ id: 1, cmd: 'a' }))
    socket.send(Buffer.from(JSON.stringify({ id: 2, cmd: 'b' })))
    socket.send('not json')
    socket.send('[1,2]')
    socket.send('null')
    socket.send('7')
    expect(runtime.sent).toEqual([{ id: 1, cmd: 'a' }, { id: 2, cmd: 'b' }])
  })

  it('emits the runtime frames as frame events while open, and none after close', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    await settle()
    const reply = { id: 1, ok: true }
    runtime.emitFrame(reply)
    runtime.emitFrame({ ev: 'out' })
    expect(named('frame').map((e) => e.args[0])).toEqual([reply, { ev: 'out' }])
    expect(named('frame')[0].args[0]).toBe(reply)
    socket.close()
    runtime.emitFrame({ ev: 'late' })
    expect(named('frame')).toHaveLength(2)
  })

  it('answers a ping with a pong carrying its payload, on a microtask', async () => {
    const { connect } = fakeRuntime()
    const { socket, named } = open(connect)
    await settle()
    socket.ping(Buffer.from('abc'))
    socket.ping('xyz')
    socket.ping()
    expect(named('pong')).toHaveLength(0)
    await Promise.resolve()
    const payloads = named('pong').map((e) => e.args[0] as Buffer)
    expect(payloads.map((b) => Buffer.isBuffer(b))).toEqual([true, true, true])
    expect(payloads.map((b) => b.toString())).toEqual(['abc', 'xyz', ''])
  })

  it('sends no pong for a ping before open or after close', async () => {
    const { connect } = fakeRuntime()
    const { socket, named } = open(connect)
    socket.ping('early')
    await settle()
    socket.ping('then-closed')
    socket.close()
    await settle()
    expect(named('pong')).toEqual([])
  })

  it('close() closes the runtime client once and emits close 1000 on a microtask', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    await settle()
    socket.close()
    socket.close()
    socket.terminate()
    expect(socket.readyState).toBe(3)
    expect(runtime.clientCloses).toBe(1)
    expect(named('close')).toHaveLength(0)
    await settle()
    expect(named('close')).toHaveLength(1)
    const [code, reason] = named('close')[0].args as [number, Buffer]
    expect(code).toBe(1000)
    expect(reason.length).toBe(0)
  })

  it('terminate() ends it as close() does', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    await settle()
    socket.terminate()
    await settle()
    expect(runtime.clientCloses).toBe(1)
    expect(named('close')).toHaveLength(1)
  })

  it('a client close that throws is swallowed', async () => {
    const { connect } = fakeRuntime({ clientCloseThrows: true })
    const { socket, named } = open(connect)
    await settle()
    expect(() => socket.close()).not.toThrow()
    await settle()
    expect(named('close')).toHaveLength(1)
  })

  it('a close by the runtime emits close once and does not close the client back', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    await settle()
    runtime.closeFromRuntime()
    runtime.closeFromRuntime()
    expect(socket.readyState).toBe(3)
    await settle()
    expect(named('close')).toHaveLength(1)
    expect(runtime.clientCloses).toBe(0)
    socket.close()
    await settle()
    expect(named('close')).toHaveLength(1)
    expect(runtime.clientCloses).toBe(0)
  })

  it('a close before open never connects and still emits close', async () => {
    const { runtime, connect } = fakeRuntime()
    const { socket, named } = open(connect)
    socket.close()
    expect(socket.readyState).toBe(3)
    await settle()
    expect(runtime.connects).toBe(0)
    expect(named('open')).toEqual([])
    expect(named('close')).toHaveLength(1)
  })

  it('a connect that throws emits error then close 1011 and stays closed', async () => {
    const refusal = new Error('refused')
    const { connect } = fakeRuntime({ refuse: refusal })
    const { socket, events, named } = open(connect)
    await settle()
    expect(socket.readyState).toBe(3)
    expect(events.map((e) => e.name)).toEqual(['error', 'close'])
    expect(named('error')[0].args[0]).toBe(refusal)
    const [code, reason] = named('close')[0].args as [number, Buffer]
    expect(code).toBe(1011)
    expect(reason.toString()).toBe('in-process daemon refused the client')
    expect(() => socket.sendFrame({ id: 1 })).toThrow('in-process daemon link is closed')
  })

  it('wraps a non-Error thrown by connect in an Error', async () => {
    const connect = vi.fn<InProcessConnect>(() => { throw 'plain string' })
    const { named } = open(connect)
    await settle()
    const err = named('error')[0].args[0]
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('plain string')
  })
})
