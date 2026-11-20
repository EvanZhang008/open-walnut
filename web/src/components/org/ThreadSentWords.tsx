/**
 * His words on a thread card that the task has not answered yet, read from the thread's own record
 * (2026-11-20, the user, after his reply on a card vanished while the card stayed: "where is the
 * fucking history"). The card used to echo his reply from its own memory only, so a reload or a
 * redraw lost it. Now every card of a thread of a task below draws them from `t.messages`: the
 * messages after the node last spoke (an answer, its first post, or its summary), and any reply
 * still on its way, each with what became of it. A reply just sent and not yet in the record
 * (`justSent`) is shown the same way until the record holds it.
 */
import { cardView, summaryAt } from '@open-walnut/thread-view';
import type { OrgThread, OrgThreadMessage } from '@/api/org-threads';

/** At most this many of his newest words the task already has; every reply still on its way shows. */
const SETTLED_MAX = 3;

const onItsWay = (m: Pick<OrgThreadMessage, 'delivery'>) => m.delivery?.state === 'pending' || m.delivery?.state === 'claimed';

/** His words the task has not answered yet, oldest first. Pure. */
export function wordsNotAnswered(t: OrgThread, justSent?: OrgThreadMessage | null): OrgThreadMessage[] {
  const said = summaryAt(t);
  const waiting = new Set(cardView(t).waiting.flatMap((x) => x.messages.map((m) => m.id)));
  const out = t.messages.filter((m) => onItsWay(m) || (waiting.has(m.id) && (!said || m.at > said)));
  if (justSent && !t.messages.some((m) => m.id === justSent.id)) out.push(justSent);
  const settled = new Set(out.filter((m) => !onItsWay(m)).slice(-SETTLED_MAX));
  return out.filter((m) => onItsWay(m) || settled.has(m));
}

function note(m: OrgThreadMessage, owner: string): string {
  const d = m.delivery;
  // An agent's reply for him is never shown as his own words.
  const sent = d?.by && d.by !== 'human' ? 'Sent for you by another task' : 'Sent';
  switch (d?.state) {
    case 'delivered': return `${sent}: ${owner} has read it.`;
    case 'dropped': return d.withdrawn ? `Taken back before ${owner} read it.` : `Not delivered: this thread settled before ${owner} read it.`;
    case 'pending':
    case 'claimed': return `${sent}: ${owner} has not read it yet.`;
    default: return `${sent} to ${owner}.`;
  }
}

export function ThreadSentWords({ t, owner, justSent }: { t: OrgThread; owner: string; justSent?: OrgThreadMessage | null }) {
  const words = wordsNotAnswered(t, justSent);
  if (!words.length) return null;
  return (<>
    {words.map((m) => (
      <div key={m.id} className="org-thread-sent" data-testid="org-thread-popped-sent" data-message-id={m.id} data-delivery={m.delivery?.state ?? 'none'} data-by={m.delivery?.by && m.delivery.by !== 'human' ? 'agent' : 'him'}>
        <p className="org-thread-sent-words" data-testid="org-thread-popped-sent-words">{m.text}</p>
        <p className="org-thread-stand-in-note" data-testid="org-thread-unread-by-task">{note(m, owner)}</p>
      </div>
    ))}
  </>);
}
