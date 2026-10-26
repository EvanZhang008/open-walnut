/**
 * tests/helpers/live-procs.ts against a fake machine: no process is spawned and no signal is sent
 * (process.kill is replaced by a recorder in the one case that reaches the real table).
 *
 * Pinned: a boot that fails before it reports; a process that outlives TERM (a failure, never
 * KILL, the directory kept); a process table that cannot be read (never taken as empty or as an
 * exit); ownership that is not proven (a reused pid, pid <= 1, a daemon running elsewhere, a file
 * outside the test's directory, a command line that changed under the same start time); what the
 * test paused is resumed before TERM, also synchronously from a signal handler, and only while
 * it is the same process; a second cleanup sends nothing; finish removes the directory only once
 * everything exited and nothing still names it.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveProcs, NotOursError, parsePs, realProcTable, type ProcRow, type ProcTable, type Sig } from '../helpers/live-procs.js'

const BASE = '/tmp/wll-fake'
const LSTART = 'Sun Oct 25 13:08:57 2026'

function machine() {
  const rows = new Map<number, ProcRow>()
  const cwds = new Map<number, string>()
  const sent: Array<[number, Sig]> = []
  const onTerm = new Map<number, 'exit' | 'ignore'>()
  const children = new Map<number, FakeChild>()
  const flags = { readFails: false, clock: 0 }
  const table: ProcTable = {
    async read() {
      if (flags.readFails) throw new Error('ps failed')
      return new Map(rows)
    },
    rowSync(pid) {
      if (flags.readFails) throw new Error('ps failed')
      return rows.get(pid) ?? null
    },
    async cwd(pid) { return cwds.get(pid) ?? null },
    kill(pid, sig) {
      sent.push([pid, sig])
      if (sig === 'SIGTERM' && onTerm.get(pid) !== 'ignore') {
        rows.delete(pid)
        children.get(pid)?.end(0)
      }
    },
    now: () => flags.clock,
    sleep: async (ms) => { flags.clock += ms },
    realpath: (p) => p,
  }
  const add = (pid: number, command: string, extra: Partial<ProcRow> = {}) => {
    rows.set(pid, { pid, ppid: 1, pgid: pid, stat: 'S', lstart: LSTART, command, ...extra })
  }
  return { rows, cwds, sent, onTerm, children, flags, table, add }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor(readonly pid: number | undefined) { super() }
  end(code: number) { this.exitCode = code; this.emit('exit', code, null) }
}
const asChild = (c: FakeChild) => c as unknown as ChildProcess

describe('a boot that fails', () => {
  it('a spawn with no pid registers nothing to signal, and finish fails', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    expect(procs.child('primary', asChild(new FakeChild(undefined)))).toBeNull()
    const remove = vi.fn(async () => {})
    await expect(procs.finish(remove)).rejects.toThrow(/spawn gave no pid/)
    expect(remove).not.toHaveBeenCalled()
    expect(m.sent).toEqual([])
  })

  it('a child that exited before it reported is stopped without a signal', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    const c = new FakeChild(4100)
    const o = procs.child('primary', asChild(c))!
    c.end(3)
    expect(await procs.stop(o, 1_000)).toBe(true)
    expect(m.sent).toEqual([])
    const remove = vi.fn(async () => {})
    await procs.finish(remove)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('a process that outlives TERM', () => {
  it('is a failure after the deadline: no KILL, the directory kept', async () => {
    const m = machine()
    m.add(4200, '/usr/bin/node daemon.cjs --start')
    m.cwds.set(4200, `${BASE}/prd`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-procs-'))
    try {
      fs.writeFileSync(path.join(dir, 'daemon.pid'), '4200\n')
      m.cwds.set(4200, dir)
      const procs = new LiveProcs(m.table, BASE)
      const o = await procs.pidFile('primary daemon', dir)
      m.onTerm.set(4200, 'ignore')
      expect(await procs.stop(o, 5_000)).toBe(false)
      expect(m.sent).toEqual([[4200, 'SIGTERM']])
      const remove = vi.fn(async () => {})
      await expect(procs.finish(remove)).rejects.toThrow(/still running 5000 ms after TERM/)
      expect(remove).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a process table that cannot be read', () => {
  it('is never an exit and never a reason to signal', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4301, `/usr/bin/node ${BASE}/mock-cli.cjs A`)
    const cli = await procs.command('mock cli A', 4301, `${BASE}/mock-cli.cjs`)
    m.flags.readFails = true
    expect(await procs.state(cli)).toBe('unknown')
    expect(await procs.stop(cli, 1_000)).toBe(false)
    expect(cli.exited).toBe(false)
    expect(m.sent).toEqual([])
    await expect(procs.finish(async () => {})).rejects.toThrow(/could not be read for the final check/)
  })
})

describe('ownership that is not proven', () => {
  it('a pid reused by another process is gone, not signalled', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4400, `/usr/bin/node ${BASE}/mock-cli.cjs A`)
    const cli = await procs.command('mock cli A', 4400, `${BASE}/mock-cli.cjs`)
    m.add(4400, `/usr/bin/node ${BASE}/mock-cli.cjs A`, { lstart: 'Sun Oct 25 13:09:30 2026' })
    expect(await procs.signal(cli, 'SIGTERM')).toBe(false)
    expect(await procs.stop(cli, 1_000)).toBe(true)
    expect(m.sent).toEqual([])
  })

  it('pid 1 and below are refused at adoption and at signal', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(1, '/sbin/launchd')
    await expect(procs.command('init', 1, `${BASE}/x`)).rejects.toBeInstanceOf(NotOursError)
    await expect(procs.command('none', 0, `${BASE}/x`)).rejects.toBeInstanceOf(NotOursError)
    const fake = { label: 'forged', pid: 1, how: 'command' as const, lstart: LSTART, command: '/sbin/launchd', paused: false, exited: false }
    expect(await procs.signal(fake, 'SIGTERM')).toBe(false)
    expect(m.sent).toEqual([])
  })

  it('a daemon whose pid file is ours but that runs elsewhere is refused', async () => {
    const m = machine()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-procs-'))
    try {
      fs.writeFileSync(path.join(dir, 'daemon.pid'), '4500\n')
      m.add(4500, '/usr/bin/node daemon.cjs --start')
      m.cwds.set(4500, '/tmp/open-walnut')
      const procs = new LiveProcs(m.table, BASE)
      await expect(procs.pidFile('primary daemon', dir)).rejects.toThrow(/runs in \/tmp\/open-walnut/)
      expect(procs.owned).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a command line that changed under the same start time is neither signalled nor taken as an exit', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4600, `/usr/bin/node ${BASE}/mock-cli.cjs A`)
    const cli = await procs.command('mock cli A', 4600, `${BASE}/mock-cli.cjs`)
    m.add(4600, '/usr/bin/node something-else')
    expect(await procs.state(cli)).toBe('unknown')
    expect(await procs.signal(cli, 'SIGTERM')).toBe(false)
    expect(await procs.waitExit(cli, 1_000)).toBe(false)
    expect(cli.exited).toBe(false)
    expect(m.sent).toEqual([])
    await expect(procs.finish(async () => {})).rejects.toThrow(/not proven ours/)
  })

  it('a command file outside the test\'s directory is refused', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4700, '/usr/bin/node /Users/someone/real-cli.cjs')
    await expect(procs.command('cli', 4700, '/Users/someone/real-cli.cjs')).rejects.toBeInstanceOf(NotOursError)
    await expect(procs.command('cli', 4700, `${BASE}/mock-cli.cjs`)).rejects.toBeInstanceOf(NotOursError)
  })
})

describe('a daemon left by a boot that failed', () => {
  it('is adopted when its pid file names a process running in its dir, and nothing otherwise', async () => {
    const m = machine()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-procs-'))
    try {
      const procs = new LiveProcs(m.table, BASE)
      // No pid file: nothing to adopt, and no refusal.
      expect(await procs.pidFile('primary daemon', dir, { ifRunning: true })).toBeNull()
      // A pid file whose pid is gone: nothing either.
      fs.writeFileSync(path.join(dir, 'daemon.pid'), '5000\n')
      expect(await procs.pidFile('primary daemon', dir, { ifRunning: true })).toBeNull()
      // A running pid elsewhere is still refused.
      m.add(5000, '/usr/bin/node daemon.cjs --start')
      m.cwds.set(5000, '/tmp/open-walnut')
      await expect(procs.pidFile('primary daemon', dir, { ifRunning: true })).rejects.toBeInstanceOf(NotOursError)
      m.cwds.set(5000, dir)
      const o = await procs.pidFile('primary daemon', dir, { ifRunning: true })
      expect(o).toMatchObject({ pid: 5000, how: 'pidfile' })
      expect(m.sent).toEqual([])
      // Without ifRunning, a missing pid file is a refusal.
      fs.rmSync(path.join(dir, 'daemon.pid'))
      await expect(procs.pidFile('primary daemon', dir)).rejects.toThrow(/no .*daemon\.pid/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable table is a refusal, never "not running"', async () => {
    const m = machine()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-procs-'))
    try {
      fs.writeFileSync(path.join(dir, 'daemon.pid'), '5100\n')
      m.flags.readFails = true
      const procs = new LiveProcs(m.table, BASE)
      await expect(procs.pidFile('primary daemon', dir, { ifRunning: true })).rejects.toBeInstanceOf(NotOursError)
      await expect(procs.finish(async () => {})).rejects.toThrow(/could not be read/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a process a child started (a keeper\'s daemon)', () => {
  it('is the test\'s while the table lists the running child as its parent, and stays so after that child ends', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    const keeper = new FakeChild(4300)
    m.children.set(4300, keeper)
    const k = procs.child('devbox keeper', asChild(keeper))!
    m.add(4301, 'bun daemon-standalone.ts --start', { ppid: 4300 })
    const d = await procs.childOf('devbox daemon', 4301, k)
    keeper.end(0)
    m.rows.get(4301)!.ppid = 1
    expect(await procs.state(d)).toBe('ours')
    expect(await procs.stopAll(1_000, [d, k])).toBe(true)
    expect(m.sent).toEqual([[4301, 'SIGTERM']])
  })

  it('is refused when the table names another parent, the parent ended, or the parent is not a child of the test', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    const keeper = new FakeChild(4310)
    const k = procs.child('devbox keeper', asChild(keeper))!
    m.add(4311, 'bun daemon-standalone.ts --start', { ppid: 999 })
    await expect(procs.childOf('stranger', 4311, k)).rejects.toThrow(NotOursError)
    m.add(4312, `node ${BASE}/de/daemon.cjs --start`, { ppid: 4310 })
    keeper.end(0)
    await expect(procs.childOf('orphan', 4312, k)).rejects.toThrow(/not a running child/)
    m.add(4320, `node ${BASE}/de/daemon.cjs --start`)
    const byCommand = await procs.command('a daemon by command', 4320, `${BASE}/de/daemon.cjs`)
    m.add(4321, 'node mock.cjs', { ppid: 4320 })
    await expect(procs.childOf('its child', 4321, byCommand)).rejects.toThrow(/not a running child/)
    expect(procs.owned.map((o) => o.label)).toEqual(['devbox keeper', 'a daemon by command'])
    expect(m.sent).toEqual([])
  })
})

describe('cleanup', () => {
  it('a step that did not happen fails finish and keeps the directory', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    procs.fail('mock cli A: the daemon did not stop it')
    const remove = vi.fn(async () => {})
    await expect(procs.finish(remove)).rejects.toThrow(/the daemon did not stop it/)
    expect(remove).not.toHaveBeenCalled()
  })

  it('waitExit sends nothing and fails past its deadline', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(5200, `/usr/bin/node ${BASE}/mock-cli.cjs A`)
    const cli = await procs.command('mock cli A', 5200, `${BASE}/mock-cli.cjs`)
    expect(await procs.waitExit(cli, 2_000)).toBe(false)
    expect(m.sent).toEqual([])
    m.rows.delete(5200)
    expect(await procs.waitExit(cli, 2_000)).toBe(true)
    await expect(procs.finish(async () => {})).rejects.toThrow(/no exit within 2000 ms/)
  })

  it('resumes what the test paused before TERM, then removes the directory once', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-procs-'))
    try {
      const c = new FakeChild(4800)
      m.children.set(4800, c)
      const server = procs.child('primary server', asChild(c))!
      fs.writeFileSync(path.join(dir, 'daemon.pid'), '4801\n')
      m.add(4801, '/usr/bin/node daemon.cjs --start')
      m.cwds.set(4801, dir)
      const daemon = await procs.pidFile('primary daemon', dir)
      expect(await procs.pause(server)).toBe(true)
      expect(await procs.pause(daemon)).toBe(true)
      expect(await procs.stopAll(10_000)).toBe(true)
      expect(m.sent).toEqual([[4800, 'SIGSTOP'], [4801, 'SIGSTOP'], [4800, 'SIGCONT'], [4801, 'SIGCONT'], [4801, 'SIGTERM'], [4800, 'SIGTERM']])
      const remove = vi.fn(async () => {})
      await procs.finish(remove)
      expect(remove).toHaveBeenCalledTimes(1)
      // A second cleanup sends nothing.
      expect(await procs.stopAll(10_000)).toBe(true)
      expect(m.sent).toHaveLength(6)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resumeSync (a signal handler) resumes only what is still the same process', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(5300, `/usr/bin/node ${BASE}/mock-cli.cjs A`)
    m.add(5301, `/usr/bin/node ${BASE}/mock-cli.cjs B`)
    const a = await procs.command('mock cli A', 5300, `${BASE}/mock-cli.cjs`)
    const b = await procs.command('mock cli B', 5301, `${BASE}/mock-cli.cjs`)
    const c = new FakeChild(5302)
    const server = procs.child('primary server', asChild(c))!
    for (const o of [a, b, server]) expect(await procs.pause(o)).toBe(true)
    m.sent.length = 0
    // B's pid now names another process (a reuse): no signal to it.
    m.add(5301, `/usr/bin/node ${BASE}/mock-cli.cjs B`, { lstart: 'Sun Oct 25 14:00:00 2026' })
    procs.resumeSync()
    expect(m.sent).toEqual([[5300, 'SIGCONT'], [5302, 'SIGCONT']])
    expect([a.paused, b.paused, server.paused]).toEqual([false, true, false])
    // An unreadable table sends nothing.
    m.sent.length = 0
    b.paused = true
    m.flags.readFails = true
    procs.resumeSync()
    expect(m.sent).toEqual([])
  })

  it('an exit nobody waited for is proven by the final look, not reported as unproven', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4400, `node ${BASE}/mock-cli.cjs aaaa`)
    await procs.command('mock cli', 4400, `${BASE}/mock-cli.cjs`)
    m.rows.delete(4400)
    const remove = vi.fn(async () => {})
    await procs.finish(remove)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(m.sent).toEqual([])
  })

  it('a process still naming the directory at the end fails the run', async () => {
    const m = machine()
    const procs = new LiveProcs(m.table, BASE)
    m.add(4900, `/usr/bin/node ${BASE}/mock-cli.cjs B`)
    const remove = vi.fn(async () => {})
    await expect(procs.finish(remove)).rejects.toThrow(/left running: 4900/)
    expect(remove).not.toHaveBeenCalled()
    expect(m.sent).toEqual([])
  })
})

describe('the real table', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('parses ps rows with the five-word start time', () => {
    const rows = parsePs(`  4200     1  4200 Ss   Sun Oct 25 13:08:57 2026     /usr/bin/node /tmp/wll-x/daemon.cjs --start\n garbage\n`)
    expect(rows.get(4200)).toEqual({ pid: 4200, ppid: 1, pgid: 4200, stat: 'Ss', lstart: LSTART, command: '/usr/bin/node /tmp/wll-x/daemon.cjs --start' })
    expect(rows.size).toBe(1)
  })

  it('refuses a signal to pid 1 or below before it reaches process.kill', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const t = realProcTable()
    expect(() => t.kill(1, 'SIGCONT')).toThrow(/refusing/)
    expect(() => t.kill(0, 'SIGCONT')).toThrow(/refusing/)
    expect(kill).not.toHaveBeenCalled()
  })
})
