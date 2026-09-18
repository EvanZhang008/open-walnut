/**
 * The four things a human can ask of a finished draft: ask the phone, send it here, retry, discard.
 *
 * All four share one shape. They FLUSH the autosave first, then refuse to go on unless everything on
 * screen is really on the server, and only then name a revision. That order is the whole guarantee:
 * an approval is a promise that the text the human read is the text that goes out, so a send that
 * proceeded over an unsaved edit (or a failed one) would be sending something nobody approved while
 * telling them it was sent.
 */
import {
  deleteMailDraft,
  requestMailDraftSend,
  retryMailSend,
  sendMailDraft,
  mailFailure,
  type MailDraftDto,
} from '@/api/mail';
import { log } from '@/utils/log';
import { noteMailIdentity, patch, store } from '../mail-store';
import { forgetDraft, mergeDraft } from './compose-drafts';
import {
  flushMailComposerSave,
  isSaveSettled,
  refreshComposerDraft,
  retireComposerEpoch,
  setComposerNotice,
} from './compose-autosave';
import { hasInvalidAddress } from './mail-address';
import { statusFollowing, type SendPhase } from './send-status';

/** What a human is told when their newest edit never reached the server. */
const UNSAVED = 'Walnut could not save your latest edit, so it will not send it. Try again.';

async function withBusy(what: string, work: () => Promise<void>): Promise<void> {
  const composer = store.state.composer;
  if (!composer || composer.busy) return;
  patch({ composer: { ...composer, busy: true, notice: null } });
  try {
    await work();
  } catch (error) {
    onSendFailed(what, error);
  } finally {
    const current = store.state.composer;
    if (current) patch({ composer: { ...current, busy: false } });
  }
}

/** The draft a send needs: flushed, really saved, existing, and with no unfixed recipient. */
async function sendableDraft(): Promise<MailDraftDto | null> {
  const composer = store.state.composer;
  if (!composer) return null;
  if (hasInvalidAddress([...composer.fields.to, ...composer.fields.cc, ...composer.fields.bcc])) {
    setComposerNotice('Fix the addresses in red first.');
    return null;
  }
  await flushMailComposerSave();
  // The flush swallows its failure so a click never crashes, which is exactly why this has to ask:
  // an offline or refused save leaves the server one revision behind what is on screen.
  if (!isSaveSettled()) {
    setComposerNotice(UNSAVED);
    return null;
  }
  const current = store.state.composer;
  if (!current?.draftId || !current.draft) {
    setComposerNotice('Add a recipient and something to say first.');
    return null;
  }
  return current.draft;
}

export function askMailOnPhone(): Promise<void> {
  return withBusy('request-send', async () => {
    const draft = await sendableDraft();
    if (!draft) return;
    const answer = await requestMailDraftSend(draft.draftId, draft.revision);
    const composer = store.state.composer;
    if (!composer) return;
    patch({
      composer: {
        ...composer,
        mode: 'status',
        ...(answer.draft ? { draft: answer.draft } : {}),
        status: answer.draft
          ? {
            ...statusFollowing(composer.status, answer.draft),
            ...(answer.letterId ? { letterId: answer.letterId } : {}),
          }
          : { ...composer.status, phase: 'waiting' },
        notice: answer.completed === false
          ? 'The letter is still being prepared. It appears on your phone in a moment.'
          : null,
      },
    });
    if (answer.draft) mergeDraft(answer.draft);
  });
}

export function sendMailNow(): Promise<void> {
  return withBusy('console send', async () => {
    const draft = await sendableDraft();
    if (!draft) return;
    const answer = await sendMailDraft(draft.draftId, draft.revision);
    const composer = store.state.composer;
    if (!composer) return;
    // Sent AS this identity, so the next compose from a merged list defaults to it.
    noteMailIdentity(composer.accountId);
    const settled = answer.draft
      ? statusFollowing(composer.status, answer.draft, answer.send ? [answer.send] : [])
      : { ...composer.status, phase: 'sending' as SendPhase };
    patch({
      composer: {
        ...composer,
        mode: 'status',
        ...(answer.draft ? { draft: answer.draft } : {}),
        status: settled,
        notice: answer.completed === false
          ? 'Still handing it to the mail server. This card updates itself when it lands.'
          : null,
      },
    });
    if (answer.draft) mergeDraft(answer.draft);
  });
}

/** A retry is a fresh approval round at a new revision, never a second attempt at the same one. */
export function retryMailComposerSend(): Promise<void> {
  return withBusy('retry', async () => {
    const composer = store.state.composer;
    const sendId = composer?.status.sendId;
    if (!composer || !sendId) return;
    const answer = await retryMailSend(sendId);
    const current = store.state.composer;
    if (!current) return;
    patch({
      composer: {
        ...current,
        mode: 'status',
        ...(answer.draft ? { draft: answer.draft } : {}),
        status: answer.draft
          ? {
            ...statusFollowing(current.status, answer.draft),
            ...(answer.letterId ? { letterId: answer.letterId } : {}),
          }
          : { ...current.status, phase: 'waiting' },
        notice: answer.completed === false
          ? 'The fresh letter is still being prepared.'
          : null,
      },
    });
    if (answer.draft) mergeDraft(answer.draft);
    // The 202 carries no draft, so the ledger row a further retry would name comes from a re-read.
    if (!answer.draft && current.draftId) void refreshComposerDraft(current.draftId, current.epoch);
  });
}

export function discardMailComposerDraft(): Promise<void> {
  return withBusy('discard', async () => {
    const composer = store.state.composer;
    if (!composer) return;
    // Retired BEFORE the delete: a save that is already in flight will answer with the row as it was
    // a moment ago, and nothing may bind that answer to the pane or put the row back in the list.
    retireComposerEpoch();
    if (composer.draftId) {
      forgetDraft(composer.accountId, composer.draftId);
      await deleteMailDraft(composer.draftId);
    }
    patch({ composer: null });
  });
}

function onSendFailed(what: string, error: unknown): void {
  const failure = mailFailure(error);
  log.warn('mail', 'draft send failed', { what, status: failure.status, code: failure.code });
  const composer = store.state.composer;
  if (!composer) return;
  // `stale` is the one failure with its own sentence: the human's text moved under the request, and
  // the fix is to look at it again rather than to press the same button harder.
  const stale = failure.code === 'stale';
  patch({
    composer: {
      ...composer,
      mode: stale ? 'edit' : composer.mode,
      notice: stale ? 'This draft changed, review it and send again.' : failure.message,
    },
  });
  if (composer.draftId) void refreshComposerDraft(composer.draftId, composer.epoch);
}
