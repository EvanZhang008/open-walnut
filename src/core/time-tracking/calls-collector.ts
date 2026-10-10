/**
 * Calls collector: watches macOS power assertions for call apps (calls.ts) and
 * keeps the intervals Mac-local (calls-store.ts).
 *
 * Two feeds, both child processes so the web server's event loop never parses
 * more than a line at a time:
 *   - live: `pmset -g assertions` every 30 s (~35 ms each), the calls open now;
 *   - backfill: `pmset -g log` streamed line by line (~20 MB, ~8 s), the exact
 *     create/release times of the last week. It runs soon after start and then
 *     every few hours, so time Walnut was down is filled in and a first run
 *     recovers the week macOS still holds (the log rotates after ~7 days).
 *
 * Gated like the foreground sampler: macOS, not the cloud companion, not an
 * ephemeral server, and only while the user has outside activity on
 * (`time.outside.enabled`; `time.calls.enabled: false` turns calls off alone).
 */

import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { CLOUD_MODE, IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { callAppSet, createLogFolder, parseAssertionsNow, type OpenCall, type Span } from './calls.js'
import { appendCallLines, callLine, coverageLine } from './calls-store.js'

const PMSET = '/usr/bin/pmset'
const LIVE_EVERY_MS = 30_000
/** An open call or a coverage stretch is written at least this often, so a crash loses little. */
export const PERSIST_EVERY_MS = 5 * 60_000
/** Ticks further apart than this (sleep, a hang) start a new coverage stretch. */
export const COVERAGE_BREAK_MS = 90_000
const ASSERT_TIMEOUT_MS = 5_000
const LOG_TIMEOUT_MS = 90_000
const BACKFILL_FIRST_DELAY_MS = 60_000
const BACKFILL_EVERY_MS = 6 * 3_600_000
/** A backfill this recent (another server run did it) is not repeated at start. */
const BACKFILL_FRESH_MS = 3 * 3_600_000

// ── Pure live state machine ──

interface LiveCall { app: string; startMs: number; lastSeenMs: number; writtenAt: number }

export interface LiveState {
  open: Map<string, LiveCall>
  cov: { startMs: number; lastMs: number; writtenAt: number } | null
}

export function emptyLiveState(): LiveState {
  return { open: new Map(), cov: null }
}

type Line = { startMs: number; line: string }

/**
 * One live sample. `seen` is parseAssertionsNow at `nowMs`, or null when the
 * command failed (the watch has a hole: coverage closes, open calls end at their
 * last sighting). Returns the lines to append; mutates `state`.
 */
export function applyLiveSample(state: LiveState, seen: readonly OpenCall[] | null, nowMs: number): Line[] {
  const lines: Line[] = []
  const writeCov = (c: NonNullable<LiveState['cov']>): void => {
    if (c.lastMs > c.startMs) lines.push({ startMs: c.startMs, line: coverageLine([c.startMs, c.lastMs], 'live') })
  }
  const writeCall = (c: LiveCall, endMs: number): void => {
    if (endMs > c.startMs) lines.push({ startMs: c.startMs, line: callLine({ app: c.app, startMs: c.startMs, endMs }, 'live') })
  }

  if (state.cov && (seen === null || nowMs - state.cov.lastMs > COVERAGE_BREAK_MS)) {
    writeCov(state.cov)
    state.cov = null
  }
  if (seen === null) {
    for (const c of state.open.values()) writeCall(c, c.lastSeenMs)
    state.open.clear()
    return lines
  }
  if (!state.cov) state.cov = { startMs: nowMs, lastMs: nowMs, writtenAt: nowMs }
  else state.cov.lastMs = nowMs
  if (nowMs - state.cov.writtenAt >= PERSIST_EVERY_MS) {
    writeCov(state.cov)
    state.cov.writtenAt = nowMs
  }

  const keys = new Set<string>()
  for (const s of seen) {
    keys.add(s.key)
    const c = state.open.get(s.key)
    if (!c) {
      const fresh: LiveCall = { app: s.app, startMs: s.startMs, lastSeenMs: nowMs, writtenAt: nowMs }
      state.open.set(s.key, fresh)
      writeCall(fresh, nowMs)
    } else {
      c.lastSeenMs = nowMs
      if (nowMs - c.writtenAt >= PERSIST_EVERY_MS) { writeCall(c, nowMs); c.writtenAt = nowMs }
    }
  }
  for (const [key, c] of state.open) {
    if (keys.has(key)) continue
    // It ended between the last sighting and now; the log backfill has the second.
    writeCall(c, c.lastSeenMs)
    state.open.delete(key)
  }
  return lines
}

/** Lines that close everything (server stop): open calls end at their last sighting. */
export function flushLiveState(state: LiveState): Line[] {
  const lines = applyLiveSample(state, null, Number.MAX_SAFE_INTEGER)
  state.cov = null
  return lines
}

// ── Impure runner ──

let liveTimer: ReturnType<typeof setTimeout> | null = null
let backfillTimer: ReturnType<typeof setTimeout> | null = null
let live: LiveState = emptyLiveState()
let backfilling: Promise<BackfillOutcome> | null = null
let lastBackfill: BackfillOutcome | null = null

export interface BackfillOutcome { ok: boolean; calls: number; written: number; span: Span | null; at: number; error?: string }

export function lastCallsBackfill(): BackfillOutcome | null {
  return lastBackfill
}

async function callsConfig(): Promise<{ enabled: boolean; apps: Set<string> }> {
  try {
    const { getConfig } = await import('../config-manager.js')
    const config = await getConfig()
    const time = config.time
    return { enabled: time?.outside?.enabled === true && time?.calls?.enabled !== false, apps: callAppSet(time?.calls?.apps) }
  } catch {
    return { enabled: false, apps: callAppSet() } // an unreadable config is not consent
  }
}

function runAssertions(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(PMSET, ['-g', 'assertions'], { timeout: ASSERT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

async function liveTick(): Promise<void> {
  const cfg = await callsConfig()
  if (!cfg.enabled) {
    void appendCallLines(flushLiveState(live))
    return
  }
  const text = await runAssertions()
  const now = Date.now()
  const lines = applyLiveSample(live, text === null ? null : parseAssertionsNow(text, now, cfg.apps), now)
  if (lines.length) void appendCallLines(lines)
}

function stateFile(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside', 'calls', 'state.json')
}

async function readLastBackfillMs(): Promise<number> {
  try {
    const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf8')) as { lastBackfillMs?: unknown }
    return typeof raw.lastBackfillMs === 'number' ? raw.lastBackfillMs : 0
  } catch {
    return 0
  }
}

/** Stream `pmset -g log` through the folder. Rejects on a non-zero exit or the deadline. */
function streamLog(apps: ReadonlySet<string>): Promise<ReturnType<ReturnType<typeof createLogFolder>['finish']>> {
  return new Promise((resolve, reject) => {
    const folder = createLogFolder(apps)
    const child = spawn(PMSET, ['-g', 'log'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pmset log timed out')) }, LOG_TIMEOUT_MS)
    timer.unref?.()
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => folder.push(line))
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`pmset log exited ${code}`)); return }
      resolve(folder.finish(Date.now()))
    })
  })
}

/** Read the power log once and store what it holds. Concurrent callers share one run. Never throws. */
export function backfillCalls(): Promise<BackfillOutcome> {
  if (backfilling) return backfilling
  backfilling = (async (): Promise<BackfillOutcome> => {
    const at = Date.now()
    const cfg = await callsConfig()
    if (!cfg.enabled) return { ok: true, calls: 0, written: 0, span: null, at }
    try {
      const { calls, span } = await streamLog(cfg.apps)
      const lines: Line[] = calls.map((c) => ({ startMs: c.startMs, line: callLine(c, 'log') }))
      if (span) lines.push({ startMs: span[0], line: coverageLine(span, 'log') })
      const written = await appendCallLines(lines)
      await fsp.mkdir(path.dirname(stateFile()), { recursive: true })
      await fsp.writeFile(stateFile(), JSON.stringify({ lastBackfillMs: at }), 'utf8')
      log.web.info('calls backfill stored', { calls: calls.length, written })
      return (lastBackfill = { ok: true, calls: calls.length, written, span, at })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.web.warn('calls backfill failed', { error })
      return (lastBackfill = { ok: false, calls: 0, written: 0, span: null, at, error })
    }
  })().finally(() => { backfilling = null })
  return backfilling
}

/** Start both feeds. Idempotent; each tick checks the config, so enabling later needs no restart. */
export function startCallsCollector(): void {
  if (liveTimer || process.platform !== 'darwin' || CLOUD_MODE || IS_EPHEMERAL) return
  const tickLive = async (): Promise<void> => {
    try { await liveTick() } catch { /* the next tick tries again */ }
    if (liveTimer) { liveTimer = setTimeout(() => { void tickLive() }, LIVE_EVERY_MS); liveTimer.unref?.() }
  }
  liveTimer = setTimeout(() => { void tickLive() }, 5_000)
  liveTimer.unref?.()
  const tickBackfill = async (first: boolean): Promise<void> => {
    if (!first || Date.now() - await readLastBackfillMs() >= BACKFILL_FRESH_MS) await backfillCalls()
    if (backfillTimer) { backfillTimer = setTimeout(() => { void tickBackfill(false) }, BACKFILL_EVERY_MS); backfillTimer.unref?.() }
  }
  backfillTimer = setTimeout(() => { void tickBackfill(true) }, BACKFILL_FIRST_DELAY_MS)
  backfillTimer.unref?.()
}

/** Counterpart for stopServer(): stop the timers and write what the live feed holds. */
export function stopCallsCollector(): void {
  if (liveTimer) clearTimeout(liveTimer)
  if (backfillTimer) clearTimeout(backfillTimer)
  liveTimer = null
  backfillTimer = null
  const lines = flushLiveState(live)
  live = emptyLiveState()
  if (lines.length) void appendCallLines(lines)
}
