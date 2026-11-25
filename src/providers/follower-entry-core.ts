/**
 * What this host's own Walnut server (the follower) asks its daemon, as plain functions of
 * `(home, params)`: its leader's view, its Walnut's sessions here, a message or a prompt's
 * answer while the leader is away ('follower-alone-v1'), a task, Board or note write
 * journaled for the leader ('replica-ops-v1'), a message between two of its sessions
 * ('follower-peer-v1'), its triggers and trigger_test ('follower-triggers-v1'), what is
 * pending for it, and a new ask started here ('replica-start-v1'; WP12).
 *
 * One function, every helper inside it, types only imported. The daemon's `cmdFollower*` handlers check the
 * socket speaks for `home` (followerHomeOf), call one function here and send its answer; a
 * server that holds the daemon runtime in its own process calls the same functions with no
 * socket at all.
 *
 * One rule for "the leader is away" (mayWrite): no server answers that Walnut within the
 * quiet window (primaryAnswers), or its server is back but still taking the journal
 * (pendingHandover), so the journal stays the one writer until the drain ends.
 */
import type { LeaderBook } from './leader-core.js'
import type { OfflineHost } from './offline-host-core.js'
import type { HostStart, HostStartAnswer, HostStartPlan, TaskStartFields } from './host-start-core.js'
import type { FollowerTriggerAnswer } from './follower-trigger-delivery-core.js'

/** A follower call's answer: what the twin sends as ok, or its refusal (message and frame fields). */
export type FollowerAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; extra?: Record<string, unknown> }

/** The few facts of a live session the follower reads (the twins' registry entry). */
export interface FollowerLiveSession {
  state: string
  pid?: number | null
  jsonlPath: string
  pendingCtrl?: { reqId: string; toolName?: string; request?: unknown } | null
  foldState?: { turnActive?: boolean } | null
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

export interface FollowerEntryDeps<L> {
  fs: { statSync(p: string): { mtime: Date } }
  leaderBook: Pick<LeaderBook, 'recordOf' | 'primaryAgeMs' | 'heardSinceBoot' | 'backupLead'>
  offline: Pick<OfflineHost,
    | 'journalStats' | 'sessionsOf' | 'sliceRowsOf' | 'ownerOf' | 'pendingHandover' | 'deliverHuman' | 'handleFollowerPeer'
    | 'handleFollowerWaiting' | 'followerTriggers' | 'followerTriggerTest' | 'pendingFor' | 'checkTaskStart'
    | 'checkSession' | 'noteSessionWaiting' | 'noteSession' | 'noteRoutineTask'>
  hostStart: HostStart
  /** A primary's socket for `home` is open (the twins' primarySocketOpen). */
  primarySocketOpen(home: string): boolean
  /** A follower of `home` is linked now (followerSockets). */
  followerLinked(home: string): boolean
  /** The companion's link for `home` (bridgeLinkFor). */
  bridgeLink(home: string): { config?: { enabled?: boolean; url?: string } | null; adapter?: unknown } | null | undefined
  /** What the leader set for the host server of `home` (hostServers.settingsOf). */
  settingsOf(home: string): unknown
  /** The follower says how it is (hostServers.report). */
  reportServer(home: string, report: unknown): void
  /** The calls this daemon still answered itself while the follower was there (followerGateway.ownAnswers). */
  offlineAnswers(): unknown
  /** The follower's pick for a trigger fire it was offered (followerTriggers.answer). */
  triggerAnswer(link: L, cmd: Record<string, unknown>): Promise<FollowerTriggerAnswer>
  /** A primary not heard this long may be taken over by the companion (leader-core.ts). */
  takeoverMs: number
  /** The one window this daemon calls the leader away by (LEADER_QUIET_MS). */
  quietMs: number
  /** daemon.pid names this process or none (a zombie predecessor journals nothing). */
  ownsDir(): boolean
  session(sid: string): FollowerLiveSession | undefined
  /** A sid this host already uses: a session in the registry or one the spawn journal names. */
  sidTaken(sid: string): boolean
  /** A CLI for that session runs here, or did (clock-host-start-core.ts `ran`, the same function). */
  ran(sid: string): boolean
  answerPermission(sid: string, raw: Record<string, unknown>, label: string): Promise<{ ok: true; allow: boolean } | { ok: false; error: string; errorKind: string }>
  /** Start the CLI from the plan through the session start gate (clock-host-start-core.ts `spawn`, the same function). */
  spawn(home: string, taskId: string, plan: HostStartPlan): Promise<unknown>
  /** The turn-start line in the stream (the CLI never echoes its stdin). */
  marker(sid: string, text: string, messageId: string): void
  /** Ends a session's process group with SIGTERM (clock-host-start-core.ts `stop`, the same function). */
  stop(sid: string): void
  randomHex(bytes: number): string
  /** Tests only: right after an ask's CLI is spawned, before its record. */
  afterAskSpawn?: () => void
  log: Log
}

export function createFollowerEntry<L>(deps: FollowerEntryDeps<L>) {
  const { leaderBook, offline, hostStart } = deps
  type Refusal = { code: string; message: string; detail?: unknown; retryAfterMs?: number }
  const ok = (result: Record<string, unknown>): FollowerAnswer => ({ ok: true, result })
  const no = (error: string, extra?: Record<string, unknown>): FollowerAnswer => (extra ? { ok: false, error, extra } : { ok: false, error })
  /** A core's refusal as the frame carries it: its kind, and its detail and retry when it has them. */
  const refused = (name: string, e: Refusal): FollowerAnswer => no(name + ': ' + e.message, {
    errorKind: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
  })
  const notOwner = (name: string): FollowerAnswer => no(name + ': this daemon no longer owns its directory', { errorKind: 'journal_unwritable', detail: { why: 'not_owner' } })
  const leaderAnswers = (name: string, what = 'write through it'): FollowerAnswer => no(name + ': your Mac answers again; ' + what, { errorKind: 'leader_answers' })
  const errorText = (err: unknown) => (err as Error | null | undefined)?.message

  /** The follower-write quiet window, read in ONE place. */
  function followerQuietMs(): number {
    return deps.quietMs
  }

  /**
   * Whether the primary answers `home` for a follower's write: the same window the host
   * server routes by (host-server/route.ts LEADER_QUIET_MS) and a host replica's presence
   * (replica/presence.ts), so the page and the daemon agree on "away".
   */
  function primaryAnswers(home: string): boolean {
    // A primary unheard since this daemon started does not answer (D14).
    return deps.primarySocketOpen(home) && leaderBook.heardSinceBoot(home) && leaderBook.primaryAgeMs(home) < followerQuietMs()
  }

  /**
   * While a follower of `home` is linked, a primary not heard within the quiet window is
   * away for gateway routing too (the replica and its sessions see one Mac, not two
   * windows). A home with no follower keeps the missed-beats rule alone.
   */
  function quietWithFollower(home: string): boolean {
    return deps.followerLinked(home) && leaderBook.primaryAgeMs(home) >= deps.quietMs
  }

  /** Whether a follower of `home` may write now (the gateway's rule in sendGatewayRequest too). */
  function mayWrite(home: string): boolean {
    return !primaryAnswers(home) || offline.pendingHandover(home)
  }

  /** What a follower of `home` is told about its leader (the leader book's view, plus its settings). */
  function view(home: string): Record<string, unknown> | null {
    const rec = leaderBook.recordOf(home)
    if (!rec) return null
    const age = leaderBook.primaryAgeMs(home)
    let companion: string | null = null
    const link = deps.bridgeLink(home)
    try { if (link?.config?.enabled && link.config.url) companion = new URL(link.config.url.replace(/^ws/, 'http')).origin } catch { companion = null }
    const stats = offline.journalStats(home)
    return {
      walnutId: rec.walnutId,
      home,
      epoch: rec.epoch,
      holder: rec.holder,
      backup: rec.backup,
      // A primary this daemon has not heard since it started is not answering yet (D14);
      // the companion's takeover still waits takeoverMs from boot (leader-core.ts).
      primaryConnected: deps.primarySocketOpen(home) && leaderBook.heardSinceBoot(home) && age < deps.takeoverMs,
      primaryHeardAgoMs: age,
      heardSinceBoot: leaderBook.heardSinceBoot(home),
      takeoverMs: deps.takeoverMs,
      // The window this daemon calls the Mac away by (the replica's presence reads it).
      quietMs: deps.quietMs,
      bridge: { connected: link?.adapter != null, companion },
      settings: deps.settingsOf(home),
      // Journal v2: the away line, and `drainablePending` for presence.
      journal: stats,
      drainablePending: stats.drainable,
      // The calls this daemon still answered itself while the follower was there (followerGateway.noteOwnOffline).
      offlineAnswers: deps.offlineAnswers(),
    }
  }

  /** The follower says how it is; the leader reads it with server.status. */
  function report(home: string, said: unknown): void {
    deps.reportServer(home, said)
  }

  /** This Walnut's sessions here, from its copy, with what the registry knows of each now. */
  function sessions(home: string): Record<string, unknown> {
    const copy = offline.sessionsOf(home)
    if (!copy) return { host: '', asOf: null, sessions: [] }
    const list = copy.sessions.map((s) => {
      const live = deps.session(s.sid)
      const running = live?.state === 'running'
      let lastActiveAt: string | undefined
      try { if (live) lastActiveAt = deps.fs.statSync(live.jsonlPath).mtime.toISOString() } catch {}
      const pc = running ? live!.pendingCtrl : null
      const req = (pc?.request ?? {}) as { subtype?: unknown; tool_name?: unknown; input?: unknown; decision_reason?: unknown }
      const prompt = pc && req.subtype === 'can_use_tool'
        ? { requestId: pc.reqId, toolName: pc.toolName || (typeof req.tool_name === 'string' ? req.tool_name : 'tool'), input: req.input ?? {}, ...(typeof req.decision_reason === 'string' ? { reason: req.decision_reason } : {}) }
        : null
      return { ...s, state: !running ? 'stopped' : live!.foldState?.turnActive ? 'working' : 'idle', ...(prompt ? { prompt } : {}), ...(lastActiveAt ? { lastActiveAt } : {}) }
    })
    return { host: copy.host, asOf: copy.asOf, sessions: list }
  }

  /**
   * The slice of its Walnut as the leader pushed it, for a service that keeps no copy
   * ('copyless-service-v1', replica/slice-source.ts): the rows its reads and writes take.
   */
  function slice(home: string): Record<string, unknown> {
    return offline.sliceRowsOf(home) ?? { host: '', asOf: null, tasks: [], sessions: [], requests: [], boards: [], boardOf: {} }
  }

  /** A follower's write is for a session of its Walnut, while no server answers that Walnut. */
  function writeTarget(home: string, cmd: Record<string, unknown>, name: string): { sid: string } | FollowerAnswer {
    if (!mayWrite(home)) return leaderAnswers(name)
    const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
    if (!sid || offline.ownerOf(sid) !== home) return no(name + ': not a session of this Walnut on this host', { errorKind: 'not_found' })
    return { sid }
  }

  /** A message from the follower's page to a running session of its Walnut (journaled for the leader). */
  async function send(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    const t = writeTarget(home, cmd, 'follower.send')
    if ('ok' in t) return t
    const r = await offline.deliverHuman(home, t.sid, cmd.text, cmd.messageId)
    if (r.ok) return ok({ delivered: true, messageId: (r.result as { messageId?: unknown }).messageId })
    return no('follower.send: ' + r.error.message, { errorKind: r.error.code })
  }

  /** The answer to a session's prompt, on the server's own write path (the twins' answerPermission). */
  async function permission(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    const t = writeTarget(home, cmd, 'follower.permission')
    if ('ok' in t) return t
    const r = await deps.answerPermission(t.sid, cmd, 'follower.permission')
    if (!r.ok) return no('follower.permission: ' + r.error, { errorKind: r.errorKind })
    return ok({ status: 'resolved', requestId: cmd.requestId as string, allow: r.allow })
  }

  /** The follower's pick for a trigger fire it was offered (follower-trigger-delivery-core.ts), from the link it was offered on. */
  async function triggerDeliver(link: L, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    const r = await deps.triggerAnswer(link, cmd)
    if (r.ok) return ok(r.result)
    return no('follower.trigger.deliver: ' + r.message, { errorKind: r.code })
  }

  /**
   * A message between two of this Walnut's sessions here that the follower decided
   * (replica/away-sends.ts): this daemon writes it into the live CLI and journals it
   * (offline-host-core.ts handleFollowerPeer). `online` (made while the server answers,
   * handleLocal's records) passes whoever leads; anything else only while the follower may write.
   */
  async function peer(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    if (cmd.online !== true && !mayWrite(home)) return leaderAnswers('follower.peer')
    // The companion leads: it delivers a message to another host now, so nothing is held for later.
    if (cmd.kind === 'hold' && leaderBook.backupLead(home)) return no('follower.peer: the cloud companion leads; it routes this message', { errorKind: 'needs_leader', detail: { why: 'companion_leads' } })
    if (!deps.ownsDir()) return notOwner('follower.peer')
    const r = await offline.handleFollowerPeer(home, cmd)
    return r.ok ? ok(r.result as Record<string, unknown>) : refused('follower.peer', r.error)
  }

  /**
   * The replica's write while the Mac is away (journal v2): a task, Board or note change
   * journaled for the Mac, with the writer's op id, actor and bases. Its own gate (not
   * writeTarget, which needs a session): the quiet window unless the Mac is still taking the
   * journal, and the daemon dir's owner.
   */
  async function op(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    if (!mayWrite(home)) return leaderAnswers('follower.op')
    if (!deps.ownsDir()) return notOwner('follower.op')
    // Waits out another process's journal lock (about 1.3 s) before it answers.
    const r = await offline.handleFollowerWaiting(home, { op: cmd.op, args: cmd.args, actor: cmd.actor, opId: cmd.opId, base: cmd.base })
    return r.ok ? ok(r.result as Record<string, unknown>) : refused('follower.op', r.error)
  }

  /** Its Walnut's triggers here: reads only, never in the serial command lane (a check may run for minutes). */
  function triggers(home: string, cmd: Record<string, unknown>): Record<string, unknown> {
    return offline.followerTriggers(home, cmd.triggerId)
  }

  /** Its trigger_test: a test writes no trigger state. */
  async function triggerTest(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    const r = await offline.followerTriggerTest(home, { actor: cmd.actor, args: cmd.args })
    return r.ok ? ok(r.result as Record<string, unknown>) : refused('follower.trigger.test', r.error)
  }

  /** What is pending for the follower's Walnut (its overlay; read only). */
  function pending(home: string, cmd: Record<string, unknown>): Record<string, unknown> {
    return offline.pendingFor(home, cmd.sinceSeq) as unknown as Record<string, unknown>
  }

  /** A start's answer as sent (a retry gets the first one, marked duplicate). */
  function startAnswer(a: HostStartAnswer, duplicate = false): FollowerAnswer {
    if (a.ok) return ok(duplicate ? { ...a.reply, duplicate: true } : a.reply)
    return no(a.error, a.extra)
  }

  function startRefusal(error: Refusal): HostStartAnswer {
    return {
      ok: false, error: 'follower.start: ' + error.message,
      extra: { errorKind: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
    }
  }

  /**
   * The replica's new ask while the Mac is away: every check, then the CLI from the
   * template, then its `session` record. `check: true` runs the checks only (the replica
   * journals the ask's task after they pass).
   */
  async function start(home: string, cmd: Record<string, unknown>): Promise<FollowerAnswer> {
    if (!mayWrite(home)) return leaderAnswers('follower.start', 'start the ask through it')
    if (!deps.ownsDir()) return notOwner('follower.start')
    const taken = no('follower.start: that session id is taken on this host', { errorKind: 'bad_request' })
    const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
    const check = cmd.check === true
    // A retry (its answer lost, or asked again while the CLI still starts): the first
    // attempt's answer once it comes, never a second plan or a second CLI.
    const first = sid ? hostStart.firstStart(home, sid) : null
    if (first === 'taken') return taken
    if (first) {
      deps.log('info', 'follower.start: asked again, answered by the first start', { home, sid, check })
      if (check) return ok({ sid, checked: true, duplicate: true })
      return startAnswer(await first, true)
    }
    if (sid && offline.ownerOf(sid) === home) {
      deps.log('info', 'follower.start: asked again, started once', { home, sid })
      return ok(check ? { sid, checked: true, duplicate: true } : { sid, duplicate: true })
    }
    if (sid && deps.sidTaken(sid)) return taken
    // A plain session of a task made here (`run: 'task'`, a host replica's own gateway call):
    // the Mac adopts it as the task's own session, so only a Mac that drains `task-start`.
    const taskRun = cmd.run === 'task'
    if (taskRun) {
      const room = offline.checkTaskStart(home, sid, cmd.actor)
      if (!room.ok || check) return room.ok ? ok({ sid, checked: true }) : startAnswer(startRefusal(room.error))
    }
    if (check) {
      const refusal = hostStart.precheck(home, cmd)
      if (refusal) return startAnswer(startRefusal(refusal))
      const room = offline.checkSession(home, sid, cmd.actor)
      if (!room.ok) return startAnswer(startRefusal(room.error))
      return ok({ sid, checked: true })
    }
    const hostKey = typeof cmd.host === 'string' ? cmd.host : ''
    const planned = taskRun ? hostStart.planTask(home, cmd as unknown as TaskStartFields, hostKey) : hostStart.plan(home, cmd, hostKey)
    if (!planned.ok) return startAnswer(startRefusal(planned))
    const p = planned.plan
    const answer = hostStart.once(home, p.sid, () => startHostAsk(home, p, cmd))
    if (answer === 'taken') return taken
    return startAnswer(await answer)
  }

  /** One ask's start: refusals before the CLI, the record after it runs (a failed start leaves none). */
  async function startHostAsk(home: string, p: HostStartPlan, cmd: Record<string, unknown>): Promise<HostStartAnswer> {
    const release = hostStart.begin(home)
    try {
      const room = cmd.run === 'task' ? offline.checkTaskStart(home, p.sid, cmd.actor) : offline.checkSession(home, p.sid, cmd.actor)
      if (!room.ok) return startRefusal(room.error)
      // The request's op id names its task-create too (the same request): the session record takes its own.
      const opId = typeof cmd.opId === 'string' && /^[A-Za-z0-9_-]{1,72}$/.test(cmd.opId) ? cmd.opId + '-session' : 'session-' + p.sid
      // On disk before the CLI runs: a daemon that dies before the record below is kept
      // journals it at its next boot (recoverPendingAsks), so the Mac still adopts the ask.
      try { hostStart.holdPending(home, { sid: p.sid, record: p.record, opId, ...(cmd.actor !== undefined ? { actor: cmd.actor } : {}) }) } catch (err) {
        return startRefusal({ code: 'journal_unwritable', message: 'this host could not keep the start: ' + errorText(err) })
      }
      try {
        await deps.spawn(home, p.taskId, p)
      } catch (err) {
        hostStart.releasePending(home, p.sid)
        throw err
      }
      deps.afterAskSpawn?.()
      const saved = await offline.noteSessionWaiting(home, p.record, opId, cmd.actor)
      hostStart.releasePending(home, p.sid)
      if (!saved.ok) {
        // Nothing would tell the Mac about this CLI: it must not run unseen. Not stamped as an
        // intentional stop (only the idle scan, cmdStop and a budget pause are): no record names
        // this session, so how its death reads matters to no one.
        deps.stop(p.sid)
        deps.log('warn', 'follower.start: the session record was not kept, the CLI is stopped', { home, sid: p.sid, code: saved.error.code })
        return startRefusal(saved.error)
      }
      // The turn start in the stream (the CLI never echoes its stdin), as a host resume writes it.
      const messageId = typeof cmd.messageId === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(cmd.messageId) ? cmd.messageId : 'qm-ask-' + deps.randomHex(8)
      if (p.message) {
        try { deps.marker(p.sid, p.message, messageId) } catch (err) { deps.log('warn', 'follower.start: no turn-start marker', { sid: p.sid, error: errorText(err) }) }
      }
      const seq = (saved.result as { seq?: number }).seq
      deps.log('info', 'follower.start: an ask started on this host while the Mac is away', { home, sid: p.sid, taskId: p.taskId, mode: p.mode, seq })
      return { ok: true, reply: { sid: p.sid, taskId: p.taskId, mode: p.mode, cwd: p.cwd, messageId, seq } }
    } catch (err) {
      deps.log('warn', 'follower.start: the ask did not start', { home, sid: p.sid, taskId: p.taskId, error: errorText(err) })
      return { ok: false, error: 'follower.start: ' + errorText(err), extra: { errorKind: 'internal' } }
    } finally {
      release()
    }
  }

  /**
   * Asks a daemon death cut between their CLI and their `session` record (startHostAsk keeps
   * each start on disk until its record is): one whose CLI ran is journaled now, under the
   * same op id, so the Mac adopts it; one that never started leaves nothing. Runs at boot,
   * after the sessions are adopted and before any client connects.
   */
  function recoverPendingAsks(): void {
    for (const p of hostStart.pendingStarts()) {
      try {
        if (deps.ran(p.sid) && offline.ownerOf(p.sid) !== p.home) {
          // A routine run's own task goes first (clock-host-start-v1): its session record names it.
          const task = p.task ? offline.noteRoutineTask(p.home, p.task.record, p.task.opId, p.task.jobId) : null
          const saved = task && !task.ok ? task : offline.noteSession(p.home, p.record, p.opId, p.actor)
          if (saved.ok) {
            deps.log('info', 'startup: an ask cut before its session record is journaled now', { home: p.home, sid: p.sid, taskId: p.record.taskId })
          } else {
            deps.stop(p.sid)
            deps.log('warn', 'startup: an ask cut before its session record could not be kept, the CLI is stopped', { home: p.home, sid: p.sid, code: saved.error.code })
          }
        }
      } catch (err) {
        deps.log('warn', 'startup: a pending ask was not recovered', { sid: p.sid, error: errorText(err) })
      }
      hostStart.releasePending(p.home, p.sid)
    }
  }

  return {
    view, report, sessions, slice, send, permission, triggerDeliver, peer, op, triggers, triggerTest, pending, start, recoverPendingAsks,
    primaryAnswers, quietWithFollower, mayWrite, followerQuietMs,
  }
}

export type FollowerEntry<L = unknown> = ReturnType<typeof createFollowerEntry<L>>
