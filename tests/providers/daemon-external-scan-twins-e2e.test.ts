/**
 * The external-session scan must not freeze the daemon, in both twins booted
 * for real.
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
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const CORE = path.resolve(__dirname, '../../src/providers/external-session-scan-core.ts')
let scriptDir = ''
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = BUN ? [
  { name: 'source twin (node)', command: () => [process.execPath, [path.join(scriptDir, 'daemon.cjs'), '--start']] },
  { name: 'standalone twin (bun)', command: () => [BUN, [STANDALONE, '--start']] },
] : []

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

beforeAll(() => {
  if (!BUN) return
  // The source twin require()s the scan from a sidecar next to it, bundled the
  // same way scripts/build-daemon.sh does.
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-extscan-src-'))
  fs.writeFileSync(path.join(scriptDir, 'daemon.cjs'), getDaemonSource())
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(scriptDir, 'external-scan-core.cjs'), CORE], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
}, 60_000)

afterAll(() => { if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }) })

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

async function boot(twin: Twin, home: string, daemonDir: string): Promise<void> {
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

describe.skipIf(TWINS.length === 0)('the external-session scan leaves the daemon responsive (both twins)', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: pings are answered during a scan of 2,000 transcripts, and the rescan reads no heads`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-extscan-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      // Programmatic sessions with a real cwd and a reply: each one is read to
      // the end of its head, like the bulk of a real host's transcripts.
      const projectDir = path.join(home, '.claude', 'projects', '-Users-dev-proj')
      fs.mkdirSync(projectDir, { recursive: true })
      const chat = L({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'y'.repeat(4000) }] } })
      for (let i = 0; i < 2000; i++) {
        fs.writeFileSync(path.join(projectDir, `bulk-${i}.jsonl`), L({
          type: 'user', cwd: '/Users/dev/proj', entrypoint: 'sdk-cli', timestamp: '2026-09-29T10:00:00.000Z',
          message: { role: 'user', content: 'task ' + i },
        }) + chat.repeat(10))
      }

      await boot(twin, home, daemonDir)
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
      expect(scanLog(daemonDir)).toEqual([
        expect.objectContaining({ scanned: 2000, parsed: 2000, found: 2000 }),
        expect.objectContaining({ scanned: 2000, parsed: 0, found: 2000 }),
      ])
      console.log(`[${twin.name}] pings answered during the scan: ${answeredDuringScan}, worst ${worstPingMs} ms`)
    }, 180_000)
  }
})

/**
 * A scripted fan-out (one `claude -p` per dashboard widget) filed hundreds of
 * tasks a day on one host (2026-10-06). Both daemons booted for real: the scan
 * leaves the workers out, describe names them for the server's audit, and the
 * daemon says it knows the rule so the server asks again about old imports.
 */
describe.skipIf(TWINS.length === 0)('fan-out workers are not outside sessions (both twins)', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: the scan skips a run's workers, describe says batch, hello advertises external-batch-v1`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-extbatch-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      const cwd = '/Users/dev/ops/widget-review'
      const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      fs.mkdirSync(projectDir, { recursive: true })
      const reply = L({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'no anomaly' }] } })
      const prompt = 'You review ONE CloudWatch dashboard widget for anomalies an on-call engineer must look at. Widget: '
      const t0 = Date.parse('2026-09-20T10:00:00.000Z')
      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(path.join(projectDir, `w-${i}.jsonl`), L({
          type: 'user', cwd, entrypoint: 'sdk-cli', timestamp: new Date(t0 + i * 20_000).toISOString(),
          message: { role: 'user', content: prompt + 'latency-p99-' + i },
        }) + reply)
      }
      fs.writeFileSync(path.join(projectDir, 'person.jsonl'), L({
        type: 'user', cwd, entrypoint: 'cli', timestamp: new Date(t0).toISOString(),
        message: { role: 'user', content: 'why did the review flag nothing?' },
      }) + reply)

      await boot(twin, home, daemonDir)
      const hello = await rpc({ cmd: 'hello' })
      expect(hello.capabilities as string[]).toContain('external-batch-v1')
      const scan = await rpc({ cmd: 'sessions.discoverExternal', sinceMs: 30 * 86_400_000, limit: 500 })
      expect(scan.ok, JSON.stringify(scan).slice(0, 300)).toBe(true)
      expect((scan.candidates as Array<{ sessionId: string }>).map((c) => c.sessionId)).toEqual(['person'])
      const described = await rpc({ cmd: 'sessions.describeExternal', sessionIds: ['w-0', 'w-11', 'person'] })
      expect(described.ok, JSON.stringify(described).slice(0, 300)).toBe(true)
      expect(Object.fromEntries((described.candidates as Array<{ sessionId: string; notExternal: unknown }>)
        .map((c) => [c.sessionId, c.notExternal]))).toEqual({ 'w-0': 'batch', 'w-11': 'batch', person: null })
    }, 120_000)
  }
})
