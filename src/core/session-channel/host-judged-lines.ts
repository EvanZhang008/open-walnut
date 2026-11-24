/**
 * The one rule for a line written into the CLI of a session this host runs and judges itself
 * (docs/plan/one-service-every-host.md, phase 2) by any path but its runner: the runner watches
 * that CLI, and reads it on from where the leader was last told. Its runner is the only reader that
 * judges a turn (the turn end, the status, the fact the leader hears, the lead's notice); a line
 * written into a CLI no runner reads starts a turn nobody judges (2026-11-23: after a restart of the
 * host's service, a same-host send was written into a live CLI the runner had not attached again
 * yet; the CLI answered and the leader never heard the turn end).
 *
 *   before a write   every host path that writes into a session's CLI through the daemon instead of
 *                    the runner (a same-host send or reply, a plain note, a prompt's answer, a trigger
 *                    fire, a message while the host is alone) asks `attachJudgeFirst` before its first
 *                    byte (ratchet: tests/core/session-channel/host-judged-lines-ratchet.test.ts). On a
 *                    host that does not run its sessions, and for any session not its own (a copied
 *                    row, an ACP engine's, one while the host stands down for an older leader), it is a
 *                    no-op. Before this host can read its own streams it attaches nothing (an attach
 *                    then would have no place to read on from): the boot passes take the session.
 *   at boot          the own rows whose CLI this host's runtime holds now (its registry, not the row:
 *                    the daemon may have resumed one itself while the service was down) are attached
 *                    again, once the runner is up and this host reads its own streams
 *   the gap          an attach of an own row reads the stream on from the furthest line the leader
 *                    was told of (fact-log.ts toldLine; attach-evidence.ts judgedReplayFloor), so what
 *                    the CLI wrote while no runner read it (the restart itself, a writer the daemon runs
 *                    alone) is said once, and nothing the leader already heard is said again
 *
 * Installed by the host's session side (host-boot.ts installOwnAttach), cleared when it stops.
 */
import { log } from '../../logging/index.js'
import type { ToldLine } from './fact-log.js'

type Attach = (sid: string, path: string) => Promise<void>
let attach: Attach | null = null
let told: ((sid: string) => ToldLine | undefined) | null = null

/** The host's session side installs how its runner attaches an own session (null: none runs here). */
export function setJudgeAttach(fn: Attach | null): void {
  attach = fn
}

/** The host's session side installs its fact log's toldLine (null: none runs here). */
export function setToldLines(fn: ((sid: string) => ToldLine | undefined) | null): void {
  told = fn
}

/** The furthest CLI line of `sid` a durable fact came from on this host, or undefined (attachToExisting reads it). */
export function toldLineOf(sid: string): ToldLine | undefined {
  try { return told?.(sid) } catch { return undefined }
}

/** Before a line goes into `sid`'s CLI by `path`: its runner watches it first. Never throws. */
export async function attachJudgeFirst(sid: string | null | undefined, path: string): Promise<void> {
  if (!attach || typeof sid !== 'string' || !sid) return
  try {
    await attach(sid, path)
  } catch (err) {
    log.session.warn('host sessions: the runner did not attach before a line into its session', { sessionId: sid, path, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Waits for `p` at most `ms`: its value, or undefined when it did not come in time (it goes on). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms)
    t.unref?.()
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(undefined) })
  })
}

/** How long a write waits for the runner's attach; past it the line goes, and the attach goes on. */
export const ATTACH_FIRST_MS = 8_000
/** The boot passes over the own rows: at once, then for rows the runtime had not adopted yet. */
export const OWN_ATTACH_PASSES_MS: readonly number[] = [0, 10_000, 60_000]
/** How often the boot passes look again whether this host reads its own streams yet (doubling, to the cap). */
const READS_POLL_MS = 250
const READS_POLL_MAX_MS = 15_000

/** An own row the boot passes may attach: an interactive native session (ACP engines attach on use). */
export interface OwnRowLike {
  claudeSessionId: string
  type?: string
  archived?: boolean
  engine?: string
}

/** What this host's runtime says of a session's CLI now: alive with its pid, or null (not alive, or no answer). */
export type LiveCli = { pid?: number } | null

export interface OwnAttachDeps {
  ownRows(): Promise<OwnRowLike[]>
  /** Does the runner hold a live session of `sid` already? */
  holds(sid: string): boolean
  /** The runtime's word on `sid`'s CLI (its registry): the row may say stopped while the CLI runs. */
  liveCli(sid: string): Promise<LiveCli>
  /** The sessions whose CLI the runtime lists alive, in one answer (null: no answer): only those are asked one by one. */
  liveSids?(): Promise<ReadonlySet<string> | null>
  /** Attach `sid` again with the runtime's pid: attached or not. */
  attach(sid: string, pid: number | undefined): Promise<boolean>
  /** ACP engines are not attached here (their worker re-attaches on use). */
  isAcp(engine: string | undefined): boolean
  /** The host stands down for an older leader (judge-of.ts): it judges none of its rows, so it attaches none. */
  standsDown?(): boolean
  passesMs?: readonly number[]
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** Is `row` a session the boot passes ask the runtime about? */
export function mayStillRun(row: OwnRowLike, isAcp: (engine: string | undefined) => boolean): boolean {
  return !!row.claudeSessionId && !row.archived && (row.type ?? 'interactive') === 'interactive' && !isAcp(row.engine)
}

/** Sleep `ms`, or less when `stop` fires (the returned stop ends it at once). */
function napper(): { nap(ms: number): Promise<void>; wake(): void } {
  let wake: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    nap: (ms) => new Promise<void>((resolve) => {
      wake = () => { if (timer) clearTimeout(timer); wake = null; resolve() }
      timer = setTimeout(() => { wake = null; resolve() }, ms)
      timer.unref?.()
    }),
    wake: () => wake?.(),
  }
}

/**
 * The boot passes: each own row whose CLI the runtime holds and the runner does not is attached
 * again, with the runtime's pid. A row the runtime had not adopted yet at one pass is asked again at
 * the next one.
 */
export function startOwnAttach(d: OwnAttachDeps): { pass(): Promise<string[]>; done: Promise<void>; stop(): void } {
  let stopped = false
  const sleeper = napper()
  async function pass(): Promise<string[]> {
    const attached: string[] = []
    if (d.standsDown?.()) return attached
    let rows: OwnRowLike[] = []
    try { rows = (await d.ownRows()).filter((r) => mayStillRun(r, d.isAcp) && !d.holds(r.claudeSessionId)) } catch (err) {
      d.log?.('warn', 'host sessions: the own rows could not be read for the boot attach', { error: err instanceof Error ? err.message : String(err) })
      return attached
    }
    // One list per pass: an own row the runtime does not list alive (most of them, long ended) is not asked.
    const listed = rows.length ? await (d.liveSids?.() ?? Promise.resolve(null)).catch(() => null) : null
    let live = 0
    for (const row of rows) {
      if (stopped) break
      if (listed && !listed.has(row.claudeSessionId)) continue
      const cli = await d.liveCli(row.claudeSessionId).catch(() => null)
      if (!cli) continue
      live++
      if (await d.attach(row.claudeSessionId, cli.pid).catch(() => false)) attached.push(row.claudeSessionId)
    }
    if (live) d.log?.('info', 'host sessions: own sessions attached again after the start', { live, attached: attached.length, sessionIds: attached.slice(0, 20) })
    return attached
  }
  const done = (async () => {
    let at = 0
    for (const ms of d.passesMs ?? OWN_ATTACH_PASSES_MS) {
      if (stopped) return
      if (ms > at) await sleeper.nap(ms - at)
      at = ms
      if (stopped) return
      await pass()
    }
  })()
  return {
    pass,
    done,
    stop() {
      stopped = true
      sleeper.wake()
    },
  }
}

export interface OwnAttachWiring {
  /** The host's session runner: attach an own session whose CLI the runtime holds, with its pid. */
  runner: { attachOwnLive(sid: string, pid?: number, budgetMs?: number): Promise<unknown> }
  /** Does the runner hold a live session of `sid` already? */
  holds(sid: string): boolean
  ownRows(): Promise<OwnRowLike[]>
  /** The engine of `sid`'s row (undefined: none, or Claude Code). */
  engineOf(sid: string): Promise<string | undefined>
  liveCli(sid: string): Promise<LiveCli>
  liveSids?: OwnAttachDeps['liveSids']
  /** The fact log's furthest told line of a session (fact-log.ts toldLine). */
  toldLine(sid: string): ToldLine | undefined
  /** Settles once the runner's own startup (its queue read, its recovery) is done: the boot passes wait for it. */
  runnerReady?: Promise<unknown>
  /** Can this host read its own sessions' streams now (its follower link up)? An attach before that has no place to read on from. */
  readsReady(): boolean
  /** Before the boot passes, after the runner and the reads are ready (WALNUT_HOST_OWN_ATTACH_DELAY_MS: a test seam). */
  delayMs?: number
  passesMs?: readonly number[]
  log?: OwnAttachDeps['log']
}

/**
 * The host's session side puts the rule in place (host-boot.ts): the told lines, the attach before a
 * write, for the sessions this host judges (sessions/judge-of.ts judgedHere: its own rows, not while
 * it stands down for an older leader), and the boot passes. Returns their stop.
 */
export async function installOwnAttach(w: OwnAttachWiring): Promise<() => void> {
  const [{ judgedHere, hostStandsDown }, { isAcpEngine }] = await Promise.all([import('../sessions/judge-of.js'), import('../agents/engine-registry.js')])
  let stopped = false
  const sleeper = napper()
  setToldLines(w.toldLine)
  setJudgeAttach(async (sid, path) => {
    if (w.holds(sid) || !judgedHere(sid) || isAcpEngine(await w.engineOf(sid))) return
    // Not readable yet: the boot passes attach it once it is, reading on from the told line.
    if (!w.readsReady()) {
      w.log?.('info', 'host sessions: a line into an own session goes before its runner can read its stream; the boot attach takes it', { sessionId: sid, path })
      return
    }
    const got = await within((async () => {
      const cli = await w.liveCli(sid)
      return cli ? w.runner.attachOwnLive(sid, cli.pid, ATTACH_FIRST_MS / 2) : undefined
    })(), ATTACH_FIRST_MS)
    w.log?.('info', 'host sessions: a line into an own session waited for its runner to attach', { sessionId: sid, path, attached: got != null })
  })
  let boot: ReturnType<typeof startOwnAttach> | null = null
  void (async () => {
    await Promise.resolve(w.runnerReady).catch(() => {})
    // This host reads its own streams once its follower link is up: no attach before (no place to read on from).
    let wait = READS_POLL_MS
    let said = false
    while (!stopped && !w.readsReady()) {
      if (!said && wait >= READS_POLL_MAX_MS) { said = true; w.log?.('warn', 'host sessions: this host does not read its own streams yet; its own sessions wait to be attached again', {}) }
      await sleeper.nap(wait)
      wait = Math.min(wait * 2, READS_POLL_MAX_MS)
    }
    if (!stopped && w.delayMs && w.delayMs > 0) await sleeper.nap(w.delayMs)
    if (stopped) return
    boot = startOwnAttach({
      ownRows: w.ownRows, holds: w.holds, isAcp: isAcpEngine, liveCli: w.liveCli, standsDown: hostStandsDown,
      ...(w.liveSids ? { liveSids: w.liveSids } : {}),
      attach: async (sid, pid) => (await w.runner.attachOwnLive(sid, pid)) != null,
      ...(w.passesMs ? { passesMs: w.passesMs } : {}),
      ...(w.log ? { log: w.log } : {}),
    })
  })()
  return () => {
    stopped = true
    sleeper.wake()
    setJudgeAttach(null)
    setToldLines(null)
    boot?.stop()
  }
}
