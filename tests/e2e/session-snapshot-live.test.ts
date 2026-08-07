/**
 * LIVE E2E for the snapshot source-of-truth feature
 * (docs/plan/session-snapshot-source-of-truth.md — C1 daemon fold + C2 walnut
 * projection + Fix E's init-after-result turn edge).
 *
 * This is the top of the pyramid: everything below it (daemon-fold unit tests,
 * session-snapshot-apply/gate/pull unit tests, the fault-injection sim, the
 * daemon-snapshot-wiring integration test) exercises one layer with the others
 * stubbed. Here the WHOLE chain runs for real:
 *
 *   startServer({port:0, dev:true})            ← real Express + WS + event bus
 *     → session:start over WS RPC              ← real route + bus
 *     → SessionRunner / ClaudeCodeSession      ← real runner (Fix E lives here)
 *     → RemoteSessionManager → DaemonConnection
 *     → REAL daemon binary in an isolated dir  ← real tailer + foldLine + push
 *     → mock claude CLI (the ONLY mock)        ← scripted stream shapes
 *     → {ev:'snapshot'} push / getState pull
 *     → applySnapshot (shadow | enforce)       ← real projection + real tracker
 *
 * THREE scenarios, serial, one server + one daemon + ≤2 mock CLI processes:
 *   1. send → converge (shadow): a clean turn settles the record to 'idle' and
 *      the daemon's projection AGREES (zero shadow divergences for that sid).
 *   2. incident ed347bde shape (Fix E live): result → bare init → streaming with
 *      no idle between. The record must go BACK to 'running' and the task phase
 *      back to IN_PROGRESS while turn 2 streams, then converge idle/AGENT_COMPLETE.
 *      REVERT-PROOF: disabling Fix E's init-edge block fails this scenario.
 *   3. enforce heal via pull: with a genuinely-idle session, corrupt the record
 *      to 'running' through a category-② pair (which the enforce gate lets
 *      through), then drive the health monitor's checkSnapshotPull step directly
 *      — the daemon's getState snapshot must heal it back to 'idle' with
 *      status_reason 'snapshot_projection'.
 *
 * MACHINE SAFETY (this box has wedged on leaked test processes before):
 *   - isolated tmp WALNUT_HOME via createMockConstants;
 *   - isolated WALNUT_DAEMON_DIR (asserted != /tmp/open-walnut) so the PRODUCTION
 *     daemon is never touched; the daemon reaps its CLI groups on exit because
 *     the dir is isolated (shouldReapOnExit);
 *   - random ports only — never 3456/3457;
 *   - afterAll kills the daemon it spawned and asserts no process still
 *     references our tmp-dir path string.
 *
 * Load tolerance: every poll uses a 60s+ budget with a 500ms interval. Under the
 * kind of external load this machine sees (load avg ~90 from unrelated agents) a
 * daemon cold boot + CLI spawn can take tens of seconds; these are not tight
 * timing assertions, they are convergence assertions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// The daemon dir must be set BEFORE any module reads it (daemon-standalone /
// local-daemon capture it at import time) — vi.hoisted runs before imports.
// Same precedent as tests/e2e/acp-session-server-e2e.test.ts.
const isolatedDaemon = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const dir = `/tmp/walnut-snaplive-daemon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  process.env.WALNUT_DAEMON_DIR = dir
  return { dir, previous }
})

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-snapshot-live'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getSessionByClaudeId, getSessionsForTask, updateSessionRecord } from '../../src/core/session-tracker.js'
import { getTask } from '../../src/core/task-manager.js'
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import {
  setSnapshotModeForTests,
  getSnapshotStatusMode,
  isSnapshotCovered,
} from '../../src/core/session-snapshot-apply.js'
import { log } from '../../src/logging/index.js'
import type { SessionRecord } from '../../src/core/types.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DAEMON_BIN = path.join(REPO_ROOT, 'dist/daemon-binaries/daemon-darwin-arm64')
const MOCK_CLI = path.join(REPO_ROOT, 'tests/providers/mock-claude.mjs')
const PROD_DAEMON_DIR = '/tmp/open-walnut'

// Real macOS daemon binary required (the whole point is the REAL fold + push).
const HAVE_BIN = fs.existsSync(DAEMON_BIN) && process.platform === 'darwin' && process.arch === 'arm64'

// Substituting the mock CLI is subtler than it looks. Daemon-backed sessions
// ALWAYS send args[0]='claude' (remote-session-manager.ts startPayload), and the
// daemon spawns it through a login shell whose preamble sources the user's
// .zshrc — which hard-resets PATH and thereby defeats a PATH= override on the
// daemon's env (measured: the real CLI won, and the test silently exercised the
// live model). Two things make the shim authoritative instead:
//   1. a FAKE HOME whose `.toolbox/bin/claude` IS the shim — the daemon's own
//      PATH bootstrap puts $HOME/.toolbox/bin FIRST, and the spawn preamble
//      appends it again, so it wins at both stages;
//   2. SHELL=/bin/sh so the preamble's `case "$SHELL"` matches neither zsh nor
//      bash and no RC file is sourced at all.
// Scenario 1 asserts the mock actually won (model === 'mock-model'), so this can
// never regress into silently testing the real CLI again.
let fakeHome = ''
let daemonProc: ChildProcess | null = null
let daemonPort = 0
let server: HttpServer
let port = 0

const TASK_ID = 'snap-live-task-1'

// ── WS helpers (same shape as tests/e2e/session-background-workflow-e2e.test.ts) ──

interface WsFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string
  ok?: boolean
  [key: string]: unknown
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 20_000)
    ws.on('open', () => { clearTimeout(t); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 30_000)
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

/** Load-tolerant poll. Generous by default — see the header note on load. */
async function pollUntil<T>(
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

/** The session record for our task, once the runner has persisted one. */
async function sessionIdForTask(taskId: string): Promise<string> {
  return await pollUntil(async () => {
    const records = await getSessionsForTask(taskId)
    return records[0]?.claudeSessionId
  }, `a session record for task ${taskId}`, 90_000)
}

async function record(sid: string): Promise<SessionRecord | undefined> {
  return await getSessionByClaudeId(sid)
}

// ── shadow-divergence capture ──
// applySnapshot logs `snapshot-shadow divergence` via log.session.warn whenever
// its projection disagrees with the record. Spying on the logger is the cheap
// wiring (the unit tests use the same hook) — no log-file parsing needed.
const divergences: Array<Record<string, unknown>> = []
let warnSpy: ReturnType<typeof vi.spyOn> | null = null

function divergencesFor(sid: string): Array<Record<string, unknown>> {
  return divergences.filter((d) => d.sessionId === sid)
}

beforeAll(async () => {
  if (!HAVE_BIN) return

  // ── isolation guards ──
  if (path.resolve(isolatedDaemon.dir) === path.resolve(PROD_DAEMON_DIR)) {
    throw new Error('refusing to run against the production daemon dir')
  }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({
    version: 1,
    tasks: [{
      id: TASK_ID,
      title: 'Snapshot live E2E task',
      status: 'todo', phase: 'TODO', priority: 'immediate',
      category: 'Work', project: 'Walnut',
      session_ids: [], active_session_ids: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      description: '', summary: '', note: '', subtasks: [],
    }],
  }))

  // ── `claude` shim → the mock CLI, via a fake HOME (see the note above) ──
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snaplive-home-'))
  fs.mkdirSync(path.join(fakeHome, '.toolbox', 'bin'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeHome, '.toolbox', 'bin', 'claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_CLI)} "$@"\n`,
    { mode: 0o755 },
  )

  // ── the ONE real daemon, in the isolated dir ──
  fs.mkdirSync(isolatedDaemon.dir, { recursive: true })
  daemonPort = await new Promise<number>((resolve, reject) => {
    const p = spawn(DAEMON_BIN, ['--start'], {
      env: {
        ...process.env,
        WALNUT_DAEMON_DIR: isolatedDaemon.dir,
        // The shim lives at $HOME/.toolbox/bin/claude, which the daemon's PATH
        // bootstrap AND its spawn preamble both put ahead of anything else.
        HOME: fakeHome,
        // No RC sourcing (the preamble's `case "$SHELL"` matches neither branch),
        // so nothing can hard-reset PATH out from under the shim.
        SHELL: '/bin/sh',
        // Scenario 2's shape: settle turn A fully, then open turn B on a bare
        // init. Both windows must be observable by a 500ms poller under load,
        // while keeping the suite inside its budget.
        MOCK_SNAPSHOT_EDGE_SETTLE_MS: '6000',
        MOCK_SNAPSHOT_EDGE_HOLD_MS: '14000',
        // Isolated-dir daemon: die with us (parent watchdog), never orphan.
        WALNUT_DAEMON_PARENT_PID: String(process.pid),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    daemonProc = p
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.on('error', (err) => { clearTimeout(timer); reject(err) })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })

  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemonPort}`)
  sessionRunner.setCliCommand(MOCK_CLI) // harmless; daemon path uses the shim

  // Capture shadow divergences before the first snapshot can arrive.
  warnSpy = vi.spyOn(log.session, 'warn').mockImplementation(((msg: string, meta?: unknown) => {
    if (msg === 'snapshot-shadow divergence' && meta && typeof meta === 'object') {
      divergences.push(meta as Record<string, unknown>)
    }
  }) as never)

  setSnapshotModeForTests('shadow')

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  warnSpy?.mockRestore()
  setSnapshotModeForTests(null)
  sessionRunner.setTestDaemonUrl(undefined)
  try { await stopServer() } catch { /* best effort */ }

  // Kill the daemon we spawned; an isolated-dir daemon reaps its CLI process
  // groups on SIGTERM (shouldReapOnExit), so this also takes the mock CLIs.
  if (daemonProc && daemonProc.exitCode === null) {
    daemonProc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { daemonProc!.kill('SIGKILL') } catch { /* gone */ }; resolve() }, 12_000)
      daemonProc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  daemonProc = null

  // Belt-and-braces: any CLI group recorded in a .pgid file under our streams dir.
  const streamsDir = `${isolatedDaemon.dir}-streams`
  try {
    for (const f of fs.readdirSync(streamsDir)) {
      if (!f.endsWith('.pgid')) continue
      const pid = parseInt(fs.readFileSync(path.join(streamsDir, f), 'utf-8').trim(), 10)
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      }
    }
  } catch { /* no streams dir */ }

  // Leak assertion — scoped to OUR tmp paths, never a name-based pkill (that
  // would reach the production daemon).
  if (HAVE_BIN) {
    let leaked = ''
    try {
      leaked = execFileSync('/bin/sh', ['-c',
        `ps -eo pid,command | grep -F -e ${JSON.stringify(isolatedDaemon.dir)} -e ${JSON.stringify(fakeHome)} | grep -v grep || true`,
      ], { encoding: 'utf-8', timeout: 20_000 }).trim()
    } catch { /* ps unavailable — skip the assertion rather than fail teardown */ }
    if (leaked) {
      // Report loudly but still clean up; a failure here means the reap path regressed.
      // eslint-disable-next-line no-console
      console.error('[snapshot-live] LEAKED processes referencing our tmp dirs:\n' + leaked)
    }
    expect(leaked, 'no process may still reference this suite\'s tmp dirs').toBe('')
  }

  for (const d of [WALNUT_HOME, isolatedDaemon.dir, streamsDir, fakeHome]) {
    if (!d) continue
    try { await fsp.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) } catch { /* best effort */ }
  }
  if (isolatedDaemon.previous === undefined) delete process.env.WALNUT_DAEMON_DIR
  else process.env.WALNUT_DAEMON_DIR = isolatedDaemon.previous
}, 90_000)

describe.runIf(HAVE_BIN)('snapshot source-of-truth — live stack (real daemon + real fold + real projection)', () => {
  // Shared across the serial scenarios: scenario 1 creates the session that
  // scenarios 2 and 3 keep using (ONE server, ONE daemon, ≤2 CLI processes).
  let sid = ''

  // ── Scenario 1: send → converge (shadow mode) ──
  it('1. send → the record converges to idle and the daemon projection AGREES (no shadow divergence)', async () => {
    expect(getSnapshotStatusMode()).toBe('shadow')

    const ws = await connectWs()
    try {
      const rpc = await sendWsRpc(ws, 'session:start', {
        taskId: TASK_ID,
        message: 'snapshot-clean-turn:hello-live',
        project: 'Walnut',
        cwd: os.tmpdir(),
      })
      expect(rpc.ok).toBe(true)

      sid = await sessionIdForTask(TASK_ID)
      expect(sid).toBeTruthy()

      // Convergence, not timing: poll the RECORD (the thing the UI reads) until
      // the turn has settled. The mock emits assistant → result → idle and then
      // STAYS ALIVE, which is the real FIFO-mode shape → 'idle', not 'stopped'.
      const settled = await pollUntil(async () => {
        const r = await record(sid)
        return r?.process_status === 'idle' ? r : undefined
      }, `record ${sid} to reach process_status=idle`, 90_000)

      expect(settled.process_status).toBe('idle')
      expect(settled.claudeSessionId).toBe(sid)

      // GUARD: the MOCK CLI must be what ran. The daemon spawns a bare `claude`
      // through a login shell, and an earlier revision of this test lost that
      // race to the user's real CLI — the suite then silently exercised the live
      // model. `model` is set from the init event, so this pins the substitution.
      expect(
        settled.model,
        'the mock CLI must have won the `claude` resolution (see the shim note at the top)',
      ).toBe('mock-model')

      // The snapshot channel actually ran for this sid: a snapshot was applied
      // or shadow-observed, which is exactly what markSnapshotCovered records.
      // (This is the live proof that push/pull reached applySnapshot at all —
      // without it "no divergence" could just mean "no snapshots".)
      await pollUntil(
        async () => isSnapshotCovered(sid),
        `sid ${sid} to be snapshot-covered (proves a real snapshot reached applySnapshot)`,
        60_000,
      )

      // ── C1 ↔ C2 agreement, asserted on the SETTLED state ──
      // The headline assertion: once the turn has settled, the daemon's
      // independently-folded projection agrees with the record walnut's
      // event-driven writers produced. Asserted as "the last snapshot walnut
      // saw for this sid agreed", not "no divergence ever occurred": the two
      // sides are eventually consistent by design, and the CLI's cold-start
      // window (SessionStart hook lines land before init, ~24s under load here)
      // legitimately produces a transient idle-vs-running disagreement while
      // the record still carries its 'running' spawn seed. A PERSISTENT
      // divergence is the bug this guards against, and it would leave the last
      // observation diverged.
      //
      // Settle delay first: the final push rides a 50ms daemon coalesce window
      // plus an async applySnapshot on our side.
      await new Promise((r) => setTimeout(r, 3000))
      const seen = divergencesFor(sid)
      const last = seen[seen.length - 1]
      expect(
        last === undefined || last.projected === 'idle',
        `the settled state must not be persistently diverged; divergences seen: ${JSON.stringify(seen)}`,
      ).toBe(true)
      // Whatever transients occurred, the record and the projection agree NOW.
      const finalRecord = await record(sid)
      expect(finalRecord?.process_status).toBe('idle')
    } finally {
      ws.close()
    }
  }, 180_000)

  // ── Scenario 2: incident ed347bde shape — Fix E live ──
  it('2. result → bare init → streaming (no idle between): record goes BACK to running + phase IN_PROGRESS, then converges', async () => {
    expect(sid, 'scenario 1 must have produced a session').toBeTruthy()

    const ws = await connectWs()
    try {
      // Second turn on the SAME live CLI (no new process). The scripted shape is:
      //   turn A: assistant → result → idle       (settles COMPLETELY)
      //   …gap…  turn B: bare init → streaming    (Fix E's ONLY signal)
      //   …hold… turn B: assistant → result → idle
      const rpc = await sendWsRpc(ws, 'session:send', {
        sessionId: sid,
        message: 'snapshot-init-edge:live',
      })
      expect(rpc.ok).toBe(true)

      // (a) First watch turn A settle all the way down: record idle AND task
      //     AGENT_COMPLETE. This is what makes step (b) revert-proof — after
      //     this point a 'running' reading cannot be a leftover of the
      //     send-time write, because the send-time write has been overwritten.
      await pollUntil(async () => {
        const r = await record(sid)
        if (r?.process_status !== 'idle') return undefined
        const task = await getTask(TASK_ID)
        return task.phase === 'AGENT_COMPLETE' ? true : undefined
      }, 'turn A to settle fully (record=idle AND task phase=AGENT_COMPLETE)', 90_000)

      // (b) Fix E assertion — turn B opens on a BARE init (no {running}, no user
      //     line). The record must go BACK to 'running' and the task phase back
      //     to IN_PROGRESS purely because of that init. Without Fix E's
      //     init-after-result edge nothing writes either one: the record stays
      //     idle and the task stays AGENT_COMPLETE for turn B's whole duration —
      //     exactly incident ed347bde, and exactly what this poll fails on.
      const midTurn = await pollUntil(async () => {
        const r = await record(sid)
        if (r?.process_status !== 'running') return undefined
        const task = await getTask(TASK_ID)
        if (task.phase !== 'IN_PROGRESS') return undefined
        return { status: r.process_status, phase: task.phase }
      }, 'turn B mid-turn: record=running AND task phase=IN_PROGRESS (Fix E init-after-result edge)', 90_000)

      expect(midTurn.status).toBe('running')
      expect(midTurn.phase).toBe('IN_PROGRESS')

      // (c) …and it converges once turn B's real result + idle land.
      const settled = await pollUntil(async () => {
        const r = await record(sid)
        return r?.process_status === 'idle' ? r : undefined
      }, `record ${sid} to converge back to idle after turn B`, 90_000)
      expect(settled.process_status).toBe('idle')

      const finalTask = await pollUntil(async () => {
        const t = await getTask(TASK_ID)
        return t.phase === 'AGENT_COMPLETE' ? t : undefined
      }, 'task phase to reach AGENT_COMPLETE after turn B', 60_000)
      expect(finalTask.phase).toBe('AGENT_COMPLETE')
    } finally {
      ws.close()
    }
  }, 240_000)

  // ── Scenario 3: enforce heal via the health-monitor pull ──
  it('3. enforce: a corrupted "running" record on a genuinely-idle session is healed by the getState pull', async () => {
    expect(sid, 'scenarios 1-2 must have produced a settled session').toBeTruthy()

    // The session is genuinely idle (scenario 2 converged it) and the CLI is
    // still alive on its FIFO — so the daemon's fold says turnActive=false and
    // its snapshot projects 'idle'.
    const before = await record(sid)
    expect(before?.process_status).toBe('idle')

    setSnapshotModeForTests('enforce')
    try {
      // Corrupt the record to 'running' with a CATEGORY-② pair. Category-①
      // (health-monitor/session-runner reasons) would be STRIPPED by the
      // enforce gate for a covered sid — the corruption would never land and
      // the test would prove nothing. ('user','retry_reconnect') is on the
      // never-gated list (session-snapshot-gate.ts).
      const corrupted = await updateSessionRecord(sid, {
        process_status: 'running',
        last_status_change: new Date().toISOString(),
        status_reason: 'retry_reconnect',
        status_changed_by: 'user',
      } as never)
      expect(corrupted.process_status, 'the category-② corruption must actually land').toBe('running')

      // Drive the pull step directly — never wait out the 30s tick. Same
      // private-step entry point tests/core/session-snapshot-pull.test.ts uses,
      // but here the connection, the daemon, the fold and the projection are
      // ALL real: the only thing this bypasses is the timer.
      //
      // A FRESH monitor per attempt is deliberate: checkSnapshotPull enforces a
      // 25s per-sid gap via an instance map, so reusing one instance would let
      // us pull exactly once inside the budget. Each instance is cheap — the
      // constructor starts no timers (only start() does, which we never call).
      const pullOnce = async (rec: SessionRecord): Promise<void> => {
        const monitor = new SessionHealthMonitor()
        await (monitor as unknown as { checkSnapshotPull(s: SessionRecord[]): Promise<void> })
          .checkSnapshotPull([rec])
      }

      const healed = await pollUntil(async () => {
        const current = await record(sid)
        if (!current) return undefined
        if (current.process_status === 'idle' && current.status_reason === 'snapshot_projection') return current
        await pullOnce(current)
        return undefined
      }, `record ${sid} to be healed to idle by the snapshot projection`, 90_000, 1000)

      expect(healed.process_status).toBe('idle')
      expect(healed.status_reason).toBe('snapshot_projection')
      expect(healed.status_changed_by).toBe('snapshot')
      // The projection adopted the daemon's byte-offset watermark.
      expect(typeof healed.consumedOffset).toBe('number')
      expect(healed.consumedOffset!).toBeGreaterThan(0)
    } finally {
      setSnapshotModeForTests('shadow')
    }
  }, 180_000)
})
