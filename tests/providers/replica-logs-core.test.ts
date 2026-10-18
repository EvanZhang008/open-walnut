/**
 * logs.tail (src/providers/replica-logs-core.ts, WP14) and the supervisor's cap
 * on a running server's stdout log (host-server-core.ts capLog), on real temp
 * files. The twins' wiring (parity, hash lists, cap) is pinned at the bottom;
 * the real daemon processes are tests/integration/replica-logs-twins.test.ts.
 *
 * Invariants:
 *   - only the replica's own log files and this daemon's journal lines for the
 *     asked Walnut are read; a line naming another Walnut, or none, never is;
 *   - nothing is read from a path the request names; a symlink is skipped;
 *   - n is capped (2000), each file is read from its last 1 MB only;
 *   - a running server's log never grows past the cap: it is copied to `.1`
 *     and emptied in place, and the server writes on at the start.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReplicaLogs } from '../../src/providers/replica-logs-core.js'
import { createHostServerSupervisor, type HostServerDeps } from '../../src/providers/host-server-core.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/marina-home'
const OTHER = '/fixture/acme-home'

let base = ''
let runDir = ''
let daemonDir = ''
let stdout = ''

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'rlogs-'))
  runDir = path.join(base, 'run')
  daemonDir = path.join(base, 'daemon')
  stdout = path.join(base, 'logs', 'server.log')
  for (const d of [runDir, daemonDir, path.dirname(stdout)]) fs.mkdirSync(d, { recursive: true })
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

function reader(running = true) {
  return createReplicaLogs({ fs, path, daemonDir, logsOf: (home) => (running && home === HOME ? { stdout, dirs: [runDir] } : null) })
}

describe('logs.tail reads the replica\'s own logs and the journal lines of its Walnut', () => {
  it('returns the replica\'s structured lines, its stdout and only this Walnut\'s journal lines', () => {
    fs.writeFileSync(path.join(runDir, 'open-walnut-2026-10-16.log'), line({ message: 'replica presence', answers: false }))
    fs.writeFileSync(path.join(runDir, 'open-walnut-2026-10-17.log'), line({ message: 'replica forward', outcome: 'answered' }) + 'not json\n')
    fs.writeFileSync(path.join(runDir, 'notes.txt'), line({ message: 'not a log file' }))
    fs.writeFileSync(stdout, 'boot line\n')
    fs.writeFileSync(path.join(daemonDir, 'daemon-d-123-abcdef01.log'),
      line({ msg: 'journal append', home: HOME, kind: 'task-fields', opId: 'op-1' })
      + line({ msg: 'journal append', home: OTHER, kind: 'task-fields', opId: 'op-2' })
      + line({ msg: 'journal: note bodies no record names were removed', removed: 2 })
      + line({ msg: 'host server: started', home: HOME }))
    const r = reader().tail(HOME, ['replica', 'journal', 'stdout'], 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.running).toBe(true)
    const by = (s: string) => r.lines.filter((l) => l.source === s).map((l) => l.line)
    expect(by('replica').map((l) => JSON.parse(l).message)).toEqual(['replica presence', 'replica forward'])
    expect(by('journal').map((l) => JSON.parse(l).opId)).toEqual(['op-1'])
    expect(by('stdout')).toEqual(['boot line'])
    expect(r.files).not.toContain('notes.txt')
  })

  it('reads nothing of a Walnut this daemon runs nothing for, except its own journal lines', () => {
    fs.writeFileSync(path.join(daemonDir, 'daemon-d-9-0a.log'), line({ msg: 'journal: acked', home: OTHER, remaining: 0 }))
    fs.writeFileSync(path.join(runDir, 'open-walnut-2026-10-17.log'), line({ message: 'replica presence' }))
    const r = reader().tail(OTHER, ['replica', 'journal'], 10)
    expect(r.ok && r.running).toBe(false)
    expect(r.ok && r.lines.map((l) => l.source)).toEqual(['journal'])
  })

  it('refuses an unknown source and a bad match, and caps n', () => {
    const logs = reader()
    expect(logs.tail(HOME, ['/etc/passwd'], 5).ok).toBe(false)
    expect(logs.tail('', ['replica'], 5).ok).toBe(false)
    expect(logs.tail(HOME, ['replica'], 5, ['x'.repeat(81)]).ok).toBe(false)
    expect(logs.tail(HOME, ['replica'], 5, 'replica').ok).toBe(false)
    const many = Array.from({ length: 2500 }, (_, i) => line({ message: 'replica forward', i })).join('')
    fs.writeFileSync(path.join(runDir, 'open-walnut-2026-10-17.log'), many)
    const r = logs.tail(HOME, ['replica'], 1e9)
    expect(r.ok && r.lines.length).toBe(2000)
    expect(r.ok && r.truncated).toBe(true)
    expect(r.ok && JSON.parse(r.lines[r.lines.length - 1]!.line).i).toBe(2499)
  })
})

describe('logs.tail bounds what it reads', () => {
  it('filters by message, skips a symlinked log, and reads only the last 1 MB of a file', () => {
    const outside = path.join(base, 'secret.log')
    fs.writeFileSync(outside, line({ message: 'replica secret' }))
    fs.symlinkSync(outside, path.join(runDir, 'open-walnut-2026-10-15.log'))
    const filler = 'x'.repeat(300)
    const big = Array.from({ length: 5000 }, (_, i) => line({ message: i % 2 ? 'replica forward' : 'web request', i, filler })).join('')
    expect(big.length).toBeGreaterThan(1024 * 1024)
    fs.writeFileSync(path.join(runDir, 'open-walnut-2026-10-17.log'), big)
    const r = reader().tail(HOME, ['replica'], 2000, ['replica forward'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.every((l) => JSON.parse(l.line).message === 'replica forward')).toBe(true)
    expect(r.lines.some((l) => l.line.includes('secret'))).toBe(false)
    expect(r.files).not.toContain('open-walnut-2026-10-15.log')
    // The first line of the cut window is dropped whole, never parsed half.
    const total = r.lines.reduce((n, l) => n + l.line.length + 1, 0)
    expect(total).toBeLessThanOrEqual(1024 * 1024)
    expect(r.truncated).toBe(true)
    expect(JSON.parse(r.lines[r.lines.length - 1]!.line).i).toBe(4999)
  })

  it('keeps the newest three daemon log files', () => {
    for (let i = 0; i < 5; i++) {
      const f = path.join(daemonDir, `daemon-d-${i + 1}-0${i}.log`)
      fs.writeFileSync(f, line({ msg: 'journal append', home: HOME, opId: `op-${i}` }))
      fs.utimesSync(f, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000))
    }
    const r = reader().tail(HOME, ['journal'], 10)
    expect(r.ok && r.lines.map((l) => JSON.parse(l.line).opId)).toEqual(['op-2', 'op-3', 'op-4'])
  })
})

// ── The supervisor's cap on a running server's stdout log ──

class FakeChild extends EventEmitter {
  constructor(public pid: number) { super() }
  unref(): void { /* nothing */ }
}

describe('the supervisor caps a running server\'s stdout log by size', () => {
  it('copies an oversized log to .1 and empties it in place, at start and while it runs', () => {
    let now = 0
    let timers: Array<{ at: number; fn: () => void; id: number }> = []
    let nextId = 1
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = []
    const procs = new Map<number, string>()
    const advance = (ms: number): void => {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        now = next.at
        next.fn()
      }
      now = end
    }
    const deps: HostServerDeps = {
      fs, path,
      spawn: () => { const c = new FakeChild(4242); procs.set(4242, 'st'); return c },
      dir: path.join(base, 'servers'),
      keyOf: (home) => Buffer.from(home).toString('hex').slice(0, 16),
      now: () => now,
      setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id },
      clearTimer: (t) => { timers = timers.filter((x) => x.id !== t) },
      log: (_l, msg, data) => { logs.push({ msg, data }) },
      startTimeOf: (pid) => procs.get(pid) ?? null,
      killGroup: () => {},
      baseEnv: () => ({ HOME: '/home/u' }),
      randomToken: () => 't'.repeat(64),
      maxLogBytes: 1000,
    }
    fs.mkdirSync(deps.dir, { recursive: true })
    fs.writeFileSync(stdout, 'a'.repeat(1500))
    const sup = createHostServerSupervisor(deps)
    sup.configure(HOME, {
      v: 1, home: HOME, walnutId: 'w1', command: '/usr/bin/node', args: ['/app/cli.js'], cwd: '/',
      env: { WALNUT_DAEMON_DIR: runDir }, log: stdout, port: 4000, settings: {},
    })
    expect(sup.status(HOME).state).toBe('running')
    // At start (the old rotation): the oversized file became .1.
    expect(fs.readFileSync(`${stdout}.1`, 'utf8')).toBe('a'.repeat(1500))
    expect(fs.statSync(stdout).size).toBe(0)
    // The server writes (appends) past the cap while it runs.
    const fd = fs.openSync(stdout, 'a')
    fs.writeSync(fd, 'b'.repeat(1200))
    advance(5_000)
    expect(fs.readFileSync(`${stdout}.1`, 'utf8')).toBe('b'.repeat(1200))
    expect(fs.statSync(stdout).size).toBe(0)
    expect(logs.some((l) => l.msg === 'host server: log capped' && l.data?.home === HOME)).toBe(true)
    // It appends on at the start of the emptied file (no hole before its next line).
    fs.writeSync(fd, 'next\n')
    fs.closeSync(fd)
    expect(fs.readFileSync(stdout, 'utf8')).toBe('next\n')
    advance(5_000)
    expect(fs.readFileSync(stdout, 'utf8')).toBe('next\n')
    expect(sup.logsOf(HOME)).toEqual({ stdout, dirs: [runDir] })
    expect(sup.logsOf(OTHER)).toBeNull()
    // Stopped: the check stops with it.
    sup.configure(HOME, null)
    const capped = logs.filter((l) => l.msg === 'host server: log capped').length
    fs.writeFileSync(stdout, 'c'.repeat(1500))
    advance(30_000)
    expect(logs.filter((l) => l.msg === 'host server: log capped').length).toBe(capped)
    expect(fs.statSync(stdout).size).toBe(1500)
  })
})

// ── Both twins carry it the same way (parity) ──

describe('logs.tail and the log cap are in both twins, behind replica-logs-v1', async () => {
  const { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } = await import('../../src/providers/daemon-capabilities.js')
  const { getDaemonSource } = await import('../../src/providers/daemon-source.js')
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const standalone = read('src/providers/daemon-standalone.ts')
  const source = read('src/providers/daemon-source.ts')

  it('advertises the cap (optional) and hashes the core in both version lists, in the same place', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('replica-logs-v1')
    expect((REQUIRED_DAEMON_CAPABILITIES as readonly string[])).not.toContain('replica-logs-v1')
    const ts = read('src/providers/daemon-version-check.ts')
    const sh = read('scripts/build-daemon.sh')
    expect(ts).toContain("'src/providers/replica-logs-core.ts'")
    expect(sh).toContain('src/providers/replica-logs-core.ts')
    const orderTs = [...ts.matchAll(/'(src\/[^']+\.ts)'/g)].map((m) => m[1])
    const orderSh = [...sh.matchAll(/^\s+(src\/\S+\.ts)\s*$/gm)].map((m) => m[1])
    expect(orderTs.indexOf('src/providers/replica-logs-core.ts') - orderTs.indexOf('src/providers/marker-find-core.ts')).toBe(1)
    expect(orderSh.indexOf('src/providers/replica-logs-core.ts') - orderSh.indexOf('src/providers/marker-find-core.ts')).toBe(1)
  })

  it('both twins route logs.tail to a handler that checks the leader\'s home first', () => {
    expect(standalone).toMatch(/case 'logs\.tail': return cmdLogsTail\(ws, id as number, cmd\)/)
    expect(source).toMatch(/case 'logs\.tail': return cmdLogsTail\(ws, id, cmd\);/)
    for (const src of [standalone, source]) {
      const body = src.slice(src.indexOf('function cmdLogsTail('), src.indexOf('function cmdLogsTail(') + 900)
      expect(body).toMatch(/origin === 'bridge' \|\| [^\n]*origin === 'follower' \|\| [^\n]*origin === 'lane'/)
      expect(body).toMatch(/gatewayClientHomes\.get\(ws\) !== home/)
      expect(body).toMatch(/replicaLogs\.tail\(home, cmd\.sources, cmd\.n, cmd\.match\)/)
      expect(src).toMatch(/daemonDir: DAEMON_DIR, logsOf: [^\n]*hostServers\.logsOf\(home\)/)
      expect(src).toMatch(/maxLogBytes: Number\(process\.env\.WALNUT_HOST_SERVER_LOG_MAX_BYTES\) \|\| undefined,/)
    }
    // A follower may never ask (it is not in its allowlist), nor the bridge.
    const allow = standalone.slice(standalone.indexOf('const FOLLOWER_ALLOWED_COMMANDS'), standalone.indexOf('const LANE_ALLOWED_COMMANDS'))
    expect(allow).not.toContain('logs.tail')
    const bridge = standalone.slice(standalone.indexOf('const BRIDGE_ALLOWED_COMMANDS'), standalone.indexOf('const BRIDGE_ALLOWED_COMMANDS') + 4000)
    expect(bridge.slice(0, bridge.indexOf('])'))).not.toContain('logs.tail')
  })

  it('the rendered source twin inlines the core byte for byte', () => {
    const rendered = getDaemonSource()
    expect(rendered).not.toContain('__CREATE_REPLICA_LOGS__')
    const text = createReplicaLogs.toString()
    expect(text).not.toMatch(/__name\(|__vite|import\(/)
    expect(rendered).toContain(text)
    expect(rendered).toContain(createHostServerSupervisor.toString())
  })
})
