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
 *     the `live` records into the proxies' mirrored state (providers/remote-judged-session.ts);
 *     leader-apply.ts holds what the records do. A dropped link dials again with a backoff.
 *   - none of it for a host whose door is revoked (leader-issue.ts hostRevokedNow): no link is
 *     kept or taken, and what one sent is not applied (noteRevoked closes it at the revoke).
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
import { attachLeaderChannel, isChannelFrame, type ChannelCursor, type ChannelFrame, type ChannelLink, type PermitPair } from './channel.js'
import { HOST_SESSIONS_PATH, type LiveState } from './host-api.js'
import { createLeaderApply, HostRevoked } from './leader-apply.js'
import { SESSION_JUDGE_CAP, SESSION_RESUME_ACP_CAP, SESSION_RESUME_CAP } from './switch.js'
import { answerOf, dialOverStream, requestOverStream, type ChannelSocket, type HostCallAnswer } from './leader-links.js'
import type { HostChannelBatch, HostChannelBatchResult } from '../session-tracker.js'
import { noteFrameParsed } from '../../providers/line-parse-count.js'

export { HostRequestNotSent, requestNotSent, type ChannelSocket, type HostCallAnswer } from './leader-links.js'
export { HostRevoked } from './leader-apply.js'

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
  /** Records of sessions `hostId` does not own were not said (refused-sessions.ts noteRefusedSessions). */
  refused?(hostId: string, sids: string[]): void
  /** The task of this leader's own row of `sid` (a host's fact says this task, never its own word). */
  taskOf?(sid: string): string | null | undefined
  /** Of `ids` under a fact's `key`, the leader objects it handed `sid` of `hostId` (fact-keys.ts scoped keys). */
  scopeIds?(hostId: string, sid: string, key: string, ids: string[]): string[]
  /** Is `hostKey` revoked (leader-issue.ts)? Its link is closed and nothing it sends is applied. */
  revoked?(hostKey: string): boolean
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

interface HostState {
  key: string
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
      s = { key: hostKey, connected: false, judges: false, socket: null, dialing: false, attempt: 0, timer: null, channel: null, resyncAt: new Map(), lostTimer: null, dialedIn: false }
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
  const wanted = (s: HostState): boolean => !stopped && !isRevoked(s.key) && ((s.dialedIn && !!s.socket) || (s.connected && s.judges))
  function isRevoked(hostKey: string): boolean {
    try { return deps.revoked?.(hostKey) === true } catch { return true }
  }
  /** A revoked host's records: never applied, and its link goes (S3 of the land 9 review). */
  function refuseRevoked(hostId: string): void {
    if (!isRevoked(hostId)) return
    const s = hosts.get(hostId)
    if (s) closeLink(s, 'revoked')
    throw new HostRevoked(hostId)
  }
  const taskOf = (sid: string): string | null | undefined => {
    if (!deps.taskOf) return undefined
    try { return deps.taskOf(sid) ?? null } catch { return null }
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

  const { applyRecs, applyRows, onFlow } = createLeaderApply(deps, { askResync, refuseRevoked, isRevoked, taskOf })

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
      onFlow: (hostId, sid, name, data, to) => onFlow(hostId || hostKey, sid, name, data, to),
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
    /** Is the switch on for `hostKey` now (whether or not its service is linked and judges)? */
    switchOn(hostKey: string): boolean {
      return !stopped && onFor(hostKey)
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
      if (stopped || isRevoked(hostKey)) { try { sock.close(stopped ? 'stopping' : 'revoked') } catch { /* gone */ } return false }
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
    /**
     * `hostKey` was revoked or allowed again (leader-issue.ts): a revoked host's link closes now and
     * none is made or taken until it is allowed; an allowed one is linked again when it is wanted.
     */
    noteRevoked(hostKey: string): void {
      const s = hosts.get(hostKey)
      if (!s || stopped) return
      if (isRevoked(hostKey)) closeLink(s, 'revoked')
      else ensure(hostKey)
    },
    /** Ask `hostKey` for these rows whole now, past the rate limit (a start's answer named a session whose born row was refused). */
    resyncNow(hostKey: string, sids: readonly string[]): void {
      const s = hosts.get(hostKey)
      if (!s) return
      for (const sid of sids) s.resyncAt.delete(sid)
      askResync(hostKey, sids)
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

/** Does it also resume an ACP engine's session (host-resume.ts, SESSION_RESUME_ACP_CAP)? */
export function reportResumesAcp(report: { capabilities?: unknown } | null | undefined): boolean {
  return reportResumes(report) && reportNames(report, SESSION_RESUME_ACP_CAP)
}

function reportNames(report: { capabilities?: unknown } | null | undefined, cap: string): boolean {
  return Array.isArray(report?.capabilities) && (report!.capabilities as unknown[]).includes(cap)
}
