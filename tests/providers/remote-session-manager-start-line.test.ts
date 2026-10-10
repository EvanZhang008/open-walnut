/**
 * The first line of a cold --resume (r5 gate N1, transport half). With
 * send-markers-v1 the start spawns the CLI and the manager writes the deferred
 * first line after it. That write had none of a send's contract: no dedupe on
 * its first try (a live-adopted process that held a piece of the line got the
 * copy glued onto it), and a cut answer from its confirm resend was only logged,
 * so start() resolved as a plain start and the runner removed the batch while
 * the CLI exited on the cut copy (the r4c gate's F1 loss, on the resume path).
 *
 * Now the deferred line is written as a resend would be (dedupe, so the daemon
 * reads its records and ends a piece first), and start() reports what the
 * write said: `cut` when it went in behind a cut copy, `fate` when the daemon
 * wrote nothing because it knew what became of the line.
 */
import { describe, it, expect, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

type Reply = Record<string, unknown> | Error

function fakeConn(replies: Reply[]) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1'].includes(c),
    onEvent: () => () => {},
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload })
      const next = replies.shift() ?? new Error('no more replies')
      if (next instanceof Error) throw next
      return next
    }),
  }
  return { conn, sent }
}

async function start(replies: Reply[]) {
  const { conn, sent } = fakeConn(replies)
  const mgr = new RemoteSessionManager('sid-start-line', '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn })
  const result = await mgr.start({
    args: [], cwd: '/tmp', message: 'hello', uuid: 'u-1', markers: [{ message: 'hello', messageId: 'qm-1' }],
    resume: true, onOutput: () => {}, onExit: () => {},
  })
  return { result: result as unknown as Record<string, unknown>, sent }
}

const started = { ok: true, pid: 4242, outputFile: '/nonexistent/start-line.jsonl', offset: 0 }

describe('RemoteSessionManager.start: the deferred first line has a send\'s contract', () => {
  it('the gate\'s PC: the confirm resend is answered cut, and start() says so', async () => {
    const { result, sent } = await start([started, new Error('connection closed'), { ok: true, cut: true }])
    expect(sent.map((s) => s.cmd)).toEqual(['start', 'send', 'send'])
    expect(sent[2].payload).toMatchObject({ uuid: 'u-1', dedupe: true })
    expect(result).toMatchObject({ pid: 4242, cut: true })
  })

  it('the first try asks too (dedupe): a live-adopted process may hold a piece of this line', async () => {
    const { result, sent } = await start([{ ...started, adopted: true }, { ok: true, cut: true }])
    expect(sent[1]).toMatchObject({ cmd: 'send', payload: { uuid: 'u-1', markers: [{ messageId: 'qm-1' }], dedupe: true } })
    expect(result).toMatchObject({ pid: 4242, cut: true })
  })

  it('the daemon knew the line\'s fate and wrote nothing: start() carries the fate', async () => {
    const { result } = await start([started, { ok: true, duplicate: true, fate: 'cancelled', state: 'cancelled' }])
    expect(result.fate).toEqual({ fate: 'cancelled', state: 'cancelled' })
    expect(result).not.toHaveProperty('cut')
  })

  it('control: a plain write is a plain start (no cut, no fate)', async () => {
    const { result } = await start([started, { ok: true }])
    expect(result).toEqual({ pid: 4242, outputFile: 'remote://__local__/sid-start-line', fileSize: 0 })
  })
})
