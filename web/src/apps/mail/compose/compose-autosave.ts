/**
 * The engine that WRITES: the debounce, the save loop, and who a server answer belongs to.
 *
 * Split from `compose-actions.ts` (which owns the pane's lifecycle) because this is the only module
 * that may touch the save timer and the in-flight request, and keeping that state in one file is what
 * makes "there is exactly one create" a property you can read rather than hope for.
 *
 * Three rules live here, each of them a way a draft loses text or sends the wrong version:
 *
 * - ONE CREATE. A keystroke that lands during a save is one more pass of the same loop, never a
 *   second request, because the first pass is what sets `draftId`.
 * - AN ANSWER BELONGS TO THE COMPOSER THAT ASKED IT. A request cannot be recalled and the fetch gate
 *   can hold its answer for seconds, so by the time it lands the pane may show another message on
 *   another account. Every fold-back checks the composer's `epoch` first.
 * - AN INVALID RECIPIENT STOPS THE LOOP. Saving `validAddresses` around a red chip writes a row
 *   addressed to three of the four people who were typed, and reopening that row shows three chips
 *   and an enabled Send.
 */
import {
  createMailDraft,
  getMailDraft,
  mailFailure,
  patchMailDraft,
  type MailDraftDto,
  type MailDraftPatch,
} from '@/api/mail';
import { log } from '@/utils/log';
import {
  onMailStoreReset,
  patch,
  run,
  store,
  type MailComposer,
  type MailComposerFields,
  type MailSaveState,
} from '../mail-store';
import { mergeDraft } from './compose-drafts';
import { bodyWithQuote } from './reply-draft';
import { chipLabel, chipsOf, validAddresses, type AddressChip } from './mail-address';
import { isComposingPhase, statusFollowing, type SendPhase } from './send-status';

/** How long after the last keystroke the edit is saved. */
const SAVE_DEBOUNCE_MS = 800;

/** How long after a save that failed for a reason retrying could fix. */
const SAVE_RETRY_MS = 2_000;

/** After this many consecutive failures the footer stops promising and says so. */
const MAX_SAVE_ATTEMPTS = 5;

/** A phase whose arrival takes the pane over: a send is actually happening. */
const CARD_PHASES: SendPhase[] = ['sending', 'sent', 'failed', 'unknown'];

/** A save state that means something on screen is NOT on the server. */
const UNSETTLED_SAVE: MailSaveState[] = ['failed', 'retrying', 'blocked'];

let timer: ReturnType<typeof setTimeout> | null = null;
let savingPromise: Promise<void> | null = null;
let dirty = false;
let attempts = 0;
let epochSeq = 0;

onMailStoreReset(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  savingPromise = null;
  dirty = false;
  attempts = 0;
  epochSeq = 0;
});

// ── composer identity ──

/** The next composer's identity. Bumped for every open, and again for a discard. */
export function nextComposerEpoch(): number {
  return ++epochSeq;
}

/** Retire the identity on screen without installing a new one: a discard. */
export function retireComposerEpoch(): void {
  cancelPendingSave();
  epochSeq += 1;
}

/** Whether `epoch` still names the composer on screen. */
function isCurrent(epoch: number): boolean {
  return store.state.composer?.epoch === epoch;
}

/** The composer on screen, when it is still the one the caller started with. */
function currentComposer(epoch: number): MailComposer | null {
  const composer = store.state.composer;
  return composer && composer.epoch === epoch ? composer : null;
}

// ── the timer, and what the lifecycle needs of it ──

export function markComposerDirty(): void {
  dirty = true;
  attempts = 0;
}

export function scheduleComposerSave(delay = SAVE_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void runSave(); }, delay);
}

/** Drop a save that has not left yet. Only a path that will not need it may call this. */
export function cancelPendingSave(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  attempts = 0;
}

/** Stop the countdown without forgetting that there is something to save. */
export function dropSaveTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** An edit that has not reached the server yet. */
export function hasPendingEdit(): boolean {
  return dirty;
}

/** A request that has already left, and therefore cannot be recalled. */
export function isSaveInFlight(): boolean {
  return !!savingPromise;
}

/** Wait for the request in flight, whatever it does. Failures are reported by the loop itself. */
export async function awaitSaveInFlight(): Promise<void> {
  if (savingPromise) await savingPromise.catch(() => undefined);
}

/**
 * Whether everything on screen is on the server.
 *
 * A send asks this AFTER flushing. Sending while it is false would approve the revision the server
 * holds while the human is looking at a newer one, and tell them "Sent".
 */
export function isSaveSettled(): boolean {
  const save = store.state.composer?.save;
  return !dirty && !(save && UNSETTLED_SAVE.includes(save));
}

// ── writing ──

function setSave(save: MailSaveState, notice?: string | null): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({ composer: { ...composer, save, ...(notice === undefined ? {} : { notice }) } });
}

export function setComposerNotice(notice: string | null): void {
  const composer = store.state.composer;
  if (!composer) return;
  patch({ composer: { ...composer, notice } });
}

function payloadOf(composer: MailComposer): MailDraftPatch {
  return {
    to: validAddresses(composer.fields.to),
    cc: validAddresses(composer.fields.cc),
    bcc: validAddresses(composer.fields.bcc),
    subject: composer.fields.subject,
    bodyMarkdown: bodyWithQuote(composer.fields.body, composer.quote),
  };
}

/** The first recipient the server would refuse, in the words it was typed in. */
function firstInvalid(fields: MailComposerFields): AddressChip | null {
  return [...fields.to, ...fields.cc, ...fields.bcc].find((chip) => !chip.valid) ?? null;
}

/**
 * The form as a stored row describes it.
 *
 * The body is taken WHOLE and any separate quote is dropped, because the text on disk is one
 * document: keeping a quote beside it would append it a second time on the next save.
 */
export function fieldsOfDraft(draft: MailDraftDto): MailComposerFields {
  return {
    to: chipsOf(draft.to),
    cc: chipsOf(draft.cc),
    bcc: chipsOf(draft.bcc),
    subject: draft.subject,
    body: draft.bodyMarkdown,
  };
}

function runSave(): Promise<void> {
  if (savingPromise) return savingPromise;
  const promise = saveLoop().finally(() => { savingPromise = null; });
  savingPromise = promise;
  return promise;
}

/** Save until there is nothing left to save. See the file header for the three rules. */
async function saveLoop(): Promise<void> {
  const epoch = store.state.composer?.epoch ?? -1;
  try {
    while (dirty) {
      const composer = currentComposer(epoch);
      if (!composer) return;
      const bad = firstInvalid(composer.fields);
      if (bad) {
        setSave('blocked', `"${chipLabel(bad)}" is not an address Walnut can send to. `
          + 'Fix it or remove it: nothing is being saved until then.');
        return;
      }
      dirty = false;
      if (!composer.draftId) {
        const answer = await createMailDraft({
          accountId: composer.accountId,
          to: validAddresses(composer.fields.to),
          cc: validAddresses(composer.fields.cc),
          bcc: validAddresses(composer.fields.bcc),
          subject: composer.fields.subject,
          bodyMarkdown: bodyWithQuote(composer.fields.body, composer.quote),
          ...(composer.replyTo ? { inReplyTo: composer.replyTo } : {}),
        });
        if (!applyDraft(answer.draft, epoch)) return;
      } else {
        const answer = await patchMailDraft(composer.draftId, payloadOf(composer));
        if (answer.draft && !applyDraft(answer.draft, epoch)) return;
        if (!isCurrent(epoch)) return;
        if (answer.letterId) {
          setSave('saved', 'Your phone has a fresh letter for this version.');
        } else if (answer.completed === false) {
          setSave('saved', 'Walnut is still preparing a fresh letter for your phone.');
        }
      }
      attempts = 0;
    }
    if (isCurrent(epoch)) setSave('saved');
  } catch (error) {
    onSaveFailed(error, epoch);
  }
}

/**
 * A saved draft, folded into the composer WITHOUT touching the fields.
 *
 * The human may have typed since this request left, and the server's copy of the body is the one
 * that includes the quote. Overwriting the form with it is how a save eats a keystroke.
 *
 * Returns whether it landed. A false means this answer belongs to a composer that is no longer on
 * screen: the row is still merged into the list (it exists), but nothing may be bound to the pane.
 */
function applyDraft(draft: MailDraftDto, epoch: number): boolean {
  const composer = currentComposer(epoch);
  if (!composer) {
    mergeDraft(draft);
    return false;
  }
  if (composer.draftId && composer.draftId !== draft.draftId) return false;
  // The STATUS follows the server (a saved edit may have re-frozen the draft), the MODE does not:
  // which half of the pane is on screen is the human's business, not the row's.
  patch({
    composer: {
      ...composer,
      draftId: draft.draftId,
      draft,
      status: statusFollowing(composer.status, draft),
      save: 'saved',
    },
  });
  mergeDraft(draft);
  return true;
}

function onSaveFailed(error: unknown, epoch: number): void {
  const failure = mailFailure(error);
  log.warn('mail', 'draft save failed', { status: failure.status, code: failure.code });
  if (!isCurrent(epoch)) return;
  // 409 means somebody else moved this draft (a phone approval, another tab); 404 means it is
  // gone. Either way the copy on screen is not the truth any more, so it is re-read AND re-seeded
  // rather than saved over: telling the human "reloaded, check it" while they are still looking at
  // their own text is a lie, and their next keystroke would PATCH it back over the server's.
  if (failure.status === 409 || failure.status === 404) {
    const draftId = store.state.composer?.draftId;
    dirty = false;
    setSave('failed', failure.status === 404
      ? 'This draft is no longer on the server, so nothing was saved.'
      : 'This draft changed somewhere else, so Walnut reloaded it. Check it before sending.');
    if (draftId) void refreshComposerDraft(draftId, epoch, { reseedFields: true });
    return;
  }
  // A 4xx the server will give again for the same text (a body or recipient list over the limit) is
  // not worth five attempts and ten seconds of "retrying": the human is the only one who can fix it.
  const terminal = failure.status >= 400 && failure.status < 500
    && failure.status !== 408 && failure.status !== 429;
  if (terminal) {
    dirty = false;
    setSave('failed', failure.message);
    return;
  }
  dirty = true;
  if (++attempts >= MAX_SAVE_ATTEMPTS) {
    setSave('failed', `Walnut could not save this draft: ${failure.message}`);
    return;
  }
  setSave('retrying');
  scheduleComposerSave(SAVE_RETRY_MS);
}

/**
 * Flush whatever is pending, then let the caller act on a revision that is really on disk.
 *
 * Called before every send and by every path that leaves a composer. Without it, "Ask on phone"
 * 800ms after a keystroke asks the human to approve the version from before that keystroke. It does
 * NOT throw: the caller checks `isSaveSettled()`, because a flush that failed must stop a send
 * rather than crash a click.
 */
export async function flushMailComposerSave(): Promise<void> {
  dropSaveTimer();
  await awaitSaveInFlight();
  if (dirty) await runSave();
}

// ── reading back ──

/**
 * Re-read one draft and its ledger rows. Coalesced: an event burst costs one request.
 *
 * `reseedFields` is for the 409/404 path only. Every other caller must leave the form alone, or a
 * refresh triggered by the human's own save would overwrite the keys they typed while it was away.
 */
export function refreshComposerDraft(
  draftId: string,
  epoch: number,
  opts: { reseedFields?: boolean } = {},
): Promise<void> {
  return run(`draft:${draftId}`, async () => {
    try {
      const answer = await getMailDraft(draftId);
      mergeDraft(answer.draft);
      const composer = currentComposer(epoch);
      if (!composer || composer.draftId !== draftId) return;
      const status = statusFollowing(composer.status, answer.draft, answer.sends ?? []);
      patch({
        composer: {
          ...composer,
          draft: answer.draft,
          status,
          ...(opts.reseedFields ? { fields: fieldsOfDraft(answer.draft), quote: null } : {}),
          ...modeForPhase(composer, status.phase),
        },
      });
    } catch (error) {
      log.warn('mail', 'draft reload failed', { draftId, error: mailFailure(error).message });
    }
  }, true);
}

/**
 * Which half of the pane a new phase gets to demand, and what to say about it.
 *
 * Two directions, both of them the server's news rather than the human's choice: a send that has
 * actually started takes the pane over, and a frozen draft going back to `composing` while the card
 * is up means the phone answered Edit, which the card has nothing to show for.
 */
export function modeForPhase(composer: MailComposer, phase: SendPhase): Partial<MailComposer> {
  if (CARD_PHASES.includes(phase)) return { mode: 'status' };
  if (composer.mode === 'status' && isComposingPhase(phase)) {
    return { mode: 'edit', notice: 'Nothing was sent; the draft is editable again.' };
  }
  return {};
}
