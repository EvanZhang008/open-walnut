/**
 * Leaving a mailing list, from the console's side: the one request, and what the answer changes.
 *
 * Its own file rather than another section of `mail-actions.ts` for the reason that file states about
 * its own edges (see `mail-task-actions.ts`): that one is the console's own READS, and this is a write
 * that leaves the machine. It keeps the same two rules as everything else in this directory — nothing
 * mutates the snapshot except through `patch`, and nothing fetches except inside `run`, so a double
 * click is one request.
 *
 * Three things this file is careful about:
 *
 * - THE OPTIMISTIC MARK IS `in-flight`, NEVER `done`. The whole point of the ladder is that leaving a
 *   list can fail quietly, so a console that painted a tick on the click would be the exact lie the
 *   server goes to such lengths to avoid. `in-flight` is a claim the server has already made by the
 *   time the response arrives, and it is what makes the row read `Unsubscribing…` on the first frame
 *   instead of one round trip later.
 * - EVERY OUTCOME IS SAID OUT LOUD, in the row's own strip, using the SERVER'S sentence. It knows
 *   whether a page asked for a confirmation, whether its guard refused a link, or whether the sender's
 *   endpoint said no; a second wording invented here would drift from what actually happened. A verdict
 *   the person has to act on stays on screen (`sticky`), and a plain success retires itself — the row
 *   strip's own rule.
 * - A `done` EVENT RELOADS THE PAGE, because leaving a LIST changes rows this console cannot derive:
 *   every other cached message of the same list becomes `done` with `scope: 'list'`, and only the
 *   server's one ledger query per page knows which those are.
 */
import {
  mailFailure,
  unsubscribeMailMessage,
  type MailMessageDto,
  type MailUnsubscribeDto,
  type MailUnsubscribeResult,
} from '@/api/mail';
import { log } from '@/utils/log';
import { finishUnsubscribePreset } from './mail-ask';
import { bodyQuoteText } from './mail-quote-text';
import {
  mailRowLabel,
  openMailAsk,
  pairKey,
  patch,
  run,
  setMailRowNote,
  standIn,
  store,
} from './mail-store';

/** The shape the bus event arrives in (`plugin:mail:unsubscribed`). */
export interface MailUnsubscribedEventData {
  accountId?: string;
  messageId?: string;
  listKey?: string;
  method?: string;
  status?: string;
}

/**
 * Write one message's unsubscribe state onto every copy the console is holding.
 *
 * The list, the search results and the open reader are three copies of one row, and all three draw this
 * (the row menu's label, the reader's status line). Shaped exactly like `applyMessageTask`, and for the
 * same reason: a live event must land without a refetch.
 *
 * MERGED onto whatever is there, never replacing it: `available` is derived from what the poll stored
 * and this function has no idea what it is, so a wholesale replace would blank the field that decides
 * whether the row can be unsubscribed from at all.
 */
export function applyUnsubscribeState(
  accountId: string,
  messageId: string,
  next: Partial<MailUnsubscribeDto>,
): void {
  const state = store.state;
  const stamp = (one: MailMessageDto): MailMessageDto => {
    if (one.accountId !== accountId || one.messageId !== messageId) return one;
    const held = one.unsubscribe;
    return {
      ...one,
      unsubscribe: {
        available: next.available ?? held?.available ?? 'none',
        // `done` survives an attempt landing on top of it: the human left this list, and a later failed
        // click on the same mail does not put them back on it.
        ...(next.done ?? held?.done ? { done: next.done ?? held?.done } : {}),
        ...(next.attempt ? { attempt: next.attempt } : {}),
      } as MailUnsubscribeDto,
    };
  };
  const open = state.open;
  patch({
    messages: state.messages.map(stamp),
    search: { ...state.search, messages: state.search.messages.map(stamp) },
    open: open && open.accountId === accountId && open.messageId === messageId
      ? { ...open, ...(open.message ? { message: stamp(open.message) } : {}) }
      : open,
  });
}

/**
 * Clear an optimistic `in-flight` this console put on a row whose request then failed outright.
 *
 * Only for a failure that never reached the ledger (a network error, a 400, a 503). A refusal the
 * SERVER made is not this: it comes back with a ledger row, and the row's real state is what gets
 * stamped. Without this, a console that lost its connection mid-click would say `Unsubscribing…`
 * forever, which is the one state a human cannot get out of.
 */
function clearOptimisticAttempt(accountId: string, messageId: string): void {
  const state = store.state;
  const strip = (one: MailMessageDto): MailMessageDto => {
    if (one.accountId !== accountId || one.messageId !== messageId) return one;
    if (one.unsubscribe?.attempt?.status !== 'in-flight') return one;
    const { attempt: _dropped, ...rest } = one.unsubscribe;
    return { ...one, unsubscribe: rest };
  };
  const open = state.open;
  patch({
    messages: state.messages.map(strip),
    search: { ...state.search, messages: state.search.messages.map(strip) },
    open: open && open.accountId === accountId && open.messageId === messageId
      ? { ...open, ...(open.message ? { message: strip(open.message) } : {}) }
      : open,
  });
}

/** The state an answer leaves behind, in the DTO's own vocabulary. */
function stateFromAnswer(answer: MailUnsubscribeResult): Partial<MailUnsubscribeDto> {
  const at = answer.at ?? Date.now();
  if (answer.status === 'done') {
    return { done: { method: answer.method, at, scope: 'message' } };
  }
  return {
    attempt: {
      status: answer.status,
      ...(answer.reason ? { reason: answer.reason } : {}),
      at,
    },
  };
}

/**
 * Leave the list this message came from.
 *
 * Coalesced per message, so a double click is one request; the SERVER's claim is the half that actually
 * guarantees one attempt, and a second click that does get through answers `409 in-flight` with the row
 * it already holds, which is a state this prints rather than an error.
 *
 * Resolves with the url a `needs-human` verdict handed back, when there was one, because that url is
 * the one thing the drawer's first message needs and it is on the wire exactly once — the ledger keeps
 * the reason, not the page.
 */
export async function unsubscribeFromMessage(
  accountId: string,
  messageId: string,
): Promise<{ status: string; url?: string; reason?: string } | null> {
  const pair = pairKey(accountId, messageId);
  // `run` answers `Promise<void>` (it is a coalescer, and a coalesced caller is handed the FIRST call's
  // promise), so the outcome comes back through a local. A second click while one is in flight therefore
  // leaves this `undefined`, which is the honest answer: that click started nothing.
  let answered: { status: string; url?: string; reason?: string } | null = null;
  await run(`unsubscribe:${pair}`, async () => {
    applyUnsubscribeState(accountId, messageId, {
      attempt: { status: 'in-flight', at: Date.now() },
    });
    try {
      const answer = await unsubscribeMailMessage(accountId, messageId);
      applyUnsubscribeState(accountId, messageId, stateFromAnswer(answer));
      // The server's own sentence, always. A verdict somebody has to act on waits for them; a plain
      // success retires itself, which is the row strip's rule for every other action too.
      setMailRowNote(answer.message, pair, { sticky: answer.status !== 'done' });
      answered = {
        status: answer.status,
        ...(answer.url ? { url: answer.url } : {}),
        ...(answer.reason ? { reason: answer.reason } : {}),
      };
    } catch (error) {
      const failure = mailFailure(error);
      // The three 409s are STATES, not faults: `already` (off this list), `in-flight` (their own second
      // click) and `unsupported` (nothing to open). Each arrives with a printable sentence.
      if (failure.status === 409) {
        const ledger = (error as { body?: { unsubscribe?: { status?: string; method?: string; at?: number } } })
          .body?.unsubscribe;
        if (ledger?.status === 'done') {
          applyUnsubscribeState(accountId, messageId, {
            done: { method: ledger.method ?? 'manual', at: ledger.at ?? Date.now(), scope: 'message' },
          });
        } else if (ledger?.status !== 'in-flight') {
          clearOptimisticAttempt(accountId, messageId);
        }
        setMailRowNote(failure.message, pair, { sticky: failure.code !== 'in-flight' });
        answered = { status: failure.code };
        return;
      }
      clearOptimisticAttempt(accountId, messageId);
      const stand = standIn(error);
      if (stand) { patch({ stand }); return; }
      log.warn('mail', 'unsubscribe failed', { accountId, messageId, error: failure.message });
      const row = [...store.state.messages, ...store.state.search.messages]
        .find((one) => one.accountId === accountId && one.messageId === messageId);
      setMailRowNote(
        `Walnut could not unsubscribe from ${row ? mailRowLabel(row) : 'that message'}: ${failure.message}`,
        pair,
        { sticky: true },
      );
    }
  });
  return answered;
}

/**
 * Hand the unfinished unsubscribe to Walnut, from the OPEN READER.
 *
 * The reader's own path, separate from the row menu's (`MailRowContextMenu`), because the two start from
 * different places: the menu has to read the body first and refuse when a composer holds unsaved text,
 * while the reader already HAS the body on screen and the drawer is taking the pane that body is in.
 * The quote is derived from what is already loaded, so this makes no request and cannot fail.
 *
 * `url` is the page a verdict just handed back, and it is optional because it exists for exactly one
 * caller: the click whose own response carried it. The ledger keeps the REASON, not the page, so a
 * reader reached after a reload has no url to pass and the preset's other branch covers that by telling
 * the model to find the way out in the message itself — which is what a person would do with the same
 * information.
 */
export function openFinishUnsubscribeAsk(
  accountId: string,
  messageId: string,
  reason?: string,
  url?: string,
): void {
  const open = store.state.open;
  if (!open || open.accountId !== accountId || open.messageId !== messageId || !open.message) return;
  const message = open.message;
  openMailAsk({
    accountId,
    messageId,
    message,
    preset: finishUnsubscribePreset({
      ...(reason ? { reason } : {}),
      ...(url ? { url } : {}),
      ...(message.from?.address ? { listName: message.from.address } : {}),
    }),
    // '' rather than null: the body is on screen, so a mail with no text half is a mail with no words
    // and not a read that failed. The two need opposite sentences in the quote (see `MailAsk`).
    bodyText: bodyQuoteText(open.body) ?? '',
  });
}

/**
 * A `plugin:mail:unsubscribed` event: stamp the row it names, without a request.
 *
 * It runs for an unsubscribe this tab started (where it is a no-op, since the response already stamped
 * the same thing) AND for one started in another tab, which is the case it exists for. The list-scope
 * siblings are NOT derived here — see the file header; `mail-actions.ts` reloads the page for that.
 */
export function onMailUnsubscribed(data: MailUnsubscribedEventData): void {
  const { accountId, messageId, status } = data;
  if (!accountId || !messageId || !status) return;
  const at = Date.now();
  if (status === 'done') {
    applyUnsubscribeState(accountId, messageId, {
      done: { method: data.method ?? 'manual', at, scope: 'message' },
    });
    return;
  }
  if (status === 'needs-human' || status === 'failed' || status === 'in-flight') {
    applyUnsubscribeState(accountId, messageId, { attempt: { status, at } });
  }
}
