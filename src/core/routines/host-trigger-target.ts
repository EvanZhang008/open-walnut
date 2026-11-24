/**
 * Which session on a host takes a trigger fire no server claimed (trigger-claim-v1),
 * as ONE rule for both who decide it there: the daemon's away code over its copy of
 * the host (offline-host-core.ts deliverTrigger) and the host's own Walnut server over
 * its copies (replica/away-trigger-delivery.ts). Either way the daemon then does the
 * mechanics (offline-host-core.ts deliverTriggerTo), so the records match.
 *
 *   the task COMPLETE                  not here (the server refuses and tells the user)
 *   the task's session runs on ACP     not here (the server's ACP worker delivers it)
 *   a live session of the task here    the task's own session (its slot) when live, else
 *                                      the first live one (the copies list newest first)
 *   none live                          the stopped one to resume: the slot when it is here,
 *                                      else the first that is no aside and that the server
 *                                      would wake (noResume); a slot on another host is the
 *                                      server's to wake
 *
 * A self-contained function: its body references NOTHING at module scope (types are erased).
 */

export interface HostTriggerTask { phase?: string; session_id?: string }

/** One session of the task on this host, newest first. */
export interface HostTriggerSession {
  sid: string
  /** Its CLI runs on this host now. */
  live: boolean
  /** An environment or lane session: never resumed for a fire. */
  aside?: boolean
  /** The server would not wake it for a fire (core/host-slice.ts resumableForTrigger). */
  noResume?: boolean
  /** It runs on an ACP engine: never written to by this host. */
  acp?: boolean
}

export type HostTriggerTarget = { ok: true; sid: string; resume: boolean } | { ok: false; reason: string }

export function pickHostTriggerTarget(task: HostTriggerTask | undefined, here: HostTriggerSession[], opts: { resume: boolean }): HostTriggerTarget {
  if (task?.phase === 'COMPLETE') return { ok: false, reason: 'target task is complete' }
  const slot = task?.session_id
  if (slot && here.some((s) => s.acp && s.sid === slot)) return { ok: false, reason: 'the target task runs on an ACP engine; the Walnut server delivers it' }
  const live = here.filter((s) => s.live && !s.acp)
  if (live.length > 0) {
    const own = slot ? live.find((s) => s.sid === slot) : undefined
    return { ok: true, sid: (own ?? live[0]).sid, resume: false }
  }
  if (!opts.resume) return { ok: false, reason: 'no live session of the target task on this host' }
  if (slot && !here.some((s) => s.sid === slot)) return { ok: false, reason: 'the target task\'s session is not on this host' }
  const pick = (slot ? here.filter((s) => s.sid === slot) : here).find((s) => !s.aside && !s.noResume && !s.acp)
  if (!pick) return { ok: false, reason: 'no session of the target task on this host to resume' }
  return { ok: true, sid: pick.sid, resume: true }
}
