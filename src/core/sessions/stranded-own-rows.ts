/**
 * Rows a host holds as its own while no session of this host runs them and the leader says they
 * are not this host's: given back to the leader's version.
 *
 * A host's copy merges the leader's copy of an own row (session-row-owner.ts mergeLeaderCopy), so
 * once a row reads host-judged here the leader can never take it back through the copy. Every way a
 * row gets there without a session behind it ends the same: a start that failed after a copy of its
 * row came down mid-claim, a host that stopped between a start's claim and its answer (the claim
 * lived in memory only, the row is on disk), the leader's marked seed reaching the host for a start
 * the leader then took back (takeSeedBack). Left alone, `owns` answers yes for it, the host frames
 * it to a leader that skips it, and its stale repair writes it stopped.
 *
 * The leader's latest version of every such row is kept by the copy itself (session-db.ts
 * noteLeaderDisown, on disk), so this one sweep sees every member: at a failed start's release, at
 * boot, after a copy that kept one, and on a clock. A row whose session is alive here stays this
 * host's whatever the leader says: a start claims it, the runner holds it, or the runtime still owns
 * its CLI.
 */
import type { SessionRecord } from '../types.js'

export interface HoldCheck {
  /** The runner holds a live session object for `sid` (a native or an ACP one). */
  runnerHolds(sid: string): boolean
  /** The runtime's word on `sid`'s CLI: alive, dead, or null when it could not be asked. */
  runtimeAlive(sid: string): Promise<boolean | null>
}

/** Is `row`'s session alive on this host (so the row stays this host's)? Unknown reads as yes. */
export async function heldOnThisHost(row: SessionRecord, check: HoldCheck): Promise<boolean> {
  const sid = row.claudeSessionId
  const { isClaimed } = await import('./starting-claims.js')
  if (isClaimed(sid)) return true
  try { if (check.runnerHolds(sid)) return true } catch { return true }
  // An ACP worker lives in the runtime by its runtime id, and a reaped one still resumes there.
  if (row.acpRuntimeId) return true
  try { return (await check.runtimeAlive(sid)) !== false } catch { return true }
}

export interface StrandedSweepOptions {
  held(row: SessionRecord): Promise<boolean>
  /** The rows given back (the emitter forgets them as own). */
  onHandedBack?(sids: string[]): void
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** One pass: every own row the leader disowns that nothing here holds goes back. `only`: just that session. */
export async function handBackStrandedRows(o: StrandedSweepOptions, only?: string): Promise<string[]> {
  const db = await import('../session-db.js')
  const back: string[] = []
  for (const c of db.ownRowsTheLeaderDisowns()) {
    const sid = c.row.claudeSessionId
    if (only !== undefined && sid !== only) continue
    if (await o.held(c.row)) continue
    if (db.handOwnRowBack(sid, c.key)) back.push(sid)
  }
  if (back.length > 0) {
    o.log?.('info', 'host sessions: rows no session here holds went back to the leader\'s version', { sessionIds: back.slice(0, 20), count: back.length })
    try { o.onHandedBack?.(back) } catch { /* the rows went back anyway */ }
  }
  return back
}

export const STRANDED_SWEEP_EVERY_MS = 60_000

export interface StrandedSweep {
  /** Run a pass now (for `only`, that session). Passes never overlap: a call during one waits for it. */
  run(only?: string): Promise<string[]>
  /** Run a pass soon (a copy kept a leader version that disowns a row). */
  poke(): void
  stop(): void
}

/** The sweep on a clock: every `everyMs`, and soon after each poke (the caller runs the first pass when it can ask the runtime). */
export function startStrandedSweep(o: StrandedSweepOptions & { everyMs?: number; pokeMs?: number }): StrandedSweep {
  let chain: Promise<unknown> = Promise.resolve()
  let stopped = false
  let poked: ReturnType<typeof setTimeout> | null = null
  const run = (only?: string): Promise<string[]> => {
    const next = chain.then(() => (stopped ? [] : handBackStrandedRows(o, only)))
    chain = next.catch((err: unknown) => o.log?.('warn', 'host sessions: giving rows back to the leader failed', { error: err instanceof Error ? err.message : String(err) }))
    return next
  }
  const tick = setInterval(() => { void run().catch(() => {}) }, o.everyMs ?? STRANDED_SWEEP_EVERY_MS)
  tick.unref?.()
  return {
    run,
    poke() {
      if (poked || stopped) return
      poked = setTimeout(() => { poked = null; void run().catch(() => {}) }, o.pokeMs ?? 1_000)
      poked.unref?.()
    },
    stop() {
      stopped = true
      clearInterval(tick)
      if (poked) { clearTimeout(poked); poked = null }
    },
  }
}
