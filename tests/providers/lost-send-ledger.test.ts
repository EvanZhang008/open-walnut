/**
 * A FIFO send whose link closed before the daemon answered runs exactly once
 * (matrix D1, 2026-10-05; runner gate r3, probe r3-torn).
 *
 * The line goes through RemoteSessionManager.writeMessage: its send hears the
 * close at once (daemon-connection.ts failPendingOn), and confirmSend asks the
 * daemon again with the same line and `dedupe`. The daemon that answers is the
 * real daemon core (createDaemonCore) writing a real FIFO; the daemon that died
 * is played by writing what it would have left at each crash point (body, then
 * the markers to the stream, then the newline, then the write record).
 *
 * Judged by a ledger of what the CLI runs, never by bytes written. FakeCli keeps
 * the CLI's stdin rules (structuredIO.ts processLine, print.ts): lines split on
 * '\n', an empty line is skipped, a malformed line exits the CLI, a user line
 * whose uuid this process already received is dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

class FakeCli {
  private buf = ''
  private seen = new Set<string>()
  runs: string[] = []
  exited = false
  write(bytes: string): void {
    if (this.exited) return
    this.buf += bytes
    let i: number
    while (!this.exited && (i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg: { uuid?: string; message?: { content?: string } }
      try { msg = JSON.parse(line) } catch { this.exited = true; return }
      if (msg.uuid) { if (this.seen.has(msg.uuid)) continue; this.seen.add(msg.uuid) }
      this.runs.push(String(msg.message?.content))
    }
  }
}

/** Where the old daemon died while writing the first copy. */
type Crash = 'before-write' | 'mid-body' | 'after-body' | 'after-marker' | 'after-newline' | 'after-record'

const PID = 4321
const SID = 'sid-ledger'

describe('a lost send runs once: the CLI\'s ledger at every crash point', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  let readerFd = -1
  let jsonlPath = ''
  let pipePath = ''

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process signal in a FIFO test') })
    ctx = await buildDeps()
    pipePath = path.join(ctx.tmpDir, `${SID}.pipe`)
    execFileSync('mkfifo', [pipePath])
    readerFd = fs.openSync(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    jsonlPath = path.join(ctx.tmpDir, `${SID}.jsonl`)
    fs.writeFileSync(jsonlPath, '')
    ctx.sessions.set(SID, makeTestSession({ pid: PID, pipePath, jsonlPath }))
  })

  afterEach(async () => {
    try { fs.closeSync(readerFd) } catch { /* closed */ }
    try { await ctx.cleanup() } finally { vi.restoreAllMocks() }
  })

  function drainInto(cli: FakeCli): void {
    for (let i = 0; i < 50; i++) {
      const buf = Buffer.alloc(64 * 1024)
      let n = 0
      try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch { break }
      if (n <= 0) break
      cli.write(buf.subarray(0, n).toString('utf8'))
    }
  }

  /** The old daemon's bytes, as daemon-core writes a line, up to `upTo`. */
  function oldDaemonWrote(p: Record<string, unknown>, upTo: Crash): void {
    const body = JSON.stringify({ type: 'user', message: { role: 'user', content: p.message }, ...(p.uuid ? { uuid: p.uuid } : {}) })
    const pipe = (bytes: string) => {
      const w = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try { fs.writeSync(w, bytes) } finally { fs.closeSync(w) }
    }
    if (upTo === 'before-write') return
    if (upTo === 'mid-body') return pipe(body.slice(0, 10))
    pipe(body)
    if (upTo === 'after-body') return
    for (const m of p.markers as Array<{ message: string; messageId: string }>) {
      fs.appendFileSync(jsonlPath, JSON.stringify({
        type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: m.message },
        walnutMessageId: m.messageId, walnutDelivery: 'ordered', walnutPid: PID,
      }) + '\n')
    }
    if (upTo === 'after-marker') return
    pipe('\n')
  }

  /** A manager whose first send dies at `crash`; every later one reaches the real daemon core. */
  function rig(crash: Crash) {
    const core = createDaemonCore(ctx.deps)
    const sends: Array<{ params: Record<string, unknown>; opts: unknown }> = []
    let connected = true
    const conn = {
      get connected() { return connected },
      hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1'].includes(c),
      async send(cmd: string, params: Record<string, unknown> = {}, _timeoutMs?: number, opts?: unknown) {
        if (cmd !== 'send') return { ok: true }
        sends.push({ params, opts })
        const toCore = () => core.handleSendCommand(SID, String(params.message), params.uuid as string | undefined,
          params.markers as Array<{ message: string; messageId: string }>, { dedupe: params.dedupe === true })
        if (sends.length > 1) return toCore()
        if (crash === 'after-record') {
          // The whole write, record included, went through; the answer died with the link.
          await toCore()
        } else oldDaemonWrote(params, crash)
        connected = false
        setTimeout(() => { connected = true }, 50)
        // What DaemonConnection.failPendingOn rejects with when the socket goes.
        throw new Error('daemon command lost: send: connection closed before __local__ answered [traceId=t1]')
      },
    }
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: SID, _hasPipe: true })
    return { mgr, sends }
  }

  const markers = [{ message: 'hello', messageId: 'qm-ledger-1' }]

  for (const crash of ['before-write', 'after-marker', 'after-newline', 'after-record'] as const) {
    it(`a line with a uuid, the old daemon died ${crash}: runs once, the CLI lives`, async () => {
      const r = rig(crash)
      const cli = new FakeCli()
      await expect(r.mgr.writeMessage('hello', { uuid: 'u-ledger-1', markers })).resolves.toBe(true)
      drainInto(cli)
      expect(cli.runs).toEqual(['hello'])
      expect(cli.exited).toBe(false)
      // The first send heard the close; the second is the SAME line, asked with dedupe.
      expect(r.sends[0].params).not.toHaveProperty('dedupe')
      expect(r.sends[1].params).toMatchObject({ uuid: 'u-ledger-1', markers, dedupe: true })
    }, 15_000)
  }

  // The writer stamps the marker in the same tick the body's last byte goes in
  // (daemon-core.ts writeFifoFullyAsync): a dead write that left a whole body
  // and no marker needs a kill between those two calls. With no marker of this
  // process the copy carries no newline (lineTornEnd; send-lost-line-v1's rule
  // for a first write into a process), so it merges with that body: never twice.
  it('a line with a uuid, the old daemon died after-body (before its marker): never runs twice (named residual)', async () => {
    const r = rig('after-body')
    const cli = new FakeCli()
    await r.mgr.writeMessage('hello', { uuid: 'u-ledger-1', markers })
    drainInto(cli)
    expect(cli.runs.length).toBeLessThanOrEqual(1)
  }, 15_000)

  it('a body cut part way is not recoverable from a FIFO: never runs twice', async () => {
    const r = rig('mid-body')
    const cli = new FakeCli()
    await r.mgr.writeMessage('hello', { uuid: 'u-ledger-1', markers })
    drainInto(cli)
    expect(cli.runs.length).toBeLessThanOrEqual(1)
  }, 15_000)

  // Without a uuid the CLI cannot drop a copy. Every queue line carries one now
  // (batch-uuid.ts lineUuidFor); a line without one is written as before.
  for (const crash of ['before-write', 'after-record'] as const) {
    it(`a line without a uuid, the old daemon died ${crash}: runs once`, async () => {
      const r = rig(crash)
      const cli = new FakeCli()
      await expect(r.mgr.writeMessage('hello', { markers })).resolves.toBe(true)
      drainInto(cli)
      expect(cli.runs).toEqual(['hello'])
      expect(cli.exited).toBe(false)
    }, 15_000)
  }

  for (const crash of ['after-body', 'after-marker'] as const) {
    it(`a line without a uuid, the old daemon died ${crash}: never runs twice (the accepted residual)`, async () => {
      const r = rig(crash)
      const cli = new FakeCli()
      await r.mgr.writeMessage('hello', { markers })
      drainInto(cli)
      expect(cli.runs.length).toBeLessThanOrEqual(1)
    }, 15_000)
  }
})
