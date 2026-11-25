/**
 * Every top-level key a host's fact or flow event may carry, and what the leader does with it
 * (leader-apply.ts says a host's records on this bus through factAsLeaderSays). A host speaks only
 * of its own session: its words never name another session, task, host, queue row or transfer of
 * this leader. One table, so a new key is a decision (tests/core/session-channel/
 * host-data-ownership-ratchet.test.ts reads every fact and flow payload in event-types.ts and fails
 * on a key that is not here, or a fact with no payload type):
 *
 *   session    names the record's own session: any other value and the event is not said
 *   rewritten  said as the leader knows it: the task of its own row of the session, the link's host
 *   scoped     a leader object: one of another session is removed (`scope`: a queue row of
 *              another session; a transfer attempt not started on this host makes the whole
 *              fork-init unsaid)
 *   own        the session's own data (its text, numbers, its CLI's ids): no reader on the leader
 *              resolves it to an object of another session
 */

export type FactKeyClass = 'session' | 'rewritten' | 'scoped' | 'own'

const own = (why: string) => ['own', why] as const
const TEXT = own('text the session wrote or said')
const NUM = own('a number or flag of the session')
const CLI = own('an id inside the session\'s own CLI stream (a message, a tool call, a row of its transcript)')

export const FACT_KEYS: Readonly<Record<string, readonly [FactKeyClass, string]>> = {
  sessionId: ['session', 'the record\'s session'],
  claudeSessionId: ['session', 'the record\'s session'],
  actualId: ['session', 'transfer:fork-init names its new session in it (sessionIdOf)'],
  taskId: ['rewritten', 'the task of the leader\'s own row of the session'],
  host: ['rewritten', 'the link\'s host'],
  messageIds: ['scoped', 'queue rows: none of another session (linesNotOthers); a row the leader never made stands'],
  messageId: ['scoped', 'a queue row: removed when it is another session\'s'],
  exits: own('session:queue-left\'s step per row, by row id: the ledger reads it only for the ids its scoped messageIds keeps (delivery-ledger.ts)'),
  dictationIds: own('the recordings dictated into a person\'s send (stt/dictation-ids.ts): Voice Accuracy pairs only a recording kept on this machine, never another session\'s object'),
  dictationText: TEXT,
  attemptId: ['scoped', 'a transfer attempt: only one the leader started on this host; else the fork-init is not said'],
  preassignedId: own('the id a transfer\'s start named; the leader reads the attempt and actualId only'),
  fromPlanSessionId: own('the plan session a failed start came from: read only by the runner that emits it'),
  createdBySessionId: own('the CLI session that made a cron: kept as text in the hook\'s note, never resolved'),
  cronTaskId: own('the CLI\'s own cron job id, not a Walnut task'),
  requestId: own('the session\'s own permission request (host-permission.ts proves an answer against the host\'s list)'),
  id: own('a side question of this session (shown under it)'),
  threadId: own('a side thread of this session (shown under it)'),
  rowIds: CLI, msgId: CLI, toolUseId: CLI, parentToolUseId: CLI, uuid: CLI, userUuid: CLI, replacesMsgId: CLI,
  tasks: own('the CLI\'s own background jobs, not Walnut tasks'),
  agents: own('the CLI\'s own background agents'),
  members: own('the CLI\'s own team members'),
  taskDescription: TEXT, workflowDescription: TEXT, workflowName: TEXT, agentName: TEXT, teamName: TEXT,
  title: TEXT, message: TEXT, messages: TEXT, queuedText: TEXT, rowText: TEXT, result: TEXT, error: TEXT, cliError: TEXT,
  question: TEXT, answer: TEXT, reason: TEXT, heldReason: TEXT, detail: TEXT, snippet: TEXT, delta: TEXT, input: TEXT,
  planContent: TEXT, toolName: TEXT, eventType: TEXT, scope: TEXT, variant: TEXT, progress: TEXT, scriptSource: TEXT,
  signIn: own('the engine its CLI is not signed in on, and that host as words (engine-sign-in.ts): shown with a link to its sign-in in Settings, never resolved to a leader object'),
  project: own('the project the session runs in, as the host says it: shown only, the leader links by its own task'),
  provider: NUM, model: NUM, models: NUM, requestedEffort: NUM, effectiveEffort: NUM, errorKind: NUM, source: NUM, sentBy: NUM,
  activity: NUM, taskActivity: NUM, phase: NUM, phases: NUM, card: NUM, events: NUM, usage: NUM, usageLimit: NUM, speed: NUM,
  promptCache: NUM, count: NUM, turnGen: NUM, v: NUM, duration: NUM, totalCost: NUM, costDelta: NUM, inputTokens: NUM,
  contextPercent: NUM, contextWindow: NUM, contextWindowEstimate: NUM, contextWindowSource: NUM, autoCompactAt: NUM,
  stopsAt: NUM, liveReply: NUM, continued: NUM, autoCompleted: NUM, backgroundActive: NUM, foregroundActive: NUM,
  compactionStopped: NUM, detachedBgActive: NUM, interrupted: NUM, isError: NUM, processDied: NUM, retryExhausted: NUM,
  safeguardStop: NUM, teamActive: NUM, wakeupPending: NUM, inFlight: NUM, parked: NUM, waitsFor: NUM, refused: NUM,
  renamed: NUM, replayed: NUM, ledgered: NUM, saidOnMessage: NUM, startRecovery: NUM, foreign: NUM, subagentType: NUM,
  retryAt: NUM, heldRetryAt: NUM, enqueuedAt: NUM, createdAt: NUM, fetchedAt: NUM, warnedAt: NUM, remainingMs: NUM,
  idleDurationMs: NUM, idleTimeoutMs: NUM, allowed: NUM, cancelled: NUM, expired: NUM, acpOptions: NUM,
}

const keysOf = (cls: FactKeyClass): string[] => Object.entries(FACT_KEYS).filter(([, [c]]) => c === cls).map(([k]) => k)
const SESSION_KEYS = keysOf('session').filter((k) => k !== 'actualId')
const SCOPED_KEYS = keysOf('scoped')

/** Of `ids` under `key`, the ones that stand for this session (leader-boot.ts: no other session's queue rows, attempts started on this host). */
export type FactScope = (key: string, ids: string[]) => string[]

/**
 * A host's fact as the leader says it (leader-apply.ts), by FACT_KEYS: null when it is not said (a
 * session key naming another session, a fork-init of an attempt the leader did not start on this
 * host); else the data with the task of the leader's own row of the session in `taskId`/`task_id`
 * (removed when it has none; undefined: no task rule here, the keys stand), `host` the link's host,
 * and no queue row of another session. `scope` absent: scoped keys stand.
 */
export function factAsLeaderSays(name: string, data: unknown, o: { sid: string; hostId: string; taskId: string | null | undefined; scope?: FactScope }): unknown | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const d = data as Record<string, unknown>
  if (name !== 'transfer:fork-init') {
    for (const k of SESSION_KEYS) if (typeof d[k] === 'string' && d[k] !== '' && d[k] !== o.sid) return null
  }
  const out: Record<string, unknown> = { ...d }
  for (const k of ['taskId', 'task_id']) {
    if (!(k in out) || o.taskId === undefined) continue
    if (o.taskId) out[k] = o.taskId
    else delete out[k]
  }
  if ('host' in out) out.host = o.hostId
  if (o.scope) {
    for (const k of SCOPED_KEYS) {
      if (!(k in out)) continue
      const v = out[k]
      const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []
      const kept = new Set(o.scope(k, ids))
      if (k === 'attemptId') { if (!kept.has(String(v))) return null; continue }
      if (Array.isArray(v)) out[k] = ids.filter((x) => kept.has(x))
      else if (!kept.has(String(v))) delete out[k]
    }
  }
  return out
}
