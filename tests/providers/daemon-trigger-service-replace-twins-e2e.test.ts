/**
 * A service daemon replaced by another binary keeps every trigger's memory, against BOTH real twins.
 *
 * 2026-11-16: right after a dev host's service daemon was replaced by a new build, a pipeline
 * watch's fire read as if it had delivered three old items again. The state had not moved: a
 * `--service` daemon keeps it in its install root (WALNUT_DAEMON_STATE_DIR/trigger-state, a named
 * Walnut's under walnuts/<key>/), not in ~/.open-walnut/tmp or the runtime dir, which is where
 * the search for it looked. This file pins that layout as production runs it (no
 * WALNUT_TRIGGER_STATE_DIR), replaces the daemon with the OTHER twin on the same dirs with an
 * emptied runtime dir, and checks nothing told comes back: not as an item (the seen ids, kept
 * fresh while the script still reports them) and not as a line of the fire's input (a line that
 * names an old item by its title).
 *
 * What's real: the standalone twin under bun, the source twin (getDaemonSource) under node with
 * its sidecars built by bun, a node check script, the state files, the timers. Mocked: nothing.
 * MACHINE SAFETY: every dir is under this file's temp dir, and the test signals only its own
 * children's process groups.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'
import { walnutScopeDir } from '../helpers/walnut-scope-dir.js'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trig-replace-')))
afterAll(() => { if (base.includes('walnut-trig-replace-')) fs.rmSync(base, { recursive: true, force: true }) })

const BIN = path.join(base, 'bin')
if (BUN) {
  fs.mkdirSync(BIN, { recursive: true })
  fs.writeFileSync(path.join(BIN, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
  const sidecars: Array<[string, string]> = [
    ['trigger-check-core', 'trigger-check-sidecar'],
    ...['task-dir-core', 'host-exec-core', 'daemon-cron-runtime', 'daemon-instance-lock'].map((n) => [n, n] as [string, string]),
  ]
  for (const [out, src] of sidecars) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(BIN, `${out}.cjs`),
      path.join(ROOT, `src/providers/${src}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error(`sidecar ${src} build failed: ${built.stderr}`)
  }
}

type Twin = 'standalone' | 'source'
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && typeof child.pid === 'number' && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }
})

async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}

class Daemon {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (reply: Record<string, unknown>) => void>()
  private constructor(readonly child: ChildProcess, private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (waiter) { this.waiters.delete(msg.id as number); waiter(msg) }
    })
  }

  static async start(twin: Twin, env: Record<string, string>, runDir: string, cwd: string): Promise<Daemon> {
    const [cmd, args] = twin === 'standalone'
      ? [BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--service']]
      : [SOURCE_TWIN.file, [path.join(BIN, 'daemon.cjs'), '--service']]
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore' })
    children.push(child)
    const portFile = path.join(runDir, 'daemon.port')
    const pidFile = path.join(runDir, 'daemon.pid')
    await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) === child.pid && fs.existsSync(portFile) ? true : undefined } catch { return undefined }
    }, 60_000, `the ${twin} daemon to serve`)
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10)
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
    return new Daemon(child, ws)
  }

  rpc(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiters.set(id, resolve)
      this.ws.send(JSON.stringify({ id, ...frame }))
    })
  }

  fires(id: string) { return [...new Map(this.events.filter((e) => e.ev === 'trigger.fired' && e.id === id).map((e) => [`${e.epoch}:${e.seq}`, e])).values()] }
  checks(id: string) { return this.events.filter((e) => e.ev === 'trigger.checked' && e.id === id) }

  /** Run now and wait for its outcome (the clock's own first run may be in flight). */
  async runOnce(id: string, home: string): Promise<void> {
    for (;;) {
      const before = this.checks(id).length + this.fires(id).length
      const reply = await this.rpc({ cmd: 'triggers.run', triggerId: id, home })
      await waitFor(() => (this.checks(id).length + this.fires(id).length > before ? true : undefined), 20_000, `the ${id} check`)
      if (reply.started === true) return
    }
  }

  async stop(): Promise<void> {
    try { this.ws.close() } catch { /* already gone */ }
    const pid = this.child.pid!
    process.kill(-pid, 'SIGTERM')
    await waitFor(() => (this.child.exitCode !== null || this.child.signalCode !== null ? true : undefined), 30_000, 'the daemon to exit')
  }
}

const itemIds = (fire: Record<string, unknown>) => (fire.items as Array<{ id: string }>).map((i) => i.id)

const ORDERS: Array<[Twin, Twin]> = BUN ? [['standalone', 'source'], ['source', 'standalone']] : []

describe.skipIf(!BUN)('a --service daemon replaced by the other twin', () => {
  it.each(ORDERS)('%s, then %s: seen ids and the script state stay in the install root; nothing told comes back', async (first, second) => {
    const t = fs.mkdtempSync(path.join(base, `${first}-${second}-`))
    const dir = (name: string) => path.join(t, name)
    for (const name of ['h', 'tmp']) fs.mkdirSync(dir(name))
    const HOME = dir('h')
    const RUN_DIR = dir('run')
    const STATE_DIR = dir('install-root')
    const env: Record<string, string> = {
      HOME, PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C',
      WALNUT_DAEMON_DIR: RUN_DIR, WALNUT_DAEMON_STATE_DIR: STATE_DIR, WALNUT_DAEMON_SUPERVISOR: 'cron',
      WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
      WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'), WALNUT_TRIGGER_REPLAY_MS: '1500',
      XDG_STATE_HOME: path.join(HOME, '.local', 'state'), XDG_CONFIG_HOME: path.join(HOME, '.config'),
      XDG_CACHE_HOME: path.join(HOME, '.cache'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
    }
    // The Walnut that pushes the set (a named scope, as every current server is).
    const WALNUT = path.join(HOME, '.open-walnut')
    const FEED = dir('feed.json')
    const CHECK = dir('check.cjs')
    // A watch like the one of the report: every item in the feed is reported on every run, and the
    // input lists each one as "[event] <short id> <title>", never by its item id.
    fs.writeFileSync(CHECK, [
      "const fs = require('fs')",
      "let raw = ''",
      "process.stdin.on('data', (c) => { raw += c }).on('end', () => {",
      "  const input = JSON.parse(raw || '{}')",
      "  const startedAt = (input.state && input.state.startedAt) || Date.now()",
      `  const items = JSON.parse(fs.readFileSync(${JSON.stringify(FEED)}, 'utf8'))`,
      "  const lines = ['Watch summary:'].concat(items.map((it, i) => '[' + it.kind + '] s' + (1000 + i) + ' ' + it.words + ' | since today'))",
      "  console.log(JSON.stringify({ fire: items.length > 0, items: items.map((it) => ({ id: it.id, title: '[' + it.kind + '] ' + it.words })), input: lines.join('\\n'), state: { startedAt } }))",
      '})',
    ].join('\n') + '\n')
    const standing = [
      { id: 'clear|mobile|build|ios|bd2e267f8d@2026-10-21', kind: 'clear', words: 'mobile nightly build on ios failed: signing step timed out' },
      { id: 'clear|docs-site|link-check|main|cffb664e95@2026-11-10', kind: 'clear', words: 'docs-site link check on main: 3 broken links' },
    ]
    fs.writeFileSync(FEED, JSON.stringify(standing))
    const ID = 'build-watch'
    const configure = (d: Daemon) => d.rpc({
      cmd: 'triggers.configure', home: WALNUT,
      config: { version: 1, triggers: [{ id: ID, name: ID, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(CHECK)}` } }] },
    })
    const stateFile = path.join(walnutScopeDir(path.join(STATE_DIR, 'trigger-state'), WALNUT), `${ID}.json`)
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { epoch: string; seq: number; seen: Record<string, number>; state: { startedAt: number } }

    // The old binary reports both standing items once.
    const a = await Daemon.start(first, env, RUN_DIR, HOME)
    expect(await configure(a)).toMatchObject({ ok: true })
    await a.runOnce(ID, WALNUT)
    const [told] = a.fires(ID)
    expect(itemIds(told).sort()).toEqual(standing.map((s) => s.id).sort())
    expect(await a.rpc({ cmd: 'triggers.ack', triggerId: ID, seq: told.seq, home: WALNUT })).toMatchObject({ acked: true })
    expect(fs.existsSync(stateFile), `the memory is in the install root: ${stateFile}`).toBe(true)
    const before = readState()
    // Every copy of it in the whole tree is in the install root (the Walnut's own, and the shared
    // one a downgraded daemon reads): none in the runtime dir, none under HOME.
    const copies = (fs.readdirSync(t, { recursive: true }) as string[]).filter((f) => path.basename(f) === `${ID}.json`).map((f) => path.join(t, f))
    expect(copies).toContain(stateFile)
    for (const c of copies) expect(c.startsWith(path.join(STATE_DIR, 'trigger-state') + path.sep), `${c} is in the install root`).toBe(true)

    // The replace: the old binary stops, the runtime dir goes with it, the other twin starts.
    await a.stop()
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    const b = await Daemon.start(second, env, RUN_DIR, HOME)
    expect(await configure(b)).toMatchObject({ ok: true, count: 1 })

    // The same standing items: quiet, and their stamps follow this run.
    await b.runOnce(ID, WALNUT)
    expect(b.checks(ID).at(-1), 'nothing told is told again').toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    expect(b.fires(ID)).toHaveLength(0)
    const after = readState()
    expect(after.epoch, 'the same memory, not a fresh one').toBe(before.epoch)
    expect(after.seq).toBe(before.seq)
    expect(after.state.startedAt, 'the script state came along').toBe(before.state.startedAt)
    for (const s of standing) expect(after.seen[s.id], `${s.id} stamped by the run that still reports it`).toBeGreaterThan(before.seen[s.id])

    // One new item beside them: the fire carries it, and the input says nothing about the old two.
    const fresh = { id: 'change|web-app|build|linux|5d8173204c', kind: 'change', words: 'web-app nightly build on linux failed: unit tests' }
    fs.writeFileSync(FEED, JSON.stringify([fresh, ...standing]))
    await b.runOnce(ID, WALNUT)
    const [next] = b.fires(ID)
    expect(itemIds(next)).toEqual([fresh.id])
    expect(next.epoch).toBe(before.epoch)
    expect(next.seq).toBe(before.seq + 1)
    expect(next.input).toBe(`Watch summary:\n[change] s1000 ${fresh.words} | since today`)
    expect(await b.rpc({ cmd: 'triggers.ack', triggerId: ID, seq: next.seq, home: WALNUT })).toMatchObject({ acked: true })
    await b.stop()
  }, 240_000)
})
