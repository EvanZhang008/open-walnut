/**
 * The conversation-thread model: a navigation tree derived from ONE linear
 * transcript plus the session record's `threadAnchors`.
 *
 * Pure on purpose (no React, no DOM): the rail, the gutter decoration, the
 * composer chip and the later tree renderer all read the SAME structure, and the
 * rules below are the kind that only stay right if they are unit-testable.
 *
 * The model in four sentences:
 *
 *  - A TURN is a user row plus every following row until the next user row.
 *  - A THREAD is every turn sharing one key (`parent` + the anchored passage), in
 *    transcript order. Unanchored turns form the ROOT thread.
 *  - DEPTH of a thread = depth of the thread that CONTAINS its parent row, + 1.
 *    Root is 0, so a question about a top-level reply is 1.
 *  - HUE belongs to the top-level (depth-1) ancestor and is inherited downwards,
 *    so one visual colour = one branch of the conversation.
 *
 * A dangling anchor (its user row or its parent row is not in the loaded slice)
 * is IGNORED, never an error: the transcript is a tail window and a rewrite
 * (/compact) can drop either end at any time.
 */
import type { SessionPinnedQuote, SessionThreadAnchor } from '@/types/session';
import { pinLabelFor } from '@/utils/pin-label';

/** NUL — the one separator that cannot appear inside a msgId or a passage (same
 *  reasoning, and the same character, as pinKeyOf's key shape). */
const THREAD_KEY_SEP = '\u0000';

/** The unanchored thread. No anchor can produce this key (every real key holds a
 *  separator), so it is unambiguous. */
export const ROOT_THREAD_KEY = '';

/**
 * Six hues, one per top-level thread, cycling. Spaced so neighbours in the cycle
 * are told apart at 3px wide, and deliberately skipping the muddy yellows that
 * disappear on a white background. Blue comes LAST: it is the app's accent and the
 * user bubble's own colour, so a first thread painted blue read as part of the
 * bubble rather than as a thread mark (seen live 2026-09-04).
 */
export const THREAD_HUES = [280, 152, 28, 330, 188, 214] as const;

/** The identity of a thread: the reply it hangs off + the passage inside it. A
 *  sticky follow-up copies the previous anchor verbatim, which is exactly why an
 *  anchor's key (not its own msgId) is what groups turns. */
export function threadKeyOf(anchor: { parent: string; quote?: SessionPinnedQuote }): string {
  return `${anchor.parent}${THREAD_KEY_SEP}${anchor.quote?.exact ?? ''}`;
}

export interface ThreadNode {
  key: string;
  /** msgId of the reply this thread hangs off ('' for the root thread). */
  parent: string;
  /** The anchored passage, when the thread is about part of a reply. */
  quote?: SessionPinnedQuote;
  /** Key of the thread containing `parent`. undefined for root. */
  parentKey?: string;
  /** 0 = root, 1 = a question about a top-level reply, 2+ = nested. */
  depth: number;
  /** hsl hue in degrees, owned by the depth-1 ancestor. */
  hue: number;
  /** Index of the depth-1 ancestor among top-level threads (-1 for root). */
  topIndex: number;
  /** Row id of the thread's FIRST user message. */
  headId: string;
  /** Transcript index of that first turn — what the outline orders on. */
  at: number;
  /** First non-empty line of the first question. */
  label: string;
  /** First non-empty line of the anchored passage, when there is one. */
  quoteLabel?: string;
  /** User row ids opening each turn in this thread, in transcript order. */
  turnIds: string[];
  /** Child thread keys, in the order they appear in the transcript. */
  childKeys: string[];
}

/** What one transcript row needs to know about its thread. */
export interface ThreadRowInfo {
  key: string;
  depth: number;
  hue: number;
  /** This row is the head (first user message) of its thread. */
  isHead: boolean;
}

export interface ThreadTree {
  /** Root first, then depth-first in transcript order. */
  threads: ThreadNode[];
  byKey: Map<string, ThreadNode>;
  /** Row id (`msgId ?? userUuid ?? walnutMessageId`) → its thread. Every identified
   *  row is present; an unanchored row maps to root at depth 0. (The shared EMPTY
   *  tree has no entries at all: consumers treat a missing row the same way.) */
  byRow: Map<string, ThreadRowInfo>;
  rootKey: string;
  /** Thread of the NEWEST user row — "where the model currently is". */
  latestKey: string;
  /** How many top-level threads exist (what the next one's hue is keyed on). */
  topCount: number;
}

/** The rows this model reads. Structural so a test can pass literals and the
 *  caller can pass SessionHistoryMessage / OptimisticMessage untouched. */
export interface ThreadTreeMessage {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  msgId?: string;
  /**
   * The uuid this user line was PRE-ASSIGNED at send time (the harness's own
   * stream-json contract), carried by the optimistic row until the transcript
   * catches up. It is the id the anchor was recorded under, so a row holding it
   * is already a member of its thread — the `↳` tag and the gutter bar appear in
   * the same frame as the send instead of one history fetch later.
   */
  userUuid?: string;
  walnutMessageId?: string;
}

/** Row identity: the transcript uuid when the line has persisted, else the uuid
 *  we told the CLI to persist it under, else the id Walnut stamped on its own
 *  optimistic row. The first two are the SAME id at different ages, which is why
 *  a row keeps its thread membership across absorption. */
function rowIdOf(m: ThreadTreeMessage): string | undefined {
  return m.msgId ?? m.userUuid ?? m.walnutMessageId;
}

interface Turn {
  /** '' when the user row carries no id (it can never be anchored). */
  headId: string;
  start: number;
  text?: string;
  /** Ids of the rows after the head, up to the next user row. */
  memberIds: string[];
}

function makeRoot(): ThreadNode {
  return {
    key: ROOT_THREAD_KEY,
    parent: '',
    depth: 0,
    hue: THREAD_HUES[0],
    topIndex: -1,
    headId: '',
    at: 0,
    label: 'Top level',
    turnIds: [],
    childKeys: [],
  };
}

/**
 * Cheap path for the common case. A session with no anchors gets ONE shared,
 * empty tree: every consumer already treats a row missing from `byRow` as root at
 * depth 0, and a stable identity means the timeline's publish effect is a no-op,
 * so a threadless session pays nothing per history refetch (no per-row walk, no
 * extra panel render).
 */
export function buildThreadTree(
  messages: ThreadTreeMessage[],
  anchors: SessionThreadAnchor[] | undefined,
): ThreadTree {
  if (!anchors || anchors.length === 0) return emptyThreadTree();
  return computeThreadTree(messages, anchors);
}

function computeThreadTree(
  messages: ThreadTreeMessage[],
  anchors: SessionThreadAnchor[],
): ThreadTree {
  const root = makeRoot();
  const byKey = new Map<string, ThreadNode>([[ROOT_THREAD_KEY, root]]);
  const byRow = new Map<string, ThreadRowInfo>();

  // First occurrence wins, exactly like the outline's index map: a re-sent text
  // can repeat an id in a rewritten transcript, and the earlier row is the one
  // every other surface points at.
  const indexOf = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const id = rowIdOf(messages[i]);
    if (id && !indexOf.has(id)) indexOf.set(id, i);
  }

  // ── Turn segmentation ──
  const turns: Turn[] = [];
  // Rows before the first user row (session init, hook notices) belong to no
  // turn; they read as top level.
  const preTurnIds: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = rowIdOf(m);
    if (m.role === 'user') {
      turns.push({ headId: id ?? '', start: i, text: m.text, memberIds: [] });
      continue;
    }
    if (turns.length === 0) {
      if (id) preTurnIds.push(id);
      continue;
    }
    if (id) turns[turns.length - 1].memberIds.push(id);
  }

  // ── Anchors, one per user row (the newest write wins) ──
  const anchorFor = new Map<string, SessionThreadAnchor>();
  for (const a of anchors) {
    if (!a?.msgId || !a.parent) continue;
    anchorFor.set(a.msgId, a);
  }

  const keyOfRow = new Map<string, string>();
  const assign = (id: string, node: ThreadNode, isHead: boolean) => {
    keyOfRow.set(id, node.key);
    byRow.set(id, { key: node.key, depth: node.depth, hue: node.hue, isHead });
  };

  for (const id of preTurnIds) assign(id, root, false);

  let topCount = 0;
  let latestKey = ROOT_THREAD_KEY;

  for (const turn of turns) {
    let node = root;
    const anchor = turn.headId ? anchorFor.get(turn.headId) : undefined;
    const parentIndex = anchor ? indexOf.get(anchor.parent) : undefined;
    // The reply a question is about always PRECEDES the question. Requiring that
    // both bounds the work (no cycles are representable) and makes a nonsense
    // anchor behave like a dangling one instead of building a loop.
    if (anchor && parentIndex !== undefined && parentIndex < turn.start) {
      const key = threadKeyOf(anchor);
      const existing = byKey.get(key);
      if (existing) {
        node = existing;
      } else {
        const parentNode = byKey.get(keyOfRow.get(anchor.parent) ?? ROOT_THREAD_KEY) ?? root;
        const topIndex = parentNode.depth === 0 ? topCount++ : parentNode.topIndex;
        node = {
          key,
          parent: anchor.parent,
          ...(anchor.quote ? { quote: anchor.quote } : {}),
          parentKey: parentNode.key,
          depth: parentNode.depth + 1,
          hue: THREAD_HUES[((topIndex % THREAD_HUES.length) + THREAD_HUES.length) % THREAD_HUES.length],
          topIndex,
          headId: turn.headId,
          at: turn.start,
          label: pinLabelFor(turn.text, 'This thread'),
          ...(anchor.quote ? { quoteLabel: pinLabelFor(anchor.quote.exact, 'this passage') } : {}),
          turnIds: [],
          childKeys: [],
        };
        byKey.set(key, node);
        parentNode.childKeys.push(key);
      }
    }
    if (turn.headId) {
      node.turnIds.push(turn.headId);
      assign(turn.headId, node, node.headId === turn.headId);
    }
    for (const id of turn.memberIds) assign(id, node, false);
    latestKey = node.key;
  }

  // Depth-first from root. `childKeys` was filled in transcript order, so this is
  // the order the outline reads in.
  const threads: ThreadNode[] = [];
  const walk = (key: string) => {
    const node = byKey.get(key);
    if (!node) return;
    threads.push(node);
    for (const child of node.childKeys) walk(child);
  };
  walk(ROOT_THREAD_KEY);

  return { threads, byKey, byRow, rootKey: ROOT_THREAD_KEY, latestKey, topCount };
}

/**
 * The transcript plus the user lines this browser has SENT but the transcript has
 * not caught up with yet — what the tree must be built from.
 *
 * Without them a new thread only reaches the tree when history refetches, which is
 * turn END: the outline, the map and the child cards appeared a whole answer after
 * the question, while the bubble already wore its thread (that decoration reads the
 * anchor directly, not the tree). A pre-assigned uuid is the SAME id at a younger
 * age, so filing the optimistic row under it makes the structure appear in the frame
 * the question is asked.
 *
 * Returns `messages` itself when there is nothing to add, so a threadless session
 * and a quiet one both keep their memo identity.
 */
export function withPendingUserRows<T extends ThreadTreeMessage>(
  messages: T[],
  optimistic: readonly T[] | undefined,
): T[] {
  if (!optimistic || optimistic.length === 0) return messages;
  const pending = optimistic.filter((m) => m.role === 'user' && !!m.userUuid);
  if (pending.length === 0) return messages;
  // An absorbed row is already in `messages` under that same uuid; adding it twice
  // would open a second turn and double the thread's count.
  const known = new Set<string>();
  for (const m of messages) if (m.msgId) known.add(m.msgId);
  const extra = pending.filter((m) => !known.has(m.userUuid as string));
  return extra.length === 0 ? messages : [...messages, ...extra];
}

/** An empty tree — what a surface with no loaded transcript reads. */
let EMPTY_TREE: ThreadTree | null = null;

/** The shared empty tree (see buildThreadTree). Built once through the real
 *  builder so its shape can never drift from a populated tree's. Never mutate it. */
export function emptyThreadTree(): ThreadTree {
  if (!EMPTY_TREE) EMPTY_TREE = computeThreadTree([], []);
  return EMPTY_TREE;
}

/**
 * Root → … → this thread: what the node view's breadcrumb reads, and what its
 * "parent" key is (`path[path.length - 2]`).
 *
 * Empty for a key the tree does not know (a thread whose rows fell out of the
 * loaded window, or one whose first message has not persisted yet — both normal).
 * `seen` is belt-and-braces: `parentKey` always names a SHALLOWER thread, so a
 * cycle is not representable, but this walk must never be the thing that hangs a
 * render on a hand-edited record.
 */
export function pathToRoot(tree: ThreadTree, key: string): ThreadNode[] {
  const out: ThreadNode[] = [];
  const seen = new Set<string>();
  let node = tree.byKey.get(key);
  while (node && !seen.has(node.key)) {
    seen.add(node.key);
    out.push(node);
    node = node.parentKey === undefined ? undefined : tree.byKey.get(node.parentKey);
  }
  return out.reverse();
}

/**
 * The threads sharing this one's parent, in transcript order — the row ←/→
 * navigate along. Includes the thread itself (it is one of its parent's
 * children), so a caller finds its own position with `indexOf`.
 */
export function siblingsOf(tree: ThreadTree, key: string): ThreadNode[] {
  const node = tree.byKey.get(key);
  if (!node) return [];
  const parent = node.parentKey === undefined ? undefined : tree.byKey.get(node.parentKey);
  // Root has no parent and therefore no siblings — it is the only thread at its
  // level, which is exactly what "one linear transcript" means.
  if (!parent) return [node];
  return parent.childKeys
    .map((childKey) => tree.byKey.get(childKey))
    .filter((child): child is ThreadNode => child !== undefined);
}

/** The composer's sticky anchor: what the NEXT send will hang off. */
export interface ComposerThreadAnchor {
  parent: string;
  quote?: SessionPinnedQuote;
  source: SessionThreadAnchor['source'];
  /** What the chip and the back-reference line call this thread. */
  label: string;
}

/**
 * Colour for an anchor that may not have a thread yet: an existing thread owns
 * its hue, and a brand-new one previews the hue it is about to get, so the chip
 * does not change colour the moment the message lands.
 */
export function hueForAnchor(tree: ThreadTree, anchor: ComposerThreadAnchor): number {
  const existing = tree.byKey.get(threadKeyOf(anchor));
  if (existing) return existing.hue;
  const parentRow = tree.byRow.get(anchor.parent);
  // A question about a reply that is ALREADY inside a thread inherits its branch
  // colour; one about a top-level reply opens the next branch.
  if (parentRow && parentRow.depth >= 1) return parentRow.hue;
  return THREAD_HUES[tree.topCount % THREAD_HUES.length];
}

/** A passage as markdown blockquote lines. Blank lines keep the quote ONE block
 *  ('>' alone), or the paragraph after them would leave the quote. */
export function quoteBlockOf(quote: SessionPinnedQuote): string {
  return quote.exact
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * The text actually sent for an anchored message.
 *
 * Everything it adds is VISIBLE in the bubble — the model and the human read the
 * same message, which is the whole reason this is composed at send time instead
 * of hidden in a side channel:
 *
 *  - a fresh selection quotes the passage, so the reply is about that passage;
 *  - returning to a thread that is NOT where the model currently is leads with
 *    one plain line naming it (plus the passage, if the thread has one), because
 *    a linear model has no other way to know the subject changed;
 *  - a follow-up inside the newest thread adds nothing at all.
 */
export function composeAnchoredText(
  text: string,
  anchor: ComposerThreadAnchor,
  latestKey: string,
): string {
  const parts: string[] = [];
  if (anchor.source === 'selection') {
    if (anchor.quote) parts.push(quoteBlockOf(anchor.quote));
  } else if (threadKeyOf(anchor) !== latestKey) {
    parts.push(`(Back to the earlier thread about “${anchor.label}”)`);
    if (anchor.quote) parts.push(quoteBlockOf(anchor.quote));
  }
  parts.push(text);
  return parts.join('\n\n');
}

/** A v4 uuid for the next user row, pre-assigned so an anchor can name the
 *  transcript line before it exists. `crypto.randomUUID` needs a secure context;
 *  where it is missing we send WITHOUT a uuid and record no anchor rather than
 *  invent an id the CLI would not use (see the send path). */
export function newUserUuid(): string | undefined {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return undefined;
}
