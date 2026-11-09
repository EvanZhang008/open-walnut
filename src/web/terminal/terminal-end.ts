/**
 * The answer of "End terminal" (terminal:kill) for one of a session's dtach sessions.
 *
 * Only a master that was stopped, or no master at all, is reported as ended. A
 * master that could not be proved (the probe gave no answer, the socket's owner
 * is not a dtach master for it, the stop itself failed) is left running, so the
 * answer says the end is unconfirmed and why: the UI must not tell the user the
 * terminal ended while its shell may still run. The answer's reason is plain
 * words for the user; the technical one goes to the log.
 */

import type { StopOutcome } from './dtach-master.js'
import { stopDtachSession, type TerminalRef } from './dtach-lifecycle.js'
import { log } from '../../logging/index.js'

export type TerminalKillAnswer =
  | { killed: true }
  | { killed: false; unconfirmed: true; reason: string }

type StopResult = Pick<StopOutcome, 'outcome' | 'reason'>
type StopFn = (record: TerminalRef) => Promise<StopResult>

const REASON_MAX = 200
let stop: StopFn = stopDtachSession

/** Test seam (the browser fixture server): replace the dtach stop; null restores it. */
export function __setTerminalStopForTesting(fn: StopFn | null): void {
  stop = fn ?? stopDtachSession
}

/**
 * The reason the user reads, from the technical one (dtach-master.ts wording,
 * which stays in the log): what happened, never how the proof works.
 */
export function readableReason(technical: string | undefined): string {
  const r = technical ?? ''
  if (r.startsWith('the probe did not finish')) return 'the host did not answer in time'
  if (r.startsWith('the stop failed')) return 'the stop command failed on the host'
  if (r.includes('no way on the host to read')) return 'the host cannot show which process holds the terminal'
  return "the terminal's owner could not be verified"
}

/** Map a stop outcome to the RPC answer; an unconfirmed end is logged with the full terminal id. */
export function killAnswer(terminalId: string, res: StopResult): TerminalKillAnswer {
  if (res.outcome !== 'left') return { killed: true }
  const technical = (res.reason?.trim() || 'the dtach master could not be proved').slice(0, REASON_MAX)
  log.web.warn('terminal end unconfirmed: its dtach session may still run', { terminalId, reason: technical })
  return { killed: false, unconfirmed: true, reason: readableReason(technical) }
}

/** Stop the session's dtach master and answer for it. Never throws. */
export async function endDtachForTerminal(terminalId: string, record: TerminalRef): Promise<TerminalKillAnswer> {
  let res: StopResult
  try {
    res = await stop(record)
  } catch (err) {
    res = { outcome: 'left', reason: `the stop failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return killAnswer(terminalId, res)
}
