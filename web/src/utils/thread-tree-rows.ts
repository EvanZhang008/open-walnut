/**
 * The tree drawer's rows (spec 6.4, 6.6): one pure flatten over the thread tree,
 * the metadata index and the pins, plus the keyboard movement helpers (6.7).
 *
 * Pure (no React, no DOM): the rules are unit tested and one search keystroke
 * is one linear pass (500 questions + pins well under a frame). Rules:
 *  - a filter or search shows the matches plus their ancestors (faded), all
 *    expanded, disclosure disabled;
 *  - `Open` lists open / suggested questions (queued, answering, failed count
 *    as open); `Pinned` lists pins with their question chain;
 *  - `All` without a search folds each parent's resolved children into one
 *    `<n> done` row (the group holding the current page opens by itself);
 *  - a question resolved in the drawer stays in place, faded (`sticky`),
 *    until the filter or search changes or the drawer closes.
 */
import type { SessionPinnedMessage } from '@/types/session';
import type { ThreadDraftRow, ThreadDrawerFilter, ThreadPendingPage } from '@/components/sessions/thread-ui-contract';
import { pathToRoot, ROOT_THREAD_KEY, type ThreadNode, type ThreadTree } from '@/utils/thread-tree';
import {
  displayTitleOf, hiddenKeysOf, isOpenish, metaOf, normalizeForSearch, openChipCount, statusOf, viewStatusOf,
  type ThreadCounts, type ThreadLiveState, type ThreadMetaIndex, type ThreadViewStatus,
} from '@/utils/thread-meta';
import { pinThreadKey } from '@/utils/thread-meta-counts';
import { pinKeyOf } from '@/hooks/useSessionPins';
import { hitSnippet, matchRanges, windowOnMatch, type MatchRange } from '@/utils/thread-search-window';

export { hitSnippet, matchRanges, segmentsOf } from '@/utils/thread-search-window';

export type TreeRowKind =
  | 'root' | 'thread' | 'pin' | 'done-group' | 'pending' | 'draft' | 'removed' | 'hidden-header' | 'hidden';

export type { MatchRange } from '@/utils/thread-search-window';

export interface TreeRow {
  /** Unique and stable: `root`, `t:<key>`, `p:<pinKey>`, `g:<parentKey>`, ... (a key may hold a NUL). */
  id: string;
  kind: TreeRowKind;
  /** Thread key: the question itself, a pin's question, a group's parent. */
  key: string;
  /** Indent depth (root 0); aria-level is depth + 1. */
  depth: number;
  parentRowId?: string;
  hue: number;
  status?: ThreadViewStatus;
  title: string;
  naming?: boolean;
  secondary?: string;
  /** Full text for the tooltip (pins). */
  tooltip?: string;
  /** Searching: the title as shown, a window on the match when the match sits
   *  past the ellipsis (N23). `title` stays whole (rename starts from it). */
  titleShown?: string;
  titleMatches?: MatchRange[];
  secondaryMatches?: MatchRange[];
  /** Has visible children (questions or pins): draws the disclosure. */
  hasChildren: boolean;
  expanded: boolean;
  disclosureDisabled: boolean;
  /** Passes the filter and the search (the first one gets Enter). `ancestorOnly`: shown as context, faded. */
  matched: boolean;
  ancestorOnly: boolean;
  current: boolean;
  /** Visible open descendants (the pill). */
  openBelow: number;
  /** Resolved from the drawer, kept in place faded until the view changes. */
  settled?: boolean;
  /** The second line is a search snippet: the hit is in a field the row never
   *  shows (quote, question, takeaway), so the row explains it (N23). */
  hitSnippet?: boolean;
  pinKey?: string;
  /** done-group: how many resolved children. removed: what the placeholder stands for. */
  groupCount?: number;
  removedOf?: 'thread' | 'pin';
}

/** A removed pin's placeholder; `at` is the index it had among its question's pins. */
export interface RemovedPinPlaceholder { pinKey: string; threadKey: string; at?: number }

export interface FlattenOptions {
  filter: ThreadDrawerFilter;
  query: string;
  /** Keys the user collapsed / parents whose `<n> done` group the user opened. */
  collapsed: ReadonlySet<string>;
  doneGroupsOpen: ReadonlySet<string>;
  showHidden: boolean;
  pending?: ThreadPendingPage;
  drafts?: readonly ThreadDraftRow[];
  currentKey: string;
  /** Resolved in the drawer since it opened: kept in place (settled). */
  sticky?: ReadonlySet<string>;
  /** Removed in the drawer: a `Removed · Undo` placeholder in place. */
  removedThreads?: ReadonlySet<string>;
  removedPins?: readonly RemovedPinPlaceholder[];
}

/** `filtering`: a filter or search is active (all expanded, disclosure off).
 *  `noResults`: a search matched nothing. */
export interface FlattenResult { rows: TreeRow[]; filtering: boolean; matchCount: number; noResults: boolean }

export const PIN_TEXT_MAX = 80;
export const MAIN_CONVERSATION = 'Main conversation';
export const NEW_QUESTION = 'New question';
export const NEW_QUESTION_DRAFT = 'New question (draft)';
export const HIDDEN_GROUP = 'Hidden';

export const noResultsText = (q: string): string => `No questions match “${q}”.`;
export const doneGroupText = (n: number): string => `${n} done`;
export const openBelowTitle = (n: number): string => `${n} open below`;

/** The first filter the drawer opens on: `Open` when anything is open or
 *  looks answered, else `All` (spec 6.6). */
export function defaultDrawerFilter(c: ThreadCounts): ThreadDrawerFilter {
  return openChipCount(c) > 0 ? 'open' : 'all';
}

/** A pin's own text: the passage for a quote pin, else its label. */
export function pinTextOf(pin: SessionPinnedMessage): string {
  return (pin.quote?.exact ?? pin.label ?? '').replace(/\s+/g, ' ').trim();
}

export function clipPinText(text: string): string {
  return text.length > PIN_TEXT_MAX ? `${text.slice(0, PIN_TEXT_MAX)}…` : text;
}

/** The question as typed (first line), when known. */
function questionLine(node: ThreadNode, index: ThreadMetaIndex): string {
  const q = metaOf(node, index)?.question ?? (node.quote ? '' : node.label);
  return (q ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** Second line per status (spec 6.4). */
export function secondaryOf(node: ThreadNode, index: ThreadMetaIndex, status: ThreadViewStatus): string {
  switch (status) {
    case 'resolved': return metaOf(node, index)?.takeaway?.trim() || questionLine(node, index);
    case 'queued': return 'Waiting…';
    case 'failed': return 'No answer · Retry';
    case 'answering': return 'Answering…';
    case 'suggested': return 'Looks answered';
    default: return questionLine(node, index);
  }
}

/** The field a search hit lives in when the row's title and line both miss it. */
function hiddenFieldHit(node: ThreadNode, index: ThreadMetaIndex, q: string): string | undefined {
  const m = metaOf(node, index);
  for (const field of [node.quote?.exact, m?.question ?? node.label, m?.takeaway]) {
    if (field) { const snip = hitSnippet(field, q); if (snip) return snip; }
  }
  return undefined;
}

/** Everything a search can hit for one question, normalized once. */
function haystackOf(node: ThreadNode, index: ThreadMetaIndex, title: string): string {
  const m = metaOf(node, index);
  return normalizeForSearch([title, m?.question ?? node.label, node.quote?.exact, m?.takeaway].filter(Boolean).join('\n'));
}

interface Ctx {
  tree: ThreadTree;
  index: ThreadMetaIndex;
  live?: ReadonlyMap<string, ThreadLiveState>;
  opts: FlattenOptions;
  q: string;
  hidden: Set<string>;
  pinsByThread: Map<string, SessionPinnedMessage[]>;
  openBelow: Map<string, number>;
  /** Filtering: the keys (threads) and pin keys that stay, ancestors included. */
  keep?: Set<string>;
  keepPins?: Set<string>;
  passThreads?: Set<string>;
  rows: TreeRow[];
  matchCount: number;
}

/** Visible open descendants per key, one post-order pass (same rule as openBelow()). */
function openBelowAll(tree: ThreadTree, index: ThreadMetaIndex, hidden: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (key: string): number => {
    const node = tree.byKey.get(key);
    if (!node) return 0;
    let n = 0;
    for (const c of node.childKeys) {
      if (hidden.has(c)) continue;
      n += walk(c) + (isOpenish(statusOf(tree.byKey.get(c), index)) ? 1 : 0);
    }
    out.set(key, n);
    return n;
  };
  walk(tree.rootKey ?? ROOT_THREAD_KEY);
  return out;
}

function threadPasses(c: Ctx, node: ThreadNode, title: string): boolean {
  const { filter } = c.opts;
  if (filter === 'pinned') return false;
  if (filter === 'open' && !isOpenish(statusOf(node, c.index)) && !c.opts.sticky?.has(node.key)) return false;
  return !c.q || haystackOf(node, c.index, title).includes(c.q);
}

function pinPasses(c: Ctx, pin: SessionPinnedMessage): boolean {
  if (c.opts.filter === 'open') return false;
  return !c.q || normalizeForSearch(pinTextOf(pin)).includes(c.q);
}

/** Filtering: which threads and pins stay (matches plus their ancestor chain). */
function computeKeep(c: Ctx): void {
  const keep = new Set<string>([c.tree.rootKey ?? ROOT_THREAD_KEY]);
  const keepPins = new Set<string>();
  const pass = new Set<string>();
  const addChain = (key: string) => {
    let k: string | undefined = key;
    while (k !== undefined && !keep.has(k)) {
      keep.add(k);
      k = c.tree.byKey.get(k)?.parentKey;
    }
  };
  for (const node of c.tree.threads) {
    if (node.key === ROOT_THREAD_KEY || c.hidden.has(node.key)) continue;
    if (threadPasses(c, node, displayTitleOf(node, c.index).title)) {
      pass.add(node.key);
      addChain(node.key);
      c.matchCount += 1;
    }
  }
  for (const [threadKey, list] of c.pinsByThread) {
    for (const pin of list) {
      if (!pinPasses(c, pin)) continue;
      keepPins.add(pinKeyOf(pin));
      addChain(threadKey);
      c.matchCount += 1;
    }
  }
  c.keep = keep;
  c.keepPins = keepPins;
  c.passThreads = pass;
}

function visibleChildCount(c: Ctx, node: ThreadNode): number {
  let n = c.pinsByThread.get(node.key)?.length ?? 0;
  for (const k of node.childKeys) if (!c.hidden.has(k)) n += 1;
  return n;
}

function isOnCurrentPath(c: Ctx, key: string): boolean {
  const pending = c.opts.pending;
  const k = pending && c.opts.currentKey === pending.pageKey ? pending.parentKey : c.opts.currentKey;
  return pathToRoot(c.tree, k).some((n) => n.key === key);
}

function pushThreadRow(c: Ctx, node: ThreadNode, depth: number, parentRowId: string): TreeRow {
  const filtering = c.keep !== undefined;
  const status = viewStatusOf(node, c.index, c.live);
  const { title, naming } = displayTitleOf(node, c.index);
  const pass = !filtering || c.passThreads!.has(node.key);
  let secondary = secondaryOf(node, c.index, status);
  let snippet = false;
  if (c.q && pass && !normalizeForSearch(title).includes(c.q) && !normalizeForSearch(secondary).includes(c.q)) {
    const hit = hiddenFieldHit(node, c.index, c.q);
    if (hit) { secondary = hit; snippet = true; }
  }
  if (c.q && pass) secondary = windowOnMatch(secondary, c.q, 64);
  const titleShown = c.q && pass ? windowOnMatch(title, c.q, 44) : title;
  const row: TreeRow = {
    id: `t:${node.key}`, kind: 'thread', key: node.key, depth, parentRowId, hue: node.hue, status, title, naming, secondary,
    ...(titleShown !== title ? { titleShown } : {}),
    titleMatches: c.q ? matchRanges(titleShown, c.q) : undefined,
    secondaryMatches: c.q ? matchRanges(secondary, c.q) : undefined,
    ...(snippet ? { hitSnippet: true } : {}),
    hasChildren: visibleChildCount(c, node) > 0,
    expanded: filtering || !c.opts.collapsed.has(node.key),
    disclosureDisabled: filtering, matched: pass, ancestorOnly: filtering && !pass,
    current: node.key === c.opts.currentKey, openBelow: c.openBelow.get(node.key) ?? 0,
    settled: (c.opts.sticky?.has(node.key) && status === 'resolved') || undefined,
  };
  c.rows.push(row);
  return row;
}

function pushPinRow(c: Ctx, pin: SessionPinnedMessage, threadKey: string, depth: number, parentRowId: string, hue: number): void {
  const full = pinTextOf(pin);
  const title = clipPinText(full);
  const pass = c.keepPins === undefined || c.keepPins.has(pinKeyOf(pin));
  c.rows.push({
    id: `p:${pinKeyOf(pin)}`, kind: 'pin', key: threadKey, depth, parentRowId, hue, title, tooltip: full,
    titleMatches: c.q ? matchRanges(title, c.q) : undefined,
    hasChildren: false, expanded: false, disclosureDisabled: true, matched: pass, ancestorOnly: false,
    current: false, openBelow: 0, pinKey: pinKeyOf(pin),
  });
}

function pushPlaceholder(c: Ctx, id: string, key: string, depth: number, parentRowId: string, hue: number, of: 'thread' | 'pin', pinKey?: string): void {
  c.rows.push({
    id: `removed:${id}`, kind: 'removed', key, depth, parentRowId, hue, title: 'Removed', pinKey,
    hasChildren: false, expanded: false, disclosureDisabled: true, matched: false, ancestorOnly: false,
    current: false, openBelow: 0, removedOf: of,
  });
}

function pushLooseRow(c: Ctx, kind: 'pending' | 'draft', pageKey: string, parent: ThreadNode, depth: number, parentRowId: string): void {
  c.rows.push({
    id: `${kind}:${pageKey}`, kind, key: pageKey, depth, parentRowId, hue: parent.hue,
    status: kind, title: kind === 'pending' ? NEW_QUESTION : NEW_QUESTION_DRAFT,
    hasChildren: false, expanded: false, disclosureDisabled: true, matched: true, ancestorOnly: false,
    current: pageKey === c.opts.currentKey, openBelow: 0,
  });
}

/** Emit `node`'s children (pins, child questions, done group, pending/draft). */
function walkChildren(c: Ctx, node: ThreadNode, depth: number, parentRowId: string): void {
  const filtering = c.keep !== undefined;
  // Pin placeholders go back into the slot the pin left (`at`), so nothing below moves.
  const holes = (c.opts.removedPins ?? []).filter((r) => r.threadKey === node.key)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const hole = (r: RemovedPinPlaceholder) => pushPlaceholder(c, `p:${r.pinKey}`, node.key, depth, parentRowId, node.hue, 'pin', r.pinKey);
  let slot = 0;
  for (const pin of c.pinsByThread.get(node.key) ?? []) {
    while (holes.length && (holes[0].at ?? Infinity) <= slot) { hole(holes.shift()!); slot += 1; }
    if (!filtering || c.keepPins!.has(pinKeyOf(pin))) pushPinRow(c, pin, node.key, depth, parentRowId, node.hue);
    slot += 1;
  }
  for (const r of holes) hole(r);
  const done: ThreadNode[] = [];
  // A pending / draft page sits in transcript order under its parent answer
  // (N44, the way Asked-from lists it): right after the last question asked
  // from the same answer, else at the end.
  const loose = looseRowsOf(c, node);
  const afterOf = new Map<string, typeof loose>();
  const tail: typeof loose = [];
  for (const l of loose) {
    let after: string | undefined;
    for (const k of node.childKeys) if (c.tree.byKey.get(k)?.parent === l.parentMsgId) after = k;
    if (after) afterOf.set(after, [...(afterOf.get(after) ?? []), l]); else tail.push(l);
  }
  const flushAfter = (k: string) => {
    for (const l of afterOf.get(k) ?? []) pushLooseRow(c, l.kind, l.pageKey, node, depth, parentRowId);
  };
  for (const k of node.childKeys) {
    walkChild(k);
    flushAfter(k);
  }
  function walkChild(k: string): void {
    const child = c.tree.byKey.get(k);
    if (!child) return;
    if (c.hidden.has(k)) {
      if (c.opts.removedThreads?.has(k)) pushPlaceholder(c, `t:${k}`, k, depth, parentRowId, child.hue, 'thread');
      return;
    }
    if (filtering) {
      if (c.keep!.has(k)) walkThread(c, child, depth, parentRowId);
      return;
    }
    if (statusOf(child, c.index) === 'resolved' && !c.opts.sticky?.has(k)) done.push(child);
    else walkThread(c, child, depth, parentRowId);
  }
  if (done.length > 0) {
    const open = c.opts.doneGroupsOpen.has(node.key) || done.some((d) => isOnCurrentPath(c, d.key));
    const groupId = `g:${node.key}`;
    c.rows.push({
      id: groupId, kind: 'done-group', key: node.key, depth, parentRowId, hue: node.hue,
      title: doneGroupText(done.length), hasChildren: true, expanded: open, disclosureDisabled: false,
      matched: true, ancestorOnly: false, current: false, openBelow: 0, groupCount: done.length,
    });
    if (open) for (const d of done) walkThread(c, d, depth, parentRowId);
  }
  for (const l of tail) pushLooseRow(c, l.kind, l.pageKey, node, depth, parentRowId);
}

/** The pending page and the draft rows asked from `node`, with the answer each
 *  hangs off (a draft's key is `pending:<parentMsgId>:<hash>`). */
function looseRowsOf(c: Ctx, node: ThreadNode): Array<{ kind: 'pending' | 'draft'; pageKey: string; parentMsgId: string }> {
  if (c.q || c.opts.filter === 'pinned') return [];
  const out: Array<{ kind: 'pending' | 'draft'; pageKey: string; parentMsgId: string }> = [];
  const p = c.opts.pending;
  if (p && p.parentKey === node.key) out.push({ kind: 'pending', pageKey: p.pageKey, parentMsgId: p.parentMsgId });
  for (const d of c.opts.drafts ?? []) {
    if (d.parentKey !== node.key || d.pageKey === p?.pageKey) continue;
    out.push({ kind: 'draft', pageKey: d.pageKey, parentMsgId: d.pageKey.split(':')[1] ?? '' });
  }
  return out;
}

function walkThread(c: Ctx, node: ThreadNode, depth: number, parentRowId: string): void {
  const row = pushThreadRow(c, node, depth, parentRowId);
  if (row.expanded) walkChildren(c, node, depth + 1, row.id);
}

function pushHiddenGroup(c: Ctx): void {
  const heads = c.tree.threads.filter((n) => {
    if (n.key === ROOT_THREAD_KEY || metaOf(n, c.index)?.hidden !== true) return false;
    return n.parentKey === undefined || !c.hidden.has(n.parentKey);
  });
  const shown = c.q
    ? heads.filter((n) => haystackOf(n, c.index, displayTitleOf(n, c.index).title).includes(c.q))
    : heads;
  if (shown.length === 0) return;
  c.rows.push({
    id: 'hidden-header', kind: 'hidden-header', key: '', depth: 0, hue: 0, title: HIDDEN_GROUP,
    hasChildren: false, expanded: false, disclosureDisabled: true, matched: false, ancestorOnly: false,
    current: false, openBelow: 0,
  });
  for (const n of shown) {
    const { title } = displayTitleOf(n, c.index);
    // Where it lived (N36): the parent, so he restores the right one.
    const parent = n.parentKey !== undefined ? c.tree.byKey.get(n.parentKey) : undefined;
    const where = `In ${parent ? displayTitleOf(parent, c.index).title : 'Main conversation'}`;
    const asked = questionLine(n, c.index);
    c.rows.push({
      id: `h:${n.key}`, kind: 'hidden', key: n.key, depth: 1, parentRowId: 'hidden-header', hue: n.hue,
      status: statusOf(n, c.index), title, secondary: asked ? `${where} · ${asked}` : where,
      titleMatches: c.q ? matchRanges(title, c.q) : undefined,
      hasChildren: false, expanded: false, disclosureDisabled: true, matched: true, ancestorOnly: false,
      current: false, openBelow: 0,
    });
  }
}

/**
 * The drawer's rows. `pins` are the session's pins; a pin whose question is
 * hidden is left out (it is not counted either, spec 7.3).
 */
export function flattenTree(
  tree: ThreadTree,
  index: ThreadMetaIndex,
  pins: readonly SessionPinnedMessage[],
  live: ReadonlyMap<string, ThreadLiveState> | undefined,
  opts: FlattenOptions,
): FlattenResult {
  const hidden = hiddenKeysOf(tree, index);
  const pinsByThread = new Map<string, SessionPinnedMessage[]>();
  for (const pin of pins) {
    const k = pinThreadKey(tree, pin);
    if (hidden.has(k)) continue;
    const list = pinsByThread.get(k);
    if (list) list.push(pin);
    else pinsByThread.set(k, [pin]);
  }
  const q = normalizeForSearch(opts.query.trim());
  const c: Ctx = {
    tree, index, live, opts, q, hidden, pinsByThread, rows: [], matchCount: 0,
    openBelow: openBelowAll(tree, index, hidden),
  };
  const filtering = q !== '' || opts.filter !== 'all';
  if (filtering) computeKeep(c);
  const rootKey = tree.rootKey ?? ROOT_THREAD_KEY;
  const root = tree.byKey.get(rootKey);
  if (root) {
    const expanded = filtering || !opts.collapsed.has(rootKey);
    c.rows.push({
      id: 'root', kind: 'root', key: rootKey, depth: 0, hue: root.hue, title: MAIN_CONVERSATION,
      hasChildren: visibleChildCount(c, root) > 0 || !!opts.pending || (opts.drafts?.length ?? 0) > 0,
      expanded, disclosureDisabled: filtering, matched: !filtering, ancestorOnly: false,
      current: opts.currentKey === rootKey, openBelow: c.openBelow.get(rootKey) ?? 0,
    });
    if (expanded) walkChildren(c, root, 1, 'root');
  }
  // Hidden questions are neither open nor pins: the group belongs to All only (N45).
  if (opts.showHidden && opts.filter === 'all') pushHiddenGroup(c);
  return { rows: c.rows, filtering, matchCount: c.matchCount, noResults: q !== '' && c.matchCount === 0 };
}

// Keyboard movement lives in thread-tree-nav.ts; re-exported for the drawer.
export {
  ancestorKeysOf, arrowLeft, arrowRight, firstMatchRowId, firstRowId, isNavigable, isTypeToSearchKey, lastRowId,
  stepRowId, survivorAfterRemove, type TreeArrowResult,
} from '@/utils/thread-tree-nav';
