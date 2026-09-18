/**
 * The composer's LIFECYCLE: what puts one on screen, what takes it away, and what happens in between.
 *
 * The engine that writes is `compose-autosave.ts`, the sends are `compose-send.ts`, the list is
 * `compose-drafts.ts`. This file is the one that decides when a pane may be replaced, which is where
 * the two subtle rules live:
 *
 * - LEAVING A COMPOSER FLUSHES IT. Closing, opening another message, replying and picking a draft row
 *   all go through `releaseComposer`. Cancelling the timer instead would throw away the last 800ms of
 *   typing, and for a draft that had not been created yet it would throw away the whole message,
 *   because no POST would ever be issued.
 * - EDITING A FROZEN DRAFT RE-ASKS THE PHONE, and that is the server's doing (it withdraws the letter
 *   and issues a fresh one). The pane does NOT flip to the status card for it: the human is
 *   mid-sentence. It flips when a send actually starts, or back to the form when the phone answers
 *   Edit.
 */
import { deleteMailDraft, mailFailure, type MailDraftDto, type MailMessageDto } from '@/api/mail';
import { log } from '@/utils/log';
import {
  patch,
  store,
  type MailComposer,
  type MailComposerFields,
} from '../mail-store';
import { forgetDraft, loadMailDrafts } from './compose-drafts';
import {
  awaitSaveInFlight,
  dropSaveTimer,
  fieldsOfDraft,
  flushMailComposerSave,
  hasPendingEdit,
  isSaveInFlight,
  markComposerDirty,
  modeForPhase,
  nextComposerEpoch,
  refreshComposerDraft,
  retireComposerEpoch,
  scheduleComposerSave,
} from './compose-autosave';
import { chipsOf } from './mail-address';
import { forwardQuote, forwardSubject, quoteMarkdown, replyPrefill } from './reply-draft';
import {
  isComposingPhase,
  phaseOf,
  reduceDraftChanged,
  reduceSendSettled,
  statusOfDraft,
} from './send-status';

// ── opening and closing ──

function blankFields(): MailComposerFields {
  return { to: [], cc: [], bcc: [], subject: '', body: '' };
}

function newComposer(accountId: string, over: Partial<MailComposer> = {}): MailComposer {
  return {
    epoch: nextComposerEpoch(),
    accountId,
    draftId: null,
    draft: null,
    fields: blankFields(),
    quote: null,
    replyTo: null,
    showCc: false,
    showBcc: false,
    mode: 'edit',
    status: { phase: 'composing', revision: 0 },
    save: 'clean',
    busy: false,
    notice: null,
    ...over,
  };
}

/**
 * Everything the composer on screen owes the server before it stops being the one on screen.
 *
 * Returns whether anything was written, which is the only reason to re-read the list. An untouched
 * reply is DELETED instead of flushed: what it holds is the quote this console built, not a draft,
 * and leaving it in Drafts makes the human tidy up after a click they took back.
 */
async function releaseComposer(): Promise<boolean> {
  const composer = store.state.composer;
  if (!composer) return false;
  dropSaveTimer();

  if (isUntouchedReply(composer)) {
    // The create may still be in flight, and its id is the only handle on the row.
    await awaitSaveInFlight();
    const draftId = store.state.composer?.draftId ?? composer.draftId;
    // Nothing may write into this composer again: its row is about to stop existing.
    retireComposerEpoch();
    if (!draftId) return false;
    forgetDraft(composer.accountId, draftId);
    void deleteMailDraft(draftId).catch((error) => {
      log.warn('mail', 'untouched reply could not be deleted', {
        draftId, error: mailFailure(error).message,
      });
    });
    return true;
  }

  // A composer with no id is not necessarily unsaved: its create may be in flight, and marking that
  // dirty would save the same text twice. `flushMailComposerSave` waits for the request either way.
  const unsaved = !composer.draftId && !isSaveInFlight() && hasContent(composer);
  if (!hasPendingEdit() && !unsaved && !isSaveInFlight()) return !!composer.draftId;
  if (unsaved) markComposerDirty();
  await flushMailComposerSave();
  return true;
}

/** A reply whose body is still only the quote the console wrote for it. */
function isUntouchedReply(composer: MailComposer): boolean {
  return !!composer.replyTo
    && !composer.fields.body.trim()
    && isComposingPhase(composer.status.phase);
}

/** Whether there is anything worth a row on the server. An empty composer is not a draft. */
function hasContent(composer: MailComposer): boolean {
  const { fields } = composer;
  return fields.to.length > 0 || fields.cc.length > 0 || fields.bcc.length > 0
    || !!fields.subject.trim() || !!fields.body.trim() || !!composer.quote;
}

/**
 * Put a composer on screen, releasing whatever was there first.
 *
 * When nothing is open the install is SYNCHRONOUS, which is what a click deserves. When something is
 * open the new pane waits for the old one's last edit to reach the server.
 */
function handOver(make: () => MailComposer, after?: (composer: MailComposer) => void): Promise<void> {
  const install = () => {
    const next = make();
    patch({ composer: next, open: null });
    after?.(next);
  };
  if (!store.state.composer) { install(); return Promise.resolve(); }
  return releaseComposer().then(install);
}

/**
 * Send this message as a different identity.
 *
 * From a merged list the compose identity is RESOLVED (the most recently used account that can send), and
 * a resolved default with no way to change it is a guess the human has to leave the view to correct. So
 * the head's identity is a control, and this is what it does: the same text, written by another account.
 *
 * A NEW MESSAGE only. A reply carries the threading headers of a message held in the other account's
 * cache and its quote is that account's mail; moving it would ask the server to copy headers from a
 * message the new identity cannot see. The composer offers no switch there, and this refuses one.
 *
 * The old row is DELETED rather than left behind: a draft belongs to one account, and keeping it would
 * leave a copy of this letter waiting in the identity the human just rejected.
 */
export function switchMailComposerAccount(accountId: string): Promise<void> {
  const from = store.state.composer;
  if (!from || from.accountId === accountId) return Promise.resolve();
  if (from.replyTo || from.intent) return Promise.resolve();
  const { fields, showCc, showBcc } = from;
  const carried = { fields, showCc, showBcc };
  const oldAccountId = from.accountId;
  return releaseComposer().then(async () => {
    const draftId = store.state.composer?.draftId ?? from.draftId;
    retireComposerEpoch();
    if (draftId) {
      forgetDraft(oldAccountId, draftId);
      await deleteMailDraft(draftId).catch((error) => {
        log.warn('mail', 'draft of the abandoned identity could not be deleted', {
          draftId, error: mailFailure(error).message,
        });
      });
    }
    patch({ composer: newComposer(accountId, carried), open: null });
    // Only text already worth a row is saved again: switching identity on an empty composer creates
    // nothing, exactly as opening one does.
    if (hasContent(store.state.composer!)) { markComposerDirty(); scheduleComposerSave(); }
  });
}

/** A blank message. Nothing is created until the human types: an empty draft is not a draft. */
export function openMailComposer(accountId: string): Promise<void> {
  return handOver(() => newComposer(accountId));
}

/**
 * Reply, or reply all.
 *
 * The draft is created AT OPEN rather than on the first keystroke, which is the one place those
 * two differ: a reply already has content nobody typed (the recipients, the `Re:` subject, the
 * quote) and the server needs the reply target to copy `In-Reply-To`/`References` from the message
 * it holds. So there is something to save before a key is pressed.
 */
export function openMailReplyComposer(input: {
  accountId: string;
  accountAddress: string;
  message: MailMessageDto;
  /** The plain-text half of the open body, when there is one. */
  bodyText?: string;
  all: boolean;
}): Promise<void> {
  return handOver(
    () => {
      const prefill = replyPrefill({
        message: input.message,
        accountAddress: input.accountAddress,
        all: input.all,
      });
      const quote = quoteMarkdown({
        message: input.message,
        ...(input.bodyText ? { text: input.bodyText } : {}),
      });
      return newComposer(input.accountId, {
        fields: {
          to: chipsOf(prefill.to),
          cc: chipsOf(prefill.cc),
          bcc: [],
          subject: prefill.subject,
          body: '',
        },
        quote,
        replyTo: { accountId: input.message.accountId, messageId: input.message.messageId },
        showCc: prefill.cc.length > 0,
        save: 'saving',
      });
    },
    () => { markComposerDirty(); scheduleComposerSave(0); },
  );
}

/**
 * Forward: the message, carried over, with nobody in `To` yet.
 *
 * It is NOT a reply, and the difference is in the one field this composer leaves unset: `replyTo`
 * is what makes the server copy `In-Reply-To`/`References` from the cached message, and a forward
 * that carried those would file somebody else's thread under a mail they never answered. The
 * original travels as the quote (`forwardQuote`), which is real body text, so what the recipient
 * gets is what the composer shows.
 *
 * The draft is created at open, like a reply, because a forward already holds content nobody typed.
 */
export function openMailForwardComposer(input: {
  accountId: string;
  message: MailMessageDto;
  /** The plain-text half of the open body, when there is one. */
  bodyText?: string;
}): Promise<void> {
  return handOver(
    () => newComposer(input.accountId, {
      intent: 'forward',
      fields: {
        to: [],
        cc: [],
        bcc: [],
        subject: forwardSubject(input.message.subject),
        body: '',
      },
      quote: forwardQuote({
        message: input.message,
        ...(input.bodyText ? { text: input.bodyText } : {}),
      }),
      save: 'saving',
    }),
    () => { markComposerDirty(); scheduleComposerSave(0); },
  );
}

/** A row in the Drafts view. A draft that is not `composing` opens on its status card. */
export function openMailDraft(draft: MailDraftDto): Promise<void> {
  return handOver(
    () => {
      const phase = phaseOf(draft.state);
      return newComposer(draft.accountId, {
        draftId: draft.draftId,
        draft,
        fields: fieldsOfDraft(draft),
        showCc: draft.cc.length > 0,
        showBcc: draft.bcc.length > 0,
        mode: isComposingPhase(phase) ? 'edit' : 'status',
        status: statusOfDraft(draft),
        save: 'clean',
      });
    },
    // The ledger rows are what a retry names, and the list route does not carry them.
    (composer) => { void refreshComposerDraft(draft.draftId, composer.epoch); },
  );
}

/**
 * Close the pane. The draft stays: it lives in the Drafts view until it is sent or discarded.
 *
 * The pane stays up for the length of the flush, because the save loop reads the composer out of the
 * snapshot and so has to run before the snapshot loses it.
 */
export async function closeMailComposer(): Promise<void> {
  const had = store.state.composer;
  if (!had) return;
  const wrote = await releaseComposer();
  patch({ composer: null });
  if (wrote || had.draftId) void loadMailDrafts(true);
}

export function showMailComposerStatus(): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({ composer: { ...composer, mode: 'status' } });
}

/** Back to the form. The draft may still be frozen; the next keystroke is what unfreezes it. */
export function editMailComposerDraft(): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({ composer: { ...composer, mode: 'edit', notice: null } });
}

// ── editing ──

export function setMailComposerFields(next: Partial<MailComposerFields>): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({
    composer: { ...composer, fields: { ...composer.fields, ...next }, save: 'saving' },
  });
  markComposerDirty();
  scheduleComposerSave();
}

export function toggleMailComposerField(which: 'showCc' | 'showBcc'): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({ composer: { ...composer, [which]: !composer[which] } });
}

// ── live events ──

/**
 * `draft-changed` and `send-settled`, from `plugin:mail:*`.
 *
 * The reducer moves the card immediately (the events carry the state, so there is no reason to wait
 * for a request), and a re-read follows for the fields the event does not carry: the error text and
 * the ledger row a retry names.
 */
export function onMailDraftEvent(name: string, data: unknown): void {
  const payload = (data ?? {}) as { draftId?: string; sendId?: string; state?: string; revision?: number };
  if (!payload.draftId) return;
  const composer = store.state.composer;

  if (composer?.draftId === payload.draftId) {
    const status = name === 'send-settled'
      ? reduceSendSettled(composer.status, { sendId: payload.sendId ?? '', state: payload.state ?? '' })
      : reduceDraftChanged(composer.status, {
        state: payload.state ?? '',
        revision: payload.revision ?? composer.status.revision,
      });
    patch({ composer: { ...composer, status, ...modeForPhase(composer, status.phase) } });
    void refreshComposerDraft(payload.draftId, composer.epoch);
    return;
  }
  // Not the open draft: the Drafts badge and list still have to follow, and only for a console
  // that has already loaded them (a tab that never opened Mail must not start fetching).
  if (store.state.loaded) void loadMailDrafts(true);
}
