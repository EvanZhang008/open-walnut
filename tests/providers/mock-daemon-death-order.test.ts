/**
 * The mock daemon reports a CLI's death only after the lines that CLI wrote before it,
 * as daemon-core's reapSession does (C18: drainSessionFold fans the last lines out
 * before the ENXIO answer and the `dead` broadcast).
 *
 * 2026-11-04 (CI run 41870554237): a mock CLI exited right after its answer, a control
 * write met the readerless FIFO before the 50 ms poll read the answer, and the mock
 * answered ENXIO first. The server took the answered line as unanswered and sent it again,
 * so one message ran three turns and the extra turns ran into the next tests.
 *
 * The poll timer is held still here (fake setInterval), so a line reaches the client
 * before the death only when the death path itself drains the stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

let daemon: MockDaemon
let ws: WebSocket
let frames: Array<Record<string, unknown>>
let nextId = 1

function streamsDir(): string {
  return (daemon as unknown as { streamsDir: string }).streamsDir
}

async function request(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  ws.send(JSON.stringify({ id, ...cmd }))
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const reply = frames.find((f) => f.id === id)
    if (reply) return reply
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no reply to ${String(cmd.cmd)}`)
}

/** A live session whose CLI is gone: a FIFO nobody reads, and its answer on disk not yet polled. */
async function deadReaderSession(sid: string): Promise<string> {
  daemon.seedSession(sid, { alive: true })
  const pipe = path.join(streamsDir(), `${sid}.pipe`)
  execSync(`mkfifo ${JSON.stringify(pipe)}`)
  const jsonl = path.join(streamsDir(), `${sid}.jsonl`)
  fs.writeFileSync(jsonl, '')
  expect((await request({ cmd: 'attach', sid, fromOffset: 0 })).ok).toBe(true)
  const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'the answer', session_id: sid })
  fs.appendFileSync(jsonl, result + '\n')
  return result
}

/** Index of the frame carrying the CLI's last line, and of the first frame reporting the death. */
function order(sid: string, result: string, replyId: number): { line: number; death: number } {
  const line = frames.findIndex((f) => f.ev === 'jsonl' && f.sid === sid && f.line === result)
  const death = frames.findIndex((f) => f.id === replyId || (f.ev === 'session_state' && f.sid === sid && f.state === 'dead'))
  return { line, death }
}

describe('mock daemon: a death is reported after the lines written before it', () => {
  beforeEach(async () => {
    daemon = await createMockDaemon()
    frames = []
    ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`)
    ws.on('message', (data) => { frames.push(JSON.parse(String(data))) })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    ws.close()
    await daemon.stop()
  })

  for (const cmd of ['send', 'sendRaw'] as const) {
    it(`${cmd} into a readerless FIFO`, async () => {
      const sid = `death-order-${cmd}`
      const result = await deadReaderSession(sid)
      const id = nextId
      const reply = await request(cmd === 'send'
        ? { cmd, sid, message: 'one more line' }
        : { cmd, sid, raw: JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'get_settings' } }) })
      expect(reply).toMatchObject({ ok: false, reason: 'ENXIO' })
      const { line, death } = order(sid, result, id)
      expect(line, 'the answer reached the client').toBeGreaterThanOrEqual(0)
      expect(line, 'the answer came before the death').toBeLessThan(death)
    })
  }

  for (const cmd of ['send', 'sendRaw'] as const) {
    it(`an injected ENXIO on ${cmd}`, async () => {
      const sid = `death-order-fault-${cmd}`
      const result = await deadReaderSession(sid)
      daemon.injectSendFault(sid, 'ENXIO')
      const id = nextId
      await request(cmd === 'send' ? { cmd, sid, message: 'x' } : { cmd, sid, raw: '{"type":"control_request"}' })
      const { line, death } = order(sid, result, id)
      expect(line).toBeGreaterThanOrEqual(0)
      expect(line).toBeLessThan(death)
    })
  }

  it('simulateDeath', async () => {
    const sid = 'death-order-simulated'
    const result = await deadReaderSession(sid)
    daemon.simulateDeath(sid, 0)
    await new Promise((r) => setTimeout(r, 100))
    const line = frames.findIndex((f) => f.ev === 'jsonl' && f.sid === sid && f.line === result)
    const death = frames.findIndex((f) => f.ev === 'session_state' && f.sid === sid && f.state === 'dead')
    expect(line).toBeGreaterThanOrEqual(0)
    expect(line).toBeLessThan(death)
  })
})

/**
 * The standalone twin (tests/helpers/mock-daemon-process.mjs) runs in its own process,
 * so its poll timer cannot be held still: the test writes into a CLI that answers and
 * exits, as fast as it can, and checks the answer reached it before the first refused
 * write. Without the drain the answer usually comes after (the poll runs every 50 ms).
 */
describe('standalone mock daemon: the same order', () => {
  const SCRIPT = path.resolve(import.meta.dirname, '../helpers/mock-daemon-process.mjs')
  let proc: ChildProcess | null = null
  let sock: WebSocket | null = null

  afterEach(async () => {
    sock?.close()
    if (proc && proc.exitCode === null) {
      const gone = new Promise((r) => proc!.once('exit', r))
      proc.kill('SIGTERM')
      await gone
    }
    proc = null
  })

  it('a write into a CLI that just exited is refused only after its answer went out', async () => {
    proc = spawn(process.execPath, [SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      proc!.stdout!.on('data', (d) => {
        out += String(d)
        const m = out.match(/PORT=(\d+)/)
        if (m) resolve(Number(m[1]))
      })
      proc!.once('exit', () => reject(new Error('mock daemon process exited')))
    })
    const seen: Array<Record<string, unknown>> = []
    sock = new WebSocket(`ws://127.0.0.1:${port}`)
    sock.on('message', (data) => { seen.push(JSON.parse(String(data))) })
    await new Promise<void>((resolve, reject) => { sock!.once('open', () => resolve()); sock!.once('error', reject) })
    let id = 1
    const ask = async (cmd: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const mine = id++
      sock!.send(JSON.stringify({ id: mine, ...cmd }))
      for (let i = 0; i < 5000; i++) {
        const reply = seen.find((f) => f.id === mine)
        if (reply) return reply
        await new Promise((r) => setTimeout(r, 1))
      }
      throw new Error(`no reply to ${String(cmd.cmd)}`)
    }
    const sid = 'death-order-standalone'
    const started = await ask({ cmd: 'start', sid, message: 'hello' })
    expect(started.ok).toBe(true)
    const outputFile = String(started.outputFile)
    const resultLine = async (): Promise<string> => {
      for (let i = 0; i < 20_000; i++) {
        const line = fs.readFileSync(outputFile, 'utf8').split('\n').find((l) => l.includes('"type":"result"'))
        if (line) return line
        await new Promise((r) => setTimeout(r, 1))
      }
      throw new Error('the mock CLI wrote no result')
    }
    const result = await resultLine()
    let refused: Record<string, unknown> | null = null
    for (let i = 0; i < 2000 && !refused; i++) {
      const reply = await ask({ cmd: 'sendRaw', sid, raw: '{"type":"control_request"}' })
      if (reply.ok === false || (reply as { reason?: unknown }).reason) refused = reply
    }
    expect(refused, 'a write was refused once the CLI exited').not.toBeNull()
    const line = seen.findIndex((f) => f.ev === 'jsonl' && f.sid === sid && f.line === result)
    const death = seen.indexOf(refused!)
    expect(line, 'the answer reached the client').toBeGreaterThanOrEqual(0)
    expect(line, 'the answer came before the refusal').toBeLessThan(death)
  })
})
