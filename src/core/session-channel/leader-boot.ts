/**
 * The leader's boot wiring of the hosts that run and judge their sessions (leader-side.ts): real
 * data, the host-server manager's views and links, this server's bus. Started by the web server on
 * the leader when the switch is on; with it off nothing here runs and every judge is 'legacy'.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import { createLeaderSide, reportJudges, type LeaderSide } from './leader-side.js'
import { hostRunsSessionsNow } from './switch.js'
import { noteHostJudged, setHostJudgeProbe } from '../sessions/judge-of.js'

let active: LeaderSide | null = null
const CONFIG_SUBSCRIBER = 'host-session-switch'

/** The running leader side, or null (switch off, a follower, not started yet). */
export function activeLeaderSide(): LeaderSide | null {
  return active
}

/** Tests: stand a fake leader side in (null removes it). */
export function _setActiveLeaderSideForTesting(side: LeaderSide | null): void {
  active = side
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
    loadCursor: async (hostId) => loadChannelCursor(hostId),
    emit: (name, data, opts) => {
      if (saidHereAlready(name, data)) return
      bus.emit(name, data, ['*'], { source: 'host-channel', ...(opts.late ? { late: true as const } : {}) })
    },
    noteLive: remote.noteLiveState,
    noteRename: (from, to) => {
      remote.renameRemoteJudgedSession(from, to)
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
  const unlisten = hostServer.onHostServerView(look)
  // The switch is read again at every config write, so a start after it went off stays here.
  bus.subscribe(CONFIG_SUBSCRIBER, () => { void side.refreshFlag() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  for (const view of hostServer.peekHostServerViews()) look(view)
  log.session.info('session channels: the leader side is on (hosts that name session-judge-v1 run their sessions)')
  return () => {
    unlisten()
    bus.unsubscribe(CONFIG_SUBSCRIBER)
    stopTasks()
    side.stop()
    setHostJudgeProbe(null)
    remote.setRemoteJudgedCaller(null)
    if (active === side) active = null
  }
}
