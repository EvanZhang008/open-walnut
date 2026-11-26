/**
 * The line a start was made for is the first line its CLI reads, on the real session daemon
 * (daemon-standalone.ts under bun): the start writes its message down the FIFO, and a `send` made
 * while the start runs waits in the session's start gate (daemon-session-commands.ts cmdSend), so
 * it is accepted and goes in after. Without the gate those sends are refused (not_found) until the
 * session is registered, and one that lands between registering and the line's write goes first.
 *
 * The mock daemon is matched against this (tests/helpers/mock-daemon.ts). 2026-11-25 it passed
 * the start's message as an argument instead, the mock CLI read a send that came right after the
 * start as its first line, and the start's message never ran (tests/e2e/session-first-line-settles.test.ts).
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the "CLI" is a node
 * script that exits on its own within 60 s, every session's process group and the daemon are
 * SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { testBun } from '../helpers/bun-runtime.js'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

let cliPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const command = (): [string, string[]] => [BUN!, [STANDALONE, '--start']]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const cliPids = new Set<number>()

/** A short boot: the race is in the daemon, between the start registering its session and writing its line. */
const BOOT_MS = 300

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
    if (msg.type === 'control_request') {
      fs.appendFileSync(received, JSON.stringify({ pid: process.pid, length: msg.request.question.length, head: msg.request.question.slice(0, 16) }) + '\\n')
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-first-line-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon'), received: path.join(root, 'received.jsonl') }
}

async function boot(dirs: Dirs): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: dirs.home,
    WALNUT_DAEMON_DIR: dirs.daemon,
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir: dirs.daemon }, (err) => { clearTimeout(timer); reject(err) })
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


beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-first-line-cli-'))
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

const SESSIONS = 6

/** Every send this test sent while the start was running, one each few ms, until the start answered. */
async function racingSends(sid: string, startDone: () => boolean): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Promise<Record<string, unknown>>> = []
  let n = 0
  while (!startDone() && n < 400) {
    sent.push(rpc({ cmd: 'send', sid, message: `second-${String(n++).padStart(3, '0')}` }))
    await new Promise((r) => setImmediate(r))
  }
  return Promise.all(sent)
}

describe.skipIf(!BUN)('a start\'s own line goes in first, standalone daemon (bun)', () => {
  it('a send that finds the session while its start still writes waits for the start\'s line', async () => {
    const dirs = makeDirs()
    await boot(dirs)
    const sids = Array.from({ length: SESSIONS }, (_, i) => `fl-${i}`)
    const results = await Promise.all(sids.map(async (sid) => {
      let done = false
      const start = rpc({ cmd: 'start', sid, cwd: root, message: `first-${sid}`, bootWait: true, mode: 'default', args: cliArgs(dirs) })
        .finally(() => { done = true })
      const sends = await racingSends(sid, () => done)
      const s = await start
      expect(s.error).toBeUndefined()
      expect(typeof s.pid).toBe('number'); cliPids.add(s.pid as number)
      return { sid, pid: s.pid as number, accepted: sends.filter((r) => r.ok === true).length }
    }))
    // Sends made while the start ran waited for it (the gate), and were taken.
    expect(results.reduce((sum, r) => sum + r.accepted, 0)).toBeGreaterThan(0)

    const until = Date.now() + 15_000
    const total = results.reduce((sum, r) => sum + 1 + r.accepted, 0)
    while (Date.now() < until && received(dirs).length < total) await new Promise((r) => setTimeout(r, 100))
    const got = received(dirs)
    for (const r of results) {
      const lines = got.filter((g) => g.pid === r.pid).map((g) => g.head)
      expect(lines.length, r.sid).toBe(1 + r.accepted)
      expect(lines[0], r.sid).toBe(`first-${r.sid}`.slice(0, 16))
    }
  }, 120_000)
})
