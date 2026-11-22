/**
 * The leader's handle on a session its host runs and judges (docs/plan/one-service-every-host.md,
 * phase 2; the inventory of what the leader uses is design/C3b-live-surface.md of the task that
 * built it). It stands where a ClaudeCodeSession or an AcpSession stands for a session this server
 * runs, so a caller keeps its one lookup (SessionRunner.findSessionByClaudeId and the rest):
 *
 *   state    synchronous getters answer from the newest `live` record the host sent
 *            (session-channel/host-api.ts LiveState), never from a guess here
 *   commands every other member is a call to the host (POST /host-api/sessions/call): async ones
 *            answer what the host answered; sync ones (detach, kill ...) send the call and return
 *   writes   the snapshot and reconcile writers are no-ops: the host judges its own process
 *
 * One object per session id, for as long as this server runs: `live === observedLive` is a fence in
 * session-snapshot-apply.ts and session-reconcile.ts.
 */
import { log } from '../logging/index.js'
import { bus, EventNames } from '../core/event-bus.js'
import { lightSubagentRows } from '../core/subagents/registry.js'
import type { HostCallTarget } from '../core/session-channel/host-calls.js'
import type { LiveState } from '../core/session-channel/host-api.js'

export interface HostCallBody { sid: string; target: HostCallTarget; member: string; args: unknown[] }
export type CallHost = (host: string, body: HostCallBody) => Promise<unknown>

let caller: CallHost | null = null

/** Installed by the leader side (session-channel/leader-side.ts); tests install a fake. */
export function setRemoteJudgedCaller(fn: CallHost | null): void {
  caller = fn
}

export class RemoteJudgedSession {
  /** Marks the object for callers that must tell it from a session this server runs. */
  readonly hostJudged = true as const
  private state: LiveState = {}
  private localTeardown: string | undefined

  constructor(private sid: string, readonly host: string, readonly kind: 'native' | 'acp', private taskIdOf: () => string | undefined = () => undefined) {}

  // ── identity ──
  get sessionId(): string { return this.sid }
  get claudeSessionId(): string { return this.sid }
  get taskId(): string | undefined { return this.taskIdOf() }

  /** The newest `live` state the host sent. */
  noteLive(state: LiveState): void { this.state = state ?? {} }
  get liveState(): Readonly<LiveState> { return this.state }
  /** The host renamed the session (a resume, a fork): the same object answers to the new id. */
  renameTo(sid: string): void { this.sid = sid }

  // ── mirrored state ──
  get mode(): string { return this.state.mode ?? 'default' }
  get controlChannelState(): 'live' | 'starting' | 'dead' { return (this.state.controlChannelState as 'live' | 'starting' | 'dead' | undefined) ?? 'dead' }
  get turnGen(): number { return this.state.turnGen ?? 0 }
  get processStatus(): string { return this.state.processStatus ?? 'stopped' }
  get hasPendingPermission(): boolean { return this.state.pendingPermission === true }
  get turnStartedAt(): number | undefined { return this.state.turnStartedAt }
  get consumedOffset(): number { return this.state.consumedOffset ?? 0 }
  get teardownReason(): string | undefined { return this.localTeardown ?? this.state.teardownReason }
  get lastResultOrigin(): string | undefined { return this.state.lastResultOrigin }
  get cliSlashCommands(): unknown { return this.state.cliSlashCommands ?? null }
  get cachedAppliedSettings(): unknown { return this.state.appliedSettings }
  get inTurn(): boolean { return this.state.inTurn === true }
  get turnRunning(): boolean { return this.state.turnRunning === true }
  get teamActive(): boolean { return this.state.teamActive === true }
  get cronArmed(): boolean { return this.state.cronArmed === true }
  get outlivingWork(): string[] { return (this.state.outliving ?? []).map(String) }
  /** The runner's rule (claude-code-session.ts): a /loop alone is no work that outlives the turn. */
  get workOutlivesTurn(): boolean { return this.outlivingWork.some((s) => s !== 'loop') }
  get promptCache(): unknown { return this.state.promptCache }
  get controlRequestsPending(): number { return this.state.controlRequestsPending ?? 0 }
  get lastClaudeOutputAt(): number { return this.state.timestamps?.lastClaudeOutputAt ?? 0 }
  get lastMessageDeliveryAt(): number { return this.state.timestamps?.lastMessageDeliveryAt ?? 0 }
  get deliveryWait(): { reason: string; retryAt?: string } | null { return this.state.deliveryWait ?? null }
  /** A session its host holds has no pipe or process here. */
  get hasPipe(): boolean { return false }
  get active(): boolean { return this.state.processStatus === 'running' || this.state.processStatus === 'idle' }
  getPendingPermissionRequests(): unknown[] { return [...(this.state.pendingPermissionRequests ?? [])] }
  /** The host does not mirror its context windows (yet): what a session with no model facts shows. */
  contextWindowsForUi(): { modelMax: number | null; autoCompactAt: number | null; estimate?: boolean; source?: string } {
    return { modelMax: null, autoCompactAt: null }
  }
  /**
   * The Background panel of the session: its host's ledger (its CLI's agents and commands, from the
   * newest `live` state) with the Walnut subagents this leader runs for it (subagents/registry.ts:
   * a session's subagent_run runs on the leader), as a session here answers it. Null: neither has any.
   */
  backgroundTasksSnapshot(sid: string = this.sid): Record<string, unknown> | null {
    const host = this.state.backgroundTasks as Record<string, unknown> | null | undefined
    const light = lightSubagentRows(sid)
    if (!host && light.length === 0) return null
    return withLeaderSubagentRows(host ?? { sessionId: sid, inFlight: 0, tasks: [], phases: [], agents: [] }, sid)
  }
  /** The panel's update, said here: the rows of this leader's subagents are only here (not on the host). */
  emitBackgroundTasks(): void {
    const payload = this.backgroundTasksSnapshot()
    if (payload) bus.emit(EventNames.SESSION_BACKGROUND_TASKS, payload as never, ['main-ai', 'web-ui'], { source: 'light-subagents' })
  }
  hasActiveBackgroundWork(): boolean { return (this.state.outliving ?? []).includes('background') }
  hasPendingBackgroundTasks(): boolean { return false }
  /** A callback cannot cross to the host: callers on the leader use bashCallMatchingOp. */
  bashCallMatching(): string | undefined { return undefined }

  // ACP state
  get activity(): string | undefined { return this.state.acp?.activity }
  get workerLive(): boolean { return this.state.acp?.workerLive === true }
  get engineId(): string | undefined { return this.state.acp?.engineId }
  get sessionControls(): unknown { return this.state.acp?.sessionControls }
  get modelCatalog(): unknown { return this.state.acp?.modelCatalog }

  // ── snapshot and reconcile writers: the host judges its own process ──
  setProcessStatusFromReconciler(): void {}
  setForegroundFromSnapshot(): void {}
  resetConsumedOffsetFromSnapshot(): void {}
  setCronArmedFromSnapshot(): void {}

  // ── forwarded, answered by the host ──
  private target(): HostCallTarget { return this.kind === 'acp' ? 'acp' : 'session' }

  /** One call to the host; the value it answered. */
  call(member: string, args: unknown[] = [], target: HostCallTarget = this.target()): Promise<unknown> {
    if (!caller) return Promise.reject(new Error(`session ${this.sid} runs on ${this.host}, and this server has no link to it`))
    return caller(this.host, { sid: this.sid, target, member, args })
  }

  /** A call whose answer nobody waits for: a failure is logged, never thrown. */
  private send(member: string, args: unknown[] = [], target: HostCallTarget = this.target()): void {
    this.call(member, args, target).catch((err: unknown) => {
      log.session.warn('host-run session: a call to its host failed', { sessionId: this.sid, host: this.host, member, error: err instanceof Error ? err.message : String(err) })
    })
  }

  getModelCatalog(...a: unknown[]) { return this.call('getModelCatalog', a, 'session') }
  getSettingsSnapshot(...a: unknown[]) { return this.call('getSettingsSnapshot', a, 'session') }
  applyModel(...a: unknown[]) { return this.call('applyModel', a, 'session') }
  refreshAppliedSettings(...a: unknown[]) { return this.call('refreshAppliedSettings', a, 'session') }
  applyEffort(...a: unknown[]) { return this.call('applyEffort', a, 'session') }
  refreshEffectiveEffort(...a: unknown[]) { return this.call('refreshEffectiveEffort', a, 'session') }
  getContextUsage(...a: unknown[]) { return this.call('getContextUsage', a, 'session') }
  getUsage(...a: unknown[]) { return this.call('getUsage', a, 'session') }
  getBinaryVersion(...a: unknown[]) { return this.call('getBinaryVersion', a, 'session') }
  askSideQuestion(...a: unknown[]) { return this.call('askSideQuestion', a, 'session') }
  generateSessionTitle(...a: unknown[]) { return this.call('generateSessionTitle', a, 'session') }
  awaitSpawn(...a: unknown[]) { return this.call('awaitSpawn', a, 'session') }
  rewindFiles(...a: unknown[]) { return this.call('rewindFiles', a, 'session') }
  stopProcess(...a: unknown[]) { return this.call('stopProcess', a, 'session') }
  retryCancelledLines(...a: unknown[]) { return this.call('retryCancelledLines', a, 'session') }
  stopBackgroundTask(...a: unknown[]) { return this.call('stopBackgroundTask', a, 'session') }
  gracefulStop(...a: unknown[]) { return this.call('gracefulStop', a) }
  resolvePermissionRequest(...a: unknown[]) { return this.call('resolvePermissionRequest', a) }
  /** The Bash call that ran `op` (and `@file`), asked of the host: bashCallMatching's crossing form. */
  bashCallMatchingOp(op: string, file: string | undefined, taken: string[] = []) { return this.call('bashCallMatchingOp', [{ op, file, taken }], 'session') as Promise<string | undefined> }
  // ACP
  reattachWatcher(...a: unknown[]) { return this.call('reattachWatcher', a, 'acp') }
  setModel(...a: unknown[]) { return this.call('setModel', a, 'acp') }
  applyWalnutMode(...a: unknown[]) { return this.call('applyWalnutMode', a, 'acp') }
  setConfigOption(...a: unknown[]) { return this.call('setConfigOption', a, 'acp') }
  requestTurnCompleteSelfReport(...a: unknown[]) { return this.call('requestTurnCompleteSelfReport', a, 'acp') }

  /** The transport's one leader-side member (prepareOutbound), as its own call. */
  readonly transport = { prepareOutbound: (...a: unknown[]) => this.call('prepareOutbound', a, 'session') }

  // ── forwarded, fire and forget ──
  invalidateModelCatalog(): void { this.send('invalidateModelCatalog', [], 'session') }
  detach(): void { this.send('detach', [], 'session') }
  kill(): void { this.send('kill', [], 'session') }
  forceSettlePermissionRequests(...a: unknown[]): void { this.send('forceSettlePermissionRequests', a, 'session') }
  adoptAppliedSettings(...a: unknown[]): void { this.send('adoptAppliedSettings', a, 'session') }

  /**
   * The host's process is about to end on purpose. Returns the local undo: it puts this side's
   * reason back and asks the host to undo its own mark (`undoExpectedTeardown` with the undo id
   * the host answered the mark with), after that answer when the undo comes first.
   */
  markExpectedTeardown(reason: string): () => void {
    const previous = this.localTeardown
    this.localTeardown = reason
    const marked = this.call('markExpectedTeardown', [reason], 'session').then(
      (v) => (v && typeof v === 'object' && typeof (v as { undoId?: unknown }).undoId === 'string' ? (v as { undoId: string }).undoId : null),
      (err: unknown) => {
        log.session.warn('host-run session: the teardown mark did not reach its host', { sessionId: this.sid, host: this.host, error: err instanceof Error ? err.message : String(err) })
        return null
      },
    )
    let undone = false
    return () => {
      if (undone) return
      undone = true
      if (this.localTeardown === reason) this.localTeardown = previous
      void marked.then((undoId) => { if (undoId) this.send('undoExpectedTeardown', [undoId], 'session') })
    }
  }
}

/**
 * A host session's Background panel payload (its ledger, as its host sent it) with the rows of the
 * Walnut subagents this leader runs for that session added: they are the leader's (their runs, their
 * sessions), so the host's ledger never has them. A row of the host's with the same id is replaced.
 */
export function withLeaderSubagentRows<P extends Record<string, unknown>>(payload: P, sid: string): P {
  const light = lightSubagentRows(sid)
  if (light.length === 0) return payload
  const ids = new Set(light.map((t) => t.taskId))
  const own = Array.isArray(payload.tasks) ? (payload.tasks as Array<{ taskId?: unknown }>).filter((t) => !ids.has(String(t?.taskId))) : []
  return { ...payload, tasks: [...own, ...light] }
}

/** One proxy per session id, kept for the life of this server (identity fences compare them). */
const proxies = new Map<string, RemoteJudgedSession>()
/** The newest `live` state per session, also for a session no caller looked up yet. */
const liveStates = new Map<string, LiveState>()

export function remoteJudgedSession(sid: string, host: string, kind: 'native' | 'acp', taskIdOf?: () => string | undefined): RemoteJudgedSession {
  const have = proxies.get(sid)
  if (have && have.host === host) return have
  const made = new RemoteJudgedSession(sid, host, kind, taskIdOf)
  const state = liveStates.get(sid)
  if (state) made.noteLive(state)
  proxies.set(sid, made)
  return made
}

/** A `live` record the channel applied (session-channel/leader-side.ts). */
export function noteLiveState(sid: string, state: LiveState): void {
  liveStates.set(sid, state ?? {})
  proxies.get(sid)?.noteLive(state ?? {})
}

export function peekRemoteJudgedSession(sid: string): RemoteJudgedSession | undefined {
  return proxies.get(sid)
}

/** A rename the host sent: the same object answers to the new id. */
export function renameRemoteJudgedSession(from: string, to: string): void {
  const p = proxies.get(from)
  const state = liveStates.get(from)
  liveStates.delete(from)
  if (state) liveStates.set(to, state)
  if (!p) return
  proxies.delete(from)
  p.renameTo(to)
  proxies.set(to, p)
}

export function isRemoteJudgedSession(v: unknown): v is RemoteJudgedSession {
  return v instanceof RemoteJudgedSession
}

export function _resetRemoteJudgedSessionsForTesting(): void {
  proxies.clear()
  liveStates.clear()
  caller = null
}
