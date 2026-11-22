/**
 * What a leader may ask of a session its host runs (POST /host-api/sessions/call), by target:
 * one list both sides read, so a member is either callable on the host or not at all. The
 * inventory of what the leader uses is design/C3b-live-surface.md in the task that built this.
 *
 * A member that takes a callback cannot cross; it has a named op instead (bashCallMatchingOp).
 * `lifecycle` members are the session controls the host carries out whole for its own session
 * (sessions/session-lifecycle.ts): the leader hands them over instead of running them itself.
 * State the leader reads synchronously (turnGen, processStatus, isInTurn ...) is not here: it comes
 * with the `live` records of the channel.
 *
 * The session id rides the body (`sid`), never `args` (hostCallArgs): a `runner` or `lifecycle`
 * member takes it as its first parameter, so the host puts it there; a `session` or `acp` member is
 * a method of that session's own object and takes `args` as they are.
 *
 * Not forwarded at all: `respawnOnCurrentPrompt` takes a callback (its `stillWanted`), and a host
 * runs its own prompt refresh for its own sessions (host-resend.ts leaderPromptRunner); the leader's
 * runner refuses it for a host-run session by name (providers/host-judged-runner.ts).
 */
export const HOST_CALL_ALLOWLIST = {
  session: [
    'getModelCatalog', 'getSettingsSnapshot', 'applyModel', 'refreshAppliedSettings', 'applyEffort', 'refreshEffectiveEffort',
    'getContextUsage', 'getUsage', 'getBinaryVersion', 'askSideQuestion', 'generateSessionTitle', 'awaitSpawn', 'rewindFiles',
    'gracefulStop', 'stopProcess', 'retryCancelledLines', 'resolvePermissionRequest', 'stopBackgroundTask',
    'invalidateModelCatalog', 'markExpectedTeardown', 'undoExpectedTeardown', 'detach', 'kill', 'forceSettlePermissionRequests',
    'emitBackgroundTasks', 'adoptAppliedSettings', 'prepareOutbound', 'bashCallMatchingOp',
  ],
  acp: [
    'gracefulStop', 'resolvePermissionRequest', 'reattachWatcher', 'setModel', 'applyWalnutMode', 'setConfigOption',
    'requestTurnCompleteSelfReport', 'detach', 'kill',
  ],
  runner: [
    'isBackgroundWorkActive', 'reconcilePendingBackgroundTasks', 'requestTurnCompleteSelfReport', 'changePermissionMode',
    'reinitialize', 'recoverCancelledForSession', 'markExpectedTeardown', 'undoExpectedTeardown',
    'settleInFlightTurn', 'syncTask', 'syncLane', 'adoptNewCwd', 'getOrAttachLiveSession', 'findOrAttachAcpSession',
  ],
  lifecycle: ['terminateSession', 'changeSessionModeOf'],
} as const satisfies Record<'session' | 'acp' | 'runner' | 'lifecycle', readonly string[]>

export type HostCallTarget = keyof typeof HOST_CALL_ALLOWLIST

export function hostCallAllowed(target: string, member: string): target is HostCallTarget {
  if (!Object.hasOwn(HOST_CALL_ALLOWLIST, target)) return false
  const list = (HOST_CALL_ALLOWLIST as Record<string, readonly string[]>)[target]
  return Array.isArray(list) && list.includes(member)
}

/** Targets whose members take the session id first (the runner's methods, the lifecycle controls). */
const SID_FIRST: ReadonlySet<HostCallTarget> = new Set(['runner', 'lifecycle'])

/** The arguments a host calls `member` with: the body's sid first for a runner or lifecycle member. */
export function hostCallArgs(target: HostCallTarget, sid: string, args: readonly unknown[]): unknown[] {
  return SID_FIRST.has(target) ? [sid, ...args] : [...args]
}
