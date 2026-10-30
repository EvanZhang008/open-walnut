/**
 * send-boot-wait-v1 on the real daemon twins, booted for real (the JS source twin,
 * and the standalone twin under bun when bun is installed), with the daemon's real
 * 20s write deadline and a stand-in CLI that boots for 23s before it reads stdin.
 *
 * The 2026-10-30 incident: `claude --resume` of a 136MB transcript took 18 to 22s
 * before it read its first line. The first line after the start was bigger than the
 * pipe buffer, so part of it went in, the write hit the 20s deadline, and the daemon
 * reaped the healthy booting CLI ('send-partial-write'), twice in a row; the server
 * showed "Session started, but the queued message was not delivered".
 *
 * Pins, in one run per twin (the three sessions boot side by side):
 *   - a boot-wait send waits for the booting CLI and the line arrives whole;
 *   - the same send without `bootWait` keeps the old contract (reaped at 20s), which
 *     is also the incident reproduced on the real twin;
 *   - a `start` whose own message carries `bootWait` waits the same way.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the
 * "CLI" is a node script that exits on its own within 60 s, every session's
 * process group and the daemon are SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

let scriptPath = ''
let cliPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const cliPids = new Set<number>()

/** Longer than the daemon's plain 20s write deadline, well inside its 120s boot one. */
const BOOT_MS = 23_000

/**
 * A stand-in CLI that boots like Claude Code resuming a huge transcript: it reads
 * nothing from stdin for BOOT_MS, then records each user line, and prints its init
 * line only once it took the first one (as `claude -p --input-format stream-json` does).
 */
const FAKE_CLI = `
const fs = require('fs')
const [received, bootMs] = process.argv.slice(2)
setTimeout(() => process.exit(0), 60000).unref()
let buf = ''
let inited = false
setTimeout(() => process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch {
      fs.appendFileSync(received, JSON.stringify({ pid: process.pid, parseError: line.slice(0, 200) }) + '\\n')
      continue
    }
    if (msg.type !== 'user') continue
    if (!inited) { inited = true; process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n') }
    fs.appendFileSync(received, JSON.stringify({ pid: process.pid, length: msg.message.content.length, head: msg.message.content.slice(0, 16) }) + '\\n')
  }
}), Number(bootMs))
setInterval(() => {}, 1000)
`

interface Dirs { home: string; streams: string; daemon: string; received: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-wait-twins-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon'), received: path.join(root, 'received.jsonl') }
}

async function boot(twin: Twin, dirs: Dirs): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: dirs.home,
    WALNUT_DAEMON_DIR: dirs.daemon,
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  // Every session's state change, to learn the pid of a start still waiting on its line.
  ws.on('message', (data: Buffer) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (typeof msg.pid === 'number' && msg.pid > 1) cliPids.add(msg.pid)
  })
}

async function killDaemon(): Promise<void> {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

const received = (dirs: Dirs): Array<{ pid: number; length?: number; head?: string; parseError?: string }> =>
  fs.existsSync(dirs.received) ? fs.readFileSync(dirs.received, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

const cliArgs = (dirs: Dirs) => {
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(dirs.received)} ${BOOT_MS}`
  return ['/bin/sh', '-c', sh, 'sh']
}

/** Far beyond any pipe buffer (64KB at most on macOS and Linux), so part of it waits in the write. */
const bigLine = (tag: string) => tag.padEnd(16, '-') + 'x'.repeat(300 * 1024)

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-wait-twins-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-cli.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  await killDaemon()
  for (const pid of cliPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  cliPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('send-boot-wait-v1: $name', (twin) => {
  it('a boot-wait line waits for a CLI booting past 20s; the plain line is reaped at 20s', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    expect((await rpc({ cmd: 'hello' })).capabilities).toContain('send-boot-wait-v1')

    // Two idle spawns, then the first line of each, as the server's deferred start sends it.
    const waitStart = await rpc({ cmd: 'start', sid: 'bw-wait', cwd: root, message: '', mode: 'default', args: cliArgs(dirs) })
    const plainStart = await rpc({ cmd: 'start', sid: 'bw-plain', cwd: root, message: '', mode: 'default', args: cliArgs(dirs) })
    for (const r of [waitStart, plainStart]) { expect(typeof r.pid).toBe('number'); cliPids.add(r.pid as number) }
    const t0 = Date.now()
    const markers = (id: string, message: string) => [{ message, messageId: id }]
    const waited = rpc({ cmd: 'send', sid: 'bw-wait', message: bigLine('wait'), uuid: 'aaaaaaaa-0000-4000-8000-0000000000b1', markers: markers('qm-bw-1', 'wait'), bootWait: true })
    const plain = rpc({ cmd: 'send', sid: 'bw-plain', message: bigLine('plain'), uuid: 'aaaaaaaa-0000-4000-8000-0000000000b2', markers: markers('qm-bw-2', 'plain') })
    // The start's own message, with bootWait (the path a start without markers takes).
    const inStart = rpc({ cmd: 'start', sid: 'bw-start', cwd: root, message: bigLine('start'), bootWait: true, mode: 'default', args: cliArgs(dirs) })

    const [w, p, s] = await Promise.all([waited, plain, inStart])
    expect(w).toMatchObject({ ok: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(BOOT_MS - 1_000)
    expect(p).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(typeof s.pid).toBe('number')
    expect(s.error).toBeUndefined()

    // Each waited line reached its CLI whole; the reaped one never ran.
    const got = await (async () => {
      const until = Date.now() + 10_000
      while (Date.now() < until && received(dirs).length < 2) await new Promise((r) => setTimeout(r, 100))
      return received(dirs)
    })()
    expect(got.filter((r) => r.parseError)).toEqual([])
    const heads = got.map((r) => r.head).sort()
    expect(heads).toEqual(['start-----------', 'wait------------'])
    for (const r of got) expect(r.length).toBe(bigLine('wait').length)

    // The waited sessions are still running; the plain one was reaped mid-boot.
    for (const sid of ['bw-wait', 'bw-start']) expect(await rpc({ cmd: 'status', sid })).toMatchObject({ exists: true, alive: true })
    expect(await rpc({ cmd: 'status', sid: 'bw-plain' })).toMatchObject({ alive: false })
  }, 120_000)
})
