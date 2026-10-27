/**
 * Restart recovery's config and its real dependencies (session-auto-recover.ts
 * holds the decisions; this holds what they read and write). Injectable so the
 * scheduler's tests run with no server, daemon or clock.
 */

import os from 'node:os'
import fs from 'node:fs/promises'
import { bus, EventNames } from '../event-bus.js'
import type { SessionRecord, SessionRestartLoss, StatusReason, TaskPhase } from '../types.js'
import type { SessionSnapshot } from '../../providers/daemon-fold.js'

/** Message source tag: also how we recognise our own sends. */
export const AUTO_RECOVER_SOURCE = 'auto-recover'

export interface AutoRecoverConfig {
  enabled: boolean
  /** Wait after the loss is observed before the first resume. */
  delayMs: number
  /** Spacing between resume starts on the same host. */
  staggerMs: number
  /** Max resumes per session inside `windowMs`. */
  maxAttempts: number
  /** Rolling window for the per-session budget. */
  windowMs: number
  /** Resumes in flight at once, per host. */
  concurrency: number
  /** Load gate for this machine: 1-minute load average per CPU above which no new resume starts. */
  maxLoadPerCpu: number
  /** How long one resume waits on the load gate before it goes anyway (one at a time). */
  loadWaitMs: number
  /** How long a resume holds its slot waiting for the session to come back. */
  settleTimeoutMs: number
  /** Wait before retrying a resume whose spawn failed. */
  retryDelayMs: number
  /** How long a lost session waits for its host to reconnect before giving up. */
  ownerWaitMs: number
}

function clampNum(raw: string | undefined, def: number, min: number, max: number, int = true): number {
  const n = raw != null && raw !== '' ? Number(raw) : def
  if (!Number.isFinite(n)) return def
  const v = Math.max(min, Math.min(max, n))
  return int ? Math.trunc(v) : v
}

export function resolveAutoRecoverConfig(): AutoRecoverConfig {
  const e = process.env
  return {
    // ON by default: this only restores a process the infrastructure took away.
    // Opt out with WALNUT_AUTO_RECOVER_ENABLED=0 or
    // hooks.overrides['session-auto-recover'].enabled: false in config.yaml.
    enabled: e.WALNUT_AUTO_RECOVER_ENABLED !== '0',
    delayMs: clampNum(e.WALNUT_AUTO_RECOVER_DELAY_MS, 20_000, 0, 3_600_000),
    staggerMs: clampNum(e.WALNUT_AUTO_RECOVER_STAGGER_MS, 15_000, 0, 600_000),
    maxAttempts: clampNum(e.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS, 3, 0, 50),
    windowMs: clampNum(e.WALNUT_AUTO_RECOVER_WINDOW_MS, 6 * 3_600_000, 60_000, 7 * 86_400_000),
    concurrency: clampNum(e.WALNUT_AUTO_RECOVER_CONCURRENCY, 2, 1, 32),
    // macOS counts threads blocked on I/O in the load average, and a Mac that
    // runs agent work idles at 1 to 2 per CPU: only a machine well past that
    // (a fresh boot measured 3 per CPU) holds new resumes back.
    maxLoadPerCpu: clampNum(e.WALNUT_AUTO_RECOVER_MAX_LOAD, 3, 0.1, 1000, false),
    loadWaitMs: clampNum(e.WALNUT_AUTO_RECOVER_LOAD_WAIT_MS, 5 * 60_000, 0, 6 * 3_600_000),
    settleTimeoutMs: clampNum(e.WALNUT_AUTO_RECOVER_SETTLE_MS, 180_000, 1_000, 3_600_000),
    retryDelayMs: clampNum(e.WALNUT_AUTO_RECOVER_RETRY_MS, 120_000, 0, 3_600_000),
    ownerWaitMs: clampNum(e.WALNUT_AUTO_RECOVER_OWNER_WAIT_MS, 24 * 3_600_000, 60_000, 7 * 86_400_000),
  }
}

// ── Injectable deps (real by default; overridden in unit tests) ───────────────

export interface AutoRecoverTask { phase: TaskPhase; isMain: boolean }

export interface AutoRecoverDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  send: (sessionId: string, message: string, opts: { source: string; taskId?: string; messageId?: string }) => Promise<unknown>
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  listSessions: () => Promise<SessionRecord[]>
  /** null = no such task (deleted). */
  getTask: (taskId: string) => Promise<AutoRecoverTask | null>
  recoveryOwner: (record: SessionRecord) => Promise<'server' | 'daemon' | 'unknown'>
  /** The host daemon's fold of the session's stream file; null when it cannot answer. */
  fetchSnapshot: (record: SessionRecord) => Promise<SessionSnapshot | null>
  /** The task's durable directory on the session's host; null = unknown. */
  taskDir: (taskId: string, host: string | null | undefined) => Promise<string | null>
  /** Does the session's cwd exist? null = cannot tell (remote host). */
  cwdExists: (record: SessionRecord) => Promise<boolean | null>
  /** Boot time of this machine (ms). */
  bootTimeMs: () => number
  /** 1-minute load average per CPU of this machine. */
  loadPerCpu: () => number
  /** Persist the attempt budget on the record (survives a server restart). */
  noteAttempt: (sessionId: string, attempts: number, cause: StatusReason | undefined) => Promise<void>
  /** Atomically rewrite `restartLoss`; returns the stored value (null = session gone). */
  patchLoss: (sessionId: string, fn: (cur: SessionRestartLoss | undefined) => SessionRestartLoss | undefined) => Promise<SessionRestartLoss | null>
  /** Hand the task back the normal way (NEED_ACTION) when its work is not resumed. */
  handBack: (taskId: string, sessionId: string) => Promise<void>
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void
  /** Messages still waiting in the session's queue (a failed delivery puts its batch back). */
  pendingMessages: (sessionId: string) => Promise<number>
  /** Calls back with the error of each delivery to the session that failed and was put back; returns the unsubscribe. */
  onDeliveryFailed: (sessionId: string, cb: (error: string) => void) => () => void
  /** Remove one still-queued message (a resume that must not go out after the hand-back). */
  dropMessage: (sessionId: string, messageId: string) => Promise<void>
}

export const LOCAL_HOST = '__local__'
export const isLocalHost = (host: string | null | undefined): boolean => !host || host === LOCAL_HOST

export function defaultDeps(): AutoRecoverDeps {
  return {
    pendingMessages: async (sessionId) => {
      const { getQueue } = await import('../session-message-queue.js')
      return (await getQueue(sessionId).catch(() => [])).filter((m) => m.status === 'pending').length
    },
    dropMessage: async (sessionId, messageId) => {
      const { deleteMessage } = await import('../session-message-queue.js')
      await deleteMessage(sessionId, messageId).catch(() => false)
    },
    onDeliveryFailed: (sessionId, cb) => {
      const name = `auto-recover-delivery-${sessionId}-${Math.random().toString(36).slice(2, 10)}`
      bus.subscribe(name, (event) => {
        const d = event.data as { sessionId?: string; error?: string; errorKind?: string }
        if (event.name === EventNames.SESSION_ERROR && d.sessionId === sessionId && d.errorKind === 'delivery_failed') cb(d.error ?? 'delivery failed')
      }, { global: true, interest: [EventNames.SESSION_ERROR] })
      return () => bus.unsubscribe(name)
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    send: async (sessionId, message, opts) => {
      const { sendMessageToSession } = await import('../session-message-queue.js')
      return sendMessageToSession(sessionId, message, opts)
    },
    getSession: async (sessionId) => {
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      return getSessionByClaudeId(sessionId)
    },
    listSessions: async () => {
      const { listSessions } = await import('../session-tracker.js')
      return listSessions()
    },
    getTask: async (taskId) => {
      // getTask THROWS on an unknown id: a deleted task reads as "no task".
      try {
        const { getTask } = await import('../task-manager.js')
        const task = await getTask(taskId)
        if (!task) return null
        const { isMainAgentTask } = await import('../org/main-stays-active.js')
        return { phase: task.phase, isMain: isMainAgentTask(task) }
      } catch {
        return null
      }
    },
    recoveryOwner: async (record) => {
      if (record.stopRequest?.state === 'pending') return 'daemon'
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
      const conn = getConnectedDaemonConnection(record.host ?? LOCAL_HOST)
      if (!conn || !conn.capabilitiesKnown) return 'unknown'
      if (!conn.hasCapability('cron-supervision-v1')) return 'server'
      const state = await conn.send('cron.supervision', { sid: record.claudeSessionId }, 5000)
      if (!state.ok) return 'unknown'
      return state.cronSupervision ? 'daemon' : 'server'
    },
    fetchSnapshot: async (record) => {
      try {
        const { getPooledSnapshotConnection } = await import('../../providers/daemon-connection.js')
        let conn = getPooledSnapshotConnection(record.host)
        // At boot this machine's daemon may still be connecting: give it a
        // moment, since its fold is the better fact. A remote host may be off.
        for (let i = 0; conn === null && isLocalHost(record.host) && i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          conn = getPooledSnapshotConnection(record.host)
        }
        if (!conn) return null
        const resp = await conn.send('getState', { sid: record.claudeSessionId }, 15_000) as { ok?: boolean; exists?: boolean; snapshot?: SessionSnapshot }
        // No stream file, or an empty one, is no evidence either way.
        return resp?.ok && resp.exists !== false && resp.snapshot && resp.snapshot.v > 0 ? resp.snapshot : null
      } catch {
        return null
      }
    },
    taskDir: async (taskId, host) => {
      try {
        const { taskDirForHost } = await import('./task-dir-place.js')
        return await taskDirForHost(taskId, host)
      } catch {
        return null
      }
    },
    cwdExists: async (record) => {
      if (!record.cwd || !isLocalHost(record.host)) return null
      try {
        return (await fs.stat(record.cwd)).isDirectory()
      } catch {
        return false
      }
    },
    bootTimeMs: () => Date.now() - os.uptime() * 1000,
    loadPerCpu: () => os.loadavg()[0] / Math.max(1, os.cpus().length),
    noteAttempt: async (sessionId, attempts, cause) => {
      const { updateSessionRecordConditionally } = await import('../session-tracker.js')
      // Deliberately NOT a status write, so the snapshot gate never drops it.
      await updateSessionRecordConditionally(sessionId, {
        autoRecover: { attempts, lastAt: new Date().toISOString(), cause },
      } as Partial<SessionRecord>, () => true, { preserveLastActiveAt: true })
    },
    patchLoss: async (sessionId, fn) => {
      const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
      for (let i = 0; i < 4; i++) {
        const cur = await getSessionByClaudeId(sessionId)
        if (!cur) return null
        const seen = JSON.stringify(cur.restartLoss ?? null)
        const next = fn(cur.restartLoss)
        if (JSON.stringify(next ?? null) === seen) return cur.restartLoss ?? null
        const written = await updateSessionRecordConditionally(
          sessionId,
          { restartLoss: next } as Partial<SessionRecord>,
          (current) => JSON.stringify(current.restartLoss ?? null) === seen,
          { preserveLastActiveAt: true },
        )
        if (written) return written.restartLoss ?? null
      }
      throw new Error('restartLoss write kept racing')
    },
    handBack: async (taskId, sessionId) => {
      const { handBackTaskOnSessionEnd } = await import('../phase.js')
      await handBackTaskOnSessionEnd(taskId, sessionId, 'auto-recover')
    },
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
        sessionId, taskId, variant: 'info' as const, message,
      }, ['main-ai'], { source: AUTO_RECOVER_SOURCE, urgency: 'urgent' })
    },
  }
}
