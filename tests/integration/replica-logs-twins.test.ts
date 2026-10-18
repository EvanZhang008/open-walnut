/**
 * logs.tail and the running log cap (WP14, cap 'replica-logs-v1') on REAL daemon
 * processes, both twins:
 *
 *   test (the leader) ══trusted WS══► daemon (source twin on node, standalone on bun)
 *                                        │ server.configure: spawns the fake replica
 *                                        ▼
 *                         fake replica: structured lines in its run dir,
 *                         a flood on stdout (the supervisor caps it while it runs)
 *
 * What's real: the daemon processes, the supervisor (spawn, log fd, the cap
 * check), the owner check of logs.tail (the leader socket's leader.configure),
 * the journal lines the daemon writes for an ack. The replica is a small script.
 *
 * Invariants:
 *   - the leader of `home` reads its replica's lines and its own journal lines;
 *   - another Walnut's leader, a follower and a socket that never configured are
 *     refused; another Walnut's journal lines never show in `home`'s answer;
 *   - a running replica's stdout log stays bounded (copied to `.1`, emptied in place).
 *
 * Hygiene: every dir is a temp dir; daemons and the fake replica are ours and are
 * stopped by pid at the end. A missing bun skips the standalone twin here (the
 * large run, tests/setup/large-run.sh, fails on it instead).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/marina-home'
const OTHER = '/fixture/acme-home'
const WALNUT = 'wmarinaleader01'
const OTHER_WALNUT = 'wacmeleader0001'
const CAP = 64 * 1024

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const REQUIRE_BUN = process.env.WALNUT_REQUIRE_BUN === '1'

/** A replica as its daemon sees it: structured lines in its run dir, a flood on stdout. */
const FAKE_REPLICA = `
const fs = require('fs')
const path = require('path')
const dir = process.env.WALNUT_DAEMON_DIR
fs.mkdirSync(dir, { recursive: true })
const d = new Date()
const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const file = path.join(dir, 'open-walnut-' + day + '.log')
const line = (o) => fs.appendFileSync(file, JSON.stringify(Object.assign({ time: new Date().toISOString(), level: 'info', subsystem: 'web' }, o)) + '\\n')
line({ message: 'replica presence', answers: false, why: 'quiet', host: 'devbox' })
line({ message: 'replica forward', outcome: 'answered', status: 200, ms: 12, bytes: 345, opId: 'op-marina-1' })
line({ message: 'web request', path: '/api/tasks' })
fs.writeFileSync(process.env.FAKE_PID + '.token', process.env.WALNUT_FOLLOWER_TOKEN || '')
fs.writeFileSync(process.env.FAKE_PID, String(process.pid))
process.on('SIGTERM', () => process.exit(0))
const chunk = 'x'.repeat(1023) + '\\n'
setInterval(() => { process.stdout.write(chunk) }, 10)
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }

let base = ''
const started: number[] = []
const fakePids: string[] = []

async function spawnDaemon(dir: string, twin: 'source' | 'standalone'): Promise<Daemon> {
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_HOST_SERVER_LOG_MAX_BYTES: String(CAP),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'rlt-')) })

afterAll(() => {
  for (const f of fakePids) {
    try { const pid = parseInt(fs.readFileSync(f, 'utf8'), 10); if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL') } catch { /* none */ }
  }
  for (const pid of started) { if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN && !REQUIRE_BUN)(`${twin} twin: logs.tail and the running log cap`, () => {
    it('the leader reads its replica\'s lines and its journal lines; nobody else does; stdout stays bounded', async () => {
      if (twin === 'standalone' && !BUN) throw new Error('bun is required for the standalone twin (WALNUT_REQUIRE_BUN=1) and was not found')
      const dir = path.join(base, twin.slice(0, 2))
      const runDir = path.join(base, `${twin}-run`)
      const stdout = path.join(base, `${twin}-logs`, 'server.log')
      const fake = path.join(base, `${twin}-fake.cjs`)
      const fakePid = path.join(base, `${twin}-fake.pid`)
      fakePids.push(fakePid)
      fs.writeFileSync(fake, FAKE_REPLICA)
      const d = await spawnDaemon(dir, twin)
      const beat: Array<ReturnType<typeof setInterval>> = []
      const socks: WebSocket[] = []
      try {
        const leader = await connectWs(d.port)
        const other = await connectWs(d.port)
        const stranger = await connectWs(d.port)
        socks.push(leader, other, stranger)
        expect((await cmd(leader, { cmd: 'hello' })).capabilities).toContain('replica-logs-v1')
        expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
        expect((await cmd(other, { cmd: 'leader.configure', home: OTHER, walnutId: OTHER_WALNUT, backup: true })).ok).toBe(true)
        for (const ws of [leader, other]) beat.push(setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 500))
        const spec = {
          v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [fake], cwd: base,
          env: { WALNUT_DAEMON_DIR: runDir, FAKE_PID: fakePid }, log: stdout, port: 41_235, settings: {},
        }
        expect((await cmd(leader, { cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
        await waitFor(() => fs.existsSync(fakePid), 20_000, 'the fake replica')
        // Journal lines of both Walnuts in the daemon's own log.
        const ackHome = await cmd(leader, { cmd: 'offline.ack', home: HOME, seqs: [] })
        const ackOther = await cmd(other, { cmd: 'offline.ack', home: OTHER, seqs: [] })
        expect([ackHome.ok, ackOther.ok]).toEqual([true, true])

        const mine = await cmd(leader, { cmd: 'logs.tail', home: HOME, sources: ['replica', 'journal'], n: 50 })
        expect(mine.ok).toBe(true)
        expect(mine.running).toBe(true)
        const replicaMsgs = mine.lines.filter((l: any) => l.source === 'replica').map((l: any) => JSON.parse(l.line).message)
        expect(replicaMsgs).toEqual(['replica presence', 'replica forward', 'web request'])
        const journal = mine.lines.filter((l: any) => l.source === 'journal').map((l: any) => JSON.parse(l.line))
        expect(journal.length).toBeGreaterThan(0)
        expect(journal.every((j: any) => j.home === HOME && String(j.msg).startsWith('journal'))).toBe(true)
        // A filter on the message, as walnut-logs.sh asks.
        const fwd = await cmd(leader, { cmd: 'logs.tail', home: HOME, sources: ['replica'], n: 10, match: ['replica forward'] })
        expect(fwd.lines.map((l: any) => JSON.parse(l.line).opId)).toEqual(['op-marina-1'])

        // Another Walnut's leader: its own journal lines, never HOME's; HOME is refused to it.
        const theirs = await cmd(other, { cmd: 'logs.tail', home: OTHER, sources: ['replica', 'journal'], n: 50 })
        expect(theirs.ok).toBe(true)
        expect(theirs.running).toBe(false)
        expect(theirs.lines.every((l: any) => l.source === 'journal' && JSON.parse(l.line).home === OTHER)).toBe(true)
        expect((await cmd(other, { cmd: 'logs.tail', home: HOME, sources: ['replica'] })).errorKind).toBe('not_owner')
        expect((await cmd(stranger, { cmd: 'logs.tail', home: HOME, sources: ['replica'] })).errorKind).toBe('not_owner')
        expect((await cmd(leader, { cmd: 'logs.tail', home: HOME, sources: ['/etc/passwd'] })).errorKind).toBe('bad_request')
        // The follower (the replica's own socket, with its token) may not ask either.
        const token = fs.readFileSync(fakePid + '.token', 'utf8')
        const follower = await connectWs(d.port)
        socks.push(follower)
        expect((await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token })).ok).toBe(true)
        expect((await cmd(follower, { cmd: 'logs.tail', home: HOME, sources: ['replica'] })).errorKind).toBe('follower_refused')

        // The flood: about 100 KB a second on stdout; the cap is 64 KB, checked every 5 s.
        await waitFor(() => fs.existsSync(stdout + '.1'), 20_000, 'the first cap while running')
        let written = 0
        let largest = 0
        const end = Date.now() + 11_000
        while (Date.now() < end) {
          const size = fs.statSync(stdout).size
          largest = Math.max(largest, size)
          await sleep(250)
        }
        written = fs.statSync(stdout).size + fs.statSync(stdout + '.1').size
        expect(written).toBeGreaterThan(CAP)
        // Bounded: at most the cap plus one check interval of writing (and slack for a slow box).
        expect(largest).toBeLessThan(CAP + 5 * 1024 * 1024 / 4)
        const daemonLog = fs.readdirSync(dir).filter((n) => /^daemon-d-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('')
        expect(daemonLog).toMatch(/"msg":"host server: log capped"/)
        const out = await cmd(leader, { cmd: 'logs.tail', home: HOME, sources: ['stdout'], n: 5 })
        expect(out.ok && out.lines.length).toBe(5)
        expect(out.lines.every((l: any) => l.source === 'stdout' && /^x+$/.test(l.line))).toBe(true)
        expect((await cmd(leader, { cmd: 'server.configure', home: HOME, spec: null })).ok).toBe(true)
      } finally {
        for (const t of beat) clearInterval(t)
        for (const ws of socks) { try { ws.close() } catch { /* closed */ } }
        try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
        await waitFor(() => !alive(d.pid), 20_000, 'daemon exit').catch(() => {})
      }
    }, 120_000)
  })
}
