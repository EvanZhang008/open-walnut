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
import { ClaudeRuntimeMissingError, isDaemonCommandOutcomeUnknown } from '../../src/providers/delivery-failure.js'
import { linkFailureKind, markLinkFailure } from '../../src/providers/link-failure.js'

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

  it('guard: start() and attach() bind the sid in the same step that ends their pending connect', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/remote-session-manager.ts'), 'utf8')
    for (const [from, to, bind] of [
      ['  async start(opts: TransportStartOptions)', '  private async retryStartAfterReconnect(', 'this._sid = this.tmpId'],
      ['  async attach(opts: TransportAttachOptions)', '  // ── Re-attach after daemon reconnect', 'this._sid = opts.sessionId'],
    ] as const) {
      const body = src.slice(src.indexOf(from), src.indexOf(to))
      const pending = body.indexOf('this._bindsPending++')
      const done = body.indexOf('finally { this._bindsPending-- }')
      expect(pending).toBeGreaterThan(0)
      expect(done).toBeGreaterThan(pending)
      // A stop between the connect and the binding would read "never bound" while a CLI starts.
      const bound = body.indexOf(bind, done)
      expect(bound).toBeGreaterThan(done)
      expect(body.slice(done + 'finally { this._bindsPending-- }'.length, bound)).not.toMatch(/\bawait\b/)
    }
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

/**
 * stop() on a manager that never bound a sid (2026-11-15: 310 queue stops on cold
 * resumes warned "stop was not confirmed" from a fresh manager whose conn was null
 * and sid unset; no start or attach had run in it). Such a manager runs nothing,
 * so its stop is a no-op. A bound sid may own a live CLI, so an unreachable daemon
 * stays an unknown stop, and so does a start or attach still connecting.
 */
describe('stop() by what the manager has bound', () => {
  const SID = 'aaaaaaaa-0000-4000-8000-0000000000d9'
  const NOT_CONFIRMED = 'DaemonConnection not connected to __local__; stop was not confirmed'
  const STARTED = { ok: true, pid: 4242, outputFile: '/nonexistent/x.jsonl', offset: 0 }

  function wired(replies: Reply[], opts: { connect?: () => Promise<unknown>; withConn?: boolean } = {}) {
    const { conn, sent } = fakeConn(replies, ['owner-home-v1'])
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    const fields = mgr as unknown as Record<string, unknown>
    if (opts.withConn !== false) fields.conn = conn
    fields.ensureConnected = opts.connect ?? (async () => { fields.conn = conn; return conn })
    return { mgr, conn, sent, fields }
  }

  function deferred() {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  // ── never bound: nothing to stop ──

  it('a fresh manager (cold resume, conn null, no sid) resolves and sends nothing', async () => {
    const { mgr, sent } = wired([], { withConn: false })
    expect(mgr.bound).toBe(false)
    await expect(mgr.stop('maintenance')).resolves.toBeUndefined()
    await expect(mgr.stop('user')).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a fresh manager with a connected link but no sid resolves and sends nothing', async () => {
    const { mgr, sent } = wired([])
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a start that failed to connect (before binding) leaves nothing to stop', async () => {
    const { mgr, sent } = wired([], { withConn: false, connect: async () => { throw new Error('DaemonConnection not connected to __local__') } })
    await expect(mgr.start(startOpts)).rejects.toThrow('DaemonConnection not connected')
    expect(mgr.bound).toBe(false)
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('an attach that failed to connect (before binding) leaves nothing to stop', async () => {
    const { mgr, sent } = wired([], { withConn: false, connect: async () => { throw new Error('DaemonConnection not connected to __local__') } })
    await expect(mgr.attach({ sessionId: SID, onOutput: () => {}, onExit: () => {} })).rejects.toThrow('DaemonConnection not connected')
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a start refused under which nothing runs resolves, even with the link down afterwards', async () => {
    const { mgr, conn, sent } = wired([REFUSALS.claude_missing])
    await expect(mgr.start(startOpts)).rejects.toBeTruthy()
    conn.connected = false
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual(['start'])
  })

  // ── bound: a live CLI may exist, unreachable stays unknown ──

  it('a started (bound) manager whose link dropped rejects as unconfirmed and sends nothing', async () => {
    const { mgr, conn, sent } = wired([STARTED])
    await mgr.start(startOpts)
    conn.connected = false
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    expect(sent).toEqual(['start'])
  })

  it('an attached (bound) manager whose link is gone rejects as unconfirmed', async () => {
    const { mgr, fields, sent } = wired([{ ok: true, pid: 4242, alive: true, currentOffset: 10 }])
    await mgr.attach({ sessionId: SID, onOutput: () => {}, onExit: () => {} })
    fields.conn = null
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    expect(sent).toEqual(['attach'])
  })

  it('a start refused with session_live (a CLI may run) and the link down rejects as unconfirmed', async () => {
    const { mgr, conn } = wired([REFUSALS.session_live])
    await expect(mgr.start(startOpts)).rejects.toBeTruthy()
    conn.connected = false
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
  })

  it('a start that bound and then failed (generic refusal) with the link down rejects as unconfirmed', async () => {
    const { mgr, conn } = wired([REFUSALS.unknown])
    await expect(mgr.start(startOpts)).rejects.toBeTruthy()
    conn.connected = false
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
  })

  it('a bound manager whose later start fails to connect still rejects: the earlier sid may run', async () => {
    const { mgr, fields, conn, sent } = wired([STARTED])
    await mgr.start(startOpts)
    fields.conn = null
    fields.ensureConnected = async () => { throw new Error('DaemonConnection not connected to __local__') }
    await expect(mgr.start(startOpts)).rejects.toThrow('DaemonConnection not connected')
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    expect(conn.send).toHaveBeenCalledTimes(1)
    expect(sent).toEqual(['start'])
  })

  it('a bound, connected manager still sends a named stop and needs the daemon\'s ack', async () => {
    const { mgr, sent, conn } = wired([STARTED, { ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' }, { ok: true, stopped: true }])
    await mgr.start(startOpts)
    await expect(mgr.stop('user')).rejects.toThrow('started by another Walnut')
    await expect(mgr.stop('user')).resolves.toBeUndefined()
    expect(sent).toEqual(['start', 'stop', 'stop'])
    expect((conn.send.mock.calls[1] as unknown[])[1]).toMatchObject({ sid: SID, reason: 'user', initiator: 'human' })
  })

  // ── in flight: a start or attach still connecting may spawn or adopt a CLI ──

  it('a stop during a start that is still connecting rejects as unconfirmed; the start then runs', async () => {
    const gate = deferred()
    const { mgr, conn, sent } = wired([STARTED, { ok: true, stopped: true }], {
      withConn: false,
      connect: async () => { await gate.promise; (mgr as unknown as Record<string, unknown>).conn = conn; return conn },
    })
    const starting = mgr.start(startOpts)
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    expect(sent).toEqual([])
    gate.resolve()
    await starting
    // Bound now: the next stop reaches the daemon.
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual(['start', 'stop'])
  })

  it('a stop during an attach that is still connecting rejects as unconfirmed', async () => {
    const gate = deferred()
    const { mgr, conn, sent } = wired([{ ok: true, pid: 4242, alive: true, currentOffset: 0 }], {
      withConn: false,
      connect: async () => { await gate.promise; (mgr as unknown as Record<string, unknown>).conn = conn; return conn },
    })
    const attaching = mgr.attach({ sessionId: SID, onOutput: () => {}, onExit: () => {} })
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    gate.resolve()
    await attaching
    expect(sent).toEqual(['attach'])
  })

  it('a start whose connect fails while pending: unknown during, a no-op after', async () => {
    const gate = deferred()
    const { mgr, sent } = wired([], { withConn: false, connect: async () => { await gate.promise; throw new Error('unreachable') } })
    const starting = mgr.start(startOpts)
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    gate.reject(new Error('DaemonConnection not connected to __local__'))
    await expect(starting).rejects.toThrow('DaemonConnection not connected')
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a refused transport with a new start still connecting rejects instead of skipping', async () => {
    const { mgr, fields, conn } = wired([REFUSALS.budget_paused])
    await expect(mgr.start(startOpts)).rejects.toBeTruthy()
    await expect(mgr.stop()).resolves.toBeUndefined()
    const gate = deferred()
    fields.conn = null
    fields.ensureConnected = async () => { await gate.promise; fields.conn = conn; return conn }
    const starting = mgr.start(startOpts)
    await expect(mgr.stop()).rejects.toThrow(NOT_CONFIRMED)
    gate.reject(new Error('DaemonConnection not connected to __local__'))
    await expect(starting).rejects.toBeTruthy()
  })
})

/**
 * A first start whose answer was lost may have spawned a CLI. When the retry
 * cannot reach the daemon (the reconnect fails, or its resend finds no link), the
 * start fails as 'lost' (outcome unknown), never as the retry's 'no-link', which
 * callers read as "never sent" (claude-code-session.ts neverSent).
 */
describe('a start whose answer was lost and whose retry never reached the daemon', () => {
  const SID = 'aaaaaaaa-0000-4000-8000-0000000000da'
  const NO_LINK = () => markLinkFailure(new Error('DaemonConnection not connected to __local__'), 'no-link')
  const FIRST: Record<string, () => Error> = {
    'no-answer': () => markLinkFailure(new Error('daemon command timeout: start (30000ms) [traceId=t1]'), 'no-answer'),
    lost: () => markLinkFailure(new Error('daemon command lost: start: connection closed before __local__ answered'), 'lost'),
  }

  function managerWith(send: (cmd: string) => Promise<Reply>, connects: Array<() => Promise<unknown>>) {
    const sent: string[] = []
    const conn = {
      connected: true,
      hasCapability: () => false,
      onEvent: () => () => {},
      send: vi.fn(async (cmd: string) => { sent.push(cmd); return send(cmd) }),
    }
    const mgr = new RemoteSessionManager(SID, '__local__', null)
    const fields = mgr as unknown as Record<string, unknown>
    fields.ensureConnected = async () => {
      const next = connects.shift()
      if (!next) throw new Error('unexpected connect')
      await next()
      fields.conn = conn
      return conn
    }
    return { mgr, conn, sent, fields }
  }

  async function expectLost(starting: Promise<unknown>, cause: string) {
    const err = await starting.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^daemon command lost: start: __local__ did not answer, and the retry failed/)
    expect((err as Error).message).toContain(cause)
    expect(linkFailureKind(err)).toBe('lost')
    expect(isDaemonCommandOutcomeUnknown(err)).toBe(true)
  }

  for (const [kind, first] of Object.entries(FIRST)) {
    it(`first send ${kind}, reconnect no-link: unknown, not "never sent"; the sid stays bound and stop is unconfirmed`, async () => {
      const { mgr, sent } = managerWith(async () => { throw first() }, [async () => {}, async () => { throw NO_LINK() }])
      await expectLost(mgr.start(startOpts), 'DaemonConnection not connected to __local__')
      expect(sent).toEqual(['start'])
      expect(mgr.bound).toBe(true)
      await expect(mgr.stop()).rejects.toThrow('DaemonConnection not connected to __local__; stop was not confirmed')
      expect(sent).toEqual(['start'])
    })

    it(`first send ${kind}, reconnect up but the resend finds no link: unknown`, async () => {
      let n = 0
      const { mgr, sent } = managerWith(async () => {
        if (++n === 1) throw first()
        throw NO_LINK()
      }, [async () => {}, async () => {}])
      await expectLost(mgr.start(startOpts), 'DaemonConnection not connected to __local__')
      expect(sent).toEqual(['start', 'status', 'start'])
    })
  }

  it('a reconnect whose dial fails untagged is unknown too', async () => {
    const { mgr } = managerWith(async () => { throw FIRST.lost() }, [async () => {}, async () => { throw new Error('tunnel refused: ECONNRESET') }])
    await expectLost(mgr.start(startOpts), 'tunnel refused: ECONNRESET')
  })

  it('control: a first send that found no link is retried, and a retry with no link stays no-link', async () => {
    let n = 0
    const { mgr, sent } = managerWith(async () => { n++; throw NO_LINK() }, [async () => {}, async () => {}])
    const err = await mgr.start(startOpts).then(() => null, (e: unknown) => e)
    expect(linkFailureKind(err)).toBe('no-link')
    expect((err as Error).message).toBe('DaemonConnection not connected to __local__')
    expect(n).toBe(3)
    expect(sent).toEqual(['start', 'status', 'start'])
  })

  it('control: a retry that reached the daemon keeps its own answer', async () => {
    let n = 0
    const { mgr } = managerWith(async (cmd) => {
      n++
      if (n === 1) throw FIRST['no-answer']()
      if (cmd === 'status') return { ok: true, exists: false }
      return { ok: true, pid: 4242, outputFile: '/nonexistent/x.jsonl', offset: 0 }
    }, [async () => {}, async () => {}])
    await expect(mgr.start(startOpts)).resolves.toMatchObject({ pid: 4242 })
  })
})
