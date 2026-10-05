/**
 * Repro for connection-matrix S8, written against APIs that predate the fix.
 *
 * The host takes the send but its answer reaches the Mac after the 30 s command
 * timeout. writeMessage used to return false for that, the same as for a dead
 * CLI, and the runner then stopped the healthy CLI and resent the line on a
 * fresh process: the message ran twice. An unanswered send must be settled by
 * asking the daemon again (same line, dedupe), never reported as refused.
 */
import { describe, it, expect, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

function managerWith(replies: Array<Record<string, unknown> | Error>) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  const conn = {
    connected: true,
    hasCapability: () => true,
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload })
      const next = replies.shift() ?? { ok: true }
      if (next instanceof Error) throw next
      return next
    }),
  }
  const mgr = new RemoteSessionManager('sid-late', '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: 'sid-late' })
  return { mgr, sent }
}

const markers = [{ message: 'hello', messageId: 'qm-late' }]

describe('S8: a send whose reply came too late', () => {
  it('is not reported as refused, and the line is asked about, not blindly resent', async () => {
    const { mgr, sent } = managerWith([new Error('daemon command timeout: send (30000ms)'), { ok: true, duplicate: true }])
    expect(await mgr.writeMessage('hello', { uuid: 'u-late', markers })).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1].payload).toMatchObject({ uuid: 'u-late', markers, dedupe: true })
  })

  it('a socket closed with the send pending is not a refusal either', async () => {
    const { mgr } = managerWith([new Error('connection closed'), { ok: true }])
    expect(await mgr.writeMessage('hello', { uuid: 'u-late', markers })).toBe(true)
  })
})
