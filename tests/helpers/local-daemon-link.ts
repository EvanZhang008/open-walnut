/**
 * A live test's boot waits for the primary's link to its own daemon, which the boot's
 * local daemon lane dials (src/web/local-daemon-lane.ts), instead of dialling it by hand.
 *
 * The wait is a bounded observation budget, LOCAL_LINK_BUDGET_MS from the moment it is
 * called (after startServer returned, and in some boots after more set-up), not from the
 * lane's ready edge. It is no bound on the dial itself: one '__local__' attempt has no
 * whole-attempt bound in the source (ensureRunning's upgrade, stop and spawn paths have
 * none), and the parent's port wait, which also covers startServer, bounds no whole boot
 * either. A link first seen at or before the deadline passes; a check that runs after it
 * fails, even when the link is up by then. A timeout does not show that the attempt or
 * the daemon ended. A boot with no local daemon (localDaemon.wsUrl empty: its start
 * failed) fails at once instead of skipping the wait.
 *
 * A failed boot goes through failBootLink: the server's own stop entry (stopServer),
 * bounded, then a non-zero exit whatever the stop did. stopServer resolving does not
 * mean every native child exited; the local daemon is left NOT_VERIFIED.
 */

/** The observation budget, from the wait's call. */
export const LOCAL_LINK_BUDGET_MS = 72_000
/** How long a failed boot gives stopServer before it exits anyway. */
export const BOOT_FAIL_STOP_BUDGET_MS = 30_000
/** A failed boot's exit code, the same whatever its cleanup did. */
export const BOOT_FAIL_EXIT = 4

export interface LocalLinkWait {
  /** localDaemon.wsUrl after the boot. */
  wsUrl: string | null | undefined
  /** getConnectedDaemonConnection('__local__') !== null. */
  connected(): boolean
  now(): number
  sleep(ms: number): Promise<void>
  budgetMs?: number
  pollMs?: number
}

/** Resolves once the link is seen up by the deadline; throws at once without a local daemon, and past the deadline. */
export async function awaitLocalDaemonLink(w: LocalLinkWait): Promise<void> {
  if (!w.wsUrl) {
    throw new Error('the boot has no local daemon (localDaemon.wsUrl is empty): its start failed, so the Mac can never link it')
  }
  const budget = w.budgetMs ?? LOCAL_LINK_BUDGET_MS
  const deadline = w.now() + budget
  const poll = w.pollMs ?? 100
  const timeout = () => new Error(
    `the boot did not link its local daemon within ${budget / 1000}s of the wait's start `
    + '(an observation budget; this does not show that the attempt or the daemon ended)',
  )
  for (;;) {
    // The clock first: a late wake past the deadline fails even when the link is up by then.
    const t = w.now()
    if (t > deadline) throw timeout()
    if (w.connected()) return
    if (t === deadline) throw timeout()
    await w.sleep(Math.min(poll, deadline - t))
  }
}

export interface BootFail {
  /** The server's own stop entry (stopServer). */
  stop(): Promise<void>
  write(line: string): void
  exit(code: number): void
  stopBudgetMs?: number
  setTimer?(fn: () => void, ms: number): void
}

/** Ends a boot whose link failed: stopServer (bounded), then exit BOOT_FAIL_EXIT, once, whatever the stop did. */
export async function failBootLink(err: unknown, f: BootFail): Promise<void> {
  f.write(`BOOT FAIL: ${err instanceof Error ? err.message : String(err)}`)
  const budget = f.stopBudgetMs ?? BOOT_FAIL_STOP_BUDGET_MS
  const setTimer = f.setTimer ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms) })
  const cleanup = await new Promise<string>((resolve) => {
    setTimer(() => resolve(`unknown (stopServer did not resolve in ${budget / 1000}s)`), budget)
    let stopping: Promise<void>
    try { stopping = f.stop() } catch (e) { stopping = Promise.reject(e) }
    stopping.then(
      () => resolve('stopServer resolved'),
      (e: unknown) => resolve(`failed (${e instanceof Error ? e.message : String(e)})`),
    )
  })
  f.write(`BOOT FAIL cleanup: ${cleanup}; the local daemon and other native children: NOT_VERIFIED`)
  f.exit(BOOT_FAIL_EXIT)
}
