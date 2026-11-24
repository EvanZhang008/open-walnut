/**
 * What a leader may ask of a session its host runs (POST /host-api/sessions/call), by target:
 * one list both sides read, so a member is either callable on the host or not at all. The
 * inventory of what the leader uses is design/C3b-live-surface.md in the task that built this.
 *
 * A member that takes a callback cannot cross; it has a named op instead (bashCallMatchingOp).
 * `lifecycle` members are the session controls the host carries out whole for its own session
 * (sessions/host-lifecycle.ts): the leader hands them over instead of running them itself, or asking
 * the host's daemon (sessions/session-command-gate.ts).
 * State the leader reads synchronously (turnGen, processStatus, isInTurn ...) is not here: it comes
 * with the `live` records of the channel.
 *
 * The session id rides the body (`sid`), never `args` (hostCallArgs): a `runner` or `lifecycle`
 * member takes it as its first parameter, so the host puts it there; a `session` or `acp` member is
 * a method of that session's own object and takes `args` as they are.
 *
 * `history` members are the transcript reads of core/sessions/host-history-reads.ts: the host reads
 * and parses its own session's transcript and answers the parsed result (rows, a plan, a search
 * text), so no line of it is parsed on the leader. They take no path: the host reads its own row.
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
  lifecycle: ['terminateSession', 'changeSessionModeOf', 'readSessionSupervision', 'lineAlreadyRan', 'cancelPendingStart', 'sendFolderWaiting'],
  history: [
    'readSessionHistory', 'readSessionHistoryTail', 'readSessionHistoryTailWindow', 'readSessionHistoryRange',
    'readSessionRowToolResult', 'extractPlanContent', 'readSingleSubagentHistory', 'reconstructWorkflowProgress',
    'readHistoryReachingAnchor', 'readAcpSessionHistoryState', 'readSessionBody', 'readPlanFromSession', 'readActiveContext',
    // The wire of those reads, not readers: the next page of a large answer, and a read the leader gave up on.
    'readNextPage', 'cancelRead',
  ],
} as const satisfies Record<'session' | 'acp' | 'runner' | 'lifecycle' | 'history', readonly string[]>

export type HostCallTarget = keyof typeof HOST_CALL_ALLOWLIST

/** The `history` members that are no reader: the paging and cancel of sessions/host-history-answer.ts. */
export const HOST_HISTORY_WIRE = ['readNextPage', 'cancelRead'] as const
/** A transcript reader a leader may route to the host (sessions/host-history-reads.ts). */
export type HostHistoryRead = Exclude<(typeof HOST_CALL_ALLOWLIST.history)[number], (typeof HOST_HISTORY_WIRE)[number]>

export function hostCallAllowed(target: string, member: string): target is HostCallTarget {
  if (!Object.hasOwn(HOST_CALL_ALLOWLIST, target)) return false
  const list = (HOST_CALL_ALLOWLIST as Record<string, readonly string[]>)[target]
  return Array.isArray(list) && list.includes(member)
}

/**
 * A call's arguments as they cross (POST /host-api/sessions/call). JSON has no `undefined` inside an
 * array: it arrives as `null`, which a member reads as a value (2026-11-24: a permission answer with
 * no option, `resolvePermissionRequest(id, true, undefined, undefined, undefined)`, reached the host
 * as option `null` and was refused as "Unknown permission option: null", so no prompt of a host-run
 * Claude session could be answered from the console or from the leader). The trailing unset
 * arguments are left off, which an older host reads right as well; an unset one before a set one is
 * named in `unset` and is undefined again on the host (callArgsIn). The two senders encode with it:
 * the leader's side (leader-side.ts callHost) and the companion's phone path (companion-host-ops.ts).
 */
export function callArgsOut(args: readonly unknown[] = []): { args: unknown[]; unset?: number[] } {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  const kept = args.slice(0, end)
  const unset = kept.flatMap((a, i) => (a === undefined ? [i] : []))
  return unset.length ? { args: kept.map((a) => (a === undefined ? null : a)), unset } : { args: kept }
}

/** The arguments a call's body carries, its `unset` positions undefined again (callArgsOut). */
export function callArgsIn(args: unknown, unset: unknown): unknown[] {
  const list = Array.isArray(args) ? [...args] : []
  if (Array.isArray(unset)) for (const i of unset) if (Number.isInteger(i) && i >= 0 && i < list.length && list[i] === null) list[i] = undefined
  return list
}

/** Targets whose members take the session id first (the runner's methods, the lifecycle controls). */
const SID_FIRST: ReadonlySet<HostCallTarget> = new Set(['runner', 'lifecycle'])

/** The arguments a host calls `member` with: the body's sid first for a runner or lifecycle member. */
export function hostCallArgs(target: HostCallTarget, sid: string, args: readonly unknown[]): unknown[] {
  return SID_FIRST.has(target) ? [sid, ...args] : [...args]
}
