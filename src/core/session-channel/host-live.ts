/**
 * The live state of one session this host runs (host-api.ts LiveState), read from the host's
 * runner and its session objects: what the leader's proxy answers its sync getters with.
 *
 * Read structurally and defensively: a member a session class does not have (an older engine, an
 * ACP session where a native one is asked) is left out, and a getter that throws leaves its field
 * out, never the whole state. Nothing here writes.
 */
import type { LiveState } from './host-api.js'

/** The members of a native session this reads (ClaudeCodeSession). */
export interface LiveSessionLike {
  turnGen?: number
  processStatus?: string
  inTurn?: boolean
  turnStartedAt?: number
  hasPendingPermission?: boolean
  getPendingPermissionRequests?(): unknown[]
  mode?: string
  cliSlashCommands?: unknown
  cachedAppliedSettings?(): unknown
  controlChannelState?: string
  backgroundTasksSnapshot?(sid: string): unknown
  lastResultOrigin?: string
  teardownReason?: string
  consumedOffset?: number
}

/** The members of an ACP session this reads (AcpSession). */
export interface LiveAcpLike {
  activity?: string
  workerLive?: boolean
  engineId?: string
  sessionControls?: unknown
  modelCatalog?: unknown
  processStatus?: string
  getPendingPermissionRequests?(): unknown[]
}

/** The members of the runner this reads (SessionRunner). */
export interface LiveRunnerLike {
  findSessionByClaudeId?(sid: string): LiveSessionLike | undefined
  findAcpSession?(sid: string): LiveAcpLike | undefined
  isTurnRunning?(sid: string): boolean
  isInTurn?(sid: string): boolean | null
  outlivingWorkOf?(sid: string): unknown[]
  isCronArmed?(sid: string): boolean
  isTeamActive?(sid: string): boolean
  getSessionTimestamps?(sid: string): { lastClaudeOutputAt: number; lastMessageDeliveryAt: number } | undefined
  promptCacheOf?(sid: string): unknown
  controlRequestsPendingOf?(sid: string): number
  deliveryWait?(sid: string): { reason: string; retryAt?: string } | null
}

function read<T>(fn: () => T): T | undefined {
  try { return fn() } catch { return undefined }
}

/** Set `key` on `out` when `v` is not undefined. */
function put<K extends keyof LiveState>(out: LiveState, key: K, v: LiveState[K] | undefined): void {
  if (v !== undefined) out[key] = v
}

/** The live state of `sid`, or null when this runner holds no live object for it. */
export function liveStateOf(runner: LiveRunnerLike, sid: string): LiveState | null {
  const s = read(() => runner.findSessionByClaudeId?.(sid))
  const a = s ? undefined : read(() => runner.findAcpSession?.(sid))
  if (!s && !a) return null
  const out: LiveState = {}
  if (s) {
    put(out, 'turnGen', read(() => s.turnGen))
    put(out, 'processStatus', read(() => s.processStatus))
    put(out, 'turnStartedAt', read(() => s.turnStartedAt))
    put(out, 'pendingPermission', read(() => s.hasPendingPermission))
    put(out, 'pendingPermissionRequests', read(() => s.getPendingPermissionRequests?.()))
    put(out, 'mode', read(() => s.mode))
    put(out, 'cliSlashCommands', read(() => s.cliSlashCommands))
    put(out, 'appliedSettings', read(() => s.cachedAppliedSettings?.()))
    put(out, 'controlChannelState', read(() => s.controlChannelState))
    put(out, 'backgroundTasks', read(() => s.backgroundTasksSnapshot?.(sid)))
    put(out, 'lastResultOrigin', read(() => s.lastResultOrigin))
    put(out, 'teardownReason', read(() => s.teardownReason))
    put(out, 'consumedOffset', read(() => s.consumedOffset))
  } else if (a) {
    put(out, 'processStatus', read(() => a.processStatus))
    put(out, 'pendingPermissionRequests', read(() => a.getPendingPermissionRequests?.()))
    const pending = out.pendingPermissionRequests
    if (Array.isArray(pending)) out.pendingPermission = pending.length > 0
    out.acp = {}
    const acp = out.acp
    const set = <K extends keyof NonNullable<LiveState['acp']>>(k: K, v: NonNullable<LiveState['acp']>[K] | undefined) => { if (v !== undefined) acp[k] = v }
    set('activity', read(() => a.activity))
    set('workerLive', read(() => a.workerLive))
    set('engineId', read(() => a.engineId))
    set('sessionControls', read(() => a.sessionControls))
    set('modelCatalog', read(() => a.modelCatalog))
  }
  put(out, 'inTurn', read(() => runner.isInTurn?.(sid)))
  put(out, 'turnRunning', read(() => runner.isTurnRunning?.(sid)))
  put(out, 'outliving', read(() => runner.outlivingWorkOf?.(sid)))
  put(out, 'cronArmed', read(() => runner.isCronArmed?.(sid)))
  put(out, 'teamActive', read(() => runner.isTeamActive?.(sid)))
  put(out, 'timestamps', read(() => runner.getSessionTimestamps?.(sid)))
  put(out, 'promptCache', read(() => runner.promptCacheOf?.(sid)))
  put(out, 'controlRequestsPending', read(() => runner.controlRequestsPendingOf?.(sid)))
  put(out, 'deliveryWait', read(() => runner.deliveryWait?.(sid)))
  // JSON only: a Map, a function or a cycle never crosses (the channel writes JSON).
  return read(() => JSON.parse(JSON.stringify(out)) as LiveState) ?? null
}
