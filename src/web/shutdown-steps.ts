/**
 * Every awaited step of stopServer() runs here, with a budget.
 *
 * The signal shutdown force-exits after SHUTDOWN_BAIL_MS (commands/web.ts, 7 s),
 * so one step that waits on outside work (a background pass, a network call, a
 * plugin) ends the whole teardown there, with every later step undone. That
 * happened twice: 2026-11-10, the HTTP close waited on long polls (http-close.ts);
 * 2026-11-12, the external session importer's stop waited on an import pass that
 * a deploy's smoke boot reached 13 s after its first tick began.
 *
 * When a bail waits (the signal shutdown, a restart into an update), a step gets
 * its own budget, capped by what is left of the steps' shared budget, then
 * shutdown moves on without it and says which step overran. The
 * bail's line names the step it caught, so the next hang reads from the trace.
 * tests/web/shutdown-steps-ratchet.test.ts fails on an await in stopServer that
 * goes around this.
 */
import { log } from '../logging/index.js'
import { HTTP_DRAIN_GRACE_MS } from './http-close.js'

/**
 * What a bail leaves after the steps (ms): the HTTP close that ends stopServer
 * (its drain grace) and a margin for the close itself and the exit.
 */
export const SHUTDOWN_STEPS_RESERVE_MS = HTTP_DRAIN_GRACE_MS + 1_000

/** A step's own budget when it names none (ms). */
export const SHUTDOWN_STEP_DEFAULT_MS = 1_500

/** What a step after the HTTP close leaves before the bail, for the exit itself (ms). */
export const SHUTDOWN_EXIT_MARGIN_MS = 300

let startedAt: number | null = null
/** When the caller's bail fires; null when none waits. */
let bailAt: number | null = null
/** Time every step together may take; null when no bail waits (a test's in-process stop). */
let stepsBudgetMs: number | null = null
let current: { name: string; at: number } | null = null

/**
 * Start the steps' clock; stopServer calls it first. With the caller's bail the
 * steps share what the bail leaves after SHUTDOWN_STEPS_RESERVE_MS; with none
 * (a test stopping a server in process, which then starts another on the same
 * data) every step is awaited to its end, as before.
 */
export function beginShutdownSteps(opts: { bailMs?: number; now?: number } = {}): void {
  startedAt = opts.now ?? Date.now()
  bailAt = opts.bailMs === undefined ? null : startedAt + opts.bailMs
  stepsBudgetMs = opts.bailMs === undefined ? null : Math.max(0, opts.bailMs - SHUTDOWN_STEPS_RESERVE_MS)
  current = null
}

/** The step running now and how long it has run, for the bail's line. */
export function shutdownStepNow(now = Date.now()): { name: string; ms: number } | null {
  return current ? { name: current.name, ms: now - current.at } : null
}

/** The bail line's tail: ` step=<name> (<ms>ms)`, or '' between steps. */
export function shutdownStepSuffix(now = Date.now()): string {
  const s = shutdownStepNow(now)
  return s ? ` step="${s.name}" (${s.ms}ms)` : ''
}

/**
 * Run one teardown step, waiting at most its budget. A step that throws is
 * logged and counts as done; one that overruns keeps running unawaited.
 * `afterClose`: a step after the HTTP close, whose budget comes out of the
 * reserve the steps leave (what the bail has left, less SHUTDOWN_EXIT_MARGIN_MS),
 * never out of the steps' shared budget, which is spent by then.
 */
export async function shutdownStep(
  name: string,
  run: () => unknown,
  opts: { budgetMs?: number; afterClose?: boolean } = {},
): Promise<void> {
  const now = Date.now()
  const left = opts.afterClose
    ? (bailAt === null ? null : bailAt - now - SHUTDOWN_EXIT_MARGIN_MS)
    : stepsBudgetMs === null || startedAt === null ? null : stepsBudgetMs - (now - startedAt)
  const budget = left === null ? null : Math.max(0, Math.min(opts.budgetMs ?? SHUTDOWN_STEP_DEFAULT_MS, left))
  current = { name, at: now }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const work = Promise.resolve().then(run).then(
      () => 'done' as const,
      (err) => {
        log.web.warn('shutdown step failed', { step: name, error: err instanceof Error ? err.message : String(err) })
        return 'done' as const
      },
    )
    const out = budget === null ? await work : await Promise.race([
      work,
      new Promise<'overran'>((resolve) => { timer = setTimeout(() => resolve('overran'), budget) }),
    ])
    if (out === 'overran') {
      log.web.warn('shutdown step overran its budget; shutdown goes on without it', {
        step: name, budgetMs: budget, stepsLeftMs: Math.max(0, left ?? 0),
      })
    }
  } finally {
    if (timer) clearTimeout(timer)
    current = null
  }
}
