/**
 * The leader's boot wiring of the hosts that run and judge their sessions (leader-side.ts): real
 * data, the host-server manager's views and links, this server's bus. Started by the web server on
 * every leader: it links only to hosts that name session-judge-v1, and with the switch off every
 * new start is 'legacy' (judge-of.ts), while the sessions a host already runs keep reporting.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import { createLeaderSide, reportJudges, type LeaderSide } from './leader-side.js'
import { hostRunsSessionsNow } from './switch.js'
import { reemitDestinations } from './event-classes.js'
import { forgetHostJudged, noteHostJudged, setHostJudgeProbe } from '../sessions/judge-of.js'
import { leaderDropHosts, leaderDropsOf } from './leader-drops.js'

let active: LeaderSide | null = null
const CONFIG_SUBSCRIBER = 'host-session-switch'
const DELETE_SUBSCRIBER = 'host-session-deletes'

/** The running leader side, or null (a follower, not started yet). */
export function activeLeaderSide(): LeaderSide | null {
  return active
}

/** Tests: stand a fake leader side in (null removes it). */
export function _setActiveLeaderSideForTesting(side: LeaderSide | null): void {
  active = side
}

/**
 * Say one host fact (or flow event) on this leader's bus, as the channel applies it: to the
 * destinations the host's emit named (never the phone's push), `source: 'host-channel'`, `late` for
 * one read back long after it happened, and its original time as the event's timestamp, so a
 * subscriber that records a time counts the fact where it happened (EmitOptions.timestamp).
 */
export function sayHostFact(name: string, data: unknown, opts: { late: boolean; to?: string[]; at?: number }): void {
  bus.emit(name, data, reemitDestinations(opts.to), {
    source: 'host-channel',
    ...(opts.late ? { late: true as const } : {}),
    ...(typeof opts.at === 'number' && Number.isFinite(opts.at) ? { timestamp: opts.at } : {}),
  })
}

export async function startLeaderSessionChannels(): Promise<() => void> {
  if (active) return () => {}
  const [{ applyHostChannelBatch, loadChannelCursor }, hostServer, { hostLeaderStates }, { getInstanceId }, remote, { saidHereAlready }] = await Promise.all([
    import('../session-tracker.js'),
    import('../host-server/index.js'),
    import('../leader/primary-leader.js'),
    import('../device-auth.js'),
    import('../../providers/remote-judged-session.js'),
    import('../../providers/host-judged-runner.js'),
  ])
  const side = createLeaderSide({
    walnutId: async () => getInstanceId(),
    permitNumber: (hostId) => hostLeaderStates()[hostId]?.epoch ?? 0,
    flagOn: hostRunsSessionsNow,
    openStream: async (hostKey, purpose) => {
      const link = hostServer.hostServerLink(hostKey)
      if (!link) throw new Error(`the host ${hostKey} is not connected`)
      return link.openStream('follower', purpose)
    },
    applyBatch: applyHostChannelBatch,
    leaderDrops: async (hostId) => leaderDropsOf(hostId),
    loadCursor: async (hostId) => loadChannelCursor(hostId),
    emit: (name, data, opts) => {
      if (saidHereAlready(name, data)) return
      // The host's ledger, with the rows of the Walnut subagents this leader runs for the session.
      const sid = (data as { sessionId?: unknown } | null)?.sessionId
      const said = name === EventNames.SESSION_BACKGROUND_TASKS && typeof sid === 'string' && data && typeof data === 'object'
        ? remote.withLeaderSubagentRows(data as Record<string, unknown>, sid) : data
      sayHostFact(name, said, opts)
    },
    noteLive: remote.noteLiveState,
    noteRename: (from, to) => {
      remote.renameRemoteJudgedSession(from, to)
      void import('./leader-tasks.js').then((m) => m.noteHostSessionRenamed(from, to))
    },
    noteHostJudged,
    log: (level, msg, data) => log.session[level](msg, data),
  })
  active = side
  setHostJudgeProbe((host) => side.hostJudges(host))
  remote.setRemoteJudgedCaller((host, body) => side.callHost(host, body))
  const look = (view: { hostKey: string; phase: string; server?: { capabilities?: unknown } | null }) => {
    void side.noteHost(view.hostKey, {
      connected: hostServer.hostServerLink(view.hostKey) !== null,
      judges: view.phase === 'running' && reportJudges(view.server),
    })
  }
  const { startHostSessionTasks } = await import('./leader-tasks.js')
  const stopTasks = startHostSessionTasks()
  // A host's retriers run there: their turn state and give-ups reach this leader's readers.
  const [{ startLeaderRetryOver }, { setHostTurnSource }] = await Promise.all([import('./leader-retry-over.js'), import('../sessions/turn-run-host.js')])
  const stopRetryOver = startLeaderRetryOver()
  setHostTurnSource((sid) => remote.hostTurnStateOf(sid))
  const unlisten = hostServer.onHostServerView(look)
  // The switch is read again at every config write, so a start after it went off stays here.
  bus.subscribe(CONFIG_SUBSCRIBER, () => { void side.refreshFlag() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  // A delete of a host's session: its host drops its row too (leader-drops.ts), now when linked, else at its next link.
  bus.subscribe(DELETE_SUBSCRIBER, (event) => {
    const ids = (event.data as { sessionIds?: unknown } | null)?.sessionIds
    if (!Array.isArray(ids)) return
    const sids = ids.filter((x): x is string => typeof x === 'string' && x !== '')
    for (const [host, mine] of leaderDropHosts(sids)) {
      for (const sid of mine) forgetHostJudged(sid)
      void side.dropOnHost(host)
    }
  }, { global: true, interest: [EventNames.SESSION_DELETED] })
  for (const view of hostServer.peekHostServerViews()) look(view)
  log.session.info('session channels: the leader side is on (hosts that name session-judge-v1 run their sessions)')
  return () => {
    unlisten()
    bus.unsubscribe(CONFIG_SUBSCRIBER)
    bus.unsubscribe(DELETE_SUBSCRIBER)
    stopTasks()
    stopRetryOver()
    setHostTurnSource(null)
    side.stop()
    setHostJudgeProbe(null)
    remote.setRemoteJudgedCaller(null)
    if (active === side) active = null
  }
}
