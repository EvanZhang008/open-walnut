/**
 * oneshot-client.ts: which side runs a one-shot claude, and how the daemon's
 * events reach the caller. A fake daemon link stands in (the real daemon is
 * oneshot-via-daemon-e2e.test.ts); the in-process fallback runs the test's fake
 * CLI for real.
 */
import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  _setOneShotDaemonForTest, _resetLocalOneShotForTest, dispatchOneShotEvent, prewarmOneShot, startOneShot,
  type OneShotConn, type OneShotExit,
} from '../../src/providers/oneshot-client.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'
import { guardedPath } from '../setup/exec-guard.js'

const FAKE = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')

afterEach(() => {
  _setOneShotDaemonForTest(null)
  _resetLocalOneShotForTest()
})

function fakeConn(reply: (cmd: string, params: Record<string, unknown>) => Record<string, unknown> | Error = () => ({ ok: true })) {
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const conn: OneShotConn & { sent: typeof sent; epoch: number; up: boolean } = {
    sent, epoch: 1, up: true,
    get connected() { return this.up },
    get connectionEpoch() { return this.epoch },
    hasCapability: (c) => c === 'oneshot-v1',
    send: async (cmd, params = {}) => {
      sent.push({ cmd, params })
      const r = reply(cmd, params)
      if (r instanceof Error) throw r
      return r
    },
  }
  return conn
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('one-shot client', () => {
  it('sends the whole spawn to the daemon and routes its events by runId', async () => {
    const conn = fakeConn((cmd) => (cmd === 'oneshot.run' ? { ok: true, warm: true, pid: 42 } : { ok: true }))
    _setOneShotDaemonForTest(() => conn)
    const lines: string[] = []
    const errs: string[] = []
    const exits: OneShotExit[] = []
    const handle = await startOneShot(
      { command: '/x/claude', args: ['-p'], cwd: '/tmp', env: { A: '1' }, input: 'hi', endInput: true, warmKey: 'k', maxMs: 9 },
      { onLine: (l) => lines.push(l), onStderr: (t) => errs.push(t), onExit: (e) => exits.push(e) },
    )
    expect(handle).toMatchObject({ via: 'daemon', warm: true, pid: 42 })
    const run = conn.sent[0]
    expect(run.cmd).toBe('oneshot.run')
    expect(run.params).toMatchObject({ command: '/x/claude', args: ['-p'], cwd: '/tmp', env: { A: '1' }, input: 'hi', endInput: true, warmKey: 'k', maxMs: 9 })
    const runId = String(run.params.runId)
    dispatchOneShotEvent({ ev: 'oneshot.out', runId: 'someone-else', lines: ['nope'] })
    dispatchOneShotEvent({ ev: 'oneshot.out', runId, lines: ['a', 'b'] })
    dispatchOneShotEvent({ ev: 'oneshot.err', runId, text: 'warn' })
    handle.kill('SIGINT')
    expect(conn.sent[1]).toEqual({ cmd: 'oneshot.cancel', params: { runId, signal: 'SIGINT' } })
    dispatchOneShotEvent({ ev: 'oneshot.exit', runId, code: null, signal: 'SIGINT' })
    dispatchOneShotEvent({ ev: 'oneshot.exit', runId, code: 0, signal: null }) // a second exit is never delivered
    expect(lines).toEqual(['a', 'b'])
    expect(errs).toEqual(['warn'])
    expect(exits).toEqual([{ code: null, signal: 'SIGINT' }])
    handle.kill() // finished: nothing more is sent
    expect(conn.sent).toHaveLength(2)
  })

  it('a refused run or a link that is down runs in this process; a lost reply rejects and cancels', async () => {
    const local = async (conn: OneShotConn) => {
      _setOneShotDaemonForTest(() => conn)
      let exit: OneShotExit | null = null
      const handle = await startOneShot(
        { command: process.execPath, args: [FAKE, '-p'], cwd: os.tmpdir(), env: { PATH: guardedPath([], '/usr/bin:/bin') }, input: 'x', endInput: true },
        { onExit: (e) => { exit = e } },
      )
      await until(() => exit !== null, 20_000)
      return { via: handle.via, exit }
    }
    // Refused before anything started (a daemon handing over).
    expect(await local(fakeConn(() => ({ ok: false, error: 'oneshot.run failed: draining' })))).toMatchObject({ via: 'local', exit: { code: 0 } })
    // The command never left: the pool tags it no-link.
    const down = fakeConn(() => markLinkFailure(new Error('DaemonConnection not connected to __local__'), 'no-link'))
    expect(await local(down)).toMatchObject({ via: 'local', exit: { code: 0 } })
    expect(down.sent.map((x) => x.cmd)).toEqual(['oneshot.run'])
    // No answer: it may have started there, so it never runs twice.
    const lost = fakeConn((cmd) => (cmd === 'oneshot.run' ? markLinkFailure(new Error('daemon command timeout: oneshot.run'), 'no-answer') : { ok: true }))
    _setOneShotDaemonForTest(() => lost)
    await expect(startOneShot({ command: '/x', args: [], env: {} }, { onExit: () => {} })).rejects.toThrow(/timeout/)
    expect(lost.sent[1]).toMatchObject({ cmd: 'oneshot.cancel', params: { signal: 'SIGKILL' } })
  }, 60_000)

  it('a run too large for one daemon frame runs in this process', async () => {
    const conn = fakeConn()
    _setOneShotDaemonForTest(() => conn)
    let exit: OneShotExit | null = null
    const handle = await startOneShot(
      { command: process.execPath, args: [FAKE, '-p'], cwd: os.tmpdir(), env: { PATH: guardedPath([], '/usr/bin:/bin') }, input: 'y'.repeat(9 * 1024 * 1024), endInput: true },
      { onExit: (e) => { exit = e } },
    )
    expect(handle.via).toBe('local')
    expect(conn.sent).toHaveLength(0)
    await until(() => exit !== null, 20_000)
    expect(exit).toMatchObject({ code: 0 })
  }, 30_000)

  it('a link that reconnects during the run ends it with an error', async () => {
    const conn = fakeConn((cmd) => (cmd === 'oneshot.run' ? { ok: true, warm: false } : { ok: true }))
    _setOneShotDaemonForTest(() => conn)
    const exits: OneShotExit[] = []
    await startOneShot({ command: '/x', args: [], env: {} }, { onExit: (e) => exits.push(e) })
    conn.epoch = 3 // a disconnect and a reconnect happened: the daemon killed the run with the old socket
    await until(() => exits.length === 1)
    expect(exits[0].error).toMatch(/link to the local daemon dropped/)
  })

  it('without the capability the same core runs in this process', async () => {
    const old: OneShotConn = { connected: true, connectionEpoch: 1, hasCapability: () => false, send: async () => ({ ok: true }) }
    _setOneShotDaemonForTest(() => (old.hasCapability('oneshot-v1') ? old : null))
    const lines: string[] = []
    let exit: OneShotExit | null = null
    const handle = await startOneShot(
      { command: process.execPath, args: [FAKE, '-p'], cwd: os.tmpdir(), env: { PATH: guardedPath([], '/usr/bin:/bin'), ONESHOT_PROBE: 'local' }, input: 'here', endInput: true },
      { onLine: (l) => lines.push(l), onExit: (e) => { exit = e } },
    )
    expect(handle.via).toBe('local')
    await until(() => exit !== null, 20_000)
    expect(exit).toMatchObject({ code: 0 })
    const result = JSON.parse(lines.find((l) => l.includes('"result"'))!) as { result: string }
    expect(JSON.parse(result.result.slice(result.result.indexOf('{')))).toMatchObject({ ppid: process.pid, probe: 'local' })
  }, 30_000)

  it('prewarm goes to the daemon pool, or to this process when the daemon is older', async () => {
    const conn = fakeConn()
    _setOneShotDaemonForTest(() => conn)
    prewarmOneShot({ command: '/x', args: ['-p'], env: {}, warmKey: 'k1' })
    await until(() => conn.sent.length === 1)
    expect(conn.sent[0]).toMatchObject({ cmd: 'oneshot.prewarm', params: { command: '/x', warmKey: 'k1' } })

    _setOneShotDaemonForTest(() => null)
    const spec = { command: process.execPath, args: [FAKE, '-p', '--input-format', 'stream-json'], cwd: os.tmpdir(), env: { PATH: guardedPath([], '/usr/bin:/bin') }, warmKey: 'local-k' }
    prewarmOneShot(spec)
    await new Promise((r) => setTimeout(r, 800))
    let exit: OneShotExit | null = null
    const lines: string[] = []
    const handle = await startOneShot({
      ...spec, input: JSON.stringify({ type: 'user', message: { role: 'user', content: 'warm here' } }) + '\n', endOnResult: true,
    }, { onLine: (l) => lines.push(l), onExit: (e) => { exit = e } })
    expect(handle).toMatchObject({ via: 'local', warm: true })
    await until(() => exit !== null, 20_000)
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'system', subtype: 'init' })
    expect(exit).toMatchObject({ code: 0 })
  }, 30_000)
})
