/**
 * Live-matrix harness — thin HTTP client over a REAL Walnut server.
 *
 * No mocks: every call here goes through the same REST/WS surface the web UI
 * and iOS app use. The server under test is an EPHEMERAL one started by the
 * matrix (never prod :3456), so stress scenarios (worker kills, floods) can't
 * hurt live sessions.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

export interface LiveServer {
  base: string
  port: number
  /** Live process handle — replaced transparently if the supervisor respawns. */
  proc: ChildProcess
  dataDir: string
  stop: () => Promise<void>
}

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../..')

/** Start an isolated ephemeral Walnut server (random port, temp data dir). */
export async function startLiveServer(): Promise<LiveServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-matrix-'))
  const port = 3900 + Math.floor(Math.random() * 500)
  // Scrub ambient AWS credentials: an agent shell often exports
  // AWS_BEARER_TOKEN_BEDROCK / AWS_ACCESS_KEY_ID etc., and a spawned codex
  // worker prefers those over its own ~/.codex auth chain — a stale token
  // then 401s every turn (2026-08-12 matrix run: M2+ all failed on
  // bedrock-mantle 401 while prod, launched from a clean shell, was fine).
  // Same reason scripts/walnut-sandbox.sh uses env -i.
  const env: Record<string, string | undefined> = {
    ...process.env,
    WALNUT_HOME: dataDir,
    WALNUT_DAEMON_DIR: path.join(dataDir, 'daemon'),
    WALNUT_DISABLE_CRON: '1',
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('AWS_')) delete env[k]
  }
  // Keep server output on disk — when a scenario kills the server (a real
  // finding), the log is the only evidence of why.
  const serverLog = path.join(dataDir, 'server.log')
  const spawnServer = (): ChildProcess => {
    const logFd = fs.openSync(serverLog, 'a')
    return spawn('node', [path.join(REPO_ROOT, 'dist/cli.js'), 'web', '--port', String(port)], {
      env,
      stdio: ['ignore', logFd, logFd],
    })
  }
  // Supervise: machine-wide sweepers (concurrent dev-prod deploys, cleanup
  // jobs) have repeatedly SIGKILLed matrix servers mid-run (2026-08-15: two
  // runs lost at :4105/:4192). Respawn on the SAME port + data dir — session
  // records and ACP journals live in WALNUT_HOME/WALNUT_DAEMON_DIR, so
  // sessions lazy-resume exactly like a real server restart. Tests assert on
  // transcript content, so a restart blip slows a scenario, never fakes it.
  let stopping = false
  const handle = { proc: spawnServer() }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    fs.appendFileSync(serverLog, `\n[harness] server exited code=${code} signal=${signal}${stopping ? ' (expected stop)' : ' — respawning'}\n`)
    if (stopping) return
    process.stdout.write(`[matrix] server on :${port} died (signal=${signal}) — respawning\n`)
    handle.proc = spawnServer()
    handle.proc.on('exit', onExit)
  }
  handle.proc.on('exit', onExit)
  const base = `http://localhost:${port}`
  // wait for readiness
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const r = await fetch(`${base}/api/config`)
      if (r.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      stopping = true
      handle.proc.kill('SIGKILL')
      throw new Error('ephemeral server failed to boot in 60s')
    }
    await sleep(500)
  }
  return {
    base, port,
    get proc() { return handle.proc },
    dataDir,
    stop: async () => {
      stopping = true
      handle.proc.kill('SIGTERM')
      await sleep(1500)
      if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL')
      // Preserve the server log for post-mortem before wiping data.
      try {
        const keep = path.join(os.tmpdir(), `wn-matrix-server-${port}.log`)
        fs.copyFileSync(serverLog, keep)
        process.stdout.write(`[matrix] server log kept: ${keep}\n`)
      } catch { /* best-effort */ }
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class MatrixClient {
  constructor(private base: string) {}

  async quickStart(cwd: string, message: string, engine: string): Promise<string> {
    fs.mkdirSync(cwd, { recursive: true })
    const r = await this.post('/api/sessions/quick-start', { cwd, message, engine, project: '' })
    return (r as { taskId: string }).taskId
  }

  /** Latest session id on a task (ACP sessions migrate ids across resumes). */
  async sidOf(taskId: string): Promise<string | undefined> {
    const d = await this.get(`/api/tasks/${taskId}`) as { task?: { session_ids?: string[] } } & { session_ids?: string[] }
    const t = d.task ?? d
    return t.session_ids?.[t.session_ids.length - 1]
  }

  async waitSid(taskId: string, timeoutSec = 60): Promise<string> {
    const deadline = Date.now() + timeoutSec * 1000
    for (;;) {
      const sid = await this.sidOf(taskId).catch(() => undefined)
      if (sid) return sid
      if (Date.now() > deadline) throw new Error(`no session appeared on task ${taskId} in ${timeoutSec}s`)
      await sleep(2000)
    }
  }

  async session(sid: string): Promise<{
    status?: string
    activity?: string
    pending: Array<{ requestId: string }>
    journalPath?: string
    raw: Record<string, unknown>
  }> {
    const d = await this.get(`/api/sessions/${sid}`) as {
      session?: Record<string, unknown>
      pendingPermissions?: Array<{ requestId: string }>
    }
    const s = d.session ?? {}
    return {
      status: s.process_status as string | undefined,
      activity: s.activity as string | undefined,
      pending: d.pendingPermissions ?? [],
      journalPath: s.acpJournalPath as string | undefined,
      raw: s,
    }
  }

  async waitIdle(sid: string, timeoutSec: number): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000
    for (;;) {
      const s = await this.session(sid)
      if (s.status === 'idle' || s.status === 'stopped') return
      if (Date.now() > deadline) throw new Error(`session ${sid} not idle in ${timeoutSec}s (status=${s.status} activity=${s.activity})`)
      await sleep(3000)
    }
  }

  /**
   * Wait until the task's CURRENT session transcript contains `text`.
   * The only reliable turn-completion signal across providers: status-based
   * waits race turn startup (send → status still 'idle' for a beat → a
   * waitIdle returns before the turn even began — 2026-08-12 matrix run,
   * M2 "0.0s warm turn"), and ACP session ids migrate across recoveries.
   */
  async waitText(taskId: string, text: string, timeoutSec: number): Promise<string> {
    const deadline = Date.now() + timeoutSec * 1000
    for (;;) {
      const sid = await this.sidOf(taskId).catch(() => undefined)
      if (sid) {
        const t = await this.transcript(sid).catch(() => '')
        if (t.includes(text)) return sid
      }
      if (Date.now() > deadline) throw new Error(`"${text}" never appeared on task ${taskId} in ${timeoutSec}s`)
      await sleep(3500)
    }
  }

  /** Wait for a pending permission, following session-id migrations. */
  async waitPermissionOnTask(taskId: string, timeoutSec: number): Promise<{ sid: string; requestId: string }> {
    const deadline = Date.now() + timeoutSec * 1000
    for (;;) {
      const sid = await this.sidOf(taskId).catch(() => undefined)
      if (sid) {
        const s = await this.session(sid).catch(() => undefined)
        if (s && s.pending.length > 0) return { sid, requestId: s.pending[0].requestId }
      }
      if (Date.now() > deadline) throw new Error(`no permission ask on task ${taskId} in ${timeoutSec}s`)
      await sleep(3000)
    }
  }

  /** Idle AND empty queue — safe point to start a new scenario on a shared
   *  session (mid-turn scenarios leave queued messages that drain later). */
  async waitQuiescent(taskId: string, timeoutSec: number): Promise<string> {
    const deadline = Date.now() + timeoutSec * 1000
    let stable = 0
    for (;;) {
      const sid = await this.sidOf(taskId).catch(() => undefined)
      if (sid) {
        const s = await this.session(sid).catch(() => undefined)
        if (s && (s.status === 'idle' || s.status === 'stopped')) {
          stable++
          if (stable >= 2) return sid // two consecutive idle polls = queue drained
        } else {
          stable = 0
        }
      }
      if (Date.now() > deadline) throw new Error(`task ${taskId} never quiescent in ${timeoutSec}s`)
      await sleep(4000)
    }
  }

  async send(sid: string, text: string): Promise<string> {
    const r = await this.post(`/api/v1/sessions/${sid}/messages`, { text }) as { messageId?: string }
    if (!r.messageId) throw new Error('send returned no messageId')
    return r.messageId
  }

  async interrupt(sid: string): Promise<void> {
    await this.post(`/api/sessions/${sid}/interrupt`, {})
  }

  async setControl(sid: string, id: string, value: string): Promise<void> {
    await this.post(`/api/sessions/${sid}/controls`, { id, value })
  }

  async setModel(sid: string, model: string): Promise<void> {
    await this.post(`/api/sessions/${sid}/model`, { model })
  }

  async permission(sid: string, requestId: string, allow: boolean, optionId?: string): Promise<{ ok: boolean; status: number }> {
    return this.withConnRetry(async () => {
      const res = await fetch(`${this.base}/api/sessions/${sid}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, allow, ...(optionId ? { optionId } : {}) }),
      })
      return { ok: res.ok, status: res.status }
    })
  }

  async waitPermission(sid: string, timeoutSec: number): Promise<string> {
    const deadline = Date.now() + timeoutSec * 1000
    for (;;) {
      const s = await this.session(sid)
      if (s.pending.length > 0) return s.pending[0].requestId
      if (Date.now() > deadline) throw new Error(`no permission ask on ${sid} in ${timeoutSec}s`)
      await sleep(3000)
    }
  }

  /** Full transcript text via the history API (provider-neutral). */
  async transcript(sid: string): Promise<string> {
    const d = await this.get(`/api/sessions/${sid}/history?source=streams`) as { messages?: Array<{ text?: string }> }
    return (d.messages ?? []).map((m) => m.text ?? '').join('\n')
  }

  async forceDeleteTask(taskId: string): Promise<number> {
    return this.withConnRetry(async () => {
      const res = await fetch(`${this.base}/api/tasks/${taskId}?force=true`, { method: 'DELETE' })
      return res.status
    })
  }

  /** WS-RPC interrupt — kept for parity testing of both interrupt surfaces. */
  async wsInterrupt(sid: string): Promise<void> {
    const ws = new WebSocket(this.base.replace('http', 'ws') + '/ws')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('ws interrupt timeout')) }, 15_000)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'req', id: 'mx1', method: 'session:interrupt', payload: { sessionId: sid } }))
      })
      ws.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as { type: string; id: string; ok?: boolean; error?: string }
        if (m.type === 'res' && m.id === 'mx1') {
          clearTimeout(timer); ws.close()
          m.ok ? resolve() : reject(new Error(m.error))
        }
      })
      ws.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
  }

  /** Connection-level failures (ECONNREFUSED / socket reset) retry for up to
   *  45s — the harness supervisor respawns a swept server on the same port,
   *  and requests landing in the respawn window must wait it out, not fail
   *  the scenario. HTTP error STATUSES never retry (they're real answers). */
  private async withConnRetry<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 45_000
    for (;;) {
      try {
        return await fn()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const connError = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('socket')
        if (!connError || Date.now() > deadline) throw e
        await sleep(2000)
      }
    }
  }

  private async get(p: string): Promise<unknown> {
    return this.withConnRetry(async () => {
      const res = await fetch(this.base + p)
      if (!res.ok) throw new Error(`GET ${p} → ${res.status}`)
      return res.json()
    })
  }

  private async post(p: string, body: unknown): Promise<unknown> {
    return this.withConnRetry(async () => {
      const res = await fetch(this.base + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`POST ${p} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return res.json()
    })
  }
}
