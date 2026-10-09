/**
 * The question stack's pure rules (spec 5.1, 5.4, 5.5): the path from the main
 * conversation to the page on screen, how a jump between two pages decomposes
 * into pops and pushes (one animation), page and draft keys, the Esc decision,
 * landing arithmetic and the sliver's bars. No React, no DOM: unit-tested in
 * tests/web/thread-stack-state.test.ts.
 */
import type { SessionPinnedQuote } from '@/types/session';
import { QUOTE_CONTEXT_CHARS } from '@/utils/text-quote-anchor';
import { ROOT_THREAD_KEY, THREAD_HUES, normalizePassage, pathToRoot, type ThreadTree } from '@/utils/thread-tree';
import { stripQuestionTag } from '@/utils/question-tag';
import {
  displayTitleOf, metaOf, openBelow, viewStatusOf,
  type ThreadLiveState, type ThreadMetaIndex, type ThreadViewStatus,
} from '@/utils/thread-meta';

export const PENDING_PREFIX = 'pending:';

/** Small stable hash (djb2, base36): short enough for a storage key. */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** `pending:<parentMsgId>:<quote hash>`: the page an Ask opens before its first send. */
export function pendingPageKey(parentMsgId: string, quoteExact: string | undefined): string {
  return `${PENDING_PREFIX}${parentMsgId}:${hashText(normalizePassage(quoteExact))}`;
}

export function isPendingKey(key: string | undefined): boolean {
  return !!key && key.startsWith(PENDING_PREFIX);
}

/**
 * Composer draft key per page. The root keeps the key drafts always had, so a
 * half-typed message from before this change is still there; a question page
 * is keyed by its head row, a pending page by its own key.
 */
export function composerDraftKey(sessionId: string, pageKey: string, tree: ThreadTree): string {
  const base = `draft:session:${sessionId}`;
  if (pageKey === ROOT_THREAD_KEY) return base;
  if (isPendingKey(pageKey)) return `${base}:${pageKey}`;
  const head = tree.byKey.get(pageKey)?.headId;
  return `${base}:${head || hashText(pageKey)}`;
}

/**
 * What a navigation does with the words typed for the page it leaves. An Ask
 * (a pending page) left with no words leaves nothing: no draft row, no mark,
 * no stored text; only a sent question, or one with words typed for it, stays.
 * An open card's own box (`cardText`, given only while the card is open) is the
 * Ask's text for a pending page: the composer probe cannot see it, and a draft
 * reopened into the card also sits in the composer's draft, stale once the card
 * is edited. `carryToRoot` (the composer chip's ×) moves the words to
 * the main conversation's draft, after any it already holds.
 */
export function pageLeave(a: {
  leavingPending: boolean;
  leavingRoot: boolean;
  composerText: string;
  cardText?: string;
  carryToRoot?: boolean;
  rootDraft: string;
}): { fromDraft: string; rootDraft?: string; keepPendingDraft: boolean } {
  const text = a.leavingPending && a.cardText !== undefined ? a.cardText : a.composerText;
  if (a.carryToRoot && !a.leavingRoot) {
    const rootDraft = !text.trim() ? a.rootDraft
      : a.rootDraft.trim() ? `${a.rootDraft.trimEnd()}\n\n${text}` : text;
    return { fromDraft: '', rootDraft, keepPendingDraft: false };
  }
  return { fromDraft: text, keepPendingDraft: a.leavingPending && !!text.trim() };
}

/** The text stored under a composer draft key ('' when none or no storage). */
export function readComposerDraft(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

/** Root..key as thread keys. A pending page sits on top of its parent's path.
 *  An unknown key resolves to the root alone (never an empty path). */
export function stackPathOf(
  tree: ThreadTree,
  key: string,
  pending?: { pageKey: string; parentKey: string },
): string[] {
  if (pending && key === pending.pageKey) return [...stackPathOf(tree, pending.parentKey), pending.pageKey];
  if (key === ROOT_THREAD_KEY) return [ROOT_THREAD_KEY];
  const nodes = pathToRoot(tree, key);
  if (nodes.length === 0) return [ROOT_THREAD_KEY];
  return nodes.map((n) => n.key);
}

export interface NavPlan {
  from: string;
  to: string;
  /** Deepest page both paths share. */
  common: string;
  /** Pages left, deepest first. */
  popped: string[];
  /** Pages entered, shallowest first. */
  pushed: string[];
  /** The ONE animation a jump plays: any page entered reads as a push. */
  direction: 'push' | 'pop' | 'none';
}

/** Cross-branch = pop to the common ancestor, then push (spec 5.4). */
export function planNavigation(fromPath: readonly string[], toPath: readonly string[]): NavPlan {
  let i = 0;
  while (i < fromPath.length && i < toPath.length && fromPath[i] === toPath[i]) i++;
  const popped = fromPath.slice(i).reverse();
  const pushed = toPath.slice(i);
  return {
    from: fromPath[fromPath.length - 1] ?? ROOT_THREAD_KEY,
    to: toPath[toPath.length - 1] ?? ROOT_THREAD_KEY,
    common: i > 0 ? toPath[i - 1] : ROOT_THREAD_KEY,
    popped,
    pushed,
    direction: pushed.length > 0 ? 'push' : popped.length > 0 ? 'pop' : 'none',
  };
}

export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Esc on the page (after every overlay had its turn): the root does nothing,
 * a composer holding text keeps the page (the Esc was about the text), an
 * empty or unfocused composer pops.
 */
export function escapeDecision(s: { depth: number; composerFocused: boolean; composerText: string }): 'pop' | 'ignore' {
  if (s.depth <= 0) return 'ignore';
  if (s.composerFocused && s.composerText.trim() !== '') return 'ignore';
  return 'pop';
}

/** Where a page was left: its scrollTop and, when it was left for a question,
 *  where that question's passage sat in the scroll box. */
export interface PageLanding {
  scrollTop: number;
  sentenceTop?: number;
  /** The scroll box's viewport top when the page was left. Chrome above the
   *  box can change height meanwhile (a status row that goes away after the
   *  first send): the landing keeps the passage at its SCREEN y (C4). */
  boxTop?: number;
}

/** Where the passage must sit in the box now, for it to be at its old screen y. */
export function landingTarget(rec: PageLanding, boxTopNow: number, clientHeight: number): number | undefined {
  if (rec.sentenceTop === undefined) return undefined;
  const moved = rec.boxTop === undefined ? 0 : rec.boxTop - boxTopNow;
  return Math.min(Math.max(0, rec.sentenceTop + moved), Math.max(0, clientHeight - 8));
}

/** A pop that still misses by more than this falls back to jumpToPlace. */
export const LANDING_TOLERANCE_PX = 8;

/** Pixels to add to scrollTop so the passage sits where it was, or null when
 *  either side of the measurement is missing. */
export function landingCorrection(rec: PageLanding | undefined, measuredTop: number | undefined): number | null {
  if (!rec || rec.sentenceTop === undefined || measuredTop === undefined) return null;
  return measuredTop - rec.sentenceTop;
}

/** Should the pop fall back to the full jump (row not loaded, or still off)? */
export function needsFallbackJump(delta: number | null, rowLoaded: boolean): boolean {
  if (!rowLoaded) return true;
  return delta !== null && Math.abs(delta) > LANDING_TOLERANCE_PX;
}

/** One sliver bar: an ancestor page (or the root plus collapsed levels). */
export interface SliverBar {
  /** The page a click on this bar pops to. */
  key: string;
  /** 0 = the root (muted), 1..3 = lightness level by position. */
  level: number;
  hue?: number;
  /** Tooltip and hover label. */
  label: string;
  /** Levels folded into this bar (the leftmost one past depth 4). */
  collapsed: number;
}

export const MAX_SLIVER_BARS = 4;
export const MAIN_TITLE = 'Main conversation';

/**
 * Bars for the ancestors of the page on screen (root first). min(depth, 4) bars;
 * past depth 4 the leftmost bar stands for the root plus the folded levels.
 */
export function sliverBars(
  ancestors: ReadonlyArray<{ key: string; hue?: number; title: string }>,
  max = MAX_SLIVER_BARS,
): SliverBar[] {
  const n = ancestors.length;
  if (n === 0) return [];
  if (n <= max) {
    return ancestors.map((a, i) => ({
      key: a.key,
      level: i === 0 ? 0 : Math.min(i, 4),
      ...(i === 0 || a.hue === undefined ? {} : { hue: a.hue }),
      label: `Back to ${i === 0 ? MAIN_TITLE : a.title}`,
      collapsed: 0,
    }));
  }
  const collapsed = n - max;
  const rest = ancestors.slice(n - (max - 1));
  return [
    { key: ancestors[0].key, level: 0, label: `Main + ${collapsed} more levels`, collapsed },
    ...rest.map((a, i) => ({
      key: a.key,
      level: i + 1,
      ...(a.hue === undefined ? {} : { hue: a.hue }),
      label: `Back to ${a.title}`,
      collapsed: 0,
    })),
  ];
}

/** A measured width bucketed to the tiers its readers compare against, so a
 *  resize re-renders only when a tier boundary is crossed: 0 unmeasured, else the
 *  largest tier at or below the width, else 1 (measured, below every tier). Every
 *  `w > 0 && w < tier` test reads the same on the bucket as on the width. */
export function widthTier(width: number, tiers: readonly number[]): number {
  if (!(width > 0)) return 0;
  let out = 1;
  for (const t of tiers) if (width >= t && t > out) out = t;
  return out;
}

/** Sliver bar width: 10px, 8px in a panel narrower than 600px. */
export function sliverBarWidth(panelWidth: number): number {
  return panelWidth > 0 && panelWidth < 600 ? 8 : 10;
}

/** A click on the sliver pops only when the press did not travel (a drag that
 *  started as a text selection must not navigate). */
export function isStillClick(
  down: { x: number; y: number } | null,
  up: { x: number; y: number },
  maxTravel = 4,
): boolean {
  if (!down) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) <= maxTravel;
}

export function wordCount(text: string | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** The quote head's pieces: a passage under 4 words borrows its stored
 *  prefix / suffix so it reads in context (spec 5.4, C76). */
/**
 * One side of a short passage's context, cut on word boundaries (N31). The
 * stored prefix / suffix is a character window (QUOTE_CONTEXT_CHARS): when it
 * is full, its outer word is usually a fragment (`r page slot`), so that word
 * goes and an ellipsis says so. A shorter window reached the text's edge and
 * is whole.
 */
export function contextSide(raw: string | undefined, side: 'before' | 'after', max = 60): string | undefined {
  if (!raw) return undefined;
  const flat = raw.replace(/\s+/g, ' ');
  const kept = side === 'before' ? flat.trimStart().slice(-max) : flat.trimEnd().slice(0, max);
  if (!kept.trim()) return undefined;
  if (raw.length < QUOTE_CONTEXT_CHARS && kept.length === (side === 'before' ? flat.trimStart() : flat.trimEnd()).length) return kept;
  const words = kept.split(' ');
  const outer = side === 'before' ? 0 : words.length - 1;
  // A single word or a window that starts / ends on a space has no fragment.
  if (words.length < 2 || words[outer] === '') return side === 'before' ? `… ${kept.trimStart()}` : `${kept.trimEnd()} …`;
  const rest = side === 'before' ? words.slice(1).join(' ') : words.slice(0, -1).join(' ');
  return side === 'before' ? `… ${rest}` : `${rest} …`;
}

export function quoteHeadParts(quote: SessionPinnedQuote | undefined): { prefix?: string; exact: string; suffix?: string } | null {
  const exact = quote?.exact?.trim();
  if (!quote || !exact) return null;
  if (wordCount(exact) >= 4) return { exact };
  const prefix = contextSide(quote.prefix, 'before');
  const suffix = contextSide(quote.suffix, 'after');
  return {
    ...(prefix ? { prefix } : {}),
    exact,
    ...(suffix ? { suffix } : {}),
  };
}

export const DRAFT_ROW_LABEL = 'New question (draft)';
export const PENDING_ROW_LABEL = 'New question';

// ── The page model: Asked-from rows and question marks (spec 5.4, 5.10) ──

export interface AskedFromRow {
  key: string;
  title: string;
  naming: boolean;
  hue: number;
  level: number;
  status: ThreadViewStatus;
  openBelow: number;
  takeaway?: string;
  unread: boolean;
  answeredAt?: number;
  draft?: boolean;
}

export interface PageModelInput {
  tree: ThreadTree;
  currentKey: string;
  hiddenKeys: ReadonlySet<string>;
  index: ThreadMetaIndex;
  live: ReadonlyMap<string, ThreadLiveState>;
  unreadKeys: ReadonlySet<string>;
  answeredAt: ReadonlyMap<string, number>;
  drafts: ReadonlyArray<{ pageKey: string; parentKey: string; parentMsgId: string; title: string }>;
}

/** Asked-from rows grouped by the reply they hang off, transcript order, drafts last. */
export function askedFromGroups(input: PageModelInput): Map<string, AskedFromRow[]> {
  const { tree, currentKey, hiddenKeys, index, live } = input;
  const out = new Map<string, AskedFromRow[]>();
  const push = (msgId: string, row: AskedFromRow) => out.set(msgId, [...(out.get(msgId) ?? []), row]);
  const node = tree.byKey.get(currentKey);
  for (const childKey of node?.childKeys ?? []) {
    if (hiddenKeys.has(childKey)) continue;
    const child = tree.byKey.get(childKey);
    if (!child?.parent) continue;
    const t = displayTitleOf(child, index);
    const meta = metaOf(child, index);
    push(child.parent, {
      key: childKey,
      title: t.title,
      naming: t.naming,
      hue: child.hue,
      level: Math.min(child.depth, 4),
      status: viewStatusOf(child, index, live),
      openBelow: openBelow(tree, childKey, index, live),
      ...(meta?.takeaway ? { takeaway: meta.takeaway } : {}),
      unread: input.unreadKeys.has(childKey),
      ...(input.answeredAt.has(childKey) ? { answeredAt: input.answeredAt.get(childKey) } : {}),
    });
  }
  for (const d of input.drafts) {
    if (d.parentKey !== currentKey) continue;
    const hue = node ? (node.depth >= 1 ? node.hue : THREAD_HUES[tree.topCount % THREAD_HUES.length]) : THREAD_HUES[0];
    push(d.parentMsgId, {
      key: d.pageKey, title: d.title, naming: false, hue, level: Math.min((node?.depth ?? 0) + 1, 4),
      status: 'draft', openBelow: 0, unread: false, draft: true,
    });
  }
  return out;
}

export interface MarkSpec {
  key: string;
  /** The question's head row id (what logs name; the key carries the quote). */
  headId: string;
  parentMsgId: string;
  quote: SessionPinnedQuote;
  hue: number;
  resolved: boolean;
  title: string;
}

/** A mark per visible child question with a passage, on the page on screen. */
export function markSpecsFor(input: Pick<PageModelInput, 'tree' | 'currentKey' | 'hiddenKeys' | 'index'>): MarkSpec[] {
  const out: MarkSpec[] = [];
  const node = input.tree.byKey.get(input.currentKey);
  for (const childKey of node?.childKeys ?? []) {
    if (input.hiddenKeys.has(childKey)) continue;
    const child = input.tree.byKey.get(childKey);
    if (!child?.parent || !child.quote?.exact) continue;
    out.push({
      key: childKey,
      headId: child.headId,
      parentMsgId: child.parent,
      quote: child.quote,
      hue: child.hue,
      resolved: metaOf(child, input.index)?.status === 'resolved',
      title: displayTitleOf(child, input.index).title,
    });
  }
  return out;
}

/** Unread (spec 5.10): the newest answer landed after the page was last viewed.
 *  A question never viewed in this tab is not announced; the page on screen never is. */
export function unreadKeysOf(
  tree: ThreadTree,
  answeredAt: ReadonlyMap<string, number>,
  lastViewedAt: ReadonlyMap<string, number>,
  currentKey: string,
): Set<string> {
  const out = new Set<string>();
  for (const [key, at] of answeredAt) {
    if (key === currentKey || key === ROOT_THREAD_KEY) continue;
    const head = tree.byKey.get(key)?.headId;
    const seen = head ? lastViewedAt.get(head) : undefined;
    if (seen !== undefined && at > seen) out.add(key);
  }
  return out;
}

/** The rows the stats read (structural: history rows pass untouched). */
export interface StatsRow {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  msgId?: string;
  walnutMessageId?: string;
  /** The uuid a `queue-…` user row was sent under (its thread id, threadIdOf). */
  sourceUuid?: string;
  timestamp?: string;
  systemVariant?: 'compact' | 'error' | 'info';
}

export interface ThreadStats {
  /** Thread key to when its newest answer text landed (ms). */
  answeredAt: Map<string, number>;
  /** Thread key to its newest answer's markdown. */
  lastAnswer: Map<string, string>;
  /** Thread key to its newest question's text (what Retry sends again). */
  lastQuestion: Map<string, string>;
  /** User row id to how its turn ended, when it did not end in an answer.
   *  `silent`: the reply is there, but as tool calls and a `[Qn]` tag only. */
  turnEnds: Map<string, 'error' | 'interrupted' | 'silent'>;
  /** User row ids with assistant words after them, inside their turn. */
  answered: Set<string>;
}

const INTERRUPT_RE = /^\[Request interrupted/;

/** One pass over the loaded rows: answers, questions and failed turn ends per
 *  question (spec 5.10). A turn is a user row and everything up to the next one.
 *  Answer words are the text left without the `[Qn]` tag: a reply of the tag and
 *  tool calls answered nothing (2026-10-08: such a question read `Answered` and
 *  its card was empty). */
export function deriveThreadStats(
  rows: readonly StatsRow[],
  keyOfRow: (rowId: string | undefined) => string,
): ThreadStats {
  const out: ThreadStats = {
    answeredAt: new Map(), lastAnswer: new Map(), lastQuestion: new Map(), turnEnds: new Map(), answered: new Set(),
  };
  let turnHead: string | undefined;
  let turnKey = '';
  for (const r of rows) {
    const text = r.text ?? '';
    if (r.role === 'user') {
      if (INTERRUPT_RE.test(text.trim())) {
        if (turnHead && !out.answered.has(turnHead)) out.turnEnds.set(turnHead, 'interrupted');
        continue;
      }
      turnHead = r.sourceUuid ?? r.msgId ?? r.walnutMessageId;
      turnKey = keyOfRow(turnHead);
      out.lastQuestion.set(turnKey, text);
      continue;
    }
    if (!turnHead) continue;
    const isError = r.systemVariant === 'error' || (r.role === 'assistant' && /^API Error\b/.test(text.trim()));
    if (isError) {
      if (!out.answered.has(turnHead)) out.turnEnds.set(turnHead, 'error');
      continue;
    }
    if (r.role !== 'assistant') continue;
    if (/\S/.test(stripQuestionTag(text))) {
      out.answered.add(turnHead);
      out.turnEnds.delete(turnHead);
      out.lastAnswer.set(turnKey, text);
      const at = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (Number.isFinite(at)) out.answeredAt.set(turnKey, at);
    } else if (!out.answered.has(turnHead) && !out.turnEnds.has(turnHead)) {
      out.turnEnds.set(turnHead, 'silent');
    }
  }
  return out;
}

// ── Which page a live block belongs to ──

/** Finished turns inside the ONE live block array: blocks [previous end, end)
 *  are the output of the turn that ran on page `key` (null = unknown, follow the
 *  live page: blocks already there when the panel mounted). Note the main
 *  conversation's key is '' (ROOT_THREAD_KEY), a real owner. */
export interface StreamTurnSegment { end: number; key: string | null }

/**
 * Record a turn end. `completedLen` is the stream's turn boundary (blocks
 * before it belong to finished turns); `ownerKey` is the page the stream was
 * live on BEFORE this render (the turn that just ended ran there). Without this,
 * a finished answer the transcript has not absorbed yet would follow the NEXT
 * turn onto its page (three Asks queued during one answer, C49). A reset stream
 * (fewer blocks, or a lower boundary) drops every segment.
 */
export function recordTurnSegments(
  segs: readonly StreamTurnSegment[], completedLen: number, blockCount: number, ownerKey: string | null,
): readonly StreamTurnSegment[] {
  const lastEnd = segs.length > 0 ? segs[segs.length - 1].end : 0;
  const base = completedLen < lastEnd || blockCount < lastEnd ? [] : segs;
  const from = base.length > 0 ? base[base.length - 1].end : 0;
  if (completedLen <= from) return base;
  return [...base, { end: completedLen, key: ownerKey }];
}

/** The page block `index` renders on: its finished turn's, else the live page. */
export function blockPageKey(segs: readonly StreamTurnSegment[], index: number, liveKey: string): string {
  for (const s of segs) if (index < s.end) return s.key ?? liveKey;
  return liveKey;
}

/** Deliveries matched to turns (render-phase bookkeeping, one per panel). */
export interface TurnBook {
  /** Deliveries no turn has claimed yet, oldest first. */
  queue: string[];
  /** Row ids already counted as delivered. */
  seen: Set<string>;
  mounted: boolean;
  /** The stream was live in the previous render. */
  wasStreaming: boolean;
  /** The running turn's owner, taken when its start was seen (undefined: no start seen). */
  turnOwner?: string | null;
}

export function newTurnBook(): TurnBook {
  return { queue: [], seen: new Set(), mounted: false, wasStreaming: false };
}

/** This render's new deliveries, in send order, as turn entries: a question row
 *  (pre-assigned uuid) is always its own turn; plain rows delivered together are
 *  one batch, so one turn. */
export function deliveryEntries(fresh: ReadonlyArray<{ key: string; uuid: boolean }>): string[] {
  const out: string[] = [];
  let plain: string | null = null;
  for (const f of fresh) {
    if (f.uuid) out.push(f.key);
    else plain = f.key;
  }
  return plain === null ? out : [plain, ...out];
}

/**
 * One render of the turn book. Turns run in delivery order, so a turn is owned by
 * the oldest delivery no turn has claimed. The claim happens when the turn is SEEN
 * TO START (the stream goes live): a delivery that shows up in the render a turn
 * ends is then plainly the next turn's. When a whole turn (delivery, reply,
 * result) lands inside one render, no start is seen and the turn claims the
 * oldest unclaimed delivery at its end, this render's own included. Returns the
 * owner of a turn that ends in this render (null: unknown, the caller asks the
 * transcript), or undefined when no turn ends.
 */
export function trackTurn(
  book: TurnBook, entries: readonly string[], isStreaming: boolean, completing: boolean,
): string | null | undefined {
  // Deliveries from before the panel mounted belong to turns it never saw start.
  if (book.mounted) book.queue.push(...entries);
  // A running turn whose owner was unknown at its start claims a delivery reported
  // while it runs (the report can trail the start; question rows are never handed
  // to a busy CLI, so it cannot be the next turn's).
  if (book.turnOwner === null && book.wasStreaming && isStreaming && !completing && book.queue.length > 0) {
    book.turnOwner = book.queue.shift()!;
  }
  let owner: string | null | undefined;
  if (completing) {
    owner = book.turnOwner !== undefined ? book.turnOwner : (book.queue.shift() ?? null);
    book.turnOwner = undefined;
  }
  // A start: live now and not before, or live again right after an end.
  if (isStreaming && (!book.wasStreaming || completing)) {
    book.turnOwner = book.queue.shift() ?? (book.mounted ? null : entries[entries.length - 1] ?? null);
  }
  book.wasStreaming = isStreaming;
  book.mounted = true;
  return owner;
}
