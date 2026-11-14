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
 *   redeliverOwedReplies (at start, then every minute): an outbox no performReply of this server holds
 *     - its row is in a queue, or left one as a written line: cleared (it went out)
 *     - else: the result is noted if the replier's task holds none newer, the same row id is
 *       queued again where the asker reads now (reply-routing.ts), then cleared
 *     - an asker that is gone, or OWED_MAX_TRIES failed tries: cleared, and logged
 *   A replier that sends the answer again after the death (the request reads replied) goes out as
 *   the owed row and clears it (session-send-core.ts performReply).
 *
 * The queue keeps the commit point of a delivery (its own atomic write, deduped by row id), so the
 * answer is delivered once: the outbox only remembers that it is owed. The window left is a death
 * after the queue write and before the clear, for a row that then left the queue with no written
 * line on record (deleted by the person, past the settled-line cap, or held out of every queue by an
 * engine switch at that moment): that answer can go out twice.
 */
import { log } from '../../logging/index.js';
import type { ReplyOutbox, SessionRequest } from '../session-requests.js';

/** Deliveries tried from one outbox before it is given up. */
export const OWED_MAX_TRIES = 5;

/** Requests a performReply of this server is answering now: their outbox is its own to clear. */
const inFlight = new Map<string, number>();

/** `id` is being answered by this server: the sweep leaves its outbox alone until the release. */
export function replyInFlight(id: string): () => void {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (inFlight.get(id) ?? 1) - 1;
    if (n > 0) inFlight.set(id, n); else inFlight.delete(id);
  };
}

export interface OwedReplyDeps {
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
    list: async () => (await import('../session-requests.js')).listAllSessionRequests(),
    wentOut: async (_to, messageId) => {
      // Any session's queue: a row moves with its session (a fork, a resume, an engine switch).
      const { findQueuedMessage } = await import('../session-message-queue.js');
      if (await findQueuedMessage(messageId)) return true;
      const { settledLineUuid } = await import('../session-queue-lines.js');
      return !!(await settledLineUuid(messageId));
    },
    deliver: async (req, owed) => {
      const { resolveReplyDestination } = await import('./reply-routing.js');
      // Where the asker reads now (a fork it carried on in), never the session that answered.
      const exclude = [owed.from, ...(req.toSessionId ? [req.toSessionId] : [])].filter(Boolean);
      const at = (await resolveReplyDestination(owed.to, { exclude }))?.session
        ?? (owed.to !== req.fromSessionId ? (await resolveReplyDestination(req.fromSessionId, { exclude }))?.session : undefined)
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
  const owed = (await d.list().catch(() => [] as SessionRequest[])).filter((r) => r.outbox);
  for (const req of owed) {
    const box = req.outbox!;
    // Still being answered here: its own call delivers and clears it.
    if (inFlight.has(req.id)) continue;
    const release = replyInFlight(req.id);
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
    } finally {
      release();
    }
  }
  return delivered;
}
