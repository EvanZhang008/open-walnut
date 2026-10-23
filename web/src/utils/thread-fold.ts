/**
 * Conversation Mode folds a question's turns in the main timeline down to their
 * label line (2026-10-15, the user: "it should auto collapse in the main chat
 * if it is about a question"). A question stays open while it is the composer's
 * target, while its card is open, while its answer is on the way, while it was
 * asked after the main conversation's newest own message (the reader is in it:
 * an answer they wait for never folds away as it lands), and while one of its
 * follow-ups is any of those (a follow-up's passage is in its parent's answer). A question folds
 * with its follow-ups, as one line. A chevron on the label overrides the rule
 * until the main conversation moves on (its next user message clears every
 * override).
 */
import { pathToRoot, ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';

/** Questions the rule keeps open: the target, the card and every live one
 *  (`live`: answering now, or asked after the main conversation's newest own
 *  message), each with its ancestors. */
export function foldOpenKeys(
  tree: ThreadTree,
  a: { target: string; card?: string | null; live: Iterable<string> },
): Set<string> {
  const open = new Set<string>();
  for (const key of [a.target, a.card, ...a.live]) {
    if (!key || key === ROOT_THREAD_KEY) continue;
    open.add(key);
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
