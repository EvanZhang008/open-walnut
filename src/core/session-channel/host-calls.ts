/**
 * What a leader may ask of a session its host runs (POST /host-api/sessions/call), by target:
 * one list both sides read, so a member is either callable on the host or not at all. The
 * inventory of what the leader uses is design/C3b-live-surface.md in the task that built this.
 *
 * A member that takes a callback cannot cross; it has a named op instead (bashCallMatchingOp).
 * State the leader reads synchronously (turnGen, processStatus, isInTurn ...) is not here: it comes
 * with the `live` records of the channel.
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
    'requestTurnCompleteSelfReport',
  ],
  runner: [
    'isBackgroundWorkActive', 'reconcilePendingBackgroundTasks', 'requestTurnCompleteSelfReport', 'changePermissionMode',
    'reinitialize', 'respawnOnCurrentPrompt', 'recoverCancelledForSession', 'markExpectedTeardown', 'undoExpectedTeardown',
    'settleInFlightTurn', 'syncTask', 'syncLane', 'adoptNewCwd', 'getOrAttachLiveSession', 'findOrAttachAcpSession',
  ],
} as const satisfies Record<'session' | 'acp' | 'runner', readonly string[]>

export type HostCallTarget = keyof typeof HOST_CALL_ALLOWLIST

export function hostCallAllowed(target: string, member: string): target is HostCallTarget {
  const list = (HOST_CALL_ALLOWLIST as Record<string, readonly string[]>)[target]
  return !!list && list.includes(member)
}
