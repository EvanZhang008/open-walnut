/**
 * The light subagents a session runs (types.ts), kept in this server's memory only:
 * a run is one prompt of one turn, so nothing of it needs to outlive the server. Each
 * run is a row of its parent session's Background tasks panel while it runs and for a
 * while after, and its answer goes back to the parent: in the call that waits for it,
 * or, when nothing waited (a background run, or a wait that ran out of time), as one
 * notification into the parent session once it ends.
 */
import crypto from 'node:crypto'
import { log } from '../../logging/index.js'
import { engineCaps } from '../agents/engine-registry.js'
import type { BackgroundTaskInfo } from '../event-types.js'
import type { SessionEngine } from '../types.js'
import { LIGHT_SUBAGENT_ENGINES, LightSubagentError, type LightRunner, type LightRunSpec, type LightSubagentStatus } from './types.js'

/** Running at once per parent session, and on this server. */
export const MAX_RUNNING_PER_SESSION = 4
export const MAX_RUNNING_TOTAL = 12
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
const PANEL_EMIT_GAP_MS = 400
const PROMPT_MAX = 200_000
const ANSWER_SHOWN_MAX = 60_000

export interface LightSubagentRun {
  id: string
  parentSid: string
  parentTaskId?: string
  host: string
  cwd: string
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
  stoppedBy?: string
  /** Its end reached the parent (a call returned it, or the notification went in). */
  told: boolean
}

interface Live {
  run: LightSubagentRun
  abort: AbortController
  waiters: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  /** Its runner returned: the worker is gone. A stopped run holds its slot until then. */
  settled: boolean
  settledP: Promise<void>
}

const runs = new Map<string, Live>()
/** Starts past the limit check and still checking the engine: they hold a slot already. */
const reserving = new Map<string, number>()
let pruneTimer: ReturnType<typeof setInterval> | null = null
const emitTimers = new Map<string, ReturnType<typeof setTimeout>>()
let runnerOverride: LightRunner | null = null
let skipEngineCheck = false

/** Tests: run every subagent with this runner instead of a real engine. */
export function _setLightRunnerForTest(fn: LightRunner | null): void { runnerOverride = fn }
/** Tests: run on a mock adapter whatever the machine has installed. */
export function _skipEngineCheckForTest(skip: boolean): void { skipEngineCheck = skip }
export function _resetLightSubagentsForTest(): void {
  for (const live of runs.values()) { live.abort.abort(); if (live.timer) clearTimeout(live.timer) }
  runs.clear()
  reserving.clear()
  for (const t of emitTimers.values()) clearTimeout(t)
  emitTimers.clear()
}

export interface StartLightSubagent {
  engine: string
  model?: string
  effort?: string
  prompt: string
  description?: string
  background?: boolean
  timeoutMin?: number
  toolUseId?: string
}

export function engineLabel(run: Pick<LightSubagentRun, 'engine' | 'model'>): string {
  const name = engineCaps(run.engine).displayName
  return run.model ? `${name} · ${run.model}` : name
}

/** Start one run for the session `parentSid` (it must be a session Walnut knows). */
export async function startLightSubagent(parentSid: string | undefined, req: StartLightSubagent): Promise<LightSubagentRun> {
  if (!parentSid) throw new LightSubagentError('no_session', 'A subagent runs inside a session: call it from a session (its WALNUT_SESSION_ID names it)', 400)
  const engine = req.engine as SessionEngine
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
  const host = !record.host || record.host === 'local' ? '__local__' : record.host
  const cwd = record.cwd
  if (!cwd) throw new LightSubagentError('no_session', `Session ${sid} has no working directory`, 409)
  const { acpSupposedFullAccess } = await import('../../providers/acp-permission-posture.js')
  // The slot is taken with no await before it, and handed to the run with none after the
  // check: starts at once never pass the limit together.
  const held = [...runs.values()].filter((l) => !l.settled)
  const reservedAll = [...reserving.values()].reduce((a, b) => a + b, 0)
  if (held.filter((l) => l.run.parentSid === sid).length + (reserving.get(sid) ?? 0) >= MAX_RUNNING_PER_SESSION) {
    throw new LightSubagentError('too_many', `This session already runs ${MAX_RUNNING_PER_SESSION} subagents: wait for one (subagent_read) or stop one (subagent_stop)`, 429)
  }
  if (held.length + reservedAll >= MAX_RUNNING_TOTAL) {
    throw new LightSubagentError('too_many', `Walnut already runs ${MAX_RUNNING_TOTAL} subagents across sessions: try again when one ends`, 429)
  }
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
    told: false,
  }
  let settle!: () => void
  const live: Live = { run, abort: new AbortController(), waiters: new Set(), settled: false, settledP: new Promise<void>((r) => { settle = r }) }
  runs.set(run.id, live)
  armPrune()
  log.agent.info('light subagent started', { id: run.id, parentSid: sid, engine, model: run.model, host, cwd, background: run.background })
  live.timer = setTimeout(() => end(live, 'failed', { error: `It ran out of its ${timeoutMin} minutes and was stopped`, errorCode: 'timed_out' }), run.timeoutMs)
  live.timer.unref?.()
  void execute(live, record.acpRuntimeId || sid).finally(() => {
    live.settled = true
    settle()
    prune()
  })
  emitPanel(sid)
  return run
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

async function execute(live: Live, callerSid: string): Promise<void> {
  const { run } = live
  const spec: LightRunSpec = {
    runtimeId: `lsa-${run.id.slice(3)}-${crypto.randomBytes(3).toString('hex')}`,
    engine: run.engine, host: run.host, cwd: run.cwd,
    ...(run.model ? { model: run.model } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    prompt: run.prompt,
    fullAccess: run.fullAccess,
    parentSid: run.parentSid,
    callerSid,
    deadlineAt: run.startedAt + run.timeoutMs,
    ...(run.parentTaskId ? { parentTaskId: run.parentTaskId } : {}),
    signal: live.abort.signal,
    onProgress: (p) => {
      if (run.status !== 'running') return
      if (p.kind === 'text') run.text = p.text
      else if (p.kind === 'tool') { run.toolUses++; run.lastTool = p.toolName; run.text = '' }
      else if (p.kind === 'tokens') run.tokens = p.tokens
      emitPanel(run.parentSid)
    },
  }
  try {
    const runner = runnerOverride ?? (engineCaps(run.engine).runtimeKind === 'acp'
      ? (await import('../../providers/light-subagent-acp.js')).runAcpLight
      : (await import('../../providers/light-subagent-claude.js')).runClaudeLight)
    const result = await runner(spec)
    run.warnings.push(...result.warnings)
    if (result.tokens) run.tokens = result.tokens
    end(live, 'completed', { answer: result.answer })
  } catch (err) {
    const code = err instanceof LightSubagentError ? err.code : 'engine_error'
    end(live, live.abort.signal.aborted && run.stoppedBy ? 'stopped' : 'failed', { error: err instanceof Error ? err.message : String(err), errorCode: code })
  }
}

function end(live: Live, status: Exclude<LightSubagentStatus, 'running'>, o: { answer?: string; error?: string; errorCode?: string }): void {
  const { run } = live
  if (run.status !== 'running') return
  run.status = status
  run.endedAt = Date.now()
  if (live.timer) clearTimeout(live.timer)
  if (o.answer !== undefined) {
    const answer = o.answer.length > ANSWER_KEEP_MAX ? `${o.answer.slice(0, ANSWER_KEEP_MAX)}\n\n[cut at ${ANSWER_KEEP_MAX} characters]` : o.answer
    run.answer = answer
    run.text = answer
  }
  run.prompt = run.prompt.slice(0, PROMPT_KEPT_MAX)
  // A stop is a stop whichever path made it (the panel, subagent_stop, the server's own), never an engine error.
  if (o.error) { run.error = o.error; run.errorCode = status === 'stopped' ? 'stopped' : o.errorCode; run.text = o.error }
  // A timeout or a stop also ends the engine's turn and worker.
  if (!live.abort.signal.aborted && status !== 'completed') live.abort.abort()
  log.agent.info('light subagent ended', { id: run.id, parentSid: run.parentSid, status, ms: run.endedAt - run.startedAt, error: run.error })
  const waiters = [...live.waiters]
  live.waiters.clear()
  for (const w of waiters) w()
  emitPanel(run.parentSid)
  // Nobody was waiting: tell the parent, unless a read takes it first.
  setTimeout(() => { if (!run.told) void tellParent(run) }, waiters.length > 0 ? TELL_GRACE_MS * 2 : TELL_GRACE_MS).unref?.()
}

/** The run of `parentSid` named `id` (a session never reads another's run). */
export function getLightSubagent(parentSid: string | undefined, id: string): LightSubagentRun {
  const live = runs.get(id)
  if (!live || (parentSid && live.run.parentSid !== parentSid)) throw new LightSubagentError('not_found', `No subagent ${id} in this session`, 404)
  return live.run
}

/** Wait up to `ms` for the run to end; resolves either way. */
export async function waitLightSubagent(run: LightSubagentRun, ms: number): Promise<void> {
  const live = runs.get(run.id)
  if (!live || run.status !== 'running' || ms <= 0) return
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); live.waiters.delete(done); resolve() }
    const t = setTimeout(done, ms)
    live.waiters.add(done)
  })
}

/** The caller is answered with this run's end: the parent knows it now. */
export function markTold(run: LightSubagentRun): void {
  if (run.status !== 'running') run.told = true
}

export function stopLightSubagent(parentSid: string | undefined, id: string, by: string): { stopped: boolean; status: LightSubagentStatus } {
  const run = getLightSubagent(parentSid, id)
  const live = runs.get(id)!
  if (run.status !== 'running') return { stopped: false, status: run.status }
  run.stoppedBy = by
  live.abort.abort()
  end(live, 'stopped', { error: `Stopped by ${by}` })
  return { stopped: true, status: 'stopped' }
}

export function listLightSubagents(parentSid: string): LightSubagentRun[] {
  return [...runs.values()].map((l) => l.run).filter((r) => r.parentSid === parentSid).sort((a, b) => a.startedAt - b.startedAt)
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

function armPrune(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(() => prune(), PRUNE_EVERY_MS)
  pruneTimer.unref?.()
}

/**
 * The server stops: stop every run and wait (bounded) for its worker to end, so none
 * runs on with no one in control of it. The host's daemon stops one this misses too
 * (light-subagent-acp.ts: its deadline and no-subscriber grace).
 */
export async function stopAllLightSubagents(by: string, waitMs: number): Promise<void> {
  const live = [...runs.values()].filter((l) => l.run.status === 'running')
  if (live.length === 0) return
  for (const l of live) { l.run.stoppedBy = by; end(l, 'stopped', { error: `Stopped: ${by}` }) }
  await Promise.race([
    Promise.all(live.map((l) => l.settledP)),
    new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref?.()),
  ])
  log.agent.info('light subagents stopped with the server', { runs: live.length, settled: live.filter((l) => l.settled).length })
}

/** The notification a parent gets for a run whose end no call returned. */
export function endNotice(run: LightSubagentRun): string {
  const head = `Your subagent ${run.id} (${engineLabel(run)}: "${run.description}") `
  const body = run.status === 'completed'
    ? `finished. Its answer:\n\n${(run.answer || '(it answered nothing)').slice(0, 20_000)}`
    : run.status === 'stopped' ? `was stopped (${run.error ?? 'stopped'}).` : `failed: ${run.error ?? 'unknown error'}`
  return `${head}${body}\n\nsubagent_read {"id":"${run.id}"} shows it again.`
}

/**
 * Why the session that ran a subagent hears nothing of its end: a notice never wakes a stopped
 * session or one whose task is COMPLETE (the answer stays readable with subagent_read). Only a
 * running or idle session of an open task is told, as a Claude Code background agent's is.
 */
export async function parentHearsNothing(target: import('../types.js').SessionRecord | null | undefined): Promise<string | null> {
  if (!target) return 'no session'
  const { isLiveSessionStatus } = await import('../routines/session-target.js')
  if (target.archived || !isLiveSessionStatus(target.process_status)) return `its session is ${target.archived ? 'archived' : target.process_status ?? 'stopped'}`
  if (target.taskId) {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(target.taskId).catch(() => null)
    if (task?.phase === 'COMPLETE') return 'its task is complete'
  }
  return null
}

async function tellParent(run: LightSubagentRun): Promise<void> {
  if (run.told) return
  run.told = true
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const target = await getSessionByClaudeId(run.parentSid)
    const quiet = await parentHearsNothing(target)
    if (quiet || !target) {
      log.agent.info('light subagent end not told: its session is not there to hear it', { id: run.id, parentSid: run.parentSid, why: quiet ?? 'no session' })
      return
    }
    const { deliverToSession } = await import('../sessions/session-send-core.js')
    const { NOTICE_SOURCE } = await import('../sessions/subtask-notices.js')
    const { liveDelivery } = await import('../sessions/ask-answer.js')
    const text = endNotice(run)
    // Only into the session still live as checked: a Stop between the check and the write wins.
    await deliverToSession(target, {
      busText: text, enqueueText: text, source: NOTICE_SOURCE,
      ...(target.taskId ? { taskId: target.taskId } : {}),
      messageId: `sa-end-${run.id}`, endsWait: true,
      liveOnly: await liveDelivery(target.claudeSessionId),
    })
    log.agent.info('light subagent end told to its session', { id: run.id, parentSid: run.parentSid, status: run.status })
  } catch (err) {
    log.agent.warn('light subagent: telling the session failed', { id: run.id, parentSid: run.parentSid, error: err instanceof Error ? err.message : String(err) })
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? 'Subagent'
}
