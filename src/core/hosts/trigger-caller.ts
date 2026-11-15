/**
 * Who a trigger check's call is, for the ops that run only for a task: host_exec and its
 * family (host_exec_read/stop/list/pinned), host_copy, host_http and host_mcp_*.
 *
 * A check is a shell command a host's daemon runs on a cadence, for no session, so its `walnut`
 * calls reached this server as `external` and every one of those ops refused it with 403
 * session_only. The scripts read the refusal as "not yet" and printed `fire: false`, so a trigger
 * that watched a job on another host never fired (2026-11-14: ~50 refusals an hour from more than
 * ten triggers, among them one that had waited two days on an iOS run long over).
 *
 * Now a check acts for its trigger's task, with that task's own grants and nothing more: the task
 * whose session wrote the check (CronJob.checkActsFor, which only the server sets: routines-core.ts),
 * or the owner a person picked. That session could run the same command itself, so no one gains a
 * power; the user's Deny, revoke and closed host stop a check as they stop the task. A caller can
 * set ownerTaskId and the target, so neither is trusted, except on a trigger saved before
 * checkActsFor existed (no field at all: legacyCheckActsFor), whose owner or target a later patch
 * freezes into the field.
 *
 * The chain of trust, each link checked where it is made:
 *   1. The daemon gives each check run a token in WALNUT_CHECK_TOKEN and relays the run's calls as
 *      `external` plus `triggerCaller` {kind, id}; it drops one a caller wrote
 *      (trigger-check-core.ts checkCallers).
 *   2. daemon-connection.ts keeps `triggerCaller` only from a daemon that says trigger-caller-v1.
 *   3. The relay (capability-router.ts) holds it here with the relaying host and passes the op's
 *      self-calls a token only this process made (as relay-proof.ts does for callerProof).
 *   4. The host routes read the token (withTriggerCaller), and callerOf (host-exec-target.ts)
 *      takes it only when the trigger still exists, is on, has a check, and that check runs on
 *      the host that relayed the call; a test run, only while the test can still run.
 */
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { log } from '../../logging/index.js'
import { HostExecError, normHost, type Caller } from './host-exec-target.js'

export const CALLER_TRIGGER_HEADER = 'x-walnut-caller-trigger'

/** A relayed call's self-calls land within a few seconds; a minute covers a slow one. */
const HOLD_TTL_MS = 60_000
const HOLD_MAX = 500
/** Two tries of the longest check (trigger-api.ts sendTestRun sends once more on a dropped link), plus margin. */
const TEST_RUN_MAX_MS = 2 * 300_000 + 120_000
const TEST_RUN_MAX = 200
const TEST_RUN_RE = /^tt-[A-Za-z0-9_-]{8,64}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/

interface TriggerRef { kind: 'armed' | 'test'; id: string }
interface Held { ref: TriggerRef; host: string; until: number }
interface TestRun { taskId: string; host: string; until: number }

const held = new Map<string, Held>()
const testRuns = new Map<string, TestRun>()
const scope = new AsyncLocalStorage<string | undefined>()

function refOf(raw: unknown): TriggerRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
  if (r.kind === 'armed') return { kind: 'armed', id: r.id }
  if (r.kind === 'test' && TEST_RUN_RE.test(r.id)) return { kind: 'test', id: r.id }
  return null
}

/**
 * Keep a relayed `triggerCaller` for the op's own calls; returns the token its self-calls carry.
 * `host` is the host whose daemon relayed the call (never one the caller named).
 */
export function holdRelayTrigger(raw: unknown, host: string, now = Date.now()): string | undefined {
  const ref = refOf(raw)
  if (!ref || !host) return undefined
  for (const [k, v] of held) if (v.until <= now) held.delete(k)
  // Full of live ones: hold none rather than drop one a call still needs (the call stays external).
  if (held.size >= HOLD_MAX) return undefined
  const token = crypto.randomBytes(24).toString('hex')
  held.set(token, { ref, host: normHost(host), until: now + HOLD_TTL_MS })
  return token
}

function heldOf(token: string | undefined, now = Date.now()): Held | undefined {
  if (!token) return undefined
  const h = held.get(token)
  return h && h.until > now ? h : undefined
}

/**
 * A test of a check that a task's session asked for (trigger-api.ts testRoutineCheck): the id the
 * daemon runs it under, so its calls act for that task while the test can still run.
 */
export function noteTestRun(taskId: string, host: string, limitSeconds: number, now = Date.now()): string | undefined {
  if (!taskId) return undefined
  for (const [k, v] of testRuns) if (v.until <= now) testRuns.delete(k)
  if (testRuns.size >= TEST_RUN_MAX) return undefined
  const id = `tt-${crypto.randomBytes(12).toString('hex')}`
  const limitMs = Math.min(TEST_RUN_MAX_MS, 2 * Math.max(1, limitSeconds) * 1000 + 120_000)
  testRuns.set(id, { taskId, host: normHost(host), until: now + limitMs })
  return id
}

/** Run a host route's work with the request's trigger token in scope (callerOf reads it). */
export function withTriggerCaller<T>(header: unknown, work: () => Promise<T>): Promise<T> {
  const raw = Array.isArray(header) ? header[0] : header
  const token = typeof raw === 'string' && /^[0-9a-f]{48}$/.test(raw.trim()) ? raw.trim() : undefined
  return scope.run(token, work)
}

/** Why a trigger's call is not its task's, as the 403 says it. */
function refused(message: string, code: string, data: Record<string, unknown> = {}): HostExecError {
  return new HostExecError(message, 403, code, data)
}

/**
 * The task a check in scope acts for, as a Caller; null when no check's call is in scope (a person,
 * an outside program), so the caller's own refusal stands. Throws the refusal for a check whose
 * trigger cannot act for a task.
 */
export async function triggerCallerInScope(now = Date.now()): Promise<Caller | null> {
  const h = heldOf(scope.getStore(), now)
  if (!h) return null
  const { getTask } = await import('../task-manager.js')
  const titled = async (taskId: string): Promise<Caller> => {
    const task = await getTask(taskId).catch(() => undefined)
    if (!task) throw refused(`This check acts for task ${taskId}, which no longer exists; nothing ran.`, 'trigger_no_task', { taskId })
    return { sid: `trigger:${h.ref.id}`, taskId, taskTitle: task.title ?? taskId, host: h.host }
  }
  if (h.ref.kind === 'test') {
    const run = testRuns.get(h.ref.id)
    if (!run || run.until <= now || run.host !== h.host) {
      throw refused('This test of a check is over, or ran on another host; nothing ran.', 'trigger_test_over')
    }
    return titled(run.taskId)
  }
  const { getRoutine } = await import('../routines/routines-core.js')
  const job = await getRoutine(h.ref.id).then((r) => r.job as Record<string, unknown>).catch(() => null)
  if (!job) throw refused(`Trigger ${h.ref.id} no longer exists; nothing ran.`, 'trigger_gone', { triggerId: h.ref.id })
  const check = job.check as { host?: unknown } | undefined
  if (job.enabled === false || !check || typeof check !== 'object') {
    throw refused(`Trigger ${h.ref.id} is paused or has no check; nothing ran.`, 'trigger_off', { triggerId: h.ref.id })
  }
  const checkHost = normHost(typeof check.host === 'string' ? check.host.trim() : '')
  if (checkHost !== h.host) {
    // The daemon of one host vouches only for its own checks.
    log.session.warn('trigger caller: a host relayed a call for a check that runs elsewhere', { triggerId: h.ref.id, relayHost: h.host, checkHost })
    throw refused(`Trigger ${h.ref.id}'s check runs on ${checkHost}, not on ${h.host}; nothing ran.`, 'trigger_wrong_host', { triggerId: h.ref.id })
  }
  const taskId = typeof job.checkActsFor === 'string' ? job.checkActsFor.trim() : legacyCheckActsFor(job)
  if (!taskId) {
    throw refused(`Trigger ${h.ref.id}'s check was written by no task's session, so it runs nothing on other hosts; re-arm it from the task's session.`, 'trigger_no_task', { triggerId: h.ref.id })
  }
  return titled(taskId)
}

/**
 * A trigger saved before the server kept checkActsFor (the field absent, never ''): its check acts
 * for the task it belongs to (ownerTaskId, else the task it delivers into), as trigger_create made
 * it for the caller's task. Every trigger the server saves since carries the field, '' for none.
 */
export function legacyCheckActsFor(job: { checkActsFor?: unknown; ownerTaskId?: unknown; executor?: unknown }): string | undefined {
  if (job.checkActsFor !== undefined) return undefined
  const owner = typeof job.ownerTaskId === 'string' ? job.ownerTaskId.trim() : ''
  if (owner) return owner
  const target = (job.executor as { config?: { target?: unknown } } | undefined)?.config?.target
  return typeof target === 'string' && target.trim() ? target.trim() : undefined
}

export function _resetTriggerCallersForTesting(): void { held.clear(); testRuns.clear() }
