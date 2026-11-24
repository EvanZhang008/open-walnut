/**
 * The external-session scan must not freeze the daemon (daemon-standalone.ts),
 * booted for real.
 *
 * The incident (2026-09-29): the scan walked a host's ~16,000 transcripts in one
 * synchronous pass, 17 to 75 s every ten minutes. Nothing else on the daemon ran
 * meanwhile: a user's send timed out after 30 s, the server fell back to a
 * resume, and the daemon stopped the live CLI to make room for it. The scan now
 * yields as it walks and remembers each unchanged file's verdict, so a daemon
 * answers other commands during a scan and the next scan reads no heads.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; no
 * CLI is started; the daemon is SIGKILLed after each test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => { const t = setTimeout(resolve, 10_000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

async function boot(home: string, daemonDir: string): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir: daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
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

/** Every `external session scan` line the daemon logged, in order. */
function scanLog(daemonDir: string): Array<{ scanned: number; parsed: number; found: number }> {
  const out: Array<{ scanned: number; parsed: number; found: number }> = []
  for (const f of fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf8').split('\n')) {
      if (!line.includes('external session scan')) continue
      const rec = JSON.parse(line) as { msg: string; scanned: number; parsed: number; found: number }
      if (rec.msg === 'external session scan') out.push(rec)
    }
  }
  return out
}

const L = (o: unknown) => JSON.stringify(o) + '\n'

describe.skipIf(!BUN)('the external-session scan leaves the daemon responsive, standalone daemon (bun)', () => {
  it('pings are answered during a scan of 2,000 transcripts, and the rescan reads no heads', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-extscan-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    // Sessions a person started, with a reply: each one is read to the end of
    // its head, the most work a transcript can cost the scan.
    const projectDir = path.join(home, '.claude', 'projects', '-Users-dev-proj')
    fs.mkdirSync(projectDir, { recursive: true })
    const chat = L({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'y'.repeat(4000) }] } })
    for (let i = 0; i < 2000; i++) {
      fs.writeFileSync(path.join(projectDir, `bulk-${i}.jsonl`), L({
        type: 'user', cwd: '/Users/dev/proj', entrypoint: 'cli', timestamp: '2026-09-29T10:00:00.000Z',
        message: { role: 'user', content: 'task ' + i },
      }) + chat.repeat(10))
    }

    await boot(home, daemonDir)
    const scanned = { done: false }
    const scan = rpc({ cmd: 'sessions.discoverExternal', sinceMs: 30 * 86_400_000, limit: 5000 })
      .finally(() => { scanned.done = true })
    // Ping from inside the scan, never alongside the frame that starts it.
    await new Promise((r) => setTimeout(r, 50))
    let answeredDuringScan = 0
    let worstPingMs = 0
    while (!scanned.done) {
      const t0 = Date.now()
      const pong = await rpc({ cmd: 'ping' }, 120_000)
      expect(pong.ok, JSON.stringify(pong)).toBe(true)
      worstPingMs = Math.max(worstPingMs, Date.now() - t0)
      if (!scanned.done) answeredDuringScan++
      await new Promise((r) => setTimeout(r, 20))
    }
    const first = await scan
    expect(first.ok, JSON.stringify(first).slice(0, 300)).toBe(true)
    expect(first.candidates as unknown[]).toHaveLength(2000)
    // A synchronous walk answers every ping after the scan, never during it.
    expect(answeredDuringScan).toBeGreaterThan(0)

    const second = await rpc({ cmd: 'sessions.discoverExternal', sinceMs: 30 * 86_400_000, limit: 5000 })
    expect(second.candidates as unknown[]).toHaveLength(2000)
    // The daemon's log is written behind its reply: give the second line a moment to land.
    for (let i = 0; i < 50 && scanLog(daemonDir).length < 2; i++) await new Promise((r) => setTimeout(r, 100))
    expect(scanLog(daemonDir)).toEqual([
      expect.objectContaining({ scanned: 2000, parsed: 2000, found: 2000 }),
      expect.objectContaining({ scanned: 2000, parsed: 0, found: 2000 }),
    ])
    console.log(`[standalone] pings answered during the scan: ${answeredDuringScan}, worst ${worstPingMs} ms`)
  }, 180_000)
})

/**
 * A scripted fan-out (one `claude -p` per sensor reading) filed hundreds of
 * tasks a day on one host (2026-10-06). Both daemons booted for real: the scan
 * imports only what a person started (the CLI's entrypoint and prompt source),
 * describe says 'programmatic' for the rest so the server's audit and a plugin's
 * claim can act on it, and the daemon says it knows the rule.
 */
describe.skipIf(!BUN)('a program\'s runs are not outside sessions, standalone daemon (bun)', () => {
  it('the scan keeps only what a person started, describe says programmatic, hello advertises external-human-v1', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exthuman-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    const cwd = '/Users/dev/garden/sensor-check'
    const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const reply = L({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'no anomaly' }] } })
    const prompt = 'You check ONE garden sensor reading for odd values. Sensor: '
    const t0 = Date.parse('2026-09-20T10:00:00.000Z')
    const user = (o: Record<string, unknown>, content: string) => L({
      type: 'user', cwd, timestamp: new Date(t0).toISOString(), message: { role: 'user', content }, ...o,
    })
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(projectDir, `w-${i}.jsonl`), user({ entrypoint: 'sdk-cli', promptSource: 'sdk' }, prompt + 'soil-moisture-' + i) + reply)
    }
    // `claude -p` from a shell inside a terminal session: inherits 'cli'.
    fs.writeFileSync(path.join(projectDir, 'child.jsonl'), user({ entrypoint: 'cli', promptSource: 'sdk' }, 'summarize this diff') + reply)
    fs.writeFileSync(path.join(projectDir, 'person.jsonl'), user({ entrypoint: 'cli', promptSource: 'typed' }, 'why did the review flag nothing?') + reply)
    fs.writeFileSync(path.join(projectDir, 'ide.jsonl'), user({ entrypoint: 'claude-vscode', promptSource: 'sdk' }, 'explain this file') + reply)

    await boot(home, daemonDir)
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('external-human-v1')
    expect(hello.capabilities as string[]).not.toContain('external-batch-v1')
    const scan = await rpc({ cmd: 'sessions.discoverExternal', sinceMs: 30 * 86_400_000, limit: 500 })
    expect(scan.ok, JSON.stringify(scan).slice(0, 300)).toBe(true)
    expect((scan.candidates as Array<{ sessionId: string }>).map((c) => c.sessionId).sort()).toEqual(['ide', 'person'])
    const described = await rpc({ cmd: 'sessions.describeExternal', sessionIds: ['w-0', 'w-11', 'child', 'person'] })
    expect(described.ok, JSON.stringify(described).slice(0, 300)).toBe(true)
    const byId = Object.fromEntries((described.candidates as Array<{ sessionId: string; notExternal: unknown; title?: string }>)
      .map((c) => [c.sessionId, [c.notExternal, c.title]]))
    expect(byId).toEqual({
      'w-0': ['programmatic', prompt + 'soil-moisture-0'],
      'w-11': ['programmatic', prompt + 'soil-moisture-11'],
      child: ['programmatic', 'summarize this diff'],
      person: [null, 'why did the review flag nothing?'],
    })
  }, 120_000)
})
