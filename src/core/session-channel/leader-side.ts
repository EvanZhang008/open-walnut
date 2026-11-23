/**
 * The leader's side of the hosts that run and judge their own sessions
 * (docs/plan/one-service-every-host.md, phase 2; the wire contract is design/C3b-design.md of the
 * task that built it). Leader only, and only while the switch is on (switch.ts).
 *
 * Per host whose service names SESSION_JUDGE_CAP and is connected:
 *   - one session channel: a WebSocket (`GET /host-api/session-channel`) over a stream the host's
 *     daemon relays to its server (`openStream('follower', 'session-channel')`), spoken by
 *     channel.ts attachLeaderChannel. What it applies: the host's rows, renames and the channel's
 *     position in one transaction (session-tracker applyHostChannelBatch), then the facts on this
 *     bus (`source: 'host-channel'`, `late` for a record read back long after it happened), and
 *     the `live` records into the proxies' mirrored state (providers/remote-judged-session.ts).
 *     A dropped link dials again with a backoff.
 *   - or the socket the host dialed into this leader's door (host-door.ts), once both proved who
 *     they are: `adopt`. One link per host: the newer one wins and the older is closed `replaced`;
 *     while a host-dialed socket is up the leader dials nothing to that host.
 *   - the commands: start, send, interrupt and the allowlisted calls (host-calls.ts), each one
 *     HTTP request on a stream of its own (`openStream('follower', 'session-call')`), or call
 *     frames on the host-dialed socket while that is the link (leader-links.ts).
 *   - the deletes this leader made of the host's sessions (leader-drops.ts): sent when one is made
 *     and again each time the channel links, until the host's `drop` record answers each one.
 */
import type { Duplex } from 'node:stream'
import { attachLeaderChannel, isChannelFrame, type AppliedFact, type ChannelCursor, type ChannelFrame, type ChannelLink, type PermitPair } from './channel.js'
import { channelClassOf, sessionIdOf } from './event-classes.js'
import { EventNames } from '../event-bus.js'
import { HOST_SESSIONS_PATH, type LiveState } from './host-api.js'
import { SESSION_JUDGE_CAP, SESSION_RESUME_CAP } from './switch.js'
import { isTurnEndName, turnEndEdgeOf } from '../sessions/turn-end-edge.js'
import type { HostTurnEnd } from './turn-ends.js'
import { answerOf, dialOverStream, requestOverStream, type ChannelSocket, type HostCallAnswer } from './leader-links.js'
import type { HostChannelBatch, HostChannelBatchResult } from '../session-tracker.js'
import type { SessionRecord } from '../types.js'
import { noteFrameParsed } from '../../providers/line-parse-count.js'

export { HostRequestNotSent, requestNotSent, type ChannelSocket, type HostCallAnswer } from './leader-links.js'

export interface LeaderSideDeps {
  walnutId(): Promise<string>
  /** This leader's standing on the host (channel.ts PermitPair): the permit's number and its claim epoch there. */
  permit(hostId: string): PermitPair
  /** The switch for each host now (switch.ts hostSwitchNow): would a new start on that host go to its service? */
  switchNow(): Promise<(hostKey: string) => boolean>
  /** A byte stream to the server on `hostKey`, through its daemon; throws when it is not connected. */
  openStream(hostKey: string, purpose: string): Promise<Duplex>
  /** The channel's link to `hostKey` (default: a WebSocket over openStream). */
  dial?(hostKey: string): Promise<ChannelSocket>
  /** One HTTP request to the host's server (default: requestOver on openStream). */
  request?(hostKey: string, route: string, body: unknown, timeoutMs: number): Promise<HostCallAnswer>
  applyBatch(batch: HostChannelBatch): Promise<Pick<HostChannelBatchResult, 'written' | 'skipped'> & Partial<HostChannelBatchResult>>
  /**
   * The host whose service judges `sid` here (judge-of.ts judgingHostOf), or null: a host's fact,
   * live state or flow event names only a session that host owns, or one this batch wrote.
   */
  ownerOf(sid: string): string | null
  /** Sessions a start this leader handed on is waiting for (no born row yet): a rows snapshot keeps them. */
  startsInFlight?(): ReadonlySet<string>
  /** The deletes of `hostId`'s sessions it has not answered yet (leader-drops.ts leaderDropsOf). */
  leaderDrops?(hostId: string): Promise<string[]>
  loadCursor(hostId: string): Promise<ChannelCursor | null>
  /**
   * Re-emit one host fact or flow event on this server's bus; `to`: the destinations the host's emit
   * named; `at`: when a fact happened, on this leader's clock (channel.ts AppliedFact.happenedAt).
   */
  emit(name: string, data: unknown, opts: { late: boolean; to?: string[]; at?: number }): void
  noteLive(sid: string, state: LiveState, hostId: string): void
  /** A host's born row of `sid` was applied: a start this leader handed on is no longer in flight. */
  noteBorn?(sid: string): void
  /** The link to `hostId` has been gone past liveUnknownMs: what its sessions do now is not known here. */
  onLinkLost?(hostId: string): void
  /** How long a dropped link may stay down before onLinkLost (default 90 s). */
  liveUnknownMs?: number
  noteRename(from: string, to: string): void
  noteHostJudged(sid: string, host: string): void
  /** The channel to `hostId` linked (its hello): what waits here for that host goes now (host-judged-send.ts). */
  onLinked?(hostId: string): void
  /** What `hostId`'s log held at the link's hello is applied: this leader's rows of that host are current (channel.ts onCaughtUp). */
  onCaughtUp?(hostId: string): void
  backoffMs?(attempt: number): number
  callTimeoutMs?: number
  startTimeoutMs?: number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

interface HostState {
  connected: boolean
  judges: boolean
  socket: ChannelSocket | null
  dialing: boolean
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  /** The attach of the current link, for tests (idle) and its close. */
  channel: ReturnType<typeof attachLeaderChannel> | null
  /** When each session's whole row was last asked for (resync), so a row the leader keeps refusing is not asked for in a loop. */
  resyncAt: Map<string, number>
  /** Runs while the link is down: past it, the host's live state reads unknown here (R2-M1). */
  lostTimer: ReturnType<typeof setTimeout> | null
  /** The current socket is one the host dialed into the door (adopt): kept whatever the daemon link says, never redialed. */
  dialedIn: boolean
}

/** A session's whole row is asked for again at most this often. */
const RESYNC_EVERY_MS = 10 * 60_000

const defaultBackoff = (attempt: number): number => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))

/** The session:started of a session born on `hostId`, from its row (as the runner says one: handleStart). */
function startedOf(hostId: string, sid: string, row: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return { sessionId: sid, claudeSessionId: sid, taskId: str(row.taskId), project: str(row.project) ?? '', host: hostId }
}

export function createLeaderSide(deps: LeaderSideDeps) {
  const hosts = new Map<string, HostState>()
  let onFor: (hostKey: string) => boolean = () => false
  let stopped = false
  let walnutId: string | null = null

  const readSwitch = async (): Promise<void> => {
    const next = await deps.switchNow().catch(() => () => false)
    if (!stopped) onFor = next
  }

  const stateOf = (hostKey: string): HostState => {
    let s = hosts.get(hostKey)
    if (!s) {
      s = { connected: false, judges: false, socket: null, dialing: false, attempt: 0, timer: null, channel: null, resyncAt: new Map(), lostTimer: null, dialedIn: false }
      hosts.set(hostKey, s)
    }
    return s
  }
  /**
   * The channel is kept while the host is linked and runs its sessions, whatever the switch says
   * now: a session the leader handed it before the switch went off still reports through it. The
   * switch decides only where a new start goes (hostJudges). A socket the host dialed in is kept
   * whatever the daemon link says: the host proved itself at the door (host-door.ts).
   */
  const wanted = (s: HostState): boolean => !stopped && ((s.dialedIn && !!s.socket) || (s.connected && s.judges))

  /** One step after the commit: a throw is logged, never closes the link (the position is already past it). */
  function after(hostId: string, what: string, sid: string, fn: () => void): void {
    try { fn() } catch (err) {
      deps.log('warn', 'session channel: a step after the apply failed', { hostId, what, sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Does this record of `hostId` name a session that host owns here (M1)? */
  function hostsOwn(hostId: string, sid: string, wrote: ReadonlySet<string>): boolean {
    if (wrote.has(sid)) return true
    try { return deps.ownerOf(sid) === hostId } catch { return false }
  }

  /** Ask the host for these rows whole (rate-limited per session). */
  function askResync(hostId: string, sids: readonly string[]): void {
    const s = hosts.get(hostId)
    if (!s?.channel || sids.length === 0) return
    const at = Date.now()
    const due = sids.filter((sid) => at - (s.resyncAt.get(sid) ?? 0) >= RESYNC_EVERY_MS)
    if (due.length === 0) return
    for (const sid of due) s.resyncAt.set(sid, at)
    if (s.resyncAt.size > 5_000) for (const [k, v] of s.resyncAt) if (at - v >= RESYNC_EVERY_MS) s.resyncAt.delete(k)
    deps.log('info', 'session channel: asking the host for rows the leader could not apply', { hostId, sessionIds: due.slice(0, 20), count: due.length })
    s.channel.resync(due)
  }

  async function applyRecs(hostId: string, recs: AppliedFact[], next: ChannelCursor): Promise<void> {
    const rows: HostChannelBatch['rows'][number][] = []
    const renames: HostChannelBatch['renames'][number][] = []
    const drops: string[] = []
    const check = new Set<string>()
    // Turn ends that move a task's phase: marked with the rows, so a leader that stops before saying them sets the phase at boot (turn-ends.ts).
    const turnEnds: HostTurnEnd[] = []
    // A new id a rename of this batch moves a row to: its row is that session's, never a start (R2-H1).
    const renamedTo = new Set<string>()
    for (const r of recs) {
      const d = (r.data ?? {}) as Record<string, unknown>
      // A `resync` row is the host's whole row again: applied as a born one (its omitted fields cleared, made when missing).
      if (r.name === 'row') rows.push({ sid: r.sid, born: d.born === true || d.resync === true, patch: (d.patch ?? {}) as Record<string, unknown>, seq: r.seq })
      else if (r.name === 'rename' && typeof d.from === 'string' && typeof d.to === 'string') { renames.push({ from: d.from, to: d.to, seq: r.seq }); renamedTo.add(d.to) }
      else if (r.name === 'drop') drops.push(r.sid)
      else {
        check.add(r.sid)
        // Every turn end of the session counts: one with no edge (a retrier took it, work goes on) still supersedes an older mark.
        if (channelClassOf(r.name) === 'fact' && sessionIdOf(r.name, r.data) === r.sid && isTurnEndName(r.name)) turnEnds.push({ sid: r.sid, edge: turnEndEdgeOf(r.name, r.data), seq: r.seq })
      }
    }
    const applied = await deps.applyBatch({ hostId, rows, renames, cursor: next, ...(drops.length ? { drops } : {}), ...(check.size ? { check: [...check] } : {}), ...(turnEnds.length ? { turnEnds } : {}) })
    const { written } = applied
    for (const sid of written) after(hostId, 'noteHostJudged', sid, () => deps.noteHostJudged(sid, hostId))
    const wrote = new Set(written)
    // Deleted here, its host not done yet: nothing of it is said (leader-drops.ts).
    const gone = new Set(applied.gone ?? [])
    // Applied by a link before this one (the transaction read the position, M2): said then.
    const appliedBefore = applied.after ?? 0
    if (applied.resync?.length) askResync(hostId, applied.resync)
    let refused = 0
    // After the commit, in log order: the rows a fact's subscribers read are already there.
    for (const r of recs) {
      if (r.seq <= appliedBefore || gone.has(r.sid)) continue
      if (r.name === 'row') {
        // A session born on the host: said as started here, at its row's place. A start the host
        // began itself says none the leader hears (a native one has no id yet), so this is its
        // only one; for a start this leader handed on, the channel's emit keeps one in all
        // (leader-tasks.ts claimHostStarted). A rows frame (applyRows) is a resync, never a start,
        // and so is a whole row the host sends again (`resync`: its boot, the leader's ask).
        // It names no destinations: it goes where a start this leader hands on says it (reemitDestinations).
        const d = (r.data ?? {}) as { born?: unknown; patch?: Record<string, unknown> }
        if (d.born === true && wrote.has(r.sid)) {
          if (deps.noteBorn) after(hostId, 'noteBorn', r.sid, () => deps.noteBorn!(r.sid))
          if (!renamedTo.has(r.sid)) emitFact(hostId, r, EventNames.SESSION_STARTED, startedOf(hostId, r.sid, d.patch ?? {}), undefined)
        }
        continue
      }
      // A dropped session holds nothing live on its host.
      if (r.name === 'drop') { after(hostId, 'noteLive', r.sid, () => deps.noteLive(r.sid, { gone: true }, hostId)); continue }
      if (r.name === 'turn-summary') continue
      if (r.name === 'rename') {
        // Only a rename the batch applied: the host renamed a row of its own (the transaction checked `from`).
        const d = r.data as { from?: string; to?: string }
        if (d?.from && d?.to && wrote.has(d.to)) after(hostId, 'noteRename', d.to, () => deps.noteRename(d.from!, d.to!))
        continue
      }
      if (!hostsOwn(hostId, r.sid, wrote)) { refused++; continue }
      if (r.name === 'live') {
        after(hostId, 'noteLive', r.sid, () => deps.noteLive(r.sid, ((r.data as { state?: LiveState } | null)?.state ?? {}) as LiveState, hostId))
        continue
      }
      if (channelClassOf(r.name) !== 'fact') continue
      // The event names the record's own session, or it is not said.
      if (sessionIdOf(r.name, r.data) !== r.sid) { refused++; continue }
      emitFact(hostId, r, r.name, r.data, r.to)
    }
    if (refused > 0) deps.log('warn', 'session channel: records of sessions this host does not own were not said', { hostId, count: refused })
    // A hand-over its host answered with a row that is no born one (a row it owned already): ended too.
    const bornHere = new Set(recs.filter((r) => r.name === 'row' && (r.data as { born?: unknown } | null)?.born === true).map((r) => r.sid))
    if (deps.noteBorn) for (const sid of applied.handOversEnded ?? []) if (!bornHere.has(sid)) after(hostId, 'noteBorn', sid, () => deps.noteBorn!(sid))
  }

  function emitFact(hostId: string, r: AppliedFact, name: string, data: unknown, to: string[] | undefined): void {
    after(hostId, name, r.sid, () => deps.emit(name, data, { late: r.late, at: r.happenedAt, ...(to ? { to } : {}) }))
  }

  async function applyRows(hostId: string, rows: SessionRecord[], next: ChannelCursor, frame: { at: number; gone: string[] }): Promise<void> {
    const { written, removed } = await deps.applyBatch({
      hostId,
      rows: rows.map((row) => ({ sid: row.claudeSessionId, born: true, patch: row as unknown as Record<string, unknown> })),
      renames: [],
      cursor: next,
      // Every row the host owns now, as of record `at`: only a row it names gone is deleted (rows-snapshot.ts).
      snapshot: { keep: deps.startsInFlight?.() ?? new Set(), at: frame.at, gone: frame.gone },
    })
    for (const sid of written) after(hostId, 'noteHostJudged', sid, () => deps.noteHostJudged(sid, hostId))
    if (deps.noteBorn) for (const sid of written) after(hostId, 'noteBorn', sid, () => deps.noteBorn!(sid))
    if (removed?.length) deps.log('info', 'session channel: rows the host no longer has were removed here', { hostId, count: removed.length })
  }

  function schedule(hostKey: string, s: HostState): void {
    if (!wanted(s) || s.timer || s.socket || s.dialing) return
    const delay = (deps.backoffMs ?? defaultBackoff)(s.attempt++)
    s.timer = setTimeout(() => { s.timer = null; ensure(hostKey) }, delay)
    s.timer.unref?.()
  }

  /** The link went down: past the bound, the host's sessions read unknown here, not running. */
  function armLost(hostKey: string, s: HostState): void {
    if (s.lostTimer || stopped) return
    s.lostTimer = setTimeout(() => {
      s.lostTimer = null
      if (s.socket || stopped) return
      try { deps.onLinkLost?.(hostKey) } catch (err) {
        deps.log('warn', 'session channel: marking a host\'s live state unknown failed', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
      }
    }, deps.liveUnknownMs ?? 90_000)
    s.lostTimer.unref?.()
  }

  function closeLink(s: HostState, why: string): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (s.lostTimer) { clearTimeout(s.lostTimer); s.lostTimer = null }
    dropSocket(s, why)
  }

  /** Close the current socket (its channel first), leaving the timers as they are. */
  function dropSocket(s: HostState, why: string): void {
    const sock = s.socket
    s.socket = null
    s.dialedIn = false
    s.channel?.onClose()
    s.channel = null
    try { sock?.close(why) } catch { /* gone */ }
  }

  function ensure(hostKey: string): void {
    const s = stateOf(hostKey)
    if (!wanted(s)) { if (s.socket || s.timer) closeLink(s, 'not_wanted'); return }
    if (s.socket || s.dialing || s.timer) return
    s.dialing = true
    void (async () => {
      walnutId ??= await deps.walnutId()
      return (deps.dial ?? ((k: string) => dialOverStream(deps.openStream, k)))(hostKey)
    })().then((sock) => {
      s.dialing = false
      // Not wanted any more, or the host dialed in meanwhile: a host-dialed link is never replaced by a dial of ours.
      if (!wanted(s) || s.socket) { try { sock.close(s.socket ? 'replaced' : 'not_wanted') } catch { /* gone */ } return }
      bind(hostKey, s, sock)
    }, (err: unknown) => {
      s.dialing = false
      deps.log('warn', 'session channel: dialing the host failed; trying again', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
      schedule(hostKey, s)
    })
  }

  /** Speak the channel on `sock`, now this host's one link. */
  function bind(hostKey: string, s: HostState, sock: ChannelSocket): void {
    s.socket = sock
    s.dialedIn = sock.kind === 'host-dialed'
    if (s.lostTimer) { clearTimeout(s.lostTimer); s.lostTimer = null }
    const link: ChannelLink = {
      send: (frame: ChannelFrame) => sock.send(JSON.stringify(frame)),
      close: (why?: string) => sock.close(why),
    }
    const channel = attachLeaderChannel(link, {
      walnutId: walnutId!,
      hostId: hostKey,
      permit: () => deps.permit(hostKey),
      loadCursor: deps.loadCursor,
      apply: applyRecs,
      applyRows,
      onFlow: (hostId, sid, name, data, to) => {
        // A text delta of a session this host owns, naming that session, or nothing (M1).
        if (!hostsOwn(hostId || hostKey, sid, new Set()) || sessionIdOf(name, data) !== sid) return
        try { deps.emit(name, data, { late: false, ...(to ? { to } : {}) }) } catch { /* a flow event is never kept */ }
      },
      onCaughtUp: (hostId) => deps.onCaughtUp?.(hostId || hostKey),
      onLog: deps.log,
    })
    s.channel = channel
    sock.onMessage((text) => {
      let frame: unknown
      noteFrameParsed('channel')
      try { frame = JSON.parse(text) } catch { return }
      if (!isChannelFrame(frame)) return
      if (frame.op === 'hello') {
        s.attempt = 0
        void flushDrops(hostKey)
        try { deps.onLinked?.(hostKey) } catch (err) { deps.log('warn', 'session channel: what waited for the host was not sent', { host: hostKey, error: err instanceof Error ? err.message : String(err) }) }
      }
      channel.onFrame(frame)
    })
    sock.onClose(() => {
      channel.onClose()
      if (s.channel === channel) s.channel = null
      if (s.socket !== sock) return
      s.socket = null
      s.dialedIn = false
      deps.log('info', 'session channel: the link to the host closed', { host: hostKey, kind: sock.kind ?? 'leader-dialed' })
      armLost(hostKey, s)
      schedule(hostKey, s)
    })
  }

  async function defaultRequest(hostKey: string, route: string, body: unknown, timeoutMs: number): Promise<HostCallAnswer> {
    // A host-dialed socket is the link: its calls ride it as frames (the daemon link may be gone).
    const sock = hosts.get(hostKey)?.socket
    if (sock?.call) {
      const r = await sock.call('POST', route, body ?? {}, timeoutMs)
      return typeof r.body === 'object' && r.body !== null ? r.body as HostCallAnswer : answerOf(r.status, JSON.stringify(r.body ?? null))
    }
    return requestOverStream(deps.openStream, hostKey, route, body, timeoutMs)
  }

  const request = (hostKey: string, op: string, body: unknown, timeoutMs: number): Promise<HostCallAnswer> =>
    (deps.request ?? defaultRequest)(hostKey, `${HOST_SESSIONS_PATH}/${op}`, body, timeoutMs)

  /** Every delete `hostKey` has not answered yet, sent again (its `drop` records clear them). */
  async function flushDrops(hostKey: string): Promise<void> {
    if (stopped || !deps.leaderDrops) return
    try {
      const sids = await deps.leaderDrops(hostKey)
      if (sids.length === 0) return
      const a = await request(hostKey, 'drop', { sids }, deps.callTimeoutMs ?? 60_000)
      if (a.ok !== true) throw new Error(a.error ?? 'refused')
      deps.log('info', 'session channel: the host was asked to drop the sessions this leader deleted', { host: hostKey, count: sids.length })
    } catch (err) {
      // Asked again at the next link.
      deps.log('warn', 'session channel: the host did not take the deletes; they go again at the next link', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    /** A host's state changed: connected, and whether its service names SESSION_JUDGE_CAP. */
    async noteHost(hostKey: string, o: { connected: boolean; judges: boolean }): Promise<void> {
      if (stopped) return
      await readSwitch()
      if (stopped) return
      const s = stateOf(hostKey)
      const had = !!s.socket
      s.connected = o.connected
      s.judges = o.judges
      if (!wanted(s)) s.attempt = 0
      ensure(hostKey)
      // A host that went away with its link open: the link is closed by ensure; its live state ages out.
      if (had && !s.socket) armLost(hostKey, s)
    },
    /** The switch may have changed (a config write): read it again for the next start. */
    async refreshFlag(): Promise<void> {
      if (stopped) return
      await readSwitch()
    },
    /** judge-of.ts's start probe: would a start on `hostKey` go to its service now? */
    hostJudges(hostKey: string): boolean {
      const s = hosts.get(hostKey)
      return !!s && wanted(s) && onFor(hostKey)
    },
    /** Is the channel to `hostKey` linked now? */
    linked(hostKey: string): boolean { return !!hosts.get(hostKey)?.socket },
    /** Which side opened the link to `hostKey` now, or null when none is up. */
    linkKind(hostKey: string): 'leader-dialed' | 'host-dialed' | null {
      const sock = hosts.get(hostKey)?.socket
      return sock ? (sock.kind ?? 'leader-dialed') : null
    },
    /**
     * A socket `hostKey` dialed into this leader's door, after both proved who they are (host-door.ts):
     * it is the link now. The link before it (leader-dialed or an earlier dial-in) is closed
     * `replaced`, and no dial of the leader's runs while it is up. False when this side is stopped.
     */
    adopt(hostKey: string, sock: ChannelSocket): boolean {
      if (stopped) { try { sock.close('stopping') } catch { /* gone */ } return false }
      // The door is open only while the switch is on: read it again for the next start.
      void readSwitch()
      const s = stateOf(hostKey)
      if (s.timer) { clearTimeout(s.timer); s.timer = null }
      if (s.socket) {
        deps.log('info', 'session channel: the host dialed in; the link before it is replaced', { host: hostKey, was: s.socket.kind ?? 'leader-dialed' })
        dropSocket(s, 'replaced')
      }
      s.attempt = 0
      const dialed: ChannelSocket = { ...sock, kind: 'host-dialed' }
      // Held as the link at once (no dial of ours starts meanwhile); the socket holds its frames
      // until the channel takes them (host-door.ts).
      s.socket = dialed
      s.dialedIn = true
      if (walnutId) { bind(hostKey, s, dialed); return true }
      void deps.walnutId().then((id) => {
        walnutId ??= id
        if (s.socket === dialed && !stopped) bind(hostKey, s, dialed)
      }, (err: unknown) => {
        deps.log('warn', 'session channel: a host-dialed link was not taken (no Walnut id)', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
        if (s.socket === dialed) { s.socket = null; s.dialedIn = false }
        try { sock.close('error') } catch { /* gone */ }
      })
      return true
    },
    /** One allowlisted call on a session the host runs (POST /host-api/sessions/call): its value, or a throw. */
    async callHost(hostKey: string, body: { sid: string; target: string; member: string; args: unknown[] }): Promise<unknown> {
      const a = await request(hostKey, 'call', body, deps.callTimeoutMs ?? 60_000)
      if (a.ok !== true) throw new Error(`${body.member} on ${hostKey}: ${a.error ?? 'refused'}`)
      return a.value
    },
    async startOnHost(hostKey: string, payload: unknown): Promise<HostCallAnswer> {
      return request(hostKey, 'start', payload, deps.startTimeoutMs ?? 120_000)
    },
    async sendToHost(hostKey: string, payload: unknown): Promise<HostCallAnswer> {
      return request(hostKey, 'send', payload, deps.callTimeoutMs ?? 60_000)
    },
    async interruptOnHost(hostKey: string, payload: unknown): Promise<HostCallAnswer> {
      return request(hostKey, 'interrupt', payload, deps.callTimeoutMs ?? 60_000)
    },
    /** A delete this leader just made of `hostKey`'s sessions: sent now when the host is linked, else at its next link. */
    async dropOnHost(hostKey: string): Promise<void> {
      if (hosts.get(hostKey)?.socket) await flushDrops(hostKey)
    },
    /** Tests: the current link's apply chain. */
    idle(hostKey: string): Promise<void> { return hosts.get(hostKey)?.channel?.idle() ?? Promise.resolve() },
    stop(): void {
      stopped = true
      for (const s of hosts.values()) closeLink(s, 'stopping')
      hosts.clear()
    },
  }
}

export type LeaderSide = ReturnType<typeof createLeaderSide>

/** Does a host's last report say its service runs and judges sessions? */
export function reportJudges(report: { capabilities?: unknown } | null | undefined): boolean {
  return reportNames(report, SESSION_JUDGE_CAP)
}

/** Does a host's last report say its start route resumes a session the leader ran (host-resume.ts)? */
export function reportResumes(report: { capabilities?: unknown } | null | undefined): boolean {
  return reportNames(report, SESSION_JUDGE_CAP) && reportNames(report, SESSION_RESUME_CAP)
}

function reportNames(report: { capabilities?: unknown } | null | undefined, cap: string): boolean {
  return Array.isArray(report?.capabilities) && (report!.capabilities as unknown[]).includes(cap)
}
