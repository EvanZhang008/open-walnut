/**
 * A host that runs and judges its sessions stops judging them when its leader is an older Walnut
 * that does not speak the session channel (docs/plan/one-service-every-host.md, "A session a host
 * runs": a straight downgrade). Such a leader judges every session itself from its transcript, as
 * before; a host that went on judging too would continue, retry and resume the same turns a second
 * time (its resend family: auto-continue, the retriers, the turn-end queue).
 *
 * The signal, on the host alone: the leader ANSWERS (server-role.ts leaderPresence, from the
 * daemon's follower view: it is linked and heard within the quiet window) while no leader has
 * opened the session channel (HostChannel.leaderLive, the host's own dial of the leader's door) for
 * OLD_LEADER_MS in a row. A leader that speaks the channel opens it as soon as this host's service
 * names session-judge-v1, whatever its switch says (web/server.ts, leader-side.ts: retried every
 * 30 s at most), so minutes of "answers, no channel" is a leader without it. A leader that is away
 * (the Mac asleep, its link down) does not answer, so it never counts: the host keeps judging, which
 * is the point of the feature.
 *
 * Standing down makes judge-of.ts judgedHere (and judgedHereRecords) false for this host's rows, the
 * one gate every member of the resend family acts through (host-resend.ts: each subscribes with
 * judgedHereOnly or lists its sessions with judgedHereRecords), so none of them continues, retries,
 * resumes or drains a turn of them; the family stays subscribed, in its order before the emitter.
 * The CLIs, the routes, the fact log and the emitter keep running, untouched; the emitter stamps no
 * turn end as taken while standing down (host-resend.ts turnEndStamp). It is undone the moment a
 * leader opens the channel again: the watch looks at once on the channel's link (host-boot.ts
 * onLeaderLinked), and the turn ends skipped meanwhile go to the resend family (stand-down-held.ts).
 * Kept in memory: a restart of the host's service watches again from the start.
 *
 * The positive signal: a leader that speaks the channel says so in its config copy
 * (`leader_capabilities` names LEADER_CHANNEL_CAP, replication/config-allowlist.ts). A host whose
 * leader says it never stands down on the timeout alone: a channel that does not open for the bound
 * is a fault of that leader (its leader side failed to start, a permit refused), reported as
 * `waiting` in this host's status report so the leader's Walnut Health shows it (leader-boot.ts).
 * A leader that says nothing (an older build, or the build before the signal) keeps the timeout.
 */

/** What a leader that speaks the session channel names in its config copy's `leader_capabilities`. */
export const LEADER_CHANNEL_CAP = 'session-channel-v1'

/** The watch's word for this host's status report: judging, waiting on a channel its leader says it has, or stood down. */
export type SessionSideState = 'judging' | 'waiting' | 'stood-down'

/** How long the leader answers with no channel before this host stands down (WALNUT_HOST_OLD_LEADER_MS). */
export function oldLeaderMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WALNUT_HOST_OLD_LEADER_MS)
  return Number.isFinite(n) && n >= 500 ? n : 3 * 60_000
}

export interface OldLeaderWatchDeps {
  /** The leader answers now (server-role.ts leaderPresence().answers). */
  leaderAnswers(): boolean
  /** A leader has the session channel open now (HostChannel.leaderLive, or the host's door dial linked). */
  channelLinked(): boolean
  /** The leader says it speaks the channel (its config copy names LEADER_CHANNEL_CAP); absent: it never says. */
  leaderSaysChannel?(): boolean | Promise<boolean>
  standDown(): void | Promise<void>
  standUp(): void | Promise<void>
  afterMs?: number
  tickMs?: number
  now?(): number
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export interface OldLeaderWatch {
  /** One look now (the timer calls it). */
  tick(): Promise<void>
  /** Is this host standing down now? */
  standingDown(): boolean
  /** What this host's status report says (see the header), and since when (this host's clock). */
  state(): { state: SessionSideState; since: number | null }
  stop(): void
}

export function startOldLeaderWatch(deps: OldLeaderWatchDeps, o: { timer?: boolean } = {}): OldLeaderWatch {
  const afterMs = deps.afterMs ?? oldLeaderMs()
  const now = deps.now ?? Date.now
  let since: number | null = null
  let down = false
  let waiting = false
  let downAt: number | null = null
  let busy = false
  let again = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    // A look asked for while one runs (a link event during a tick) runs right after it.
    if (busy) { again = true; return }
    busy = true
    try {
      if (deps.channelLinked()) {
        since = null
        waiting = false
        if (down) {
          down = false
          downAt = null
          deps.log?.('info', 'host sessions: a leader speaks the session channel again; this host judges its sessions again')
          await deps.standUp()
        }
        return
      }
      // Away (or not heard yet): never counts, whatever this host does now stays.
      if (!deps.leaderAnswers()) { since = null; waiting = false; return }
      since ??= now()
      if (!down && now() - since >= afterMs) {
        if (await deps.leaderSaysChannel?.()) {
          if (!waiting) deps.log?.('warn', 'host sessions: the leader answers and says it speaks the session channel, but has not opened it; this host keeps judging its sessions and reports it', { forMs: now() - since })
          waiting = true
          return
        }
        waiting = false
        down = true
        downAt = now()
        deps.log?.('warn', 'host sessions: the leader answers but has not opened the session channel; it is an older Walnut that judges every session itself, so this host stops judging its own (their CLIs keep running)', { forMs: now() - since })
        await deps.standDown()
      }
    } catch (err) {
      deps.log?.('warn', 'host sessions: the old-leader watch failed a look', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      busy = false
      if (again && !stopped) { again = false; void tick() }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  if (o.timer !== false) {
    timer = setInterval(() => { void tick() }, deps.tickMs ?? Math.max(250, Math.min(30_000, Math.floor(afterMs / 4))))
    timer.unref?.()
  }
  return {
    tick,
    standingDown: () => down,
    state: () => down ? { state: 'stood-down', since: downAt } : waiting ? { state: 'waiting', since } : { state: 'judging', since: null },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null },
  }
}
