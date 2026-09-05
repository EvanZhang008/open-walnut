/**
 * The Drafts list: one read for every account, and the in-place merges that keep it honest.
 *
 * Split out of `compose-actions.ts` because it is the only part of the write path with no opinion
 * about what is on screen: it owns the `drafts` map and nothing else, so the composer's lifecycle
 * and the send buttons can both lean on it without importing each other.
 */
import { listMailDrafts, mailFailure, type MailDraftDto } from '@/api/mail';
import { log } from '@/utils/log';
import { patch, run, store, onMailStoreReset } from '../mail-store';

/** The plugin caps a draft list at 200, which is far more than a human has. */
const DRAFT_PAGE = 200;

/**
 * Drafts this client has deleted, so a request that was already in flight cannot put one back.
 *
 * A PATCH and a DELETE can overlap (the PATCH left before the human pressed Discard), and the
 * PATCH's answer describes the row as it was BEFORE the delete. Merging that would re-add a draft
 * the human threw away, and it would stay until the next full read. Cleared by that read, which is
 * the moment the server's own list becomes the authority again.
 */
const forgotten = new Set<string>();

onMailStoreReset(() => forgotten.clear());

/**
 * Every account's drafts in ONE request.
 *
 * Per-account would be one request per account on every open and after every draft event, for a
 * list a human keeps in single digits. The route answers with `discarded` and `sent` rows too
 * (it has no default filter), so the grouping drops them: a sent draft is not a draft.
 */
export function loadMailDrafts(force = false): Promise<void> {
  return run('drafts', async () => {
    patch({ draftsLoading: true });
    try {
      const answer = await listMailDrafts({ limit: DRAFT_PAGE });
      forgotten.clear();
      patch({ drafts: groupDrafts(answer.drafts ?? []), draftsLoading: false });
    } catch (error) {
      patch({ draftsLoading: false });
      log.warn('mail', 'draft list failed', { error: mailFailure(error).message });
    }
  }, force);
}

function groupDrafts(drafts: MailDraftDto[]): Record<string, MailDraftDto[]> {
  const grouped: Record<string, MailDraftDto[]> = {};
  for (const draft of drafts) {
    if (draft.state === 'discarded' || draft.state === 'sent') continue;
    (grouped[draft.accountId] ??= []).push(draft);
  }
  for (const list of Object.values(grouped)) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return grouped;
}

/** One draft record, replaced in place, so the list follows a save without a refetch. */
export function mergeDraft(draft: MailDraftDto): void {
  if (forgotten.has(draft.draftId)) return;
  const drafts = { ...store.state.drafts };
  const list = (drafts[draft.accountId] ?? []).filter((one) => one.draftId !== draft.draftId);
  if (draft.state !== 'discarded' && draft.state !== 'sent') list.push(draft);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  drafts[draft.accountId] = list;
  patch({ drafts });
}

export function forgetDraft(accountId: string, draftId: string): void {
  forgotten.add(draftId);
  const drafts = { ...store.state.drafts };
  drafts[accountId] = (drafts[accountId] ?? []).filter((one) => one.draftId !== draftId);
  patch({ drafts });
}
