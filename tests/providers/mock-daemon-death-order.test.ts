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
    await vi.waitFor(() => {
      expect(frames.some((f) => f.ev === 'session_state' && f.sid === sid && f.state === 'dead')).toBe(true)
    }, { timeout: 10_000, interval: 10 })
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
      // Only a death refuses (session_dead, ENXIO). EAGAIN is a full FIFO of a CLI that is still
      // alive (a loaded runner shrinks the pipe buffer to a page): wait and write again
      // (2026-11-05, a push gate run counted it as the death, before the answer was read).
      const reason = (reply as { reason?: unknown }).reason
      if (reason === 'EAGAIN') { await new Promise((r) => setTimeout(r, 1)); continue }
      if (reply.ok === false || reason) refused = reply
    }
    expect(refused, 'a write was refused once the CLI exited').not.toBeNull()
    const line = seen.findIndex((f) => f.ev === 'jsonl' && f.sid === sid && f.line === result)
    const death = seen.indexOf(refused!)
    expect(line, 'the answer reached the client').toBeGreaterThanOrEqual(0)
    expect(line, 'the answer came before the refusal').toBeLessThan(death)
  })
})

/**
 * One death, one report, as daemon-core's reapSession (`state === 'dead'` returns):
 * once a refused write reported a CLI's death, the CLI's own exit, which the mock
 * reports late (100 ms by default, 1.5 s here so the refusal surely comes first),
 * reports nothing more.
 *
 * 2026-11-07 (session-lifecycle e2e, on a Linux dev host and in GitHub CI): a turn-end control
 * write found the CLI gone, and its exit came again 100 ms later. Once it reached the
 * server while a follow-up's send was on its way, which ended the turn that send had
 * opened with the previous turn's text (one turn's result twice); once it reached the
 * process the resume had just started under the same sid, which ended that turn with
 * an empty result and handed its line back, so the follow-up ran twice.
 */
describe('mock daemon: a death a refused write reported is not reported again', () => {
  let d: MockDaemon
  let sock: WebSocket
  let seen: Array<Record<string, unknown>>
  let next = 1

  async function ask(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = next++
    sock.send(JSON.stringify({ id, ...cmd }))
    let reply: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      reply = seen.find((f) => f.id === id)
      expect(reply, `a reply to ${String(cmd.cmd)}`).toBeTruthy()
    }, { timeout: 10_000, interval: 5 })
    return reply!
  }

  type Inner = { sessions: Map<string, { procExited?: boolean; exited?: Promise<void> }> }

  beforeEach(async () => {
    d = await createMockDaemon({ exitReportDelayMs: 1_500 })
    seen = []
    sock = new WebSocket(`ws://127.0.0.1:${d.port}`)
    sock.on('message', (data) => { seen.push(JSON.parse(String(data))) })
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject) })
  })

  afterEach(async () => {
    sock.close()
    await d.stop()
  })

  for (const cmd of ['send', 'sendRaw'] as const) {
    it(`${cmd} into a CLI that exited after its answer`, async () => {
      const sid = `death-once-${cmd}`
      expect((await ask({ cmd: 'start', sid, message: 'hello' })).ok).toBe(true)
      const inner = (d as unknown as Inner).sessions
      const proc = inner.get(sid)!
      // The mock CLI answers and exits; its exit is reported 1.5 s later.
      await vi.waitFor(() => { expect(proc.procExited).toBe(true) }, { timeout: 15_000, interval: 5 })
      const refused = await ask(cmd === 'send'
        ? { cmd, sid, message: 'one more line' }
        : { cmd, sid, raw: JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'get_settings' } }) })
      expect(refused).toMatchObject({ ok: false, reason: 'ENXIO' })
      // The death reached every client before the refusal, as reapSession broadcasts it.
      const dead = seen.findIndex((f) => f.ev === 'session_state' && f.sid === sid && f.state === 'dead')
      expect(dead).toBeGreaterThanOrEqual(0)
      expect(dead).toBeLessThan(seen.indexOf(refused))
      // The next write is refused as a dead session, without trying the FIFO again.
      expect(await ask({ cmd: 'send', sid, message: 'and another' })).toMatchObject({ ok: false, reason: 'session_dead' })
      // Once the exit timer ran, it reported nothing (a reply after it: every frame sent before is in).
      await proc.exited
      await ask({ cmd: 'offline.ack' })
      expect(seen.filter((f) => f.ev === 'exit' && f.sid === sid)).toEqual([])
    })
  }

  it('a CLI that exits with no write refused reports its exit once', async () => {
    const sid = 'death-once-quiet'
    expect((await ask({ cmd: 'start', sid, message: 'hello' })).ok).toBe(true)
    await (d as unknown as Inner).sessions.get(sid)!.exited
    await ask({ cmd: 'offline.ack' })
    expect(seen.filter((f) => f.ev === 'exit' && f.sid === sid)).toHaveLength(1)
  })
})

describe('standalone mock daemon: a death a refused write reported is not reported again', () => {
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

  it('a write refused by a CLI that just exited is the only report of its death', async () => {
    proc = spawn(process.execPath, [SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOCK_DAEMON_EXIT_DELAY_MS: '1500' },
    })
    let errText = ''
    proc.stderr!.on('data', (d) => { errText += String(d) })
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
      let reply: Record<string, unknown> | undefined
      await vi.waitFor(() => {
        reply = seen.find((f) => f.id === mine)
        expect(reply).toBeTruthy()
      }, { timeout: 10_000, interval: 1 })
      return reply!
    }
    const sid = 'death-once-standalone'
    expect((await ask({ cmd: 'start', sid, message: 'hello' })).ok).toBe(true)
    let refused: Record<string, unknown> | null = null
    // Write until the CLI is gone (EAGAIN is a full pipe of a live CLI: write again).
    for (let i = 0; i < 5000 && !refused; i++) {
      const reply = await ask({ cmd: 'sendRaw', sid, raw: '{"type":"control_request"}' })
      const reason = (reply as { reason?: unknown }).reason
      if (reply.ok === false && reason !== 'EAGAIN') refused = reply
      else await new Promise((r) => setTimeout(r, 1))
    }
    expect(refused, 'a write was refused once the CLI exited').not.toBeNull()
    // The exit timer has run: it reported nothing.
    await vi.waitFor(() => { expect(errText).toContain(`exit of sid=${sid}:`) }, { timeout: 10_000, interval: 10 })
    expect(errText).toContain(`exit of sid=${sid}: not reported again`)
    expect(seen.filter((f) => f.ev === 'exit' && f.sid === sid)).toEqual([])
  })
})
