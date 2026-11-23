/**
 * A host named a session that is not its own (handed-sessions.ts): a born row of an id nobody
 * handed it, an id handed to another host, a rename into another session's row, a start's answer
 * naming another host's session, a record of a session another host runs, a row or fact naming
 * another task than the one its session is for. Nothing of it is applied;
 * this says so once per host and session (a host repeats its records at every link), and counts it
 * in one Walnut Health item per host (audience.ts: no needsYou, so never a popup), since a host that
 * does this is broken or not to be trusted, which is Walnut's to look into.
 */
import { log } from '../../logging/index.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'

const conditions = healthConditions('host-session-ownership')
/** `host\nsid` already said; bounded, cleared when full. */
const said = new Set<string>()
const SAID_MAX = 5_000

/** `task`: a row the leader holds whose patch named another task (the leader's task was kept). */
export type RefusedWhat = 'row' | 'answer' | 'record' | 'task'

export function refusedSessionsKey(hostKey: string): string {
  return `host-session-ownership:${hostKey}`
}

/** `hostKey` named these sessions, which are not its: logged once each, counted in Walnut Health. */
export function noteRefusedSessions(hostKey: string, sids: readonly string[], what: RefusedWhat): void {
  const fresh = sids.filter((sid) => !said.has(`${hostKey}\n${sid}`))
  if (fresh.length === 0) return
  if (said.size + fresh.length > SAID_MAX) said.clear()
  for (const sid of fresh) said.add(`${hostKey}\n${sid}`)
  log.session.warn('host channel: a host named sessions that are not its own; refused, nothing applied', { hostId: hostKey, what, sessionIds: fresh.slice(0, 20), count: fresh.length })
  void conditions.raise(refusedSessionsKey(hostKey), async () => {
    const label = await hostLabel(hostKey)
    return {
      kind: 'operation-error',
      severity: 'warning',
      title: `${label} named sessions that are not its own`,
      body: `Walnut refused what ${label} sent about sessions it was never handed, or about tasks those sessions are not for. Nothing of it was applied; the sessions stay as they were.`,
      detail: `host ${hostKey} named ${fresh.length} session(s) it does not own (${what}): ${fresh.slice(0, 5).join(', ')}`,
      dedupKey: refusedSessionsKey(hostKey),
      recoveryKey: refusedSessionsKey(hostKey),
      category: 'Sessions',
      host: hostKey,
    }
  }).catch(() => { /* raiseHealthItem logs its own */ })
}

/** Tests only. */
export function _resetRefusedSessionsForTesting(): void {
  said.clear()
  conditions.reset()
}
