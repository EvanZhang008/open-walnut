/**
 * The one rule for a line written into the CLI of a session this host runs and judges itself
 * (docs/plan/one-service-every-host.md, phase 2) by any path but its runner: the runner watches
 * that CLI first. Its runner is the only reader that judges a turn (the turn end, the status, the
 * fact the leader hears, the lead's notice); a line written into a CLI no runner reads starts a
 * turn nobody judges (2026-11-23: after a restart of the host's service, a same-host send was
 * written into a live CLI the runner had not attached again yet; the CLI answered and the leader
 * never heard the turn end).
 *
 *   before a write   every host path that writes into a session's CLI through the daemon instead of
 *                    the runner (a same-host send or reply, a plain note, a prompt's answer, a trigger
 *                    fire, a message while the host is alone) asks `attachJudgeFirst` before its first
 *                    byte (ratchet: tests/core/session-channel/host-judged-lines-ratchet.test.ts). On a
 *                    host that does not run its sessions, and for any session not its own, it is a
 *                    no-op: nothing is installed or the row is not one this host judges.
 *   at boot          the host's own rows whose CLI survived the restart are attached again at once
 *                    (startOwnAttach), not when something first asks for them
 *   the gap          what a CLI wrote while no runner read it (the restart itself, a writer the daemon
 *                    runs alone) is read again from the last turn end the runner judged, when the stream
 *                    shows a turn end past it (attach-evidence.ts judgedReplayFloor)
 *
 * Installed by the host's session side (host-boot.ts), cleared when it stops.
 */
import { log } from '../../logging/index.js'

type Attach = (sid: string, path: string) => Promise<void>
let attach: Attach | null = null

/** The host's session side installs how its runner attaches an own session (null: none runs here). */
export function setJudgeAttach(fn: Attach | null): void {
  attach = fn
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
/** How long the boot passes wait for this host's own stream reads, and how often they look. */
export const READS_WAIT_MS = 60_000
const READS_POLL_MS = 250
/** The boot passes over the own rows: at once, then for rows the runtime had not adopted yet. */
export const OWN_ATTACH_PASSES_MS: readonly number[] = [0, 10_000, 60_000]

/** A row whose CLI may still run here: a live interactive native session (ACP engines attach on use). */
export interface OwnRowLike {
  claudeSessionId: string
  pid?: number | null
  type?: string
  archived?: boolean
  process_status?: string
  engine?: string
}

export interface OwnAttachDeps {
  ownRows(): Promise<OwnRowLike[]>
  /** Does the runner hold a live session of `sid` already? */
  holds(sid: string): boolean
  /** Attach `sid` again (the runner checks its CLI is alive): attached or not. */
  attach(sid: string): Promise<boolean>
  /** ACP engines are not attached here (their worker re-attaches on use). */
  isAcp(engine: string | undefined): boolean
  passesMs?: readonly number[]
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** Is `row` a session whose CLI may have survived the restart? */
export function mayStillRun(row: OwnRowLike, isAcp: (engine: string | undefined) => boolean): boolean {
  return !!row.claudeSessionId && row.pid != null && !row.archived && (row.type ?? 'interactive') === 'interactive'
    && row.process_status !== 'stopped' && !isAcp(row.engine)
}

/**
 * The boot passes: each own row that may still run and that the runner does not hold is attached
 * again. A row the runtime had not adopted yet at the first pass is tried again at the next one.
 */
export function startOwnAttach(d: OwnAttachDeps): { pass(): Promise<string[]>; done: Promise<void>; stop(): void } {
  let stopped = false
  /** The wait before the next pass, ended at once by a stop. */
  let wake: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  async function pass(): Promise<string[]> {
    const attached: string[] = []
    let rows: OwnRowLike[] = []
    try { rows = (await d.ownRows()).filter((r) => mayStillRun(r, d.isAcp) && !d.holds(r.claudeSessionId)) } catch (err) {
      d.log?.('warn', 'host sessions: the own rows could not be read for the boot attach', { error: err instanceof Error ? err.message : String(err) })
      return attached
    }
    for (const row of rows) {
      if (stopped) break
      if (await d.attach(row.claudeSessionId).catch(() => false)) attached.push(row.claudeSessionId)
    }
    if (rows.length) d.log?.('info', 'host sessions: own sessions attached again after the start', { candidates: rows.length, attached: attached.length, sessionIds: attached.slice(0, 20) })
    return attached
  }
  const done = (async () => {
    let at = 0
    for (const ms of d.passesMs ?? OWN_ATTACH_PASSES_MS) {
      if (stopped) return
      if (ms > at) {
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, ms - at)
          timer.unref?.()
        })
        wake = null
      }
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
      if (timer) clearTimeout(timer)
      wake?.()
    },
  }
}

export interface OwnAttachWiring {
  /** The host's session runner: its attach-on-demand of a session whose CLI still runs. */
  runner: { getOrAttachLiveSession(sid: string): Promise<unknown> }
  /** Does the runner hold a live session of `sid` already? */
  holds(sid: string): boolean
  ownRows(): Promise<OwnRowLike[]>
  /** Settles once the runner's own startup (its queue read, its recovery) is done: the boot passes wait for it. */
  runnerReady?: Promise<unknown>
  /**
   * Can this host read its own sessions' streams now (its follower link up, its reads answered)? An attach
   * before that has no stream evidence, so no replay floor: the attaches wait for it, a while.
   */
  readsReady?: () => boolean
  log?: OwnAttachDeps['log']
}

/**
 * The host's session side puts the rule in place (host-boot.ts): the attach before a write, for the
 * sessions this host judges (sessions/judge-of.ts judgedHere: its own rows, not while it stands down
 * for an older leader), and the boot passes. Returns their stop.
 */
export async function installOwnAttach(w: OwnAttachWiring): Promise<() => void> {
  const [{ judgedHere }, { isAcpEngine }] = await Promise.all([import('../sessions/judge-of.js'), import('../agents/engine-registry.js')])
  let stopped = false
  /** Resolves once the streams are readable here, or after `ms` (or a stop) without them. */
  const readable = async (ms: number): Promise<void> => {
    const until = Date.now() + ms
    while (!stopped && w.readsReady && !w.readsReady() && Date.now() < until) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, READS_POLL_MS); t.unref?.() })
    }
  }
  setJudgeAttach(async (sid, path) => {
    if (w.holds(sid) || !judgedHere(sid)) return
    const got = await within(readable(ATTACH_FIRST_MS / 2).then(() => w.runner.getOrAttachLiveSession(sid)), ATTACH_FIRST_MS)
    w.log?.('info', 'host sessions: a line into an own session waited for its runner to attach', { sessionId: sid, path, attached: got != null })
  })
  let boot: ReturnType<typeof startOwnAttach> | null = null
  void Promise.resolve(w.runnerReady).catch(() => {}).then(() => readable(READS_WAIT_MS)).then(() => {
    if (stopped) return
    boot = startOwnAttach({
      ownRows: w.ownRows, holds: w.holds, isAcp: isAcpEngine,
      attach: async (sid) => (await w.runner.getOrAttachLiveSession(sid)) != null,
      ...(w.log ? { log: w.log } : {}),
    })
  })
  return () => {
    stopped = true
    setJudgeAttach(null)
    boot?.stop()
  }
}
