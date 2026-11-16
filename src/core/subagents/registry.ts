/**
 * The Walnut subagents a session runs (subagent_run), kept in this server's memory. Each is a
 * hidden session of its own (on-host.ts SubagentSession: a lane, no task, no board row), on the
 * session's host or another one, that lives past its answer: its caller talks to it again with
 * subagent_send, the user in its conversation in the Background tasks panel, and it keeps its
 * context. It is closed (its session stopped and removed, its copy too) when it is stopped, after
 * KEEP_IDLE_MS with no turn, or when its caller's session is gone for good.
 *
 * It outlives this server: a deploy restarts the server many times a day while the subagent's
 * session runs on in its host's daemon (sessions are detached, never killed, on a stop). Each
 * run's state is written to disk as it changes (subagents-open.json); a stopping server only
 * writes it down and lets go, and the next one takes every run up again (restoreLightSubagents):
 * a turn the restart cut off is asked again of the same session, and an end not yet told to
 * its caller is told then (2026-11-16: sa-82bc6450d3, a codex run of 60 minutes, was stopped by
 * a deploy 11 minutes in and its caller never heard of it).
 *
 * Each caller turn's answer goes back to the caller by itself, as a native background agent's
 * does: in the call that waits for it, or, when nothing waited (background, or a wait that ran
 * out), as one message into the caller's session once it ends, which wakes an idle caller. The
 * caller never polls (T3 Code's delegate_task: "Completion wakes this thread. Do not wait on it
 * or poll it.").
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { engineCaps } from '../agents/engine-registry.js'
import type { BackgroundTaskInfo } from '../event-types.js'
import type { SessionEngine } from '../types.js'
import { LIGHT_SUBAGENT_ENGINES, LightSubagentError, RESUME_PROMPT, type LightRunner, type LightRunResult, type LightRunSpec, type LightSubagentStatus, type ReturnedFile } from './types.js'
import type { SubagentSessionState, SubagentTurnSpec } from './on-host.js'

/** Running at once per parent session, and on this server. */
export const MAX_RUNNING_PER_SESSION = 4
export const MAX_RUNNING_TOTAL = 12
/** Subagents a session keeps open (idle ones answer follow-ups); past it the oldest idle one is closed. */
export const MAX_OPEN_PER_SESSION = 8
/** An open subagent with no turn for this long is closed. */
export const KEEP_IDLE_MS = 60 * 60_000
export const DEFAULT_TIMEOUT_MIN = 30
export const MAX_TIMEOUT_MIN = 120
/** An ended run stays a row this long; a parent keeps at most this many, the server this many in all. */
const KEEP_ENDED_MS = 6 * 3_600_000
const KEEP_ENDED_PER_SESSION = 30
const KEEP_ENDED_TOTAL = 200
const PRUNE_EVERY_MS = 10 * 60_000
/** What of an answer a run keeps (the call that waits for it gets the same). */
const ANSWER_KEEP_MAX = 200_000
/** What of the prompt an ended run keeps: the panel shows this much. */
const PROMPT_KEPT_MAX = 4_000
/** A run whose end nobody read in this long is told to the parent session. */
const TELL_GRACE_MS = 3_000
const TELL_TRIES = 5
const TELL_RETRY_MS = 60_000
const PANEL_EMIT_GAP_MS = 400
const PROMPT_MAX = 200_000
const ANSWER_SHOWN_MAX = 60_000

export interface LightSubagentRun {
  id: string
  parentSid: string
  parentTaskId?: string
  /** Where it runs. */
  host: string
  /** The parent's host, when the run went to another one (`host`): it works there in a copy of the parent's work. */
  fromHost?: string
  /** The caller's task's grant on that host (host_exec's), read again before work starts there. */
  grant?: { taskId: string; id: string }
  cwd: string
  parentMode?: import('../types.js').SessionMode
  engine: SessionEngine
  model?: string
  effort?: string
  description: string
  prompt: string
  toolUseId?: string
  fullAccess: boolean
  background: boolean
  status: LightSubagentStatus
  startedAt: number
  endedAt?: number
  timeoutMs: number
  tokens?: number
  toolUses: number
  lastTool?: string
  /** What it says now while it runs; its answer, or why it failed, once it ended. */
  text: string
  answer?: string
  error?: string
  errorCode?: string
  warnings: string[]
  /** A run on another host: the files it named, copied back to the parent's host, and what of the parent's work it got. */
  files: ReturnedFile[]
  work: string[]
  stoppedBy?: string
  /** Caller turns asked of it (the first prompt and each subagent_send), and the ones that ended. */
  turns: number
  turnsEnded: number
  /** Its session is gone (stopped, idle too long, its caller gone): only its last answer is kept. */
  closed: boolean
  /** When its latest turn began or ended. */
  activeAt: number
  /** The running turn's own limit (epoch ms). */
  turnDeadlineAt?: number
}

/** One caller turn as it ended: what a call or the notice about it says. */
export interface TurnEnd {
  status: Exclude<LightSubagentStatus, 'running'>
  answer?: string
  error?: string
  errorCode?: string
  /** The notice's body; its last line (talk to it again, or it is closed) is read when it is sent. */
  body: string
  told: boolean
  /** Deliveries that failed (its host's link, the session store): tried again a minute later, a few times. */
  tries?: number
}

/** One subagent's session (on-host.ts SubagentSession), or a test runner standing in for it. */
interface Handle {
  readonly sessionId?: string
  /** When its session last did anything (the user may write in its conversation). */
  readonly activeAt?: number
  turn(prompt: string, t: SubagentTurnSpec): Promise<LightRunResult>
  close(reason: string): Promise<boolean>
  /** What a restart keeps (absent: a test runner, kept as nothing). */
  state?(): SubagentSessionState
  detach?(): Promise<void>
  /** The turn a restart cut off: its own end, or, its session idle with none seen, the answer to RESUME_PROMPT. */
  resume?(t: SubagentTurnSpec): Promise<LightRunResult>
}
export { RESUME_PROMPT }

interface Live {
  run: LightSubagentRun
  /** The current turn's: a stop or a timeout aborts it. */
  abort: AbortController
  waiters: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  handle: Handle | null
  /** Turns run one after another: a follow-up sent while one runs waits for it. */
  chain: Promise<void>
  /** The caller turn running now (1 = the first prompt). */
  turnNo: number
  /** Each ended caller turn as it ended (a later turn changes the run, never this), and whether its end reached the caller. */
  tells: Map<number, TurnEnd>
  /** Messages sent while a turn ran, in order, each run after the one before. */
  pending: Array<{ turn: number; message: string }>
  /** This server let it go (it stops): nothing of this process acts on it any more. */
  detached: boolean
  closing: Promise<void> | null
  /** It is closed and its session gone (a running slot is held only while a turn runs). */
  settled: boolean
  settledP: Promise<void>
  settle: () => void
}

const runs = new Map<string, Live>()
/** Starts past the limit check and still checking the engine: they hold a slot already. */
const reserving = new Map<string, number>()
let pruneTimer: ReturnType<typeof setInterval> | null = null
const emitTimers = new Map<string, ReturnType<typeof setTimeout>>()
let runnerOverride: LightRunner | null = null
let keepIdleMs = KEEP_IDLE_MS
/** Tests: close an idle subagent this much after its last turn. */
export function _setKeepIdleMsForTest(ms: number | null): void { keepIdleMs = ms ?? KEEP_IDLE_MS }
/** Tests: the prune round's check for subagents whose caller is gone. */
export function _closeOrphansForTest(): Promise<void> { return closeOrphans() }
let skipEngineCheck = false

/** Tests: run every subagent with this runner instead of a real engine. */
export function _setLightRunnerForTest(fn: LightRunner | null): void { runnerOverride = fn }
/** Tests: run on a mock adapter whatever the machine has installed. */
export function _skipEngineCheckForTest(skip: boolean): void { skipEngineCheck = skip }
/** Tests: this process "ends" (a restart): every run is forgotten here, its written state kept. */
export function _forgetLightSubagentsForTest(): void {
  for (const live of runs.values()) { live.detached = true; if (live.timer) clearTimeout(live.timer); if (live.idleTimer) clearTimeout(live.idleTimer) }
  runs.clear()
  reserving.clear()
}
export function _resetLightSubagentsForTest(): void {
  for (const live of runs.values()) { live.detached = true; live.abort.abort(); if (live.timer) clearTimeout(live.timer); if (live.idleTimer) clearTimeout(live.idleTimer) }
  runs.clear()
  reserving.clear()
  for (const t of emitTimers.values()) clearTimeout(t)
  emitTimers.clear()
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  letGo = false
  fs.rmSync(STATE_FILE(), { force: true })
}

export interface StartLightSubagent {
  /** Default: claude. */
  engine?: string
  /** Another host to run on (an alias or a selector like "@ios"): it works there in a copy of the parent's work. */
  host?: string
  /** The folder to run in (absolute, on the caller's host; with `host`, the folder whose work is copied). Default: the session's own. */
  cwd?: string
  model?: string
  effort?: string
  prompt: string
  description?: string
  background?: boolean
  timeoutMin?: number
  toolUseId?: string
}

export function engineLabel(run: Pick<LightSubagentRun, 'engine' | 'model'> & Partial<Pick<LightSubagentRun, 'host' | 'fromHost'>>): string {
  const name = engineCaps(run.engine).displayName
  const label = run.model ? `${name} · ${run.model}` : name
  return run.fromHost && run.host ? `${label} · on ${run.host === '__local__' ? 'this machine' : run.host}` : label
}

/** Start one run for the session `parentSid` (it must be a session Walnut knows). */
export async function startLightSubagent(parentSid: string | undefined, req: StartLightSubagent): Promise<LightSubagentRun> {
  if (!parentSid) throw new LightSubagentError('no_session', 'A subagent runs inside a session: call it from a session (its WALNUT_SESSION_ID names it)', 400)
  const engine = (req.engine || 'claude') as SessionEngine
  if (!LIGHT_SUBAGENT_ENGINES.includes(engine)) {
    throw new LightSubagentError('bad_request', `Unknown engine "${req.engine}". Engines: ${LIGHT_SUBAGENT_ENGINES.join(', ')}`, 400)
  }
  const prompt = (req.prompt ?? '').trim()
  if (!prompt) throw new LightSubagentError('bad_request', 'prompt is empty', 400)
  if (prompt.length > PROMPT_MAX) throw new LightSubagentError('bad_request', `prompt is over ${PROMPT_MAX} characters: put the material in a file and name it`, 400)
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const { canonicalCallerSid } = await import('../sessions/acp-caller-sid.js')
  const sid = canonicalCallerSid(parentSid)
  const record = await getSessionByClaudeId(sid)
  if (!record) throw new LightSubagentError('no_session', `Session ${sid} is not one Walnut knows`, 404)
  const ownHost = !record.host || record.host === 'local' ? '__local__' : record.host
  const cwd = req.cwd?.trim().replace(/(?<=.)\/+$/, '') || record.cwd
  if (!cwd) throw new LightSubagentError('no_session', `Session ${sid} has no working directory`, 409)
  // A folder on the caller's own host, named whole: what the session's own shell reaches already.
  if (req.cwd && (!cwd.startsWith('/') || cwd.split('/').includes('..'))) {
    throw new LightSubagentError('bad_request', `cwd must be an absolute path without "..": ${req.cwd}`, 400)
  }
  // Another host: the one host_exec would run on, under the same grant (it is as strong as a command there).
  const away = req.host?.trim() ? await awayHost(sid, req.host.trim(), prompt) : null
  const host = away?.host ?? ownHost
  const { acpSupposedFullAccess } = await import('../../providers/acp-permission-posture.js')
  // The slot is taken with no await before it, and handed to the run with none after the
  // check: starts at once never pass the limit together.
  assertSlot(sid)
  reserving.set(sid, (reserving.get(sid) ?? 0) + 1)
  try {
    await checkEngineOnHost(engine, host)
  } finally {
    const left = (reserving.get(sid) ?? 1) - 1
    if (left > 0) reserving.set(sid, left)
    else reserving.delete(sid)
  }
  const timeoutMin = Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.round(req.timeoutMin ?? DEFAULT_TIMEOUT_MIN)))
  const run: LightSubagentRun = {
    id: `sa-${crypto.randomBytes(5).toString('hex')}`,
    parentSid: sid,
    ...(record.taskId ? { parentTaskId: record.taskId } : {}),
    host, cwd, engine,
    ...(away ? { fromHost: ownHost, grant: { taskId: away.taskId, id: away.grantId } } : {}),
    ...(record.mode ? { parentMode: record.mode } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
    description: (req.description?.trim() || firstLine(prompt)).slice(0, 120),
    prompt,
    ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
    // The parent's real posture: its Walnut mode, or the preset it picked in its engine's own controls.
    fullAccess: acpSupposedFullAccess({ walnutMode: record.mode ?? 'default', chosenMode: record.acpConfig?.mode }),
    background: req.background === true,
    status: 'running',
    startedAt: Date.now(),
    timeoutMs: timeoutMin * 60_000,
    toolUses: 0,
    text: '',
    warnings: [],
    files: [],
    work: [],
    turns: 1,
    turnsEnded: 0,
    closed: false,
    activeAt: Date.now(),
  }
  const live = newLive(run)
  runs.set(run.id, live)
  save()
  armPrune()
  log.agent.info('light subagent started', { id: run.id, parentSid: sid, engine, model: run.model, host, cwd, background: run.background })
  // The session keeps this many open: the oldest idle one goes first.
  const open = [...runs.values()].filter((l) => l.run.parentSid === sid && !l.closing && l !== live)
  for (const old of open.filter((l) => l.run.status !== 'running').sort((a, b) => a.run.activeAt - b.run.activeAt).slice(0, Math.max(0, open.length + 1 - MAX_OPEN_PER_SESSION))) {
    void closeRun(old, 'subagent_too_many')
  }
  live.chain = execute(live, record.acpRuntimeId || sid)
  emitPanel(sid)
  return run
}

function newLive(run: LightSubagentRun): Live {
  let settle!: () => void
  const settledP = new Promise<void>((r) => { settle = r })
  return { run, abort: new AbortController(), waiters: new Set(), handle: null, chain: Promise.resolve(), turnNo: run.turnsEnded + 1, tells: new Map(), pending: [], detached: false, closing: null, settled: false, settledP, settle }
}

/** A running slot for `sid`: subagents answering now (and starts still checking their engine), per session and in all. */
function assertSlot(sid: string): void {
  const held = [...runs.values()].filter((l) => !l.settled && l.run.status === 'running')
  const reservedAll = [...reserving.values()].reduce((a, b) => a + b, 0)
  if (held.filter((l) => l.run.parentSid === sid).length + (reserving.get(sid) ?? 0) >= MAX_RUNNING_PER_SESSION) {
    throw new LightSubagentError('too_many', `This session already has ${MAX_RUNNING_PER_SESSION} subagents answering at once: their answers come to you by themselves; send this when one has answered, or stop one (subagent_stop)`, 429)
  }
  if (held.length + reservedAll >= MAX_RUNNING_TOTAL) {
    throw new LightSubagentError('too_many', `Walnut already runs ${MAX_RUNNING_TOTAL} subagents across sessions: try again when one ends`, 429)
  }
}

/**
 * Send the subagent `id` of `parentSid` another message, as a native agent takes one: it keeps
 * its context, and its answer comes back the same way as the first. A message sent while it is
 * still answering waits for that turn. Returns the run and the number of this turn.
 */
export function sendLightSubagent(parentSid: string | undefined, id: string, req: { message: string }): { run: LightSubagentRun; turn: number } {
  const run = getLightSubagent(parentSid, id)
  const live = runs.get(id)!
  const message = (req.message ?? '').trim()
  if (!message) throw new LightSubagentError('bad_request', 'message is empty', 400)
  if (message.length > PROMPT_MAX) throw new LightSubagentError('bad_request', `message is over ${PROMPT_MAX} characters: put the material in a file and name it`, 400)
  if (live.closing || run.closed) {
    throw new LightSubagentError('closed', `Subagent ${id} was closed (${run.status === 'completed' ? 'it had no turn for a while, or its session ended' : `it ${run.status}`}): start a new one with subagent_run, and give it what it needs in the prompt`, 409)
  }
  // A message to an idle subagent makes it answer again: it takes a running slot like a new run.
  if (run.status !== 'running') assertSlot(run.parentSid)
  const turn = ++run.turns
  if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined }
  run.activeAt = Date.now()
  live.pending.push({ turn, message })
  live.chain = live.chain.then(() => runNext(live))
  save()
  log.agent.info('light subagent message', { id, parentSid: run.parentSid, turn })
  return { run, turn }
}

/**
 * The host a `host` names for this session's subagent, after the same checks host_exec makes
 * (a task's session, a host Walnut knows, the task's grant there), or null when it names the
 * session's own host (the run goes on there as without one).
 */
async function awayHost(sid: string, raw: string, prompt: string): Promise<{ host: string; taskId: string; grantId: string } | null> {
  const hx = await import('../hosts/host-exec.js')
  try {
    const caller = await hx.callerOf(sid)
    let host: string
    try {
      host = await hx.targetHost(raw, caller)
    } catch (err) {
      if (err instanceof hx.HostExecError && err.code === 'same_host') return null
      throw err
    }
    const grantId = await hx.grantFor(caller, host, `subagent_run: ${firstLine(prompt).slice(0, 160)}`)
    return { host, taskId: caller.taskId, grantId }
  } catch (err) {
    if (err instanceof hx.HostExecError) {
      throw new LightSubagentError(err.code as never, err.message.replace(/host_exec runs for a task's session/, 'A subagent on another host runs for a task\'s session'), err.status, err.data)
    }
    throw err
  }
}

/** The run's grant on its host, read again (host_exec's assertStillGranted); a revoke ends the run. */
async function stillGranted(run: LightSubagentRun): Promise<void> {
  const hx = await import('../hosts/host-exec.js')
  try {
    await hx.assertStillGranted(run.grant!.taskId, run.host, run.grant!.id)
  } catch (err) {
    if (err instanceof hx.HostExecError) throw new LightSubagentError(err.code as never, err.message, err.status, err.data)
    throw err
  }
}

async function checkEngineOnHost(engine: SessionEngine, host: string): Promise<void> {
  if (skipEngineCheck) return
  const { hostEnginesAvailability } = await import('../agents/host-engines.js')
  const all = await Promise.race([
    hostEnginesAvailability(host).catch(() => ({})),
    new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 6_000).unref?.()),
  ]) as Record<string, { installed: boolean; reason: string | null } | undefined>
  const row = all[engine]
  // No answer in time is no verdict: the start itself says what is wrong.
  if (!row || row.installed) return
  const usable = Object.entries(all).filter(([id, r]) => r?.installed && LIGHT_SUBAGENT_ENGINES.includes(id as SessionEngine)).map(([id]) => id)
  const where = host === '__local__' ? 'this machine' : host
  throw new LightSubagentError('engine_unavailable',
    `${engineCaps(engine).displayName} cannot run on ${where}: ${row.reason ?? 'it is not installed'}.${usable.length ? ` Engines that can: ${usable.join(', ')}.` : ''}`,
    409, { engines: usable })
}

/** The next message sent while a turn ran, once that turn ended. */
async function runNext(live: Live): Promise<void> {
  if (live.closing || live.detached || !live.handle) return
  const next = live.pending.shift()
  if (next) await runTurn(live, next.message)
}

function specOf(live: Live, callerSid: string): LightRunSpec {
  const { run } = live
  return {
    runtimeId: `lsa-${run.id.slice(3)}-${crypto.randomBytes(3).toString('hex')}`,
    runId: run.id,
    engine: run.engine, host: run.host, cwd: run.cwd,
    ...(run.model ? { model: run.model } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    prompt: run.prompt,
    fullAccess: run.fullAccess,
    parentSid: run.parentSid,
    callerSid,
    deadlineAt: run.startedAt + run.timeoutMs,
    startedAt: run.startedAt,
    ...(run.parentTaskId ? { parentTaskId: run.parentTaskId } : {}),
    ...(run.parentMode ? { parentMode: run.parentMode } : {}),
    ...(run.fromHost ? { away: { fromHost: run.fromHost, fromCwd: run.cwd } } : {}),
    ...(run.grant ? { stillGranted: () => stillGranted(run) } : {}),
    signal: live.abort.signal,
    onProgress: () => {},
    onState: () => save(),
  }
}

async function execute(live: Live, callerSid: string): Promise<void> {
  const { run } = live
  const spec = specOf(live, callerSid)
  try {
    // The grant may have been revoked while the run waited for its slot: nothing starts there then.
    if (run.grant) await stillGranted(run)
    if (runnerOverride) {
      const runner = runnerOverride
      live.handle = { turn: (prompt, t) => runner({ ...spec, prompt, signal: t.signal, deadlineAt: t.deadlineAt, onProgress: t.onProgress }), close: async () => true }
    } else {
      const { SubagentSession } = await import('./on-host.js')
      live.handle = new SubagentSession(spec)
    }
    save()
  } catch (err) {
    const code = err instanceof LightSubagentError ? err.code : 'engine_error'
    end(live, live.abort.signal.aborted && run.stoppedBy ? 'stopped' : 'failed', { error: err instanceof Error ? err.message : String(err), errorCode: code })
    await closeRun(live, 'subagent_failed')
    return
  }
  await runTurn(live, run.prompt, true)
}

/** One caller turn: the first prompt or a later message. A turn that fails or is stopped closes the subagent. */
async function runTurn(live: Live, prompt: string, first = false, resume = false): Promise<void> {
  const { run } = live
  if (live.closing || live.detached || !live.handle) return
  // Never closed as idle while it answers.
  if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined }
  live.turnNo = run.turnsEnded + 1
  run.activeAt = Date.now()
  if (!first) {
    live.abort = new AbortController()
    run.status = 'running'
    run.text = ''
    run.lastTool = undefined
    delete run.answer; delete run.error; delete run.errorCode
    run.endedAt = undefined
    emitPanel(run.parentSid)
  }
  const timeoutMin = Math.round(run.timeoutMs / 60_000)
  // A turn taken up again after a restart keeps the limit it began with.
  if (!resume || !run.turnDeadlineAt) run.turnDeadlineAt = Date.now() + run.timeoutMs
  const deadlineAt = run.turnDeadlineAt
  live.timer = setTimeout(() => end(live, 'failed', { error: `It ran out of its ${timeoutMin} minutes and was stopped`, errorCode: 'timed_out' }), Math.max(0, deadlineAt - Date.now()))
  live.timer.unref?.()
  save()
  const signal = live.abort.signal
  try {
    const spec: SubagentTurnSpec = {
      signal,
      deadlineAt,
      onProgress: (p) => {
        if (run.status !== 'running' || signal.aborted) return
        if (p.kind === 'text') run.text = p.text
        else if (p.kind === 'tool') { run.toolUses++; run.lastTool = p.toolName; run.text = '' }
        else if (p.kind === 'tokens') run.tokens = p.tokens
        emitPanel(run.parentSid)
      },
    }
    const result = resume && live.handle.resume ? await live.handle.resume(spec) : await live.handle.turn(prompt, spec)
    takeResult(live, result)
  } catch (err) {
    const code = err instanceof LightSubagentError ? err.code : 'engine_error'
    end(live, signal.aborted && run.stoppedBy ? 'stopped' : 'failed', { error: err instanceof Error ? err.message : String(err), errorCode: code })
  } finally {
    notifyWaiters(live)
  }
  if (live.detached) return
  if (run.status === 'completed') armIdle(live)
  else await closeRun(live, run.status === 'stopped' ? 'subagent_stopped' : 'subagent_failed')
}

/** Close the subagent: its session stopped and removed, its copy too. Its row stays, with its last answer. */
function closeRun(live: Live, reason: string): Promise<void> {
  if (live.detached) return Promise.resolve()
  live.closing ??= (async () => {
    const { run } = live
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined }
    if (run.status === 'running') {
      run.stoppedBy ??= reason
      live.abort.abort()
      end(live, 'stopped', { error: `Closed: ${reason}` })
    }
    run.closed = true
    try {
      await live.handle?.close(reason)
    } finally {
      live.settled = true
      live.settle()
      log.agent.info('light subagent closed', { id: run.id, parentSid: run.parentSid, reason, turns: run.turnsEnded })
      save()
      notifyWaiters(live)
      emitPanel(run.parentSid)
      prune()
    }
  })()
  return live.closing
}

/** Close it once nothing happened in it for keepIdleMs (a turn the user wrote in its conversation counts). */
function armIdle(live: Live): void {
  if (live.idleTimer) clearTimeout(live.idleTimer)
  live.idleTimer = undefined
  if (live.closing || live.detached || live.run.status === 'running') return
  const left = keepIdleMs - (Date.now() - Math.max(live.run.activeAt, live.handle?.activeAt ?? 0))
  if (left <= 0) { void closeRun(live, 'subagent_idle'); return }
  live.idleTimer = setTimeout(() => armIdle(live), left)
  live.idleTimer.unref?.()
}

function notifyWaiters(live: Live): void {
  const waiters = [...live.waiters]
  live.waiters.clear()
  for (const w of waiters) w()
}

/** The turn's answer: it completes now. */
function takeResult(live: Live, result: LightRunResult): void {
  const { run } = live
  if (run.status !== 'running') return
  run.warnings.push(...result.warnings)
  if (result.files) run.files = [...run.files, ...result.files]
  if (result.work) run.work = [...run.work, ...result.work]
  if (result.tokens) run.tokens = result.tokens
  end(live, 'completed', { answer: result.answer })
}

function end(live: Live, status: Exclude<LightSubagentStatus, 'running'>, o: { answer?: string; error?: string; errorCode?: string }): void {
  const { run } = live
  if (run.status !== 'running' || live.detached) return
  run.status = status
  run.endedAt = Date.now()
  run.activeAt = run.endedAt
  if (live.timer) clearTimeout(live.timer)
  if (o.answer !== undefined) {
    const answer = o.answer.length > ANSWER_KEEP_MAX ? `${o.answer.slice(0, ANSWER_KEEP_MAX)}\n\n[cut at ${ANSWER_KEEP_MAX} characters]` : o.answer
    run.answer = answer
    run.text = answer
  }
  run.prompt = run.prompt.slice(0, PROMPT_KEPT_MAX)
  // A stop is a stop whichever path made it (the panel, subagent_stop, the server's own), never an engine error.
  if (o.error) { run.error = o.error; run.errorCode = status === 'stopped' ? 'stopped' : o.errorCode; run.text = o.error }
  // A timeout or a stop also ends the engine's turn.
  if (!live.abort.signal.aborted && status !== 'completed') live.abort.abort()
  const turn = live.turnNo
  run.turnsEnded = Math.max(run.turnsEnded, turn)
  log.agent.info('light subagent ended', { id: run.id, parentSid: run.parentSid, status, ms: run.endedAt - run.startedAt, turn, error: run.error })
  // THIS turn as it ended, fixed now: a later turn changes the run, never this.
  const tell: TurnEnd = {
    status, ...(run.answer !== undefined && status === 'completed' ? { answer: run.answer } : {}),
    ...(run.error ? { error: run.error, errorCode: run.errorCode } : {}),
    body: endNotice(run, turn), told: false,
  }
  live.tells.set(turn, tell)
  save()
  const waited = live.waiters.size > 0
  notifyWaiters(live)
  emitPanel(run.parentSid)
  // Nobody took it from a call: tell the parent, unless a read takes it first.
  setTimeout(() => { if (!tell.told && !live.detached) void tellParent(run, turn, tell) }, waited ? TELL_GRACE_MS * 2 : TELL_GRACE_MS).unref?.()
}

/** The run of `parentSid` named `id` (a session never reads another's run). */
export function getLightSubagent(parentSid: string | undefined, id: string): LightSubagentRun {
  const live = runs.get(id)
  if (!live || (parentSid && live.run.parentSid !== parentSid)) throw new LightSubagentError('not_found', `No subagent ${id} in this session`, 404)
  return live.run
}

/** Whether caller turn `turn` of the run ended (or the run was closed before it could). */
export function turnEnded(run: LightSubagentRun, turn = run.turns): boolean {
  return run.closed || run.turnsEnded >= turn
}

/** Caller turn `turn` as it ended, once it did. */
export function turnResult(run: LightSubagentRun, turn: number): TurnEnd | undefined {
  return runs.get(run.id)?.tells.get(turn)
}

/** Wait up to `ms` for caller turn `turn` (default: the latest) to end; resolves either way. */
export async function waitLightSubagent(run: LightSubagentRun, ms: number, turn = run.turns): Promise<void> {
  const live = runs.get(run.id)
  const until = Date.now() + ms
  while (live && !turnEnded(run, turn) && Date.now() < until) {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); live.waiters.delete(done); resolve() }
      const t = setTimeout(done, until - Date.now())
      live.waiters.add(done)
    })
  }
}

/** The caller is answered with this run's end: the parent knows it now. */
export function markTold(run: LightSubagentRun, turn = run.turns): void {
  const tell = runs.get(run.id)?.tells.get(turn)
  if (tell && !tell.told) { tell.told = true; save() }
}

/** Stop the subagent (a running turn ends as stopped) and close it. `stopped`: it was open. */
export function stopLightSubagent(parentSid: string | undefined, id: string, by: string): { stopped: boolean; status: LightSubagentStatus } {
  const run = getLightSubagent(parentSid, id)
  const live = runs.get(id)!
  if (live.detached) throw new LightSubagentError('restarting', 'Walnut\'s server is restarting: stop it again in a moment', 503)
  if (live.closing) return { stopped: false, status: run.status }
  const wasRunning = run.status === 'running'
  if (wasRunning) {
    run.stoppedBy = by
    live.abort.abort()
    end(live, 'stopped', { error: `Stopped by ${by}` })
  }
  void closeRun(live, wasRunning ? 'subagent_stopped' : 'subagent_closed')
  return { stopped: true, status: run.status }
}

export function listLightSubagents(parentSid: string): LightSubagentRun[] {
  return [...runs.values()].map((l) => l.run).filter((r) => r.parentSid === parentSid).sort((a, b) => a.startedAt - b.startedAt)
}

/** Resolves once the subagent was closed and its session removed: tests, and a caller that must wait for it. */
export function lightSubagentSettled(id: string): Promise<void> {
  return runs.get(id)?.settledP ?? Promise.resolve()
}

/** A subagent this server still holds open (its session lives): the left-runs sweep leaves its folders alone. */
export function isLightSubagentLive(id: string): boolean {
  const live = runs.get(id)
  return !!live && !live.settled
}

export function hasLightSubagent(parentSid: string, id: string): boolean {
  return runs.get(id)?.run.parentSid === parentSid
}

/** The parent's Background tasks rows (display only: they never hold its turn open). */
export function lightSubagentRows(parentSid: string): BackgroundTaskInfo[] {
  return listLightSubagents(parentSid).map((run) => ({
    taskId: run.id,
    description: run.description,
    subagentType: engineLabel(run),
    taskType: 'walnut_subagent',
    status: run.status,
    engine: run.engine,
    ...(runs.get(run.id)?.handle?.sessionId && !run.closed ? { walnutSessionId: runs.get(run.id)!.handle!.sessionId! } : {}),
    ...(run.fromHost ? { host: run.host } : {}),
    ...(run.closed ? { closed: true } : {}),
    ...(run.tokens ? { tokens: run.tokens } : {}),
    ...(run.lastTool ? { lastTool: run.lastTool } : {}),
    ...(run.text ? { summary: run.text.length > ANSWER_SHOWN_MAX ? `${run.text.slice(0, ANSWER_SHOWN_MAX)}\n\n…` : run.text } : {}),
    ...(run.toolUseId ? { toolUseId: run.toolUseId } : {}),
    toolUses: run.toolUses,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt, durationMs: run.endedAt - run.startedAt } : {}),
    prompt: run.prompt.slice(0, 4_000),
  }))
}

/** One panel snapshot per gap at most: progress comes in bursts. */
function emitPanel(parentSid: string): void {
  if (emitTimers.has(parentSid)) return
  const t = setTimeout(() => {
    emitTimers.delete(parentSid)
    void emitNow(parentSid)
  }, PANEL_EMIT_GAP_MS)
  t.unref?.()
  emitTimers.set(parentSid, t)
}

async function emitNow(parentSid: string): Promise<void> {
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    const live = sessionRunner.findByClaudeId(parentSid)
    // A Claude Code runner sends its own ledger with these rows in it.
    if (live) { live.emitBackgroundTasks(); return }
    const { bus, EventNames } = await import('../event-bus.js')
    bus.emit(EventNames.SESSION_BACKGROUND_TASKS, {
      sessionId: parentSid, inFlight: 0, tasks: lightSubagentRows(parentSid), phases: [], agents: [],
    }, ['main-ai', 'web-ui'], { source: 'light-subagents' })
  } catch (err) {
    log.agent.warn('light subagent: panel update failed', { parentSid, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Drop ended runs past their keep (age, per parent, in all), oldest first; a running one stays. */
export function prune(now = Date.now()): void {
  const ended = [...runs.values()].filter((l) => l.settled && l.run.status !== 'running')
    .sort((a, b) => (a.run.endedAt ?? 0) - (b.run.endedAt ?? 0))
  const perParent = new Map<string, number>()
  for (const l of ended) perParent.set(l.run.parentSid, (perParent.get(l.run.parentSid) ?? 0) + 1)
  let total = ended.length
  for (const l of ended) {
    const mine = perParent.get(l.run.parentSid) ?? 0
    if (now - (l.run.endedAt ?? now) > KEEP_ENDED_MS || mine > KEEP_ENDED_PER_SESSION || total > KEEP_ENDED_TOTAL) {
      runs.delete(l.run.id)
      perParent.set(l.run.parentSid, mine - 1)
      total--
    }
  }
  if (runs.size === 0 && pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
}

/** An open subagent whose caller can no longer talk to it (its session stopped, archived, its task complete) is closed. */
async function closeOrphans(): Promise<void> {
  const open = [...runs.values()].filter((l) => !l.closing && l.run.status !== 'running')
  if (open.length === 0) return
  // No session store to read (starting, failing): nothing can be decided this round.
  if (!(await import('../session-db.js')).getDb()) return
  for (const l of open) {
    // A caller whose CLI only went quiet (stopped after its own idle time, a dropped link) comes back
    // and talks to it again: only one that is gone for good closes it. A failed read decides nothing.
    let gone: boolean
    try {
      const rec = await callerOf(l.run)
      gone = !rec || !!rec.archived
      if (!gone && rec?.taskId) {
        const { getTask } = await import('../task-manager.js')
        gone = (await getTask(rec.taskId).catch(() => null))?.phase === 'COMPLETE'
      }
    } catch { continue }
    if (gone) void closeRun(l, 'subagent_caller_gone')
  }
}

function armPrune(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(() => { prune(); void closeOrphans() }, PRUNE_EVERY_MS)
  pruneTimer.unref?.()
}

// ── Across a restart ──

/** What of each run outlives this server: every one not closed, and a closed one whose end its caller has not heard yet. */
interface SavedRun {
  run: LightSubagentRun
  handle?: SubagentSessionState
  tells: Array<[number, TurnEnd]>
  pending: Array<{ turn: number; message: string }>
  settled: boolean
}

const STATE_FILE = () => path.join(WALNUT_HOME, 'subagents-open.json')
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Write the runs down soon (changes come in bursts); a stopping server writes at once (saveNow). */
/** This server let every run go (it stops): it writes nothing more, the next one owns the file. */
let letGo = false

function save(): void {
  if (saveTimer || letGo) return
  saveTimer = setTimeout(() => { saveTimer = null; saveNow() }, 50)
  saveTimer.unref?.()
}

function saveNow(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (letGo) return
  const rows: SavedRun[] = []
  for (const l of runs.values()) {
    const untold = [...l.tells.values()].some((t) => !t.told)
    if (l.settled && !untold) continue
    const handle = l.handle?.state?.()
    // Only what the next server needs: ends not told yet, and the latest one (a read of it shows it).
    const tells = [...l.tells].filter(([turn, t]) => !t.told || turn === l.run.turnsEnded)
    rows.push({ run: l.run, ...(handle ? { handle } : {}), tells, pending: l.pending, settled: l.settled })
  }
  const f = STATE_FILE()
  try {
    if (rows.length === 0) { fs.rmSync(f, { force: true }); return }
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rows))
    fs.renameSync(tmp, f)
  } catch (err) {
    log.agent.warn('light subagents: writing their state failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

function readSaved(): SavedRun[] {
  let text: string
  try { text = fs.readFileSync(STATE_FILE(), 'utf8') } catch { return [] }
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) throw new Error('not a list')
    return raw as SavedRun[]
  } catch (err) {
    const aside = `${STATE_FILE()}.unreadable-${Date.now()}`
    try { fs.renameSync(STATE_FILE(), aside) } catch { /* gone meanwhile */ }
    log.agent.warn('light subagents: their state could not be read; kept aside (the sweep retires their sessions)', { aside, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * The server stops: every run is written down and let go, never stopped. Its session runs on in
 * its host's daemon (the session runner detaches sessions on a stop, never kills them), and the
 * next server takes it up (restoreLightSubagents).
 */
export async function detachAllLightSubagents(by: string): Promise<void> {
  const all = [...runs.values()]
  if (all.length === 0) return
  for (const l of all) {
    l.detached = true
    if (l.timer) clearTimeout(l.timer)
    if (l.idleTimer) { clearTimeout(l.idleTimer); l.idleTimer = undefined }
  }
  // Written before anything awaits: the process may end at any await from here.
  const kept = [...runs.values()].filter((l) => !l.settled).length
  saveNow()
  letGo = true
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
  await Promise.all(all.map((l) => l.handle?.detach?.().catch(() => {})))
  log.agent.info('light subagents written down for the next server', { by, open: kept, running: all.filter((l) => l.run.status === 'running').length })
}

/**
 * A new server takes up the runs the one before it wrote down: each is listed again at once (so
 * the left-runs sweep leaves its session alone), an end its caller has not heard yet is told now,
 * a turn the restart cut off is asked again of the same session, and the messages that waited
 * for it follow. A run whose session cannot be found again ends as failed, and its caller is told.
 */
export async function restoreLightSubagents(ready: Promise<unknown> = Promise.resolve()): Promise<number> {
  letGo = false
  const saved = readSaved()
  const taken: Array<{ live: Live; s: SavedRun }> = []
  const setups: Array<Promise<boolean>> = []
  // Listed at once, before any await: the left-runs sweep leaves a listed run's session alone, and
  // a message or a stop meanwhile waits in its chain for it to be taken up.
  for (const s of saved) {
    if (runs.has(s.run.id)) continue
    const live = newLive(s.run)
    live.tells = new Map(s.tells)
    live.pending = [...s.pending]
    if (s.settled) { live.settled = true; live.settle(); live.closing = Promise.resolve() }
    runs.set(s.run.id, live)
    // The session runner has reattached the sessions and replayed their queues first.
    const setup = ready.catch(() => {}).then(() => takeUp(live, s)).catch((err: unknown) => {
      log.agent.warn('light subagent: taking it up failed', { id: live.run.id, error: err instanceof Error ? err.message : String(err) })
      return false
    })
    live.chain = setup.then((go) => (go ? carryOn(live) : undefined)).catch(() => {})
    setups.push(setup)
    taken.push({ live, s })
  }
  if (taken.length === 0) return 0
  armPrune()
  log.agent.info('light subagents taken up from the server before', { runs: taken.length, running: taken.filter((t) => t.live.run.status === 'running').length })
  // Resolves once each is taken up (its session found again, its ends told): its turn runs on after.
  await Promise.all(setups)
  save()
  return taken.length
}

/** Its session found again and its untold ends told; true when it carries on (carryOn). */
async function takeUp(live: Live, s: SavedRun): Promise<boolean> {
  const { run } = live
  for (const [turn, tell] of live.tells) if (!tell.told) void tellParent(run, turn, tell)
  if (live.settled) return false
  let found = false
  try {
    if (runnerOverride) {
      const runner = runnerOverride
      const spec = specOf(live, run.parentSid)
      live.handle = { turn: (prompt, t) => runner({ ...spec, prompt, signal: t.signal, deadlineAt: t.deadlineAt, onProgress: t.onProgress }), close: async () => true }
      found = true
    } else if (s.handle) {
      const { SubagentSession } = await import('./on-host.js')
      const handle = await SubagentSession.restore(specOf(live, s.handle.callerSid), s.handle)
      live.handle = handle
      found = handle.taken
    }
  } catch (err) {
    log.agent.warn('light subagent: its session could not be taken up', { id: run.id, error: err instanceof Error ? err.message : String(err) })
  }
  // Stopped while it was being taken up: what it had is closed now.
  if (live.closing) { await live.closing; await live.handle?.close('subagent_stopped'); return false }
  if (run.closed) { await closeRun(live, 'subagent_closed'); return false }
  if (run.status === 'running') {
    if (!found) {
      end(live, 'failed', { error: 'Walnut\'s server restarted before its session had started, so it did not run: start it again with subagent_run', errorCode: 'engine_error' })
      await closeRun(live, 'subagent_failed')
      return false
    }
    if (run.turnDeadlineAt && run.turnDeadlineAt <= Date.now()) {
      end(live, 'failed', { error: `It ran out of its ${Math.round(run.timeoutMs / 60_000)} minutes and was stopped`, errorCode: 'timed_out' })
      await closeRun(live, 'subagent_failed')
      return false
    }
  } else if (!found) { await closeRun(live, 'subagent_failed'); return false }
  emitPanel(run.parentSid)
  return true
}

/** A run taken up goes on: the turn the restart cut off, then the messages sent before it, in order. */
async function carryOn(live: Live): Promise<void> {
  if (live.run.status === 'running') await runTurn(live, RESUME_PROMPT, false, true)
  else armIdle(live)
  for (let n = live.pending.length; n > 0 && !live.closing; n--) await runNext(live)
}

/** Its caller has subagents answering now: its own process stays alive for their answers (live-sessions.ts mustStay). */
export function hasRunningLightSubagents(parentSid: string): boolean {
  for (const l of runs.values()) if (l.run.parentSid === parentSid && !l.settled && (l.run.status === 'running' || l.pending.length > 0)) return true
  return false
}

/** The notification a parent gets for a run whose end no call returned. */
export function endNotice(run: LightSubagentRun, turn = run.turnsEnded): string {
  const head = `Your subagent ${run.id} (${engineLabel(run)}: "${run.description}") `
  const body = run.status === 'completed'
    ? `${turn > 1 ? 'answered your message' : 'finished'}. Its answer:\n\n${(run.answer || '(it answered nothing)').slice(0, 20_000)}`
    : run.status === 'stopped' ? `was stopped (${run.error ?? 'stopped'}).` : `failed: ${run.error ?? 'unknown error'}`
  return `${head}${body}`
}

/** A notice's last line, read when it is sent: whether the subagent still takes a message. */
function noticeNext(run: LightSubagentRun, tell: TurnEnd): string {
  return tell.status === 'completed' && !run.closed && !runs.get(run.id)?.closing
    ? `It keeps its context: to tell it more, call subagent_send {"id":"${run.id}","message":"..."}; its answer comes back to you the same way.`
    : 'It is closed: start a new one with subagent_run if you still need it.'
}

/**
 * Why the session that ran a subagent hears nothing of its end: a notice never wakes a stopped
 * session or one whose task is COMPLETE (the answer stays readable with subagent_read). Only a
 * running or idle session of an open task is told, as a Claude Code background agent's is.
 */
export async function parentHearsNothing(target: import('../types.js').SessionRecord | null | undefined): Promise<string | null> {
  if (!target) return 'no session'
  const { isLiveSessionStatus } = await import('../routines/session-target.js')
  if (target.archived) return 'its session is archived'
  // Stopped by a person, its task closed or gone, its team stopped: it stays as it is (the same
  // check every wait that continues a session by itself makes). Stopped by Walnut (its idle exit,
  // a restart, the live limit): the notice resumes it, as a message to it would.
  if (!isLiveSessionStatus(target.process_status)) {
    const { sessionWaitHoldsOff } = await import('../sessions/endpoint-wait.js')
    const held = PERSON_STOPS.has(String(target.status_reason ?? '')) ? 'person-stopped' : await sessionWaitHoldsOff(target)
    if (held) return `its session stays stopped (${held})`
  }
  if (target.taskId) {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(target.taskId).catch(() => null)
    if (task?.phase === 'COMPLETE') return 'its task is complete'
  }
  return null
}

/** A stop that was a person's own: their session is never resumed by a subagent's end. */
const PERSON_STOPS = new Set(['user_stopped', 'user_terminated'])

/**
 * The caller's session now: its record by id, or, when that id is gone (a resume that came back
 * as a new session, an engine switch), its task's session; the run follows it there.
 */
async function callerOf(run: LightSubagentRun): Promise<import('../types.js').SessionRecord | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const rec = await getSessionByClaudeId(run.parentSid)
  if (rec || !run.parentTaskId) return rec ?? null
  const { getTask } = await import('../task-manager.js')
  const sid = (await getTask(run.parentTaskId).catch(() => null))?.session_id
  if (!sid || sid === run.parentSid) return null
  const now = await getSessionByClaudeId(sid)
  if (now) {
    log.agent.info('light subagent: its caller is its task\'s session now', { id: run.id, from: run.parentSid, to: sid })
    run.parentSid = sid
    save()
  }
  return now ?? null
}

/** Ends being told now (told is written down only once the notice is in the caller's queue). */
const telling = new Set<TurnEnd>()

async function tellParent(run: LightSubagentRun, turn: number, tell: TurnEnd): Promise<void> {
  if (tell.told || telling.has(tell)) return
  telling.add(tell)
  try {
    const target = await callerOf(run)
    const quiet = await parentHearsNothing(target)
    if (quiet || !target) {
      log.agent.info('light subagent end not told: its session is not there to hear it', { id: run.id, parentSid: run.parentSid, why: quiet ?? 'no session' })
      tell.told = true
      return
    }
    const { deliverToSession } = await import('../sessions/session-send-core.js')
    const { NOTICE_SOURCE } = await import('../sessions/subtask-notices.js')
    const { liveDelivery } = await import('../sessions/ask-answer.js')
    const { isLiveSessionStatus } = await import('../routines/session-target.js')
    const text = `${tell.body}\n\n${noticeNext(run, tell)}`
    const send = async (to: import('../types.js').SessionRecord, live: boolean) => deliverToSession(to, {
      busText: text, enqueueText: text, source: NOTICE_SOURCE,
      ...(to.taskId ? { taskId: to.taskId } : {}),
      // One per turn: a later turn's notice is never taken for an earlier one still queued.
      messageId: `sa-end-${run.id}-${turn}`, endsWait: true,
      // A live caller: only while it is still live as checked (a person's Stop meanwhile wins). One
      // Walnut stopped: the row resumes it.
      ...(live ? { liveOnly: await liveDelivery(to.claudeSessionId) } : {}),
    })
    try {
      await send(target, isLiveSessionStatus(target.process_status))
    } catch (err) {
      // It went quiet between the check and the write (its idle exit): told again as a stopped one is, unless a person stopped it.
      const now = await callerOf(run)
      if (!now || isLiveSessionStatus(now.process_status) || await parentHearsNothing(now)) throw err
      await send(now, false)
    }
    tell.told = true
    log.agent.info('light subagent end told to its session', { id: run.id, parentSid: run.parentSid, turn })
  } catch (err) {
    tell.tries = (tell.tries ?? 0) + 1
    log.agent.warn('light subagent: telling the session failed', { id: run.id, parentSid: run.parentSid, tries: tell.tries, error: err instanceof Error ? err.message : String(err) })
    if (tell.tries < TELL_TRIES) setTimeout(() => { if (!runs.get(run.id)?.detached) void tellParent(run, turn, tell) }, TELL_RETRY_MS).unref?.()
  } finally {
    telling.delete(tell)
    save()
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? 'Subagent'
}
