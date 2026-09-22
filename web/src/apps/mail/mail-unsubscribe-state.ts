/**
 * What the console says about leaving a mailing list, as one pure answer both surfaces read.
 *
 * The row menu and the reader's header ask the same question ("where is this one up to?") and used to
 * be the two places it could be answered differently, so the answer lives here once and they each draw
 * it. No DOM, no fetch, no store: `tests/web/mail-unsubscribe-items.test.ts` grades every state
 * directly, which matters because most of them are states a browser cannot easily be put into.
 *
 * The rules this file encodes, each of which is a sentence somebody would otherwise have got wrong:
 *
 * - `done` OUTRANKS a failed attempt, and `in-flight` outranks `done`. Both can be true at once: the
 *   human left the list through a DIFFERENT mail (so this one is `done` with `scope: 'list'`) and their
 *   click on THIS one failed, and the useful thing to say is that they are off the list. `in-flight`
 *   goes first because it is the only one of the three that is about right now.
 * - "THIS LIST" AND "THIS SENDER" ARE NOT INTERCHANGEABLE. A ledger keyed on a sender's address is
 *   coarser than one keyed on a `List-Id`: one sender running three lists off one address shares a key,
 *   so leaving one marks all three. Saying "you unsubscribed from this list" there tells somebody they
 *   are off a list they still get mail from, which is the one outcome worse than saying nothing.
 * - `done` STAYS CLICKABLE. Asking again is legitimate (a list that kept sending), and it is also safe
 *   without any client-side gate: the ledger's claim refuses a `done` row outright, so the click
 *   answers `409 already` and sends nothing. That is why the SMTP gate below does not cover it.
 * - A DISABLED ITEM ALWAYS SAYS WHY. The menu's own rule (see `mail-context-items.ts`): an item that
 *   is greyed out with no `title` presents the whole feature as broken.
 */
import type { MailMessageDto, MailUnsubscribeDto } from '@/api/mail';
import { CANNOT_SEND_TITLE } from './compose/send-status';

/** Said under a disabled `Unsubscribe`: the design's exact wording, and the one hint that follows it. */
export const UNSUBSCRIBE_NONE_TITLE = 'No unsubscribe link found. Ask Walnut can try.';

/** Said under a `failed` row, where the click is a retry rather than a first attempt. */
export const UNSUBSCRIBE_RETRY_TITLE = 'Walnut\'s last attempt did not work. Clicking tries again.';

/** Said under `Finish unsubscribing…`, because the click opens a conversation and sends nothing. */
export const UNSUBSCRIBE_ASK_TITLE =
  'Walnut got part of the way and the rest needs a person. This opens Ask Walnut about it.';

/**
 * The words each state draws, exported because three surfaces name them: the menu, the reader's button
 * and the Playwright specs that click them. A label typed twice is a label that drifts.
 */
export const UNSUBSCRIBE_LABELS = {
  ready: 'Unsubscribe',
  pending: 'Unsubscribing…',
  done: 'Unsubscribed ✓',
  needsHuman: 'Finish unsubscribing…',
  /** The agent asked and the letter is still open. Names WHERE the answer goes, not what to click. */
  asked: 'Waiting on your answer',
} as const;

/**
 * Said under a row whose `needs-human` is the AGENT's letter waiting, not a page waiting.
 *
 * The two arrive as the same ledger status and mean opposite things: one is "Walnut opened a page and it
 * wants a button pressed", the other is "Walnut has not touched anything and is asking you first". A
 * menu that offered to finish the second would offer to finish a page nobody opened.
 */
export const UNSUBSCRIBE_ASKED_TITLE =
  'Walnut asked you about this in your inbox. Answer there and it will finish the job.';

/**
 * The ledger reason that means "a letter is waiting for the human", written by the agent's own op.
 *
 * A reason rather than a status, because the ROW's state really is `needs-human` — the difference is
 * what the human has to do, and that is a wording question this file owns.
 */
const ASKED_REASON = 'asked';

/**
 * Does this verdict hand the rest of the job to Ask Walnut, there and then?
 *
 * Both surfaces that can start an unsubscribe ask this, and neither decides it for itself: a click that
 * ran out of road goes straight on into the drawer with the page and the reason, because the url is on
 * the wire exactly once (the ledger keeps the reason, not the page) and a second click later can only
 * ask the model to go looking for the way out again.
 *
 * `asked` is the one `needs-human` that must NOT: it means the agent has already put the question in
 * front of the person in their inbox, so nothing was opened and there is nothing to finish. Opening a
 * drawer about it would be Walnut answering its own letter.
 */
export function unsubscribeHandsOverToAsk(
  answer: { status?: string; reason?: string } | null | undefined,
): boolean {
  return answer?.status === 'needs-human' && answer.reason !== ASKED_REASON;
}

/** Which of the ladder's situations this message is in. `ready` is "nothing has happened yet". */
export type UnsubscribeRowStatus =
  | 'none' | 'ready' | 'pending' | 'done' | 'needs-human' | 'asked' | 'failed';

export interface UnsubscribeRowState {
  status: UnsubscribeRowStatus;
  label: string;
  /** For the `title` attribute. '' when there is nothing extra worth saying. */
  title: string;
  disabled: boolean;
  /**
   * What a click does. `run` posts to the unsubscribe route, `ask` opens the Ask-Walnut drawer with the
   * finish-it preset, and `none` is a click that cannot happen because the row is disabled.
   */
  action: 'run' | 'ask' | 'none';
  /** With `action: 'ask'`, the ledger's reason so the drawer's first message can say what stopped. */
  reason?: string;
}

/** A short date, and the year only when it is not this one: `Sep 21` reads as recent, and should. */
function shortDate(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const when = new Date(at);
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** How the ladder's own vocabulary reads in a sentence. `manual` is a human saying they did it. */
function methodPhrase(method: string): string {
  if (method === 'one-click') return 'one-click';
  if (method === 'mailto') return 'a mail to the list';
  if (method === 'link') return 'the unsubscribe page';
  return method || 'this message';
}

/**
 * The one sentence about a finished unsubscribe, used by the menu's `title` and by the reader's line.
 *
 * Two shapes, because the two facts are different. A `message`-scope row is about THIS mail and names
 * the rung that did it (`Unsubscribed via one-click · Sep 21`); a `list`-scope row is about a mail
 * nobody clicked, so it has to say what was left and when (`You unsubscribed from this list on Sep 21`)
 * — and `keyedBy` decides that noun (see the header).
 */
export function unsubscribeDoneTitle(
  done: NonNullable<MailUnsubscribeDto['done']>,
  now: number = Date.now(),
): string {
  const when = shortDate(done.at, now);
  if (done.scope === 'list') {
    // `sender` is also the fallback for a server that did not say: understating what was left is the
    // safe direction, since "this sender" is true whenever "this list" is.
    const what = done.keyedBy === 'list-id' ? 'this list' : 'this sender';
    return when
      ? `You unsubscribed from ${what} on ${when}`
      : `You unsubscribed from ${what}`;
  }
  return when
    ? `Unsubscribed via ${methodPhrase(done.method)} · ${when}`
    : `Unsubscribed via ${methodPhrase(done.method)}`;
}

export interface UnsubscribeRowInput {
  /** The message as the snapshot holds it NOW: a menu is open across syncs and across live events. */
  message: Pick<MailMessageDto, 'unsubscribe'>;
  /** Can this message's own account send mail? Only the mailto rung needs it (see below). */
  canSend: boolean;
  now?: number;
}

/**
 * The `Unsubscribe` row, in whichever of its states this message is in.
 *
 * The SMTP gate is deliberately narrow: it applies only where a click would really try to send a mail,
 * which is `ready` and `failed` on a message whose ONLY rung is `mailto`. A message that also offers an
 * https rung needs no SMTP at all, and `done` / `needs-human` never send (see the header).
 */
export function unsubscribeRowState(input: UnsubscribeRowInput): UnsubscribeRowState {
  const now = input.now ?? Date.now();
  // The documented reading of an absent field: the cache captured nothing, which is exactly `none`.
  const held = input.message.unsubscribe;
  const available = held?.available ?? 'none';
  const attempt = held?.attempt;
  const done = held?.done;

  if (attempt?.status === 'in-flight') {
    return {
      status: 'pending',
      label: UNSUBSCRIBE_LABELS.pending,
      title: 'Walnut is unsubscribing you from this one.',
      disabled: true,
      action: 'none',
    };
  }
  if (done) {
    return {
      status: 'done',
      label: UNSUBSCRIBE_LABELS.done,
      title: unsubscribeDoneTitle(done, now),
      disabled: false,
      action: 'run',
    };
  }
  if (attempt?.status === 'needs-human' && attempt.reason === ASKED_REASON) {
    // Disabled, and that is the deliberate half. The ledger WOULD let a click through (a `needs-human`
    // row is re-claimable), so clicking would run the ladder and leave the agent's letter sitting in the
    // inbox with a button that no longer means anything. The answer belongs where it was asked.
    return {
      status: 'asked',
      label: UNSUBSCRIBE_LABELS.asked,
      title: UNSUBSCRIBE_ASKED_TITLE,
      disabled: true,
      action: 'none',
    };
  }
  if (attempt?.status === 'needs-human') {
    return {
      status: 'needs-human',
      label: UNSUBSCRIBE_LABELS.needsHuman,
      title: UNSUBSCRIBE_ASK_TITLE,
      disabled: false,
      action: 'ask',
      ...(attempt.reason ? { reason: attempt.reason } : {}),
    };
  }
  if (available === 'none') {
    // Present but disabled, rather than dropped. The two other Walnut rows can look at a message with
    // no link at all, so the honest thing is to show that this one cannot and say what can.
    return {
      status: 'none',
      label: UNSUBSCRIBE_LABELS.ready,
      title: UNSUBSCRIBE_NONE_TITLE,
      disabled: true,
      action: 'none',
    };
  }
  const blocked = available === 'mailto' && !input.canSend;
  if (attempt?.status === 'failed') {
    return {
      status: 'failed',
      label: UNSUBSCRIBE_LABELS.ready,
      title: blocked ? CANNOT_SEND_TITLE : UNSUBSCRIBE_RETRY_TITLE,
      disabled: blocked,
      action: blocked ? 'none' : 'run',
    };
  }
  return {
    status: 'ready',
    label: UNSUBSCRIBE_LABELS.ready,
    title: blocked ? CANNOT_SEND_TITLE : '',
    disabled: blocked,
    action: blocked ? 'none' : 'run',
  };
}

/**
 * The reader's status line, or null when there is nothing to report.
 *
 * Only the three states that are ABOUT something that happened. `ready` and `none` get no line: the
 * reader already carries a button, and a header row saying "this message can be unsubscribed from" is
 * noise on top of a control that says the same thing.
 */
export function unsubscribeStatusLine(
  message: Pick<MailMessageDto, 'unsubscribe'>,
  now: number = Date.now(),
): { status: 'pending' | 'done' | 'needs-human' | 'asked' | 'failed'; text: string } | null {
  const state = unsubscribeRowState({ message, canSend: true, now });
  if (state.status === 'done') return { status: 'done', text: state.title };
  if (state.status === 'pending') return { status: 'pending', text: 'Unsubscribing…' };
  if (state.status === 'needs-human') {
    return {
      status: 'needs-human',
      text: 'Unsubscribe needs a confirmation',
    };
  }
  if (state.status === 'asked') {
    return { status: 'asked', text: 'Walnut asked you about unsubscribing' };
  }
  if (state.status === 'failed') {
    return { status: 'failed', text: 'Unsubscribe did not work' };
  }
  return null;
}
