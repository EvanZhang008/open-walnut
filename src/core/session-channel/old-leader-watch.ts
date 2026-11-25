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
 * turn end as taken while standing down (host-resend.ts turnEndStamp). A fact of a moment when the
 * leader this host stood down for still answers (oldLeaderJudgesNow) is kept with `judgedBy: 'leader'`
 * (fact-log.ts): that leader judges the turn from its transcript, so a newer leader that reads the
 * fact back later applies it and acts on nothing of it (leader-apply.ts actedOnAlready). Never marked:
 * a fact while no leader answers (the older one stopped for its update, the computer asleep) or while
 * a leader answers whose presence began after the stand-down (a newer one whose channel is not open
 * yet): nobody judged those turns, and a turn end nobody acts on is worse than one acted on twice.
 * Not covered, a known duplicate: a turn that ends in the first afterMs of an older leader, before the
 * stand-down, is judged by this host (its fact unmarked) and by that leader, so a newer leader acts on
 * it again after the upgrade. Nothing on the host tells the two apart at that time. It is undone the moment a
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
  /** When the leader's presence that answers now began (server-role.ts leaderPresence().since, the watch's clock). */
  presenceSince?(): number
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
  /**
   * Does the leader this host stood down for judge a turn that ends now? Only while it is still the
   * one answering: standing down, a leader answers, and that presence began no later than the stand-
   * down (`presenceSince`, server-role.ts leaderPresence: it restarts at every change). With no
   * presenceSince to read, never (when in doubt, the fact is left for the leader to act on).
   */
  oldLeaderJudgesNow(): boolean
  /** What this host's status report says (see the header), and since when (this host's clock). */
  state(): { state: SessionSideState; since: number | null }
  stop(): void
}

export function startOldLeaderWatch(deps: OldLeaderWatchDeps, o: { timer?: boolean } = {}): OldLeaderWatch {
  const afterMs = deps.afterMs ?? oldLeaderMs()
  const now = deps.now ?? Date.now
  let since: number | null = null
  /** The presence `since` counts in (presenceSince): a new one, the leader back after a restart, counts from its own start. */
  let presenceAt: number | null = null
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
      // A leader that restarted between two looks is a new presence: its own channel gets the whole
      // bound, and its config copy (leaderSaysChannel) the time to be heard again. Counted from the
      // presence before it, a leader that says it speaks the channel read as an old one for the
      // moment its copy was not heard yet, and the host stood down and up at each restart (2026-11-25).
      const p = deps.presenceSince?.() ?? null
      // `waiting` stays as it was: a channel still shut after the restart is the same fault, and
      // Walnut Health keeps one item for it instead of recovering and raising it at every restart.
      if (p !== presenceAt) { presenceAt = p; since = null }
      since ??= now()
      if (down) {
        // Stood down, and the leader that answers now says it speaks the channel (a copy heard since
        // its presence began: a newer leader whose channel is not open yet, or a misfire on a link
        // flap): it treats this host's rows as host-judged, so this host judges them again now.
        if (await deps.leaderSaysChannel?.()) {
          down = false
          downAt = null
          waiting = true
          deps.log?.('info', 'host sessions: the leader that answers says it speaks the session channel; this host judges its sessions again while it waits for the channel')
          await deps.standUp()
        }
        return
      }
      if (now() - since >= afterMs) {
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
    oldLeaderJudgesNow: () => {
      if (!down || downAt === null || !deps.presenceSince || !deps.leaderAnswers()) return false
      return deps.presenceSince() <= downAt
    },
    state: () => down ? { state: 'stood-down', since: downAt } : waiting ? { state: 'waiting', since } : { state: 'judging', since: null },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null },
  }
}
