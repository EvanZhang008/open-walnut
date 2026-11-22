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
 *   - the commands: start, send, interrupt and the allowlisted calls (host-calls.ts), each one
 *     HTTP request on a stream of its own (`openStream('follower', 'session-call')`).
 *   - the deletes this leader made of the host's sessions (leader-drops.ts): sent when one is made
 *     and again each time the channel links, until the host's `drop` record answers each one.
 */
import type { Duplex } from 'node:stream'
import { attachLeaderChannel, isChannelFrame, type AppliedFact, type ChannelCursor, type ChannelFrame, type ChannelLink } from './channel.js'
import { channelClassOf, sessionIdOf } from './event-classes.js'
import { EventNames } from '../event-bus.js'
import { HOST_CHANNEL_PATH, HOST_SESSIONS_PATH, type LiveState } from './host-api.js'
import { SESSION_JUDGE_CAP } from './switch.js'
import type { HostChannelBatch, HostChannelBatchResult } from '../session-tracker.js'
import type { SessionRecord } from '../types.js'

/** A text link: a WebSocket in production, anything that carries whole frames in tests. */
export interface ChannelSocket {
  send(text: string): void
  close(why?: string): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
}

export interface HostCallAnswer { ok: boolean; value?: unknown; error?: string; why?: string; [k: string]: unknown }

export interface LeaderSideDeps {
  walnutId(): Promise<string>
  /** The lead this leader holds on the host (its epoch): the channel's permit number. */
  permitNumber(hostId: string): number
  /** Is the switch on now? */
  flagOn(): Promise<boolean>
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
  noteLive(sid: string, state: LiveState): void
  noteRename(from: string, to: string): void
  noteHostJudged(sid: string, host: string): void
  /** The channel to `hostId` linked (its hello): what waits here for that host goes now (host-judged-send.ts). */
  onLinked?(hostId: string): void
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
  let flag = false
  let stopped = false
  let walnutId: string | null = null

  const stateOf = (hostKey: string): HostState => {
    let s = hosts.get(hostKey)
    if (!s) {
      s = { connected: false, judges: false, socket: null, dialing: false, attempt: 0, timer: null, channel: null, resyncAt: new Map() }
      hosts.set(hostKey, s)
    }
    return s
  }
  /**
   * The channel is kept while the host is linked and runs its sessions, whatever the switch says
   * now: a session the leader handed it before the switch went off still reports through it. The
   * switch decides only where a new start goes (hostJudges).
   */
  const wanted = (s: HostState): boolean => !stopped && s.connected && s.judges

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
    for (const r of recs) {
      const d = (r.data ?? {}) as Record<string, unknown>
      // A `resync` row is the host's whole row again: applied as a born one (its omitted fields cleared, made when missing).
      if (r.name === 'row') rows.push({ sid: r.sid, born: d.born === true || d.resync === true, patch: (d.patch ?? {}) as Record<string, unknown>, seq: r.seq })
      else if (r.name === 'rename' && typeof d.from === 'string' && typeof d.to === 'string') renames.push({ from: d.from, to: d.to, seq: r.seq })
      else if (r.name === 'drop') drops.push(r.sid)
      else check.add(r.sid)
    }
    const applied = await deps.applyBatch({ hostId, rows, renames, cursor: next, ...(drops.length ? { drops } : {}), ...(check.size ? { check: [...check] } : {}) })
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
        if (d.born === true && wrote.has(r.sid)) emitFact(hostId, r, EventNames.SESSION_STARTED, startedOf(hostId, r.sid, d.patch ?? {}), undefined)
        continue
      }
      if (r.name === 'drop' || r.name === 'turn-summary') continue
      if (r.name === 'rename') {
        // Only a rename the batch applied: the host renamed a row of its own (the transaction checked `from`).
        const d = r.data as { from?: string; to?: string }
        if (d?.from && d?.to && wrote.has(d.to)) after(hostId, 'noteRename', d.to, () => deps.noteRename(d.from!, d.to!))
        continue
      }
      if (!hostsOwn(hostId, r.sid, wrote)) { refused++; continue }
      if (r.name === 'live') {
        after(hostId, 'noteLive', r.sid, () => deps.noteLive(r.sid, ((r.data as { state?: LiveState } | null)?.state ?? {}) as LiveState))
        continue
      }
      if (channelClassOf(r.name) !== 'fact') continue
      // The event names the record's own session, or it is not said.
      if (sessionIdOf(r.name, r.data) !== r.sid) { refused++; continue }
      emitFact(hostId, r, r.name, r.data, r.to)
    }
    if (refused > 0) deps.log('warn', 'session channel: records of sessions this host does not own were not said', { hostId, count: refused })
  }

  function emitFact(hostId: string, r: AppliedFact, name: string, data: unknown, to: string[] | undefined): void {
    after(hostId, name, r.sid, () => deps.emit(name, data, { late: r.late, at: r.happenedAt, ...(to ? { to } : {}) }))
  }

  async function applyRows(hostId: string, rows: SessionRecord[], next: ChannelCursor): Promise<void> {
    const { written, removed } = await deps.applyBatch({
      hostId,
      rows: rows.map((row) => ({ sid: row.claudeSessionId, born: true, patch: row as unknown as Record<string, unknown> })),
      renames: [],
      cursor: next,
      // Every row the host owns now: one of its rows here it no longer names is gone (M8).
      snapshot: { keep: deps.startsInFlight?.() ?? new Set() },
    })
    for (const sid of written) after(hostId, 'noteHostJudged', sid, () => deps.noteHostJudged(sid, hostId))
    if (removed?.length) deps.log('info', 'session channel: rows the host no longer has were removed here', { hostId, count: removed.length })
  }

  function schedule(hostKey: string, s: HostState): void {
    if (!wanted(s) || s.timer || s.socket || s.dialing) return
    const delay = (deps.backoffMs ?? defaultBackoff)(s.attempt++)
    s.timer = setTimeout(() => { s.timer = null; ensure(hostKey) }, delay)
    s.timer.unref?.()
  }

  function closeLink(s: HostState, why: string): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    const sock = s.socket
    s.socket = null
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
      return (deps.dial ?? defaultDial)(hostKey)
    })().then((sock) => {
      s.dialing = false
      if (!wanted(s)) { try { sock.close('not_wanted') } catch { /* gone */ } return }
      s.socket = sock
      const link: ChannelLink = {
        send: (frame: ChannelFrame) => sock.send(JSON.stringify(frame)),
        close: (why?: string) => sock.close(why),
      }
      const channel = attachLeaderChannel(link, {
        walnutId: walnutId!,
        hostId: hostKey,
        permitNumber: () => deps.permitNumber(hostKey),
        loadCursor: deps.loadCursor,
        apply: applyRecs,
        applyRows,
        onFlow: (hostId, sid, name, data, to) => {
          // A text delta of a session this host owns, naming that session, or nothing (M1).
          if (!hostsOwn(hostId || hostKey, sid, new Set()) || sessionIdOf(name, data) !== sid) return
          try { deps.emit(name, data, { late: false, ...(to ? { to } : {}) }) } catch { /* a flow event is never kept */ }
        },
        onLog: deps.log,
      })
      s.channel = channel
      sock.onMessage((text) => {
        let frame: unknown
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
        if (s.socket !== sock) return
        s.socket = null
        channel.onClose()
        if (s.channel === channel) s.channel = null
        deps.log('info', 'session channel: the link to the host closed', { host: hostKey })
        schedule(hostKey, s)
      })
    }, (err: unknown) => {
      s.dialing = false
      deps.log('warn', 'session channel: dialing the host failed; trying again', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
      schedule(hostKey, s)
    })
  }

  async function defaultDial(hostKey: string): Promise<ChannelSocket> {
    const stream = await deps.openStream(hostKey, 'session-channel')
    const { WebSocket } = await import('#ws')
    const ws = new WebSocket(`ws://host-server${HOST_CHANNEL_PATH}`, { createConnection: () => stream } as never)
    // The host speaks first (its hello), possibly in the same read as the upgrade's answer: frames
    // are held from the start until the channel takes them, and so is a close.
    const held: string[] = []
    let onText: ((text: string) => void) | null = null
    let closed = false
    let onGone: (() => void) | null = null
    ws.on('message', (data) => { const text = String(data); if (onText) onText(text); else held.push(text) })
    ws.on('close', () => { closed = true; onGone?.() })
    ws.on('error', () => { /* a close follows */ })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req: unknown, res: { statusCode?: number }) => reject(new Error(`the host refused the session channel (HTTP ${res.statusCode ?? '?'})`)))
      ws.once('close', () => reject(new Error('the host closed the session channel before it opened')))
    })
    return {
      send: (text) => ws.send(text),
      close: (why) => { try { ws.close(1000, (why ?? '').slice(0, 100)) } catch { ws.terminate() } },
      onMessage: (fn) => { onText = fn; for (const text of held.splice(0)) fn(text) },
      onClose: (fn) => { onGone = fn; if (closed) fn() },
    }
  }

  async function defaultRequest(hostKey: string, route: string, body: unknown, timeoutMs: number): Promise<HostCallAnswer> {
    const stream = await deps.openStream(hostKey, 'session-call')
    const { requestOver } = await import('../host-server/request-over.js')
    const res = await requestOver(stream, 'POST', route, Buffer.from(JSON.stringify(body ?? {})), timeoutMs)
    const text = await res.text()
    let answer: HostCallAnswer
    try { answer = JSON.parse(text) as HostCallAnswer } catch { answer = { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` } }
    if (!answer || typeof answer !== 'object') answer = { ok: false, error: `HTTP ${res.status}` }
    return answer
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
      flag = await deps.flagOn().catch(() => false)
      if (stopped) return
      const s = stateOf(hostKey)
      s.connected = o.connected
      s.judges = o.judges
      if (!wanted(s)) s.attempt = 0
      ensure(hostKey)
    },
    /** The switch may have changed (a config write): read it again for the next start. */
    async refreshFlag(): Promise<void> {
      if (stopped) return
      flag = await deps.flagOn().catch(() => false)
    },
    /** judge-of.ts's start probe: would a start on `hostKey` go to its service now? */
    hostJudges(hostKey: string): boolean {
      const s = hosts.get(hostKey)
      return flag && !!s && wanted(s)
    },
    /** Is the channel to `hostKey` linked now? */
    linked(hostKey: string): boolean { return !!hosts.get(hostKey)?.socket },
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
  return Array.isArray(report?.capabilities) && (report!.capabilities as unknown[]).includes(SESSION_JUDGE_CAP)
}
