/**
 * An answer owed to its asker survives the server (SessionRequest.outbox).
 *
 * A reply to a request (task_send in_reply_to) is three writes in three stores: the request settles
 * (session-requests.json), the replier's result is noted on its task (tasks.sqlite), and the answer
 * goes into the asker's queue (session-message-queue.json). Before 2026-11-14 a server that died
 * after the settle and before the queue write left the request "replied" with the answer never
 * delivered, and only the replier sending it again could recover it. Modelled on T3 Code's effect
 * outbox (one transaction records the state change and the effect it owes; a worker delivers it):
 *
 *   performReply ──► settle + outbox, ONE write ──► result noted ──► queued ──► outbox cleared
 *                         │ the server dies anywhere after this write
 *                         ▼
 *   redeliverOwedReplies (at start, then every minute): an outbox older than OWED_AFTER_MS
 *     - its row is in the asker's queue, or left it as a delivered line: cleared (it went out)
 *     - else: the result is noted if the replier's task holds none newer, the same row id is
 *       queued again (session-send-core.ts deliverToSession), then cleared
 *     - an asker that is gone, or OWED_MAX_TRIES failed tries: cleared, and logged
 *
 * The queue keeps the commit point of a delivery (its own atomic write, deduped by row id), so the
 * answer is delivered once: the outbox only remembers that it is owed. The one window left is a
 * death after the queue write and before the clear, for a row that then left the queue with no
 * line id on record (a host without send markers): that answer can go out twice.
 */
import { log } from '../../logging/index.js';
import type { ReplyOutbox, SessionRequest } from '../session-requests.js';

/** An outbox this old is no performReply's still in flight (its delivery times out well before). */
export const OWED_AFTER_MS = 60_000;
/** Deliveries tried from one outbox before it is given up. */
export const OWED_MAX_TRIES = 5;

export interface OwedReplyDeps {
  now: () => number;
  list: () => Promise<SessionRequest[]>;
  /** The row is in the asker's queue, or left it as a delivered line. */
  wentOut: (to: string, messageId: string) => Promise<boolean>;
  deliver: (req: SessionRequest, owed: ReplyOutbox) => Promise<'delivered' | 'gone'>;
  noteReport: (req: SessionRequest, owed: ReplyOutbox) => Promise<void>;
  clear: (id: string, messageId: string) => Promise<void>;
  noteTry: (id: string, messageId: string) => Promise<void>;
}

function defaultDeps(): OwedReplyDeps {
  return {
    now: () => Date.now(),
    list: async () => (await import('../session-requests.js')).listAllSessionRequests(),
    wentOut: async (to, messageId) => {
      const { isMessageQueued } = await import('../session-message-queue.js');
      if (await isMessageQueued(to, messageId)) return true;
      const { settledLineUuid } = await import('../session-queue-lines.js');
      return !!(await settledLineUuid(messageId));
    },
    deliver: async (req, owed) => {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const { resolveReplyDestination } = await import('./reply-routing.js');
      // The asker as it reads now (a fork it carried on in), never the replier itself.
      const at = (await getSessionByClaudeId(owed.to).catch(() => null))
        ?? (await resolveReplyDestination(req.fromSessionId, { exclude: req.toSessionId ? [req.toSessionId] : [] }))?.session
        ?? null;
      if (!at) return 'gone';
      const { deliverToSession } = await import('./session-send-core.js');
      await deliverToSession(at, {
        busText: owed.busText, enqueueText: owed.enqueueText, source: owed.source, endsWait: true,
        messageId: owed.messageId, ...(owed.taskId ? { taskId: owed.taskId } : {}), ...(owed.fromLeader ? { fromLeader: true } : {}),
      });
      const { answerDigest, noteAnswerDelivered } = await import('../session-requests.js');
      await noteAnswerDelivered(req.id, { digest: answerDigest(owed.busText), deliveredTo: at.claudeSessionId }).catch(() => {});
      return 'delivered';
    },
    noteReport: async (req, owed) => {
      if (!owed.report) return;
      const { getTask } = await import('../task-manager.js');
      const cur = (await getTask(owed.report.taskId).catch(() => null))?.result_report;
      // Noted already (this request's), or a newer result since: it stays.
      if (cur && (cur.request_id === (owed.report.head as { request_id?: string }).request_id || Date.parse(cur.at) >= Date.parse(owed.at))) return;
      const { noteResultReport } = await import('./session-send-core.js');
      await noteResultReport(owed.report.taskId, owed.report.head as Parameters<typeof noteResultReport>[1], owed.report.fields);
    },
    clear: async (id, messageId) => (await import('../session-requests.js')).clearReplyOutbox(id, messageId),
    noteTry: async (id, messageId) => (await import('../session-requests.js')).noteReplyOutboxTry(id, messageId),
  };
}

let running: Promise<number> | null = null;

/** Deliver every answer still owed (once at a time; a call while one runs joins it). Returns how many went out. */
export function redeliverOwedReplies(deps: Partial<OwedReplyDeps> = {}): Promise<number> {
  return (running ??= run({ ...defaultDeps(), ...deps }).finally(() => { running = null; }));
}

async function run(d: OwedReplyDeps): Promise<number> {
  let delivered = 0;
  const owed = (await d.list().catch(() => [] as SessionRequest[]))
    .filter((r) => r.outbox && d.now() - Date.parse(r.outbox.at) >= OWED_AFTER_MS);
  for (const req of owed) {
    const box = req.outbox!;
    try {
      if (await d.wentOut(box.to, box.messageId)) {
        await d.clear(req.id, box.messageId);
        continue;
      }
      if ((box.tries ?? 0) >= OWED_MAX_TRIES) {
        log.session.warn('owed reply given up: it could not be delivered', { requestId: req.id, to: box.to, tries: box.tries });
        await d.clear(req.id, box.messageId);
        continue;
      }
      await d.noteTry(req.id, box.messageId);
      await d.noteReport(req, box).catch((err) => log.session.warn('owed reply: its result was not noted', { requestId: req.id, error: err instanceof Error ? err.message : String(err) }));
      const how = await d.deliver(req, box);
      if (how === 'gone') log.session.warn('owed reply dropped: its asker is gone', { requestId: req.id, to: box.to });
      else { delivered++; log.session.info('owed reply delivered after a restart', { requestId: req.id, to: box.to, messageId: box.messageId }); }
      await d.clear(req.id, box.messageId);
    } catch (err) {
      // Kept: the next pass tries again, up to OWED_MAX_TRIES.
      log.session.warn('owed reply: delivery failed, trying again later', { requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return delivered;
}
