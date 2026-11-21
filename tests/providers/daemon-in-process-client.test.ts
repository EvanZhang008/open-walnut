/**
 * A client of a daemon runtime in the same process (daemon-in-process-client.ts), against fake
 * runtime deps that record every call. The runtime side is played by the test: its command
 * handler answers through ws.data.deliverFrame (an object) or ws.send (text), as the runtime does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInProcessClient, type Frame, type InProcessWs } from '../../src/providers/daemon-in-process-client.js'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(handler?: (ws: InProcessWs, frame: Frame) => void, opts: { onFrame?: (f: Frame) => void; onClose?: () => void } = {}) {
  const calls = {
    register: [] as InProcessWs[],
    unregister: [] as InProcessWs[],
    heardFrom: [] as InProcessWs[],
    commands: [] as Frame[],
    warn: [] as Array<{ msg: string; data: Record<string, unknown> }>,
  }
  const frames: Frame[] = []
  const onClose = opts.onClose ? vi.fn(opts.onClose) : vi.fn()
  const { client, ws } = createInProcessClient<InProcessWs>({
    handleCommandFrame: (socket, frame) => { calls.commands.push(frame); handler?.(socket, frame) },
    register: (socket) => { calls.register.push(socket) },
    unregister: (socket) => { calls.unregister.push(socket) },
    heardFrom: (socket) => { calls.heardFrom.push(socket) },
    warn: (msg, data) => { calls.warn.push({ msg, data }) },
  }, opts.onFrame ?? ((f) => { frames.push(f) }), onClose)
  return { client, ws, calls, frames, onClose }
}

/** A handler that answers every command with { id, ok: true, echo: cmd }. */
const echo = (ws: InProcessWs, frame: Frame) => ws.data.deliverFrame({ id: frame.id, ok: true, echo: frame.cmd })

afterEach(() => { vi.restoreAllMocks() })

describe('createInProcessClient: joining', () => {
  it('registers the ws with the runtime and counts it heard from', () => {
    const { ws, calls } = setup()
    expect(calls.register).toEqual([ws])
    expect(calls.heardFrom).toEqual([ws])
    expect(ws.readyState).toBe(1)
  })

  it('answers a ping at once through heardFrom', () => {
    const { ws, calls } = setup()
    ws.ping()
    ws.ping()
    expect(calls.heardFrom).toHaveLength(3)
  })
})

describe('createInProcessClient: commands and replies', () => {
  it('request() resolves with the reply matched by its negative id', async () => {
    const { client, calls, frames } = setup(echo)
    const a = client.request('status', { verbose: true })
    const b = client.request('list')
    expect(calls.commands).toEqual([
      { verbose: true, id: -1, cmd: 'status' },
      { id: -2, cmd: 'list' },
    ])
    expect(await a).toEqual({ id: -1, ok: true, echo: 'status' })
    expect(await b).toEqual({ id: -2, ok: true, echo: 'list' })
    // A reply that answered a request is not also handed to onFrame.
    expect(frames).toEqual([])
  })

  it('hands the command over in the call and every frame heardFrom the runtime', () => {
    const { client, calls } = setup()
    void client.request('a')
    client.send({ id: 7, cmd: 'b' })
    expect(calls.commands.map((c) => c.cmd)).toEqual(['a', 'b'])
    expect(calls.heardFrom).toHaveLength(3)
  })

  it('delivers frames on a later turn of the loop, never inside the command, and in order', async () => {
    const order: string[] = []
    const { client, frames } = setup((ws, frame) => {
      ws.data.deliverFrame({ id: frame.id, ok: true })
      ws.data.deliverFrame({ ev: 'one' })
      ws.data.deliverFrame({ ev: 'two' })
      order.push('handler returned')
    }, { onFrame: (f) => { order.push(`frame ${String(f.ev ?? f.id)}`); frames.push(f) } })
    client.send({ id: 5, cmd: 'go' })
    order.push('send returned')
    expect(frames).toEqual([])
    // Not even in this turn's microtasks: the runtime's own work and the hand-over are separate turns.
    await Promise.resolve()
    expect(frames).toEqual([])
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['handler returned', 'send returned', 'frame 5', 'frame one', 'frame two'])
  })

  it('does not take an event with a negative id field as a reply', async () => {
    const later: { reply?: () => void } = {}
    const { client, frames } = setup((ws, frame) => {
      ws.data.deliverFrame({ ev: 'progress', id: frame.id })
      later.reply = () => ws.data.deliverFrame({ id: frame.id, ok: true })
    })
    let resolved = false
    const p = client.request('work').then((f) => { resolved = true; return f })
    await settle()
    expect(frames).toEqual([{ ev: 'progress', id: -1 }])
    expect(resolved).toBe(false)
    later.reply!()
    expect(await p).toEqual({ id: -1, ok: true })
  })

  it('send() passes the caller positive id through and its reply goes to onFrame', async () => {
    const { client, calls, frames } = setup(echo)
    client.send({ id: 42, cmd: 'ping-me', x: 1 })
    expect(calls.commands).toEqual([{ id: 42, cmd: 'ping-me', x: 1 }])
    await settle()
    expect(frames).toEqual([{ id: 42, ok: true, echo: 'ping-me' }])
  })

  it('hands a reply with an unknown negative id to onFrame', async () => {
    const { ws, frames } = setup()
    ws.data.deliverFrame({ id: -99, ok: true })
    await settle()
    expect(frames).toEqual([{ id: -99, ok: true }])
  })

  it('answers a command whose handler throws with an error reply, and warns', async () => {
    const { client, calls, frames } = setup(() => { throw new Error('kaput') })
    const reply = await client.request('bad')
    expect(reply).toEqual({ id: -1, ok: false, error: 'daemon command failed: kaput' })
    client.send({ id: 3, cmd: 'bad2' })
    await settle()
    expect(frames).toEqual([{ id: 3, ok: false, error: 'daemon command failed: kaput' }])
    expect(calls.warn.map((w) => [w.msg, w.data.cmd])).toEqual([
      ['in-process client: command handler threw', 'bad'],
      ['in-process client: command handler threw', 'bad2'],
    ])
  })

  it('warns and answers nothing when a handler throws for a command without an id', async () => {
    const { client, calls, frames } = setup(() => { throw new Error('x') })
    expect(() => client.send({ cmd: 'fire-and-forget' })).not.toThrow()
    await settle()
    expect(frames).toEqual([])
    expect(calls.warn).toHaveLength(1)
  })

  it('warns when onFrame throws, and later frames still arrive', async () => {
    const got: Frame[] = []
    const { ws, calls } = setup(undefined, {
      onFrame: (f) => { got.push(f); if (f.ev === 'bad') throw new Error('consumer broke') },
    })
    ws.data.deliverFrame({ ev: 'bad' })
    ws.data.deliverFrame({ ev: 'after' })
    await settle()
    ws.data.deliverFrame({ ev: 'later' })
    await settle()
    expect(got.map((f) => f.ev)).toEqual(['bad', 'after', 'later'])
    expect(calls.warn).toHaveLength(1)
    expect(calls.warn[0].msg).toBe('in-process client: frame handler threw')
    expect(String(calls.warn[0].data.error)).toContain('consumer broke')
  })
})

describe('createInProcessClient: text from the runtime', () => {
  it('parses ws.send text once and delivers the object', async () => {
    const { ws, frames } = setup()
    const spy = vi.spyOn(JSON, 'parse')
    const text = JSON.stringify({ ev: 'out', data: [1, 2] })
    expect(ws.send(text)).toBe(text.length)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    await settle()
    expect(frames).toEqual([{ ev: 'out', data: [1, 2] }])
  })

  it('answers a request through text too', async () => {
    const { client } = setup((ws, frame) => { ws.send(JSON.stringify({ id: frame.id, ok: true })) })
    expect(await client.request('t')).toEqual({ id: -1, ok: true })
  })

  it('ignores text that is no JSON object', async () => {
    const { ws, frames } = setup()
    expect(ws.send('not json')).toBe('not json'.length)
    ws.send('[1,2]')
    ws.send('null')
    ws.send('3')
    expect(ws.send('')).toBe(1)
    await settle()
    expect(frames).toEqual([])
  })
})

describe('createInProcessClient: closing', () => {
  it('client.close() answers waiting requests, unregisters once, and runs no onClose', async () => {
    const { client, ws, calls, onClose } = setup()
    const a = client.request('never-answered')
    const b = client.request('also')
    client.close()
    client.close()
    expect(await a).toEqual({ ok: false, error: 'client closed' })
    expect(await b).toEqual({ ok: false, error: 'client closed' })
    expect(calls.unregister).toEqual([ws])
    expect(onClose).not.toHaveBeenCalled()
    expect(ws.readyState).toBe(3)
  })

  it('a close by the runtime (ws.close) runs onClose once', () => {
    const { ws, calls, onClose } = setup()
    ws.close()
    ws.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(calls.unregister).toEqual([ws])
  })

  it('ws.terminate() closes as ws.close() does', () => {
    const { ws, calls, onClose } = setup()
    ws.terminate()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(calls.unregister).toHaveLength(1)
  })

  it('warns when onClose throws', () => {
    const { ws, calls } = setup(undefined, { onClose: () => { throw new Error('close broke') } })
    expect(() => ws.close()).not.toThrow()
    expect(calls.warn.map((w) => w.msg)).toEqual(['in-process client: close handler threw'])
  })

  it('send after close throws; request after close resolves client closed without a command', async () => {
    const { client, calls } = setup(echo)
    client.close()
    expect(() => client.send({ id: 1, cmd: 'x' })).toThrow('in-process daemon client is closed')
    expect(await client.request('y')).toEqual({ ok: false, error: 'client closed' })
    expect(calls.commands).toEqual([])
  })

  it('drops frames queued before the close and any delivered after it', async () => {
    const { client, ws, frames } = setup()
    ws.data.deliverFrame({ ev: 'queued' })
    client.close()
    ws.data.deliverFrame({ ev: 'late' })
    expect(ws.send(JSON.stringify({ ev: 'late-text' }))).toBe(0)
    await settle()
    expect(frames).toEqual([])
  })
})
