/**
 * A resend of a line that may already be in a CLI: a Retry whose first send's
 * acknowledgement was lost (the server took the message and the CLI answered it,
 * the client only never heard), or a phone repeating its qm- id after a lost 202.
 *
 * The queue row of the first send is gone by then, so the resend used to be
 * enqueued again under the same line uuid and left to the daemon to skip. On a
 * dead session that meant a --resume spawn for a line the daemon then did not
 * write: a CLI process came up with no turn to run (2026-11-10 acceptance: the
 * session read "working" with nothing running). The daemon already knows what
 * became of the line (`line.fate`, line-fate-read-v1: existing evidence only, it
 * never dials, starts a CLI or writes a line), so the route asks it first and
 * enqueues nothing when the line ran.
 *
 * `ran` is the only fate that answers yes: the CLI finished the line, answered
 * it, or the process running now took it and is answering it. A line a gone
 * process took and never answered is `unanswered` (sent again, as before), and
 * any other answer, or none (an older daemon, no link, a cloud replica), keeps
 * the old path, so this can only ever save a duplicate, never lose a message.
 */
import { log } from '../../logging/index.js';

export async function resendAlreadyRan(input: {
  sessionId: string;
  host?: string | null;
  /** The uuid the line went out under (the send's userUuid, or the row's settled line uuid). */
  lineUuid?: string;
  /** Queue ids the line carried, when known (a phone's qm- id). */
  messageIds?: string[];
}): Promise<boolean> {
  if (!input.lineUuid) return false;
  try {
    const { getConnectedDaemonConnection, readDaemonLineFate } = await import('../../providers/daemon-connection.js');
    const conn = getConnectedDaemonConnection(input.host ?? '__local__');
    const fate = await readDaemonLineFate(conn, input.sessionId, input.lineUuid, input.messageIds ?? []);
    if (fate?.fate !== 'ran') return false;
    log.session.info('resend of a line that already ran: nothing enqueued, no process started', {
      sessionId: input.sessionId, uuid: input.lineUuid, state: fate.state, answer: fate.answer,
    });
    return true;
  } catch (err) {
    log.session.warn('resend fate check failed: sending it as before', {
      sessionId: input.sessionId, uuid: input.lineUuid, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
