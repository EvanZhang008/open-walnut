/**
 * What crosses the session channel from a host to its leader, per session event
 * (docs/plan/one-service-every-host.md, phase 2; the plan's "facts and flow").
 *
 *   fact     kept in the host's fact log (fact-log.ts) with a per-session sequence number and
 *            delivered exactly once, also after a reconnect or a leader that was away
 *   flow     sent only while the link is up and caught up; never kept, never replayed: after a
 *            reconnect the leader has the whole message as a fact (the text deltas)
 *   leader   made on the leader from its own data (a row the channel applied, its own hooks):
 *            the host never sends it
 *   command  the leader's ask of a session (start, send, interrupt): an API call to the host's
 *            service, never a channel record
 *
 * Every session and transfer event in EventNames has a class here: the table must name each one
 * (tests/core/session-channel/event-classes.test.ts reads event-bus.ts), so a new event fails until
 * it is given one.
 */

export type ChannelClass = 'fact' | 'flow' | 'leader' | 'command'

export const SESSION_EVENT_CLASS: Readonly<Record<string, ChannelClass>> = {
  'session:start': 'command',
  'session:send': 'command',
  'session:interrupt': 'command',
  'session:started': 'fact',
  'session:ended': 'fact',
  'session:deleted': 'leader',
  'session:content-updated': 'leader',
  'session:result': 'fact',
  'session:error': 'fact',
  'transfer:fork-init': 'fact',
  'session:will-reap': 'fact',
  'session:text-delta': 'flow',
  'session:thinking-delta': 'flow',
  'session:tool-use': 'fact',
  'session:tool-result': 'fact',
  'session:unknown-event': 'fact',
  'session:usage-limit': 'fact',
  'session:status-changed': 'leader',
  'session:messages-delivered': 'fact',
  'session:queued-cancelled': 'fact',
  'session:batch-completed': 'fact',
  'session:batch-failed': 'fact',
  'session:delivery-held': 'fact',
  'session:message-queued': 'fact',
  'session:system-event': 'fact',
  'session:user-line': 'fact',
  'session:background-tasks': 'fact',
  'session:usage-update': 'fact',
  'session:turn-speed': 'fact',
  'session:live-activity': 'flow',
  'session:settings-applied': 'fact',
  'session:controls-changed': 'fact',
  'session:recap-updated': 'leader',
  'session:turn-settled': 'fact',
  'session:retry-over': 'fact',
  'session:model-catalog': 'fact',
  'session:permission-request': 'fact',
  'session:permission-resolved': 'fact',
  'session:cron-fired': 'fact',
  'session:side-question-done': 'fact',
  'session:side-thread-renamed': 'fact',
  'session:side-question-error': 'fact',
  'session:team-info': 'fact',
  'session:team-agent-delta': 'flow',
}

/**
 * Channel records that are not bus events: a change to a row the host owns (its patch, the
 * whole row at birth), a session id the CLI replaced (resume, fork), a row the host dropped
 * because the leader deleted it, the summary that stands for a finished turn's tool facts in a
 * log the leader has not read for a while (fact-log.ts compaction), and `live`: the state the
 * leader reads of a running session at once (its turn, its prompt, its mode ...; the newest one
 * stands for every earlier one).
 */
export const CHANNEL_RECORD_KINDS = ['row', 'rename', 'drop', 'turn-summary', 'live'] as const
export type ChannelRecordKind = typeof CHANNEL_RECORD_KINDS[number]

/** The session id an event names (the host keys its records by it, the leader checks them by it). */
export function sessionIdOf(name: string, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (name === 'transfer:fork-init') return typeof d.actualId === 'string' && d.actualId ? d.actualId : null
  for (const k of ['sessionId', 'claudeSessionId']) {
    const v = d[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** The class of one event name; a name the table does not know is never sent. */
export function channelClassOf(name: string): ChannelClass | null {
  return SESSION_EVENT_CLASS[name] ?? null
}

/** The facts a finished turn's summary stands for, in a log the leader has not read (compaction). */
export const TURN_DETAIL_FACTS: ReadonlySet<string> = new Set([
  'session:tool-use', 'session:tool-result', 'session:user-line', 'session:system-event', 'session:usage-update',
  'session:unknown-event', 'session:background-tasks', 'session:turn-speed', 'session:team-info',
])

/** The fact that ends a turn (the summary goes in front of it). */
export const TURN_END_FACT = 'session:result'

/** Who hears a record that names no destinations: the subscriber the leader's own start names (host-judged-runner.ts). */
const UNNAMED_DESTINATIONS: readonly string[] = ['main-ai']

/**
 * The named subscribers a host's fact or flow event may reach on the leader: the readers of a
 * session's events (the main agent, the web UI and its streams, the phone's feed) and the leader's
 * side of a host's give-up (leader-retry-over.ts, sessions/held-error.ts RETRY_OVER_SUBSCRIBER).
 * Never a command subscriber (the session runner, the subagent runner, the task outbox ...) and never
 * the phone's push subscriber (a host session buzzes the phone no more than one here does). A host
 * cannot choose any other. Every named subscriber of the codebase is in this list or in
 * REEMIT_REFUSED: tests/core/session-channel/reemit-destinations-ratchet.test.ts.
 */
export const REEMIT_ALLOWED: readonly string[] = ['*', 'main-ai', 'web-ui', 'session-sse', 'mobile-events-feed', 'host-retry-over']
/** The named subscribers a host's record never names on the leader (see REEMIT_ALLOWED). */
export const REEMIT_REFUSED: readonly string[] = [
  'session-runner', 'subagent-runner', 'task-outbox', 'setup-health', 'plugin-config-reload', 'push-notifications',
  'human-inbox-letters', 'approvals', 'transfer',
]

/**
 * Who the leader says a host's fact or flow event to (leader-boot.ts): the destinations the host's
 * own emit named (the record's `to`) that REEMIT_ALLOWED holds, so the leader's readers hear it as
 * they hear one of its own sessions. Ratchet: tests/core/push-producer-ratchet.test.ts.
 */
export function reemitDestinations(to: readonly string[] | undefined): string[] {
  const named = Array.isArray(to) ? to.filter((d) => typeof d === 'string' && REEMIT_ALLOWED.includes(d)) : []
  return named.length > 0 ? [...new Set(named)] : [...UNNAMED_DESTINATIONS]
}
