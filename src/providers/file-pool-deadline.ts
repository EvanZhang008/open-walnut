/**
 * The one deadline rule for the daemon's async file writes (registry-writer-core.ts,
 * log-appender-core.ts): when may a write still in flight be made synchronously instead?
 *
 * A write slower than the deadline has two causes that call for opposite answers:
 *   - the file pool is wedged by other work (2026-08-15: open() on a FIFO with no writer held
 *     every pool thread for hours; a dead mount elsewhere does the same). Nothing async runs
 *     again, and a synchronous write of a small file is cheap: write it here.
 *   - the write's own disk is slow (a busy volume, a snapshot, a large build). A synchronous
 *     fsync would then take seconds ON THIS THREAD, which in a server that runs the daemon in its
 *     own process (in_process_daemon) is the web server's: every route would freeze, against the
 *     rule "never block the event loop on a slow disk". Wait for the async write instead.
 *
 * So at the deadline the pool is probed with one cheap call (a stat of the root directory, a
 * path that is not on the slow write's disk unless the whole machine is) under a short timer.
 * The probe answers: the pool is alive and the disk is slow, so nothing changes and the deadline
 * is armed again. It does not answer in time: the pool is wedged, and `onWedged` runs once.
 *
 * How each twin gets it: the writers take it through their deps (`armDeadline`);
 * daemon-standalone.ts and daemon-core.ts import it, daemon-source.ts inlines
 * `armFilePoolDeadline.toString()` through `__ARM_FILE_POOL_DEADLINE__`. So the body references
 * NOTHING at module scope.
 */

export interface FilePoolDeadlineOptions {
  fsp: { stat?: (p: string) => Promise<unknown> }
  deadlineMs: number
  /** How long the probe may take before the pool counts as wedged. Default min(500, deadlineMs). */
  probeMs?: number
  /** The pool did not answer the probe: called once, never after the returned cancel. */
  onWedged: () => void
  /** The pool answered: the write is slow, not stuck (called once per deadline passed, with the time waited). */
  onSlow?: (waitedMs: number) => void
}

/** Arms the deadline for one write in flight; the returned function cancels it (call it when the write ends). */
export function armFilePoolDeadline(opts: FilePoolDeadlineOptions): () => void {
  const probeMs = typeof opts.probeMs === 'number' && opts.probeMs > 0 ? opts.probeMs : Math.min(500, opts.deadlineMs)
  let over = false
  let waited = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const unref = (t: unknown) => {
    const u = t as { unref?: () => void } | null
    if (u && typeof u.unref === 'function') u.unref()
  }
  function probe(): void {
    let answered = false
    const wedged = () => {
      timer = null
      if (over || answered) return
      answered = true
      over = true
      opts.onWedged()
    }
    const back = () => {
      if (over || answered) return
      answered = true
      if (timer) clearTimeout(timer)
      timer = null
      if (opts.onSlow) opts.onSlow(waited)
      arm()
    }
    timer = setTimeout(wedged, probeMs)
    unref(timer)
    let asked: Promise<unknown> | null = null
    try { asked = typeof opts.fsp.stat === 'function' ? opts.fsp.stat('/') : null } catch { asked = null }
    // No way to ask the pool: the probe timer decides (as wedged), the old deadline rule.
    if (asked && typeof asked.then === 'function') asked.then(back, back)
  }
  function arm(): void {
    timer = setTimeout(() => {
      timer = null
      if (over) return
      waited += opts.deadlineMs
      probe()
    }, opts.deadlineMs)
    unref(timer)
  }
  arm()
  return () => {
    over = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}
