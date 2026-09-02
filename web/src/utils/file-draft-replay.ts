/**
 * What a read does with the unsaved draft it found, and what the editor's
 * optimistic lock must hold afterwards.
 *
 * Pure policy, no storage: it lives apart from utils/file-drafts.ts (which owns
 * the IndexedDB records) because that file was over the ~500-line guideline, and
 * because these two rules are the part a reader has to get exactly right. Both
 * are still exported from '@/utils/file-drafts' — one import site for callers.
 *
 * The two answers are ONE rule: the lock token is always the hash the SEEDED TEXT
 * was written against, so they are decided together here rather than separately
 * in the view.
 */
import type { FileDraft } from './file-drafts';

export interface DraftReplayPlan {
  /** Text to seed the editor with; null = seed from the bytes on disk. */
  seed: string | null;
  /** Draft written against OLDER bytes: held back for the banner, not replayed. */
  stale: { text: string; baseHash: string } | null;
  /** Record is obsolete (typed back to what is on disk) — delete it. */
  drop: boolean;
  /** expectedHash the next save must send. */
  lockHash: string | undefined;
}

export function planDraftReplay(
  draft: FileDraft | null,
  disk: { content: string | null; contentHash: string | undefined },
): DraftReplayPlan {
  const base: DraftReplayPlan = { seed: null, stale: null, drop: false, lockHash: disk.contentHash };
  if (!draft) return base;
  if (draft.text === disk.content) return { ...base, drop: true };
  if (draft.baseHash === disk.contentHash) return { ...base, seed: draft.text };
  return { ...base, stale: { text: draft.text, baseHash: draft.baseHash } };
}

/** Stand-in token for a draft whose baseHash was never recorded: an EMPTY
 *  expectedHash reads as "no lock" to both the client and the server, so passing
 *  one through would restore the silent overwrite below. Any non-empty value that
 *  cannot match the file gives the 409 instead. */
const UNRECORDED_BASE_HASH = 'draft-base-unrecorded';

/**
 * "Restore my changes" on the stale-draft banner.
 *
 * The lock stays armed at the DRAFT's OWN baseHash — the bytes that text was
 * typed against — so the next Save hits the 409 path and the user gets the
 * existing "this file changed on disk, press Save again to overwrite it" warning.
 * Re-arming at the CURRENT disk hash (which is what leaving the lock alone did)
 * made that ⌘S a SILENT overwrite of the newer file: type, let the session's
 * agent rewrite the file, Refresh, "Restore my changes", ⌘S — and the agent's
 * work was gone with no conflict and no warning.
 */
export function planStaleDraftRestore(
  stale: { text: string; baseHash: string },
): { seed: string; lockHash: string } {
  return { seed: stale.text, lockHash: stale.baseHash || UNRECORDED_BASE_HASH };
}
