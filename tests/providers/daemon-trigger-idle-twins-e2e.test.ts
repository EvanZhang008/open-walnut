/**
 * A check that says nothing it watches is in flight (`"idle": true`), on the real daemon
 * (trigger-check-core.ts checkIdleOf): the quiet `trigger.checked` event carries `idle`, the host's
 * state file never does (an older daemon's snapshot check would call a field it does not know
 * corrupt), and a fire, a run while an earlier fire waits for its ack, or a run without it carries none.
 *
 *   test (server WS) ◄═trigger.checked {idle}═ daemon ◄═last stdout line═ check (cat of a file)
 *
 * 2026-11-23: a task read Working with its session idle and its Mac queue empty; the queue's result
 * watch now prints idle, and the server stops reading the watch as work going on.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the state dir are temp paths under /tmp (a unix socket
 * path is at most 104 bytes on macOS); the only processes signalled are the daemons this file started.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN: string | undefined = testBun()
const STANDALONE = path.join(ROOT, 'src/providers/daemon-standalone.ts')
let root = ''

interface Daemon { proc: ChildProcess; ws: WebSocket; stateDir: string; events: Array<Record<string, any>> }
let daemon: Daemon | null = null
let rpcId = 1

function rpc(d: { ws: WebSocket }, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, any>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, any>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor<T>(pick: () => T | undefined, ms = 30_000): Promise<T | undefined> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const hit = pick()
    if (hit !== undefined) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return pick()
}

async function boot(): Promise<Daemon> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wti-'))
  const daemonDir = path.join(root, 'd')
  const stateDir = path.join(root, 'ts')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_SESSION_ID: undefined,
    WALNUT_AGENT_SOCKET: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_TRIGGER_STATE_DIR: stateDir,
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(b.toString()))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const events: Array<Record<string, any>> = []
  ws.on('message', (data: Buffer) => {
    let m: Record<string, any>
    try { m = JSON.parse(data.toString()) } catch { return }
    if (m.ev === 'trigger.checked' || m.ev === 'trigger.fired') events.push(m)
  })
  await rpc({ ws }, { cmd: 'hello', run: 'trigger-idle-test' })
  daemon = { proc, ws, stateDir, events }
  return daemon
}

afterEach(async () => {
  if (daemon) {
    try { daemon.ws.close() } catch { /* closed */ }
    if (daemon.proc.exitCode === null) {
      daemon.proc.kill('SIGKILL')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); daemon!.proc.once('exit', () => { clearTimeout(t); resolve() }) })
    }
  }
  daemon = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

const ID = 'trg-own-1'

describe.skipIf(!BUN)('an idle check, standalone daemon (bun)', () => {
  it('a quiet idle run says so on the event only; a fire and a run without it say nothing', async () => {
    const d = await boot()
    const out = path.join(root, 'out.json')
    fs.writeFileSync(out, '{"fire": false, "idle": true}')
    const configured = await rpc(d, {
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: ID, name: 'Mac queue results', everyMs: 3_600_000, check: { run: `cat '${out}'`, timeoutSeconds: 30 } }] },
    })
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    // Quiet for a moment: a run the arm itself started has reported, so the next event is ours.
    const settle = async () => {
      let n = -1
      while (n !== d.events.length) { n = d.events.length; await new Promise((r) => setTimeout(r, 800)) }
    }
    const run = async (line: string, ack = true): Promise<Record<string, any>> => {
      fs.writeFileSync(out, line)
      await settle()
      const from = d.events.length
      await rpc(d, { cmd: 'triggers.run', triggerId: ID }).catch(() => undefined)
      const ev = await waitFor(() => d.events.slice(from).find((e) => e.id === ID && !e.replay))
      expect(ev, `no event after triggers.run; events: ${JSON.stringify(d.events)}`).toBeDefined()
      if (ev!.ev === 'trigger.fired' && ack) await rpc(d, { cmd: 'triggers.ack', triggerId: ID, seq: ev!.seq })
      return ev!
    }

    expect(await run('{"fire": false, "idle": true}')).toMatchObject({ ev: 'trigger.checked', outcome: 'quiet', reason: 'fire-false', idle: true })
    const file = JSON.parse(fs.readFileSync(path.join(d.stateDir, fs.readdirSync(d.stateDir).find((f) => f.endsWith('.json'))!), 'utf8'))
    expect(file.lastCheck).toMatchObject({ outcome: 'quiet' })
    expect(JSON.stringify(file)).not.toContain('"idle"')

    // Work in flight: no idle.
    expect((await run('{"fire": false}')).idle).toBeUndefined()

    // A result: it fires (news, never idle). Until the server acks it, its wake is owed: the same
    // result again is all-seen but not idle; once acked, it is.
    const line = '{"fire": true, "items": [{"id": "r1"}], "idle": true}'
    const fired = await run(line, false)
    expect(fired.ev).toBe('trigger.fired')
    expect(fired.idle).toBeUndefined()
    const owed = await run(line)
    expect(owed).toMatchObject({ ev: 'trigger.checked', reason: 'all-seen' })
    expect(owed.idle).toBeUndefined()
    await rpc(d, { cmd: 'triggers.ack', triggerId: ID, seq: fired.seq })
    expect(await run(line)).toMatchObject({ ev: 'trigger.checked', reason: 'all-seen', idle: true })

    // A wrong value is dropped with a warning, never a failed run.
    const wrong = await run('{"fire": false, "idle": "yes"}')
    expect(wrong).toMatchObject({ ev: 'trigger.checked', outcome: 'quiet' })
    expect(wrong.idle).toBeUndefined()
    expect(JSON.stringify(wrong.warnings ?? [])).toContain('idle')
  }, 120_000)
})
