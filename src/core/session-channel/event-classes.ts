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
  'session:queue-left': 'fact',
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

/**
 * Transcript detail: what the CLI's output file holds anyway, so a new read of lines the leader
 * already heard keeps none of it (host-emitter.ts).
 */
export const TURN_DETAIL_FACTS: ReadonlySet<string> = new Set([
  'session:tool-use', 'session:tool-result', 'session:user-line', 'session:system-event', 'session:usage-update',
  'session:unknown-event', 'session:background-tasks', 'session:turn-speed', 'session:team-info',
])

/**
 * Facts that are a step of a message's delivery (`session:user-line`: the CLI read a line, the
 * delivery ledger's `read`): a turn summary never stands for one.
 */
export const DELIVERY_STEP_FACTS: ReadonlySet<string> = new Set(['session:user-line'])

/**
 * The facts a finished turn's summary stands for, in a log the leader has not read (fact-log.ts
 * compaction): transcript detail, never a delivery step. 2026-11-25: after the Mac slept 3.4 hours,
 * the compacted logs of its hosts folded the CLI's read of 57 delivered messages into turn
 * summaries, and the delivery ledger showed them written and never read. Ratchet:
 * tests/core/sessions/delivery-ledger-facts-ratchet.test.ts.
 */
export const TURN_SUMMARY_FACTS: ReadonlySet<string> = new Set([...TURN_DETAIL_FACTS].filter((n) => !DELIVERY_STEP_FACTS.has(n)))

/**
 * The facts whose payload is a whole snapshot of one session's state (its background-task ledger,
 * its team, its model catalog, the speed readout of its turn): the newest of a session stands for
 * every earlier one, as `live` does, so a log the leader has not read keeps one of each per session
 * (fact-log.ts compaction), a turn still running included. 2026-11-25: a turn of one session with a
 * busy background ledger wrote 1,242 snapshots of about 74 KB each while the Mac was away; the
 * unread log reached 102 MB and the leader never caught up on its return. Every fact is either
 * here or named as kept whole (tests/core/session-channel/event-classes.test.ts).
 */
export const SNAPSHOT_FACTS: ReadonlySet<string> = new Set([
  'session:background-tasks', 'session:team-info', 'session:model-catalog', 'session:turn-speed',
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
 * cannot choose any other. Every named subscriber of the codebase is in this list, in
 * REEMIT_ALLOWED_PREFIXES or in REEMIT_REFUSED: tests/core/session-channel/reemit-destinations-ratchet.test.ts.
 */
export const REEMIT_ALLOWED: readonly string[] = ['main-ai', 'web-ui', 'session-sse', 'mobile-events-feed', 'host-retry-over']
/**
 * Readers named once per request (a lane turn's relay, web/routes/lane-turn-sse.ts: `api-v1-lane-relay-<turn>`,
 * `cloud-fallback-relay-<turn>`): a host's `'*'` reaches the ones registered now.
 */
export const REEMIT_ALLOWED_PREFIXES: readonly string[] = ['api-v1-lane-relay-', 'cloud-fallback-relay-']
/** The named subscribers a host's record never names on the leader (see REEMIT_ALLOWED). */
export const REEMIT_REFUSED: readonly string[] = [
  'session-runner', 'subagent-runner', 'task-outbox', 'setup-health', 'plugin-config-reload', 'push-notifications',
  'human-inbox-letters', 'approvals', 'transfer',
]

/**
 * Who the leader says a host's fact or flow event to (leader-boot.ts): the destinations the host's
 * own emit named (the record's `to`) that REEMIT_ALLOWED holds, so the leader's readers hear it as
 * they hear one of its own sessions. A `'*'` is never passed on (the bus would hand it to every
 * subscriber, the refused ones included): it stands for every allowed reader, and for the
 * per-request readers among `registered` (the bus's subscriber names now). Ratchet:
 * tests/core/push-producer-ratchet.test.ts.
 */
export function reemitDestinations(to: readonly string[] | undefined, registered: readonly string[] = []): string[] {
  const list = Array.isArray(to) ? to.filter((d) => typeof d === 'string') : []
  const out = new Set(list.filter((d) => REEMIT_ALLOWED.includes(d)))
  if (list.includes('*')) {
    for (const d of REEMIT_ALLOWED) out.add(d)
    for (const d of registered) if (REEMIT_ALLOWED_PREFIXES.some((p) => d.startsWith(p))) out.add(d)
  }
  return out.size > 0 ? [...out] : [...UNNAMED_DESTINATIONS]
}
