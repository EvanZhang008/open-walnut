/**
 * What the leader knows of a host-judged session's process without asking anyone
 * (docs/plan/one-service-every-host.md, phase 2): the newest `live` record its host sent over the
 * session channel (remote-judged-session.ts), and the row the same channel keeps here. Every probe
 * of such a session (its liveness, its turn, what outlives the turn) answers from this, never from a
 * command to the host's daemon (sessions/session-command-gate.ts).
 *
 *   alive     the host's live state while its link is fresh; else its row's status, which only the
 *             host writes (a link down past its bound reads the row, never a death)
 *   inTurn    a turn runs or a prompt of it waits on a person
 *   working   a turn runs (not one stopped on a prompt), or work it started outlives its turn
 */
import type { SessionRecord } from '../core/types.js'
import type { OutlivingSource } from '../core/sessions/outliving-work.js'
import type { OwnerHold } from '../core/sessions/replaced-session.js'
import { hostJudgedSession } from './host-judged-runner.js'

export interface HostJudgedView {
  /** Null: neither the host's live state nor a row says (no row here at all). */
  alive: boolean | null
  inTurn: boolean
  /** A prompt of it waits on a person. */
  prompt: boolean
  working: boolean
  outliving: OutlivingSource[]
  hold: OwnerHold
  /** From the host's live state (true) or only from its row (false). */
  live: boolean
}

const OUTLIVING = new Set<OutlivingSource>(['background', 'team', 'wakeup', 'loop'])

function rowAlive(row: Pick<SessionRecord, 'process_status' | 'pid'> | null | undefined): boolean | null {
  if (!row) return null
  if (row.process_status === 'running' || row.process_status === 'idle') return true
  if (row.process_status === 'stopped') return false
  if (row.process_status === 'error') return row.pid != null
  return null
}

/**
 * The view of a host-judged session, or null when `sid` is not one (a legacy session: ask its
 * daemon as before). `row` is the caller's copy of its row, when it holds one.
 */
export async function hostJudgedView(sid: string, row?: Pick<SessionRecord, 'process_status' | 'pid'> | null): Promise<HostJudgedView | null> {
  const proxy = hostJudgedSession(sid)
  if (!proxy) return null
  const st = proxy.liveState
  const fresh = !st.unknown && typeof st.processStatus === 'string'
  let alive: boolean | null
  if (fresh) alive = st.processStatus === 'running' || st.processStatus === 'idle'
  else {
    const { getSessionByClaudeIdSync } = await import('../core/session-tracker.js')
    alive = rowAlive(row ?? getSessionByClaudeIdSync(sid))
  }
  if (!fresh || !alive) return { alive, inTurn: false, prompt: false, working: false, outliving: [], hold: 'idle', live: fresh }
  // The host's runner's own list (outlivingWorkOf, session-channel/host-live.ts): a /loop is in it as 'loop'.
  const outliving = (st.outliving ?? []).map(String).filter((s): s is OutlivingSource => OUTLIVING.has(s as OutlivingSource))
  const prompt = st.pendingPermission === true
  const inTurn = st.inTurn === true || st.turnRunning === true || prompt
  const working = !prompt && (inTurn || outliving.some((s) => s !== 'loop'))
  const hold: OwnerHold = inTurn ? 'turn' : outliving.some((s) => s !== 'loop') ? 'background' : 'idle'
  return { alive, inTurn, prompt, working, outliving, hold, live: true }
}
