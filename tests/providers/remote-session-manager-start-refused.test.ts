/**
 * A start the daemon refused leaves a transport no process ever ran under
 * (src/providers/remote-session-manager.ts `_startRefused`).
 *
 * Review round 2, D08: a task sent before Claude Code was installed kept that
 * transport in memory. The next send wrote the line to it as if a CLI were live:
 * a test server's gate refused that write outright ("inherited_session: this test
 * server did not start session ..."), and a real daemon answers an unknown
 * session, which only holds the line. A refused start's writes now answer "not
 * written", so the caller starts a process (the --resume fallback, which starts the
 * never-written conversation under the same id), and its stop has nothing to stop.
 *
 * Only a refusal under which nothing of ours runs (START_REFUSALS_RUN_NOTHING):
 * `session_live` may mean this host's own daemon runs a CLI under the id, so its
 * writes and stop still go to the daemon (review round 2, should-fix 6).
 *
 * The matrix covers every refusal start() knows; the guard reads them from the
 * source, so a new refusal kind fails here until it is listed and judged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RemoteSessionManager, START_REFUSALS_MAY_RUN, START_REFUSALS_RUN_NOTHING } from '../../src/providers/remote-session-manager.js'
import { ClaudeRuntimeMissingError } from '../../src/providers/delivery-failure.js'

type Reply = Record<string, unknown>

function fakeConn(replies: Reply[], caps: string[] = []) {
  const sent: string[] = []
  const conn = {
    connected: true,
    hasCapability: (c: string) => caps.includes(c),
    onEvent: () => () => {},
    send: vi.fn(async (cmd: string) => {
      sent.push(cmd)
      const next = replies.shift()
      if (!next) throw new Error(`unexpected command ${cmd}`)
      return next
    }),
  }
  return { conn, sent }
}

function manager(replies: Reply[], caps: string[] = []) {
  const { conn, sent } = fakeConn(replies, caps)
  const mgr = new RemoteSessionManager('aaaaaaaa-0000-4000-8000-0000000000d8', '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn })
  return { mgr, sent }
}

const startOpts = { args: [], cwd: '/tmp', message: 'hello before installing', resume: false, onOutput: () => {}, onExit: () => {} }

/** Every refusal reply start() handles, by the field it reads (errorKind or reason). */
const REFUSALS: Record<string, Reply> = {
  budget_paused: { ok: false, reason: 'budget_paused', errorKind: 'budget_paused' },
  budget_checking: { ok: false, reason: 'budget_checking', errorKind: 'budget_checking' },
  session_stopped: { ok: false, reason: 'session_stopped' },
  session_other_walnut: { ok: false, errorKind: 'session_other_walnut', reason: 'session_other_walnut' },
  session_live: { ok: false, errorKind: 'session_live', reason: 'session_live', error: 'session already has a running CLI (pid 4242, started by a terminal)' },
  claude_missing: { ok: false, errorKind: 'claude_missing', error: 'Claude Code is not installed on this host.' },
  claude_needs_node: { ok: false, errorKind: 'claude_needs_node', error: 'Claude Code on this host is the npm build and no working Node.js was found.' },
  unknown: { ok: false, error: 'something else' },
  no_pid: { ok: true, outputFile: '/nonexistent/x.jsonl', offset: 0 },
}

/** Refusals under which a CLI may still run for the id (this host's own daemon's, a start in progress, unknown). */
const MAY_RUN = new Set(['session_live', 'unknown'])

describe('a transport whose start was refused', () => {
  for (const [kind, reply] of Object.entries(REFUSALS).filter(([k]) => !MAY_RUN.has(k))) {
    it(`${kind}: a later write says "not written" without reaching the daemon, and a stop has nothing to stop`, async () => {
      const { mgr, sent } = manager([reply])
      await expect(mgr.start(startOpts)).rejects.toBeTruthy()
      expect(sent).toEqual(['start'])
      await expect(mgr.writeMessage('hello again')).resolves.toBe(false)
      await expect(mgr.stop()).resolves.toBeUndefined()
      expect(sent).toEqual(['start'])
    })
  }

  for (const kind of MAY_RUN) {
    it(`${kind}: a process may run under the id, so a later write and a stop still reach the daemon`, async () => {
      const { mgr, sent } = manager([REFUSALS[kind], { ok: true }, { ok: true, stopped: true }], ['owner-home-v1'])
      await expect(mgr.start(startOpts)).rejects.toBeTruthy()
      await mgr.writeMessage('hello again')
      await expect(mgr.stop()).resolves.toBeUndefined()
      expect(sent).toEqual(['start', 'send', 'stop'])
    })
  }

  it('Claude Code missing is typed, with the sentence every surface shows and what to do while the message waits', async () => {
    const { mgr } = manager([REFUSALS.claude_missing])
    const err = await mgr.start(startOpts).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ClaudeRuntimeMissingError)
    expect((err as ClaudeRuntimeMissingError).message).toBe('Claude Code is not installed on this computer.')
    expect((err as ClaudeRuntimeMissingError).waitingReason).toMatch(/Install Claude Code and this message goes out by itself/)
  })

  it('control: a transport whose start ran still writes to its process', async () => {
    const { mgr, sent } = manager([{ ok: true, pid: 4242, outputFile: '/nonexistent/x.jsonl', offset: 0 }, { ok: true }])
    await mgr.start(startOpts)
    await expect(mgr.writeMessage('hello again')).resolves.toBe(true)
    expect(sent).toEqual(['start', 'send'])
  })

  it('guard: every refusal start() reads is in the matrix above', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/remote-session-manager.ts'), 'utf8')
    const body = src.slice(src.indexOf('  async start(opts: TransportStartOptions)'), src.indexOf('  async attach(opts: TransportAttachOptions)'))
    const block = body.slice(body.indexOf('if (!result.ok) {'), body.indexOf('if (!result.pid) {'))
    const kinds = new Set([...block.matchAll(/result\.(?:errorKind|reason) === '([a-z_]+)'/g)].map((m) => m[1]))
    expect(kinds.size).toBeGreaterThan(0)
    expect([...kinds].filter((k) => !(k in REFUSALS))).toEqual([])
    // Each one is judged: nothing of ours runs (writes and stop are skipped) or a CLI may run.
    expect([...kinds].filter((k) => START_REFUSALS_RUN_NOTHING.has(k) === START_REFUSALS_MAY_RUN.has(k))).toEqual([])
    expect([...START_REFUSALS_MAY_RUN].every((k) => MAY_RUN.has(k))).toBe(true)
    // The refusal block decides the mark before any of its throws.
    expect(block.indexOf('this._startRefused = startRunsNothing(result)')).toBeGreaterThanOrEqual(0)
    expect(block.indexOf('this._startRefused = startRunsNothing(result)')).toBeLessThan(block.indexOf('throw '))
  })
})
