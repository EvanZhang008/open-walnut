/**
 * Where the chat's composer writes in Conversation Mode (2026-10-27, the user:
 * "not quote automatically ... unless user explicit"). Opening, expanding or
 * selecting a question's card never moves it: the composer stays on the main
 * conversation until the reader quotes a question into it (the card's "Quote in
 * chat", the mark's right-click row, a review card) and lets go with the chip's
 * ×. The card's own box always writes to its question.
 */
import type { ThreadPendingPage } from '@/components/sessions/thread-ui-contract';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';

/** A pending page (an Ask not sent yet) by key: the one on the path, or a draft. */
export function pendingPageOf(
  key: string,
  onPath: ThreadPendingPage | undefined,
  drafts: readonly ThreadPendingPage[],
): ThreadPendingPage | undefined {
  if (onPath?.pageKey === key) return onPath;
  return drafts.find((d) => d.pageKey === key);
}

/** The composer's key: the quoted question while it still exists, else the
 *  main conversation. */
export function composerKeyOf(
  quoted: string | null,
  tree: ThreadTree,
  onPath: ThreadPendingPage | undefined,
  drafts: readonly ThreadPendingPage[],
): string {
  if (!quoted || quoted === ROOT_THREAD_KEY) return ROOT_THREAD_KEY;
  if (tree.byKey.has(quoted) || pendingPageOf(quoted, onPath, drafts)) return quoted;
  return ROOT_THREAD_KEY;
}

/** Letting go of a quoted question: the words typed for it join the main
 *  conversation's draft (after what was already there). */
export function carriedRootDraft(rootDraft: string, typed: string): string {
  if (!typed.trim()) return rootDraft;
  return rootDraft.trim() ? `${rootDraft.trimEnd()}\n\n${typed}` : typed;
}
