/**
 * Conversation Mode folds a question's turns in the main timeline down to their
 * label line (2026-10-15, the user: "it should auto collapse in the main chat
 * if it is about a question"). Since 2026-10-23 a question folds even while it
 * is being answered, is the composer's target or has its card open (the user:
 * "the response thread should be automatically collapsed"): the card is where
 * its turns are read. What stays open is the question that HOLDS the passage of
 * one of those (a follow-up's passage is in its parent's answer, and its card
 * and its live marks sit on that passage). A question folds with its follow-ups,
 * as one line. A chevron on the label overrides the rule until the main
 * conversation moves on (its next user message clears every override).
 */
import { pathToRoot, ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';

/** Questions the rule keeps open: the ones holding the passage of the target,
 *  the card or a live question (`live`: answering now, or asked after the main
 *  conversation's newest own message), that is their ancestors, never the
 *  question itself. A question not in the tree yet (a pending or draft page)
 *  names the question its passage is in through `holders`: that one stays open
 *  too, with its ancestors, so an Ask on a question's answer keeps the passage
 *  on screen. */
export function foldOpenKeys(
  tree: ThreadTree,
  a: { target: string; card?: string | null; live: Iterable<string>; holders?: Iterable<string> },
): Set<string> {
  const open = new Set<string>();
  for (const key of [a.target, a.card, ...a.live]) {
    if (!key || key === ROOT_THREAD_KEY) continue;
    for (const node of pathToRoot(tree, key)) if (node.key !== key) open.add(node.key);
  }
  for (const key of a.holders ?? []) {
    if (!key || key === ROOT_THREAD_KEY) continue;
    for (const node of pathToRoot(tree, key)) open.add(node.key);
  }
  open.delete(ROOT_THREAD_KEY);
  return open;
}

/** The top-level question a key belongs to: one line folds a question with all
 *  its follow-ups. A key the tree does not know yet is its own. */
export function foldGroupOf(tree: ThreadTree, key: string): string {
  if (key === ROOT_THREAD_KEY) return key;
  const top = pathToRoot(tree, key).find((n) => n.depth >= 1);
  return top?.key ?? key;
}

/** Folded = a question the rule does not keep open, unless the user said otherwise. */
export function isFolded(key: string, open: ReadonlySet<string>, overrides: ReadonlyMap<string, boolean>): boolean {
  if (key === ROOT_THREAD_KEY) return false;
  const manual = overrides.get(key);
  if (manual !== undefined) return !manual;
  return !open.has(key);
}

/**
 * The timeline as rendered: a folded question's consecutive parts become ONE
 * label line (`fold`), whatever kind its first part is (a turn whose user row
 * lies outside the loaded window still gets its line); every other part as is.
 */
export type FoldedItem<P> = { kind: 'part'; part: P; index: number } | { kind: 'fold'; key: string; part: P; index: number; hidden: number };

export function foldParts<P>(
  parts: readonly P[],
  keyOf: (part: P) => string,
  folded: (key: string) => boolean,
): FoldedItem<P>[] {
  const out: FoldedItem<P>[] = [];
  let run: Extract<FoldedItem<P>, { kind: 'fold' }> | null = null;
  parts.forEach((part, index) => {
    const key = keyOf(part);
    if (key !== ROOT_THREAD_KEY && folded(key)) {
      if (run && run.key === key) { run.hidden += 1; return; }
      run = { kind: 'fold', key, part, index, hidden: 1 };
      out.push(run);
      return;
    }
    run = null;
    out.push({ kind: 'part', part, index });
  });
  return out;
}
