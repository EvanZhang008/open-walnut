/**
 * The comparison runner: one job at a time, in this process. A job takes the
 * newest takes (or the ones named), runs each ready engine that has no text
 * for a take yet (a stored failure is tried again; `force` runs again what is
 * stored), then the judge, then the scores. "Recalculate estimated errors" is a job too
 * (`judgeOnly`), so it waits its turn like any other.
 *
 * The config is read again before every step: a step runs only while the
 * experiment is on and its engine is switched on and (if it sends anything)
 * consented. A settings save stops the step in flight (its signal aborts the
 * upload), and the step runs again only if it is still allowed. It waits while
 * the user dictates, so the in-use engine always answers the user first. One
 * take's failure, even of the store, never stops the rest of the job.
 */
import { log } from '../../../logging/index.js'
import type { Config } from '../../types.js'
import { voiceInputLive } from '../media-hold-runtime.js'
import { COMPARE_ENGINES, JUDGE, engineMayRun } from './engines.js'
import { judgeTake, needsJudge, rescore } from './judge.js'
import { compareFlag } from './settings.js'
import { compareStore, takeIdOf, validTakeId } from './store.js'
import { ensureTake, readTakeAudio, recentRecordings } from './takes-source.js'
import { EngineStateError, type AudioRef, type CompareEngine, type CompareTake } from './types.js'

export const LIVE_PAUSE_MS = 15_000
const PAUSE_POLL_MS = 1_000
const DEFAULT_LAST = 20
const MAX_LAST = 500

export interface RunRequest {
  last?: number
  takeIds?: string[]
  engines?: string[]
  force?: boolean
  sinceMs?: number
  /** Only ask the judge again for the named takes (the user's Recalculate estimated errors). */
  judgeOnly?: boolean
}
export type RunState = 'queued' | 'running' | 'failed' | 'done'
export interface UnitState { state: RunState; error?: string }

export interface RunProgress {
  running: boolean
  done: number
  total: number
  current?: string
  engine?: string
  startedAt?: string
  finishedAt?: string
  lastError?: string
  /** The recordings this job planned to compare (set when it starts, kept after it ends). */
  takes?: number
  /** The recordings it actually compared so far: an engine or the judge ran on them (a stop, a
   *  switch turned off or a skipped take leaves a planned one out). */
  compared?: number
  /** Jobs waiting behind this one. */
  queued: number
}

let progress: RunProgress = { running: false, done: 0, total: 0, queued: 0 }
const waiting: RunRequest[] = []
/** Per take, per engine (and `judge`): the state in the last job that touched it. */
const states = new Map<string, Record<string, UnitState>>()
let loop: Promise<void> | null = null
/** The step in flight: aborted by a settings save or a stop. */
let stepAbort: AbortController | null = null
/** Bumped by every settings save: a step that sees it moved checks its engine again. */
let settingsGeneration = 0
/** Bumped by stopAllRuns: the job in flight ends at its next step. */
let stopGeneration = 0

export function runProgress(): RunProgress {
  return { ...progress, queued: waiting.length }
}

export function runStatesOf(takeId: string): Record<string, UnitState> | undefined {
  const s = states.get(takeId)
  return s ? { ...s } : undefined
}

function setState(takeId: string, engine: string, state: UnitState): void {
  states.set(takeId, { ...(states.get(takeId) ?? {}), [engine]: state })
}

/** The units this job left queued or running (it ended early): no state, so their Retry shows again. */
function clearUnfinished(units: Array<{ takeId: string; engine: string }>): void {
  for (const { takeId, engine } of units) {
    const s = states.get(takeId)
    const unit = s?.[engine]
    if (!s || !unit || (unit.state !== 'queued' && unit.state !== 'running')) continue
    const { [engine]: _gone, ...rest } = s
    if (Object.keys(rest).length) states.set(takeId, rest)
    else states.delete(takeId)
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function refOf(takeId: string): AudioRef | null {
  if (!validTakeId(takeId)) return null
  return takeId.startsWith('phone-') ? { kind: 'archive', id: takeId.slice(6) } : { kind: 'recording', id: takeId.slice(4) }
}

/** Queue a job; it starts when the one before it ends. */
export function runComparison(req: RunRequest = {}): RunProgress {
  waiting.push(req)
  loop ??= (async () => {
    while (waiting.length) {
      const next = waiting.shift()!
      await runJob(next).catch((err) => {
        progress = { ...progress, lastError: errorText(err) }
        log.stt.warn(`voice accuracy run failed: ${errorText(err)}`)
      })
    }
  })().finally(() => { loop = null })
  return runProgress()
}

/** Resolves when the queue is empty (tests and the nightly run). */
export async function runIdle(): Promise<void> {
  while (loop) await loop
}

/** A settings save: the step in flight stops (its upload is aborted) and checks its engine again. */
export function settingsChanged(): void {
  settingsGeneration++
  stepAbort?.abort(new Error('the settings changed'))
}

/** Stop the job in flight and drop the queued ones (Delete comparison data). */
export async function stopAllRuns(): Promise<void> {
  waiting.length = 0
  stopGeneration++
  stepAbort?.abort(new Error('stopped'))
  await runIdle()
}

async function freshConfig(): Promise<Config> {
  const { getConfig } = await import('../../config-manager.js')
  return getConfig()
}

/**
 * Waits out a live dictation, then reads the config again: null when the job
 * must stop (the experiment turned off, or a stop).
 */
async function mayGoOn(stopAt: number): Promise<Config | null> {
  while (voiceInputLive(LIVE_PAUSE_MS)) {
    if (stopGeneration !== stopAt) return null
    progress = { ...progress, engine: 'paused while you dictate' }
    await sleep(PAUSE_POLL_MS)
  }
  if (stopGeneration !== stopAt || !(await compareFlag.on())) return null
  return freshConfig()
}

function needsRun(take: CompareTake, engine: CompareEngine, force: boolean): boolean {
  const result = take.results[engine.id]
  return force || !result || result.text === undefined
}

/**
 * The engines a take still needs, hearing engines first. One that edits another's text runs only
 * where that text is stored or comes in this job (no failure "no text to clean up yet" per take).
 */
function enginesToRun(take: CompareTake, ordered: CompareEngine[], force: boolean): CompareEngine[] {
  const hearing = ordered.filter((e) => !e.after && needsRun(take, e, force))
  const editing = ordered.filter((e) => e.after && needsRun(take, e, force)
    && (take.results[e.after]?.text !== undefined || hearing.some((h) => h.id === e.after)))
  return [...hearing, ...editing]
}

/** Runs `fn` with a signal a settings save aborts; a step aborted that way runs again if `allowed` still says so. */
async function guardedStep<T>(allowed: (config: Config) => boolean, stopAt: number, fn: (config: Config, signal: AbortSignal) => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const config = await mayGoOn(stopAt)
    if (!config || !allowed(config)) return { ran: false }
    const generation = settingsGeneration
    const controller = new AbortController()
    stepAbort = controller
    try {
      return { ran: true, value: await fn(config, controller.signal) }
    } catch (err) {
      // Stopped by a settings save: look at the engine again before anything is stored.
      if (controller.signal.aborted && (settingsGeneration !== generation || stopGeneration !== stopAt)) continue
      throw err
    } finally {
      if (stepAbort === controller) stepAbort = null
    }
  }
  return { ran: false }
}

async function runJob(req: RunRequest): Promise<void> {
  if (!(await compareFlag.on())) return
  const stopAt = stopGeneration
  const config = await freshConfig()
  const named = !!req.takeIds?.length
  const refs = named
    ? req.takeIds!.map(refOf).filter((r): r is AudioRef => r !== null)
    : await recentRecordings(MAX_LAST, req.sinceMs)
  const force = req.force === true
  const wanted = req.judgeOnly ? [] : req.engines?.length ? COMPARE_ENGINES.filter((e) => req.engines!.includes(e.id)) : COMPARE_ENGINES
  // Engines a job plans for: switched on, consented, set up (the switch and consent are checked again per step).
  const ready: CompareEngine[] = []
  for (const engine of wanted) {
    if ((await engine.status(config).catch(() => ({ state: 'not-installed' }))).state === 'ready') ready.push(engine)
  }
  const judgeReady = (await JUDGE.status(config)).state === 'ready'
  // Named takes run as named; otherwise the newest `last` takes not yet complete.
  const limit = named ? refs.length : Math.max(1, Math.min(MAX_LAST, req.last ?? DEFAULT_LAST))
  // Hearing engines first, then the ones that edit their text.
  const ordered = [...ready.filter((e) => !e.after), ...ready.filter((e) => e.after)]
  const plan: Array<{ take: CompareTake; engines: CompareEngine[] }> = []
  const units: Array<{ takeId: string; engine: string }> = []
  for (const ref of refs) {
    if (plan.length >= limit) break
    try {
      const existing = await compareStore.get(takeIdOf(ref))
      if (req.judgeOnly && !existing) continue
      if (existing && !named && !enginesToRun(existing, ordered, force).length && !(judgeReady && needsJudge(existing, config))) continue
      const take = existing ?? await ensureTake(ref)
      if (!take) continue
      const engines = enginesToRun(take, ordered, force)
      for (const e of engines) { setState(take.id, e.id, { state: 'queued' }); units.push({ takeId: take.id, engine: e.id }) }
      if (req.judgeOnly) { setState(take.id, JUDGE.id, { state: 'queued' }); units.push({ takeId: take.id, engine: JUDGE.id }) }
      plan.push({ take, engines })
    } catch (err) {
      // One take that cannot be read or stored is skipped; the rest run.
      log.stt.warn(`voice accuracy: skipped a take: ${errorText(err)}`)
    }
  }
  progress = {
    running: true, done: 0, total: plan.reduce((n, p) => n + p.engines.length + (req.judgeOnly ? 1 : 0), 0), takes: plan.length, compared: 0,
    startedAt: new Date().toISOString(), queued: waiting.length,
  }
  const stopped = new Map<string, string>()
  try {
    for (const step of plan) {
      if (stopGeneration !== stopAt || !(await compareFlag.on())) return
      try {
        if (await runTake(step, { force, stopAt, stopped, judgeReady: judgeReady || !!req.judgeOnly, judgeOnly: !!req.judgeOnly })) {
          progress = { ...progress, compared: (progress.compared ?? 0) + 1 }
        }
      } catch (err) {
        progress = { ...progress, lastError: `${step.take.id}: ${errorText(err)}` }
        log.stt.warn(`voice accuracy: a take failed: ${errorText(err)}`)
      }
    }
  } finally {
    clearUnfinished(units)
    progress = { ...progress, running: false, current: undefined, engine: undefined, finishedAt: new Date().toISOString() }
  }
}

/** One take's engines, then its judge or scores; true when anything ran on it (it counts as compared). */
async function runTake(
  step: { take: CompareTake; engines: CompareEngine[] },
  opts: { force: boolean; stopAt: number; stopped: Map<string, string>; judgeReady: boolean; judgeOnly: boolean },
): Promise<boolean> {
  let take = step.take
  let audio: { audio: string; format: string } | null | undefined
  let changed = false
  for (const engine of step.engines) {
    progress = { ...progress, current: take.id, engine: engine.id }
    const reason = opts.stopped.get(engine.id)
    if (reason) { setState(take.id, engine.id, { state: 'failed', error: reason }); progress.done++; continue }
    const t0 = Date.now()
    try {
      const out = await guardedStep((config) => engineMayRun(engine, config), opts.stopAt, async (config, signal) => {
        setState(take.id, engine.id, { state: 'running' })
        progress = { ...progress, current: take.id, engine: engine.id }
        const input = engine.after
          ? { text: take.results[engine.after]?.text }
          : { ...((audio ??= await readTakeAudio(take.audioRef)) ?? {}), durationSec: take.durationSec }
        if (!engine.after && !audio) throw new Error('the recording is gone')
        return engine.run(input, { config, signal })
      })
      // Not allowed any more (switched off, consent taken back, the experiment off): nothing is stored.
      if (!out.ran) { progress.done++; continue }
      take = await compareStore.upsert(take.id, { results: { [engine.id]: { text: out.value.text, ms: out.value.ms, at: new Date().toISOString(), ...(out.value.model ? { model: out.value.model } : {}) } } })
      setState(take.id, engine.id, { state: 'done' })
      changed = true
    } catch (err) {
      const error = errorText(err)
      setState(take.id, engine.id, { state: 'failed', error })
      progress = { ...progress, lastError: `${engine.id}: ${error}` }
      // A bad key or a used-up quota stops that engine for the rest of the job.
      if (err instanceof EngineStateError) opts.stopped.set(engine.id, error)
      take = await compareStore.upsert(take.id, { results: { [engine.id]: { error, ms: Date.now() - t0, at: new Date().toISOString() } } }).catch(() => take)
      changed = true
    }
    progress.done++
  }
  const judged = await finishTake(take, opts.stopAt, { judgeReady: opts.judgeReady, force: opts.judgeOnly || (opts.force && changed) })
  if (opts.judgeOnly) progress.done++
  return changed || judged
}

/** The judge when the take needs one (and may have one), else the scores again; true when the judge was asked. */
async function finishTake(take: CompareTake, stopAt: number, opts: { judgeReady: boolean; force: boolean }): Promise<boolean> {
  const config = await mayGoOn(stopAt)
  if (!config) return false
  if (opts.judgeReady && (opts.force || needsJudge(take, config))) {
    progress = { ...progress, current: take.id, engine: JUDGE.id }
    try {
      const out = await guardedStep((c) => engineMayRun(JUDGE, c), stopAt, async (c, signal) => {
        setState(take.id, JUDGE.id, { state: 'running' })
        return judgeTake(take, c, { force: opts.force, signal })
      })
      if (out.ran) setState(take.id, JUDGE.id, { state: 'done' })
      return out.ran
    } catch (err) {
      setState(take.id, JUDGE.id, { state: 'failed', error: errorText(err) })
      progress = { ...progress, lastError: `judge: ${errorText(err)}` }
      return true
    }
  }
  if (take.reference) await rescore(take)
  return false
}

/** Queue the judge again for one take (the user's Recalculate estimated errors); the poll of GET /run follows it. */
export async function judgeAgain(takeId: string): Promise<RunProgress> {
  if (!(await compareStore.has(takeId))) throw new Error('no such take')
  return runComparison({ takeIds: [takeId], judgeOnly: true })
}

/** Test hook. */
export function _resetRunnerForTest(): void {
  progress = { running: false, done: 0, total: 0, queued: 0 }
  waiting.length = 0
  states.clear()
}
