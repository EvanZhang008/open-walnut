/**
 * The mock daemon lives inside the browser fixture server, so a command that throws
 * must answer an error and leave the daemon serving, as the real daemon does.
 *
 * 2026-11-12: on Linux, bun's spawn threw E2BIG synchronously for a VP session's long
 * argv; the throw ended the fixture server and every browser test after it failed with
 * ECONNREFUSED.
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MockDaemon } from '../helpers/mock-daemon.js'

let daemon: MockDaemon | null = null
let ws: WebSocket | null = null

afterEach(async () => {
  ws?.close()
  ws = null
  await daemon?.stop()
  daemon = null
})

async function connect(): Promise<(cmd: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  daemon = new MockDaemon()
  await daemon.start()
  ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`)
  await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject) })
  let next = 1
  return (cmd) => new Promise((resolve) => {
    const id = next++
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id !== id) return
      ws!.off('message', onMessage)
      resolve(msg)
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

describe('a mock daemon command that throws answers an error and the daemon keeps serving', () => {
  it('a spawn the OS refuses (argument list too long) is the start\'s error', async () => {
    const call = await connect()
    // Over ARG_MAX on Linux and macOS alike, so posix_spawn refuses it.
    const huge = Array.from({ length: 48 }, () => 'x'.repeat(100_000))
    const reply = await call({ cmd: 'start', sid: 'too-long', args: ['claude', '-p', ...huge] })
    expect(reply.ok).not.toBe(true)
    expect(String(reply.error)).toMatch(/spawn failed|E2BIG|too long/i)
    const status = await call({ cmd: 'status', sid: 'too-long' })
    expect(status.id).toBeDefined()
  })

  it('any other throw in a handler is answered too', async () => {
    const call = await connect()
    const reply = await call({ cmd: 'start', sid: 'bad-args', args: 42 })
    expect(reply.ok).not.toBe(true)
    expect(String(reply.error)).toMatch(/iterable|not a function/)
    const status = await call({ cmd: 'status', sid: 'bad-args' })
    expect(status.id).toBeDefined()
  })
})
