/**
 * A changes recompute continues from where the last one stopped even after the
 * session's output fell out of the daemon's output LRU, in both twins booted for
 * real.
 *
 * The incident (2026-09-29): the server's prewarm sweep warms ~20 sessions and
 * the daemon kept 12 outputs, with the parse memos inside each output entry. A
 * whale's entry was evicted between its warms, so every warm re-read the whole
 * 907 MB transcript (5 to 20 s) even with the incremental parse in place. The
 * memos now live in their own, larger LRU; the daemon logs how each compute read
 * the transcript, which is what this test reads back.
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
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const CORE = path.resolve(__dirname, '../../src/providers/session-changes-core.ts')
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
  // The source twin require()s the changes pipeline from a sidecar next to it,
  // bundled the same way scripts/build-daemon.sh does.
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-memo-src-'))
  fs.writeFileSync(path.join(scriptDir, 'daemon.cjs'), getDaemonSource())
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(scriptDir, 'changes-core.cjs'), CORE], { encoding: 'utf8' })
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

function rpc(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

/** Every `changes.compute done` line the daemon logged for this sid, in order. */
function computeLog(daemonDir: string, sid: string): Array<{ resumed: boolean; readBytes: number; files: number }> {
  const out: Array<{ resumed: boolean; readBytes: number; files: number }> = []
  for (const f of fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf8').split('\n')) {
      if (!line.includes('changes.compute done')) continue
      const rec = JSON.parse(line) as { msg: string; sid: string; resumed: boolean; readBytes: number; files: number }
      if (rec.msg === 'changes.compute done' && rec.sid === sid) out.push(rec)
    }
  }
  return out
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
const writeLine = (repo: string, rel: string, content: string) => L({
  type: 'assistant', cwd: repo,
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(repo, rel), content } }] },
})

describe.skipIf(TWINS.length === 0)('changes parse memos outlive the output LRU (both twins)', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: a whale's recompute after 14 other sessions reads only the appended bytes`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-memo-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      const repo = path.join(root, 'repo')
      fs.mkdirSync(repo, { recursive: true })
      const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(repo))
      fs.mkdirSync(projectDir, { recursive: true })
      const transcript = (sid: string) => path.join(projectDir, `${sid}.jsonl`)

      const whale = 'whale-sid'
      const chat = L({ type: 'assistant', cwd: repo, message: { content: [{ type: 'text', text: 'x'.repeat(1500) }] } })
      fs.writeFileSync(transcript(whale), L({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } })
        + writeLine(repo, 'a.ts', 'a1\n') + chat.repeat(2000))
      fs.writeFileSync(path.join(repo, 'a.ts'), 'a1\n')
      const others = Array.from({ length: 14 }, (_, i) => `other-${i}`)
      for (const sid of others) fs.writeFileSync(transcript(sid), writeLine(repo, `${sid}.ts`, 'o\n'))

      await boot(twin, home, daemonDir)
      const first = await rpc({ cmd: 'changes.compute', sid: whale, cwd: repo })
      expect(first.ok, JSON.stringify(first)).toBe(true)
      for (const sid of others) expect((await rpc({ cmd: 'changes.compute', sid, cwd: repo })).ok).toBe(true)

      const appended = writeLine(repo, 'b.ts', 'b1\n')
      fs.appendFileSync(transcript(whale), appended)
      fs.writeFileSync(path.join(repo, 'b.ts'), 'b1\n')
      const second = await rpc({ cmd: 'changes.compute', sid: whale, cwd: repo })
      const files = ((second.result as { groups: Array<{ files: Array<{ relPath: string }> }> }).groups)
        .flatMap((g) => g.files.map((f) => f.relPath)).sort()
      expect(files).toEqual(['a.ts', 'b.ts'])

      const log = computeLog(daemonDir, whale)
      expect(log).toHaveLength(2)
      expect(log[0]).toMatchObject({ resumed: false, readBytes: fs.statSync(transcript(whale)).size - Buffer.byteLength(appended) })
      expect(log[1]).toMatchObject({ resumed: true, readBytes: Buffer.byteLength(appended), files: 2 })
    }, 90_000)
  }
})
