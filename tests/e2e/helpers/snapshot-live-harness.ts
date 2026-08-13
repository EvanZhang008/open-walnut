/**
 * Shared harness for the LIVE snapshot E2E suites
 * (tests/e2e/session-snapshot-live.test.ts — behaviour scenarios;
 *  tests/e2e/session-snapshot-stress.test.ts — bounded stress scenarios).
 *
 * Everything here is a faithful extraction of the primitives the live suite
 * established: the fake-HOME `claude` shim that makes the daemon spawn the mock
 * CLI, an isolated real-daemon spawn, load-tolerant polling, and a teardown that
 * reaps + leak-scans by tmp-path (never by process name — a name-based pkill
 * would reach the PRODUCTION daemon).
 *
 * Deliberately parameterised, never importing `src/constants.js`: each suite
 * vi.mock()s constants with its own tmp WALNUT_HOME, and a shared module that
 * imported the real constants would break that isolation.
 *
 * MACHINE SAFETY invariants every caller inherits:
 *   - assertIsolatedDaemonDir() refuses the production daemon dir (/tmp/open-walnut);
 *   - the spawned daemon carries WALNUT_DAEMON_PARENT_PID so it dies with the test;
 *   - an isolated-dir daemon reaps its CLI process groups on SIGTERM, and
 *     teardownDaemon() additionally sweeps every `.pgid` under the streams dir;
 *   - scanForLeaks() greps ONLY for this suite's tmp path strings.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'

export const PROD_DAEMON_DIR = '/tmp/open-walnut'
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
export const DAEMON_BIN = path.join(REPO_ROOT, 'dist/daemon-binaries/daemon-darwin-arm64')
export const MOCK_CLI = path.join(REPO_ROOT, 'tests/providers/mock-claude.mjs')

/** The real macOS daemon binary is required — the point is the REAL fold + push. */
export function haveDaemonBinary(): boolean {
  return fs.existsSync(DAEMON_BIN) && process.platform === 'darwin' && process.arch === 'arm64'
}

/** The daemon derives its streams dir from the daemon dir (WALNUT_STREAMS_DIR unset). */
export function streamsDirFor(daemonDir: string): string {
  return `${daemonDir}-streams`
}

export function assertIsolatedDaemonDir(dir: string): void {
  if (path.resolve(dir) === path.resolve(PROD_DAEMON_DIR)) {
    throw new Error('refusing to run against the production daemon dir')
  }
}

// ── WS RPC against the walnut server (same shape as the session E2E suites) ──

export interface WsFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string
  ok?: boolean
  [key: string]: unknown
}

export function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 20_000)
    ws.on('open', () => { clearTimeout(t); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

export function sendWsRpc(ws: WebSocket, method: string, payload: unknown, timeoutMs = 30_000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      let frame: WsFrame
      try { frame = JSON.parse(raw.toString()) as WsFrame } catch { return }
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

// ── Direct daemon RPC (no auth on the daemon socket; localhost only) ──

export function connectDaemonWs(daemonPort: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
    const t = setTimeout(() => reject(new Error('daemon ws connect timeout')), 15_000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let daemonRpcId = 1

/** One request/response round-trip on the daemon's numeric-id protocol. */
export function daemonRpc(
  ws: WebSocket,
  cmd: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const id = daemonRpcId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`daemon rpc timeout: ${cmd.cmd}`)) }, timeoutMs)
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', onMsg); resolve(msg) }
      } catch { /* not our frame */ }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/**
 * Load-tolerant poll. Generous by default: under the external load this box
 * sees, a daemon cold boot + CLI spawn can take tens of seconds. These are
 * convergence assertions, never timing assertions.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 90_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as T
      last = v
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout after ${timeoutMs}ms waiting for ${what} (last: ${JSON.stringify(last)})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ── The `claude` shim ────────────────────────────────────────────────────────
// Substituting the mock CLI is subtler than it looks. Daemon-backed sessions
// ALWAYS send args[0]='claude' (remote-session-manager startPayload), and the
// daemon spawns it through a login shell whose preamble sources the user's
// .zshrc — which hard-resets PATH and thereby defeats a PATH= override on the
// daemon's env (measured: the real CLI won, and the suite silently exercised the
// live model). Two things make the shim authoritative instead:
//   1. a FAKE HOME whose `.toolbox/bin/claude` IS the shim — the daemon's own
//      PATH bootstrap puts $HOME/.toolbox/bin FIRST, and the spawn preamble
//      appends it again, so it wins at both stages;
//   2. SHELL=/bin/sh so the preamble's `case "$SHELL"` matches neither zsh nor
//      bash and no RC file is sourced at all.
// Suites MUST assert the mock actually won (record.model === 'mock-model'), so
// this can never regress into silently testing the real CLI.

/** Create a throwaway HOME containing `.toolbox/bin/claude` → the mock CLI. */
export function createFakeHomeWithClaudeShim(prefix: string): string {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(fakeHome, '.toolbox', 'bin'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeHome, '.toolbox', 'bin', 'claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_CLI)} "$@"\n`,
    { mode: 0o755 },
  )
  return fakeHome
}

// ── The ONE real daemon, isolated ────────────────────────────────────────────

export interface SpawnedDaemon {
  proc: ChildProcess
  port: number
}

/**
 * Spawn the real daemon binary in an isolated dir with the shim HOME.
 * `extraEnv` carries per-suite mock knobs (MOCK_SNAPSHOT_* etc).
 */
export async function spawnIsolatedDaemon(opts: {
  daemonDir: string
  fakeHome: string
  extraEnv?: Record<string, string>
  timeoutMs?: number
}): Promise<SpawnedDaemon> {
  assertIsolatedDaemonDir(opts.daemonDir)
  fs.mkdirSync(opts.daemonDir, { recursive: true })
  let proc: ChildProcess | null = null
  const port = await new Promise<number>((resolve, reject) => {
    const p = spawn(DAEMON_BIN, ['--start'], {
      env: {
        ...process.env,
        WALNUT_DAEMON_DIR: opts.daemonDir,
        // The shim lives at $HOME/.toolbox/bin/claude, which the daemon's PATH
        // bootstrap AND its spawn preamble both put ahead of anything else.
        HOME: opts.fakeHome,
        // No RC sourcing, so nothing can hard-reset PATH out from under the shim.
        SHELL: '/bin/sh',
        // Isolated-dir daemon: die with us (parent watchdog), never orphan.
        WALNUT_DAEMON_PARENT_PID: String(process.pid),
        ...(opts.extraEnv ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    proc = p
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), opts.timeoutMs ?? 60_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.on('error', (err) => { clearTimeout(timer); reject(err) })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return { proc: proc as unknown as ChildProcess, port }
}

/**
 * Kill the daemon we spawned, then sweep any CLI process group still recorded
 * in a `.pgid` file under the streams dir. An isolated-dir daemon already reaps
 * its groups on SIGTERM (shouldReapOnExit); the sweep is belt-and-braces for the
 * case where that path regressed or the daemon was already dead.
 */
export async function teardownDaemon(opts: {
  proc: ChildProcess | null
  streamsDir: string
  graceMs?: number
}): Promise<void> {
  const { proc } = opts
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ }; resolve() }, opts.graceMs ?? 12_000)
      proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  try {
    for (const f of fs.readdirSync(opts.streamsDir)) {
      if (!f.endsWith('.pgid')) continue
      const pid = parseInt(fs.readFileSync(path.join(opts.streamsDir, f), 'utf-8').trim(), 10)
      if (pid > 1) {
        try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      }
    }
  } catch { /* no streams dir */ }
}

/**
 * Any process still referencing one of OUR tmp path strings. Returns '' when
 * clean. Scoped to the given paths on purpose — never a name-based pkill.
 */
export function scanForLeaks(paths: string[]): string {
  const args = paths.filter(Boolean).map((p) => `-e ${JSON.stringify(p)}`).join(' ')
  if (!args) return ''
  try {
    return execFileSync('/bin/sh', ['-c',
      `ps -eo pid,command | grep -F ${args} | grep -v grep || true`,
    ], { encoding: 'utf-8', timeout: 20_000 }).trim()
  } catch {
    // ps unavailable — report clean rather than failing teardown.
    return ''
  }
}

export async function removeDirs(dirs: Array<string | undefined | null>): Promise<void> {
  for (const d of dirs) {
    if (!d) continue
    try { await fsp.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) } catch { /* best effort */ }
  }
}

// ── Task seeding ─────────────────────────────────────────────────────────────

export interface SeedTaskSpec {
  id: string
  title: string
  category?: string
  project?: string
}

/** Write a fresh tasks.json holding exactly these tasks (TODO / immediate). */
export async function seedTasksFile(tasksFile: string, tasks: SeedTaskSpec[]): Promise<void> {
  await fsp.mkdir(path.dirname(tasksFile), { recursive: true })
  const now = new Date().toISOString()
  await fsp.writeFile(tasksFile, JSON.stringify({
    version: 1,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: 'todo', phase: 'TODO', priority: 'immediate',
      category: t.category ?? 'Work', project: t.project ?? 'Walnut',
      session_ids: [], active_session_ids: [],
      created_at: now, updated_at: now,
      description: '', summary: '', note: '', subtasks: [],
    })),
  }))
}

// ── Event-loop lag sampler ───────────────────────────────────────────────────

export interface LagSampler {
  stop: () => void
  samples: number[]
  percentile: (p: number) => number
  max: () => number
}

/**
 * Sample event-loop lag in THIS process: schedule a timer for `intervalMs` and
 * record how late it actually fired. Measures the test process, which shares
 * the box with the server under test — a starved loop here is the same
 * starvation the UI would feel.
 */
export function startLagSampler(intervalMs = 100): LagSampler {
  const samples: number[] = []
  let stopped = false
  let expected = Date.now() + intervalMs
  const tick = (): void => {
    if (stopped) return
    const now = Date.now()
    samples.push(Math.max(0, now - expected))
    expected = now + intervalMs
    const t = setTimeout(tick, intervalMs)
    t.unref?.()
  }
  const first = setTimeout(tick, intervalMs)
  first.unref?.()
  return {
    stop: () => { stopped = true },
    samples,
    percentile: (p: number) => {
      if (samples.length === 0) return 0
      const sorted = [...samples].sort((a, b) => a - b)
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
      return sorted[idx]
    },
    max: () => (samples.length ? Math.max(...samples) : 0),
  }
}
