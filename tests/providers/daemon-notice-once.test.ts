/**
 * One CLI process is given one instruction notice once (daemon-core.ts createNoticeOnce).
 *
 * The notice reaches a session by the server's queue and by this host's own same-host
 * delivery, and each learns of the other's only later (a debounced slice push, a journal
 * drained after a moment), so both could lead a line with the same notice. Every line of
 * both paths is written by handleSendCommand, which leaves out of one path's line a notice
 * the OTHER path gave in the last 2 minutes. The same path says it again (its first line may never
 * have run), and a resend keeps it.
 *
 * What's real: daemon-core's handleSendCommand and real FIFOs. Nothing is signalled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'
import { createNoticeOnce } from '../../src/providers/daemon-core.js'
import { NOTICE_OPENING } from '../../src/core/sessions/instruction-notice-flight.js'

const notice = (body: string) => `${NOTICE_OPENING} note="current default instructions, not a work request">\n${body}\n</walnut-message>`
const N1 = notice('Walnut changed your default instructions: rule one.')
const N2 = notice('Walnut changed your default instructions: rule two.')

describe('the daemon gives one process one notice once', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  let readerFd = -1

  beforeEach(() => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process signal in a FIFO test') })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
  })
  afterEach(async () => {
    try { fs.closeSync(readerFd) } catch { /* closed */ }
    try { await ctx?.cleanup() } finally { vi.restoreAllMocks() }
  })

  async function session() {
    ctx = await buildDeps({})
    const fifo = path.join(ctx.tmpDir, 'n.pipe')
    execFileSync('mkfifo', [fifo])
    const jsonlPath = path.join(ctx.tmpDir, 'n.jsonl')
    fs.writeFileSync(jsonlPath, '')
    readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    ctx.sessions.set('sid', makeTestSession({ pid: 970, pipePath: fifo, jsonlPath }))
    return createDaemonCore(ctx.deps)
  }
  /** The user lines written to the FIFO since the last read. */
  function lines(): string[] {
    const buf = Buffer.alloc(1 << 20)
    let n = 0
    try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch { n = 0 }
    return buf.subarray(0, n).toString().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { message: { content: string } }).message.content)
  }

  it('one path\'s line goes without a notice the other path just wrote; the same path says it again', async () => {
    const core = await session()
    const fromHost = { fromHost: true }
    // The server says it, the host's own delivery (on a slice that does not know yet) goes without it.
    expect(await core.handleSendCommand('sid', `${N1}\n\nFrom the server`, 'u1', [{ message: `${N1}\n\nFrom the server`, messageId: 'qm-1' }])).toEqual({ ok: true })
    expect(await core.handleSendCommand('sid', `${N1}\n\nFrom a peer on this host`, undefined, [{ message: `${N1}\n\nFrom a peer on this host`, messageId: 'qm-2' }], fromHost)).toEqual({ ok: true, noticeLeftOut: true })
    // The server's own next line keeps it: its first may never have run (a Stop), and only the server knows.
    expect(await core.handleSendCommand('sid', `${N1}\n\nThe server again`)).toEqual({ ok: true })
    // The host says a newer one; the server's line with the same newer one goes without it.
    expect(await core.handleSendCommand('sid', `${N2}\n\nHost first`, undefined, undefined, fromHost)).toEqual({ ok: true })
    expect(await core.handleSendCommand('sid', `${N2}\n\nServer second`)).toEqual({ ok: true })
    expect(lines()).toEqual([`${N1}\n\nFrom the server`, 'From a peer on this host', `${N1}\n\nThe server again`, `${N2}\n\nHost first`, 'Server second'])
  })

  it('pure rules: a resend, a new process, a stale entry, a bare notice and the same path keep it', () => {
    const once = createNoticeOnce()
    once.given('sid', 1, N1, false, 1_000)
    const line = `${N1}\n\nText`
    const host = { fromHost: true }
    expect(once.once('sid', 1, line, [], host, 2_000)).toMatchObject({ message: 'Text', stripped: true })
    expect(once.once('sid', 1, line, [], {}, 2_000)).toMatchObject({ message: line, stripped: false })
    expect(once.once('sid', 1, line, [], { resend: true, fromHost: true }, 2_000)).toMatchObject({ message: line, stripped: false })
    expect(once.once('sid', 2, line, [], host, 2_000)).toMatchObject({ message: line, stripped: false })
    expect(once.once('sid', 1, line, [], host, 1_000 + 2 * 60_000)).toMatchObject({ message: line, stripped: false })
    expect(once.once('sid', 1, N1, [], host, 2_000)).toMatchObject({ message: N1, stripped: false })
    expect(once.once('other', 1, line, [], host, 2_000)).toMatchObject({ message: line, stripped: false })
    // No pid, no proof of one process.
    once.given('nopid', null, N1, false, 1_000)
    expect(once.once('nopid', null, line, [], host, 2_000)).toMatchObject({ stripped: false })
    // Markers carry the same text for the stream capture: they lose the notice with the line.
    expect(once.once('sid', 1, line, [{ message: line, messageId: 'qm' }], host, 2_000).markers).toEqual([{ message: 'Text', messageId: 'qm' }])
  })
})
