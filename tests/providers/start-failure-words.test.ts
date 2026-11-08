/**
 * A daemon start failure reads in plain words (src/providers/delivery-failure.ts), and one whose
 * Claude Code stopped before it read the first line waits like a missing install: typed, parked
 * with the cause, and started fresh later, never resumed (2026-11-11 review: the user read
 * "Daemon start failed on host ...: internal daemon error handling start: start: initial message
 * not delivered (ENXIO)", then a false "began outside this Demo" on the retry).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import {
  ClaudeRuntimeMissingError, classifyDeliveryFailure, cliStoppedBeforeFirstLine, isClaudeRuntimeMissing, cliStoppedSentence, startFailureSentence,
} from '../../src/providers/delivery-failure.js'
import { AGENT_WAIT_RESEND } from '../../src/core/sessions/agent-wait-resend.js'

const ROOT = path.join(__dirname, '../..')

/** Every reason a daemon's send gives for a line it did not write (daemon-core.ts SendResult), judged. */
const SEND_REASONS: Record<string, 'cli_gone' | 'other'> = {
  not_found: 'cli_gone', // the process was already reaped
  session_dead: 'cli_gone',
  ENXIO: 'cli_gone', // nothing reads its stdin
  EAGAIN: 'other',
  partial_write: 'other',
  budget_paused: 'other',
  budget_checking: 'other',
}

function manager(host: string, reply: Record<string, unknown>) {
  const conn = { connected: true, hasCapability: () => false, onEvent: () => () => {}, send: vi.fn(async () => reply) }
  const mgr = new RemoteSessionManager('aaaaaaaa-0000-4000-8000-0000000000e1', host, null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn })
  return mgr
}
const startOpts = { args: [], cwd: '/tmp', message: 'Summarize this folder', resume: false, onOutput: () => {}, onExit: () => {} }

describe('a start whose Claude Code stopped before it read the message', () => {
  for (const reason of Object.keys(SEND_REASONS).filter((r) => SEND_REASONS[r] === 'cli_gone')) {
    it(`${reason}: typed claude_error, named host, no internal words, waits for Retry`, async () => {
      const error = `internal daemon error handling start: start: initial message not delivered (${reason})`
      const err = await manager('demo-devbox', { ok: false, error }).start(startOpts).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ClaudeRuntimeMissingError)
      const typed = err as ClaudeRuntimeMissingError
      expect(typed.errorKind).toBe('claude_error')
      expect(typed.message).toBe(cliStoppedSentence('demo-devbox'))
      expect(typed.message).toMatch(/^Claude Code on demo-devbox stopped before it read your message/)
      expect(typed.waitingReason).toMatch(/Retry/)
      expect(typed.message).not.toMatch(/daemon|ENXIO|internal/i)
      // Parked for good until Retry or the host reads runnable again, never retried on a clock.
      expect(classifyDeliveryFailure(err)).toMatchObject({ kind: 'permanent', waitsFor: 'claude_error' })
      expect(AGENT_WAIT_RESEND.claude_error).toBe('host-runnable')
      // Rebuilt from its words (an error that crossed a boundary as text), it is still this.
      expect(isClaudeRuntimeMissing(new Error(typed.message))).toBe(true)
    })
  }

  it('on this computer the sentence names no host', () => {
    expect(cliStoppedSentence(null)).toMatch(/^Claude Code stopped before it read your message.*on this computer/)
    expect(cliStoppedSentence('__local__')).toBe(cliStoppedSentence(null))
  })

  it('any other start failure says what failed without the daemon frames', async () => {
    const err = await manager('demo-devbox', { ok: false, error: 'internal daemon error handling start: start: spawn EACCES' })
      .start(startOpts).then(() => null, (e: unknown) => e) as Error
    expect(err.message).toBe('Walnut could not start Claude Code on demo-devbox: spawn EACCES')
    expect(startFailureSentence(null, '')).toBe('Walnut could not start Claude Code.')
  })

  it('guard: every send reason of the daemon is judged, and only the gone ones read as stopped', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-core.ts'), 'utf8')
    const union = core.slice(core.indexOf('export type SendResult ='), core.indexOf('/** Read-only line lookup'))
    let judged = 0
    for (const m of union.matchAll(/reason: ((?:'[A-Za-z_]+'(?: \| )?)+)/g)) {
      for (const r of m[1].match(/[A-Za-z_]+/g)!) { expect(SEND_REASONS[r], `judge the send reason ${r}`).toBeDefined(); judged++ }
    }
    expect(judged).toBeGreaterThanOrEqual(Object.keys(SEND_REASONS).length)
    for (const [reason, kind] of Object.entries(SEND_REASONS)) {
      expect(cliStoppedBeforeFirstLine(`start: initial message not delivered (${reason})`), reason).toBe(kind === 'cli_gone')
    }
    // Both daemon twins still word the failure the way the server reads it.
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      expect(fs.readFileSync(path.join(ROOT, twin), 'utf8'), twin).toMatch(/start: initial message not delivered \(/)
    }
    // start() throws no raw daemon text.
    const rsm = fs.readFileSync(path.join(ROOT, 'src/providers/remote-session-manager.ts'), 'utf8')
    expect(rsm).not.toMatch(/Daemon start failed on host/)
  })
})
