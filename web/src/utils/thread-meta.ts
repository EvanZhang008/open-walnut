/**
 * Per-question metadata over the thread tree (status, title, takeaway, hidden).
 *
 * Pure on purpose (no React, no DOM): the drawer toggle, the drawer summary, the
 * filter chips, the row pills and the stack header all read the SAME functions
 * here, so their numbers cannot drift apart. The ONE count function lives in
 * thread-meta-counts.ts and is re-exported below.
 *
 * Meta is keyed by the question's HEAD row msgId (`ThreadNode.headId`), never by
 * `threadKeyOf`: short, stable, and one-to-one with an anchor. A question with
 * no meta entry reads as `older` (created before meta existed): shown, never
 * counted as open.
 */
import type { SessionThreadMeta, SessionThreadMetaPatch, SessionThreadStatus, SessionThreadAnchor } from '@/types/session';
import { ROOT_THREAD_KEY, type ThreadNode, type ThreadTree } from '@/utils/thread-tree';

export type ThreadMetaIndex = Map<string, SessionThreadMeta>;

/** Client-only derived states of an OPEN question (never persisted). */
export type ThreadLiveState = 'queued' | 'answering' | 'failed';

/** What a row, a dot or a header renders. `pending` = a page pushed from a
 *  selection before its first send; `draft` = a left pending page with text. */
export type ThreadViewStatus = SessionThreadStatus | ThreadLiveState | 'pending' | 'draft';

export const TITLE_MAX = 120;
export const TAKEAWAY_MAX = 280;
export const QUESTION_MAX = 400;
/** `Naming…` stops showing this long after the first answer landed (display only). */
export const NAMING_TIMEOUT_MS = 90_000;

export function indexMeta(list: readonly SessionThreadMeta[] | undefined): ThreadMetaIndex {
  const index: ThreadMetaIndex = new Map();
  for (const m of list ?? []) if (m?.headId) index.set(m.headId, m);
  return index;
}

export function metaOf(node: Pick<ThreadNode, 'headId'> | undefined, index: ThreadMetaIndex): SessionThreadMeta | undefined {
  if (!node?.headId) return undefined;
  return index.get(node.headId);
}

/** Persisted status; `older` when the question has no meta entry. */
export function statusOf(node: Pick<ThreadNode, 'headId'> | undefined, index: ThreadMetaIndex): SessionThreadStatus {
  return metaOf(node, index)?.status ?? 'older';
}

/** The status to draw: a live state overlays any not-yet-resolved question. */
export function viewStatusOf(
  node: Pick<ThreadNode, 'key' | 'headId'>,
  index: ThreadMetaIndex,
  live?: ReadonlyMap<string, ThreadLiveState>,
): ThreadViewStatus {
  const s = statusOf(node, index);
  const l = live?.get(node.key);
  if (l && s !== 'resolved') return l;
  return s;
}

/** Open-ish statuses: what the `Open` filter lists and what Done applies to. */
export function isOpenish(s: SessionThreadStatus): boolean {
  return s === 'open' || s === 'suggested';
}

export interface DeriveLiveInput {
  tree: ThreadTree;
  /** Queued sends that carry a pre-assigned uuid, in queue order. */
  queued: ReadonlyArray<{ rowId: string; status: 'pending' | 'processing' }>;
  /** Thread key the CLI is currently answering, or null when idle. */
  streamingKey: string | null;
  /** How the turn opened by each user row ended, when it ended. */
  turnEnds: ReadonlyMap<string, 'ok' | 'error' | 'interrupted' | 'parked' | 'silent'>;
  /** Is there assistant text after this user row (within its turn)? */
  hasAnswerAfter: (rowId: string) => boolean;
}

/**
 * Live states per thread key (spec 5.4 queued, 5.10 failed):
 *  - answering: the key the stream is on;
 *  - queued: a thread whose uuid-carrying send is waiting in the queue;
 *  - failed: the thread's LAST turn ended in error / interrupted / parked, or
 *    replied with tool calls and no words (silent), with no answer text after it.
 * Answering wins over queued (a follow-up queued behind its own answer is still
 * being answered), queued wins over failed (a retry is on its way).
 */
export function deriveThreadLiveStates(input: DeriveLiveInput): Map<string, ThreadLiveState> {
  const out = new Map<string, ThreadLiveState>();
  const { tree } = input;
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY) continue;
    const last = node.turnIds[node.turnIds.length - 1];
    if (!last) continue;
    const end = input.turnEnds.get(last);
    if (end && end !== 'ok' && !input.hasAnswerAfter(last)) out.set(node.key, 'failed');
  }
  for (const q of input.queued) {
    const key = tree.byRow.get(q.rowId)?.key;
    if (key && key !== ROOT_THREAD_KEY) out.set(key, q.status === 'processing' ? 'answering' : 'queued');
  }
  if (input.streamingKey && input.streamingKey !== ROOT_THREAD_KEY) out.set(input.streamingKey, 'answering');
  return out;
}

// ── Hidden subtrees and descendants ──

/** Keys hidden from the stack and the tree: a head with `hidden: true` hides its
 *  whole subtree by DERIVATION (children are never written hidden one by one),
 *  so one Undo that clears one field restores everything. Root is never hidden. */
export function hiddenKeysOf(tree: ThreadTree, index: ThreadMetaIndex): Set<string> {
  const hidden = new Set<string>();
  const walk = (key: string, parentHidden: boolean) => {
    const node = tree.byKey.get(key);
    if (!node) return;
    const self = key !== ROOT_THREAD_KEY && (parentHidden || metaOf(node, index)?.hidden === true);
    if (self) hidden.add(key);
    for (const c of node.childKeys) walk(c, self);
  };
  walk(tree.rootKey ?? ROOT_THREAD_KEY, false);
  return hidden;
}

/** Every descendant key of `key` (depth-first, transcript order), excluding
 *  `key` itself. `visibleOnly` drops hidden subtrees. */
export function descendantsOf(
  tree: ThreadTree,
  key: string,
  opts: { visibleOnly?: boolean; index?: ThreadMetaIndex; hidden?: ReadonlySet<string> } = {},
): string[] {
  const out: string[] = [];
  const hidden = opts.visibleOnly
    ? opts.hidden ?? (opts.index ? hiddenKeysOf(tree, opts.index) : new Set<string>())
    : undefined;
  const walk = (k: string) => {
    const node = tree.byKey.get(k);
    if (!node) return;
    for (const c of node.childKeys) {
      if (hidden?.has(c)) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(key);
  return out;
}

/** Visible descendants of `key` that count as open (open, suggested, or open
 *  with a live state), the number a row pill and `<n> open below` show. */
export function openBelow(
  tree: ThreadTree,
  key: string,
  index: ThreadMetaIndex,
  live?: ReadonlyMap<string, ThreadLiveState>,
): number {
  void live;
  let n = 0;
  for (const k of descendantsOf(tree, key, { visibleOnly: true, index })) {
    if (isOpenish(statusOf(tree.byKey.get(k), index))) n += 1;
  }
  return n;
}

/** Ancestors of `key` from its parent up to depth 1 (root excluded), nearest first. */
export function ancestorsOf(tree: ThreadTree, key: string): ThreadNode[] {
  const out: ThreadNode[] = [];
  let node = tree.byKey.get(key);
  const seen = new Set<string>();
  while (node?.parentKey !== undefined && node.parentKey !== ROOT_THREAD_KEY && !seen.has(node.parentKey)) {
    seen.add(node.parentKey);
    const parent = tree.byKey.get(node.parentKey);
    if (!parent) break;
    out.push(parent);
    node = parent;
  }
  return out;
}

export {
  counts, pinThreadKey, pluralFollowUps, pluralQuestions, openChipCount, toggleLabel, toggleTitle,
  drawerShortcutText, summaryText, chipCounts, openChipTitle, ZERO_COUNTS, type ThreadCounts,
} from '@/utils/thread-meta-counts';

// ── Titles ──

const FALLBACK_TITLE_MAX = 48;
export const UNTITLED_QUESTION = 'Untitled question';

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^>\s?/, '').replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/[*_`]/g, '').trim();
}

/** Cut at a word boundary to `max` chars plus `…`; hard cut when the line has
 *  no usable space (CJK text). */
export function clipAtWord(line: string, max: number): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const body = space >= Math.floor(max / 3) ? cut.slice(0, space) : cut;
  return `${body.replace(/[\s,;:.]+$/, '')}…`;
}

/** Title before (or without) an AI name: the passage's first line, else the
 *  question's first line, else `Untitled question`. */
export function fallbackTitle(quoteExact?: string, question?: string): string {
  const q = firstLine(quoteExact);
  if (q) return clipAtWord(q, FALLBACK_TITLE_MAX);
  const t = firstLine(question);
  if (t) return clipAtWord(t, FALLBACK_TITLE_MAX);
  return UNTITLED_QUESTION;
}

/** The label the tree model falls back to when a turn has no text. Never a
 *  question's title (it names the old concept). */
const TREE_LABEL_PLACEHOLDER = 'This thread';

export interface DisplayTitle {
  title: string;
  /** Show the faint `Naming…` after the title. */
  naming: boolean;
}

/**
 * The one title rule (spec 7.3): a non-empty meta title, else the fallback.
 * `naming` is true while the AI name is pending, until 90s after the first
 * answer landed, or 90s after the entry's last write when the caller does not
 * know the answer time (display only, nothing is written back).
 */
export function displayTitleOf(
  node: Pick<ThreadNode, 'key' | 'headId' | 'quote' | 'label'> | undefined,
  index: ThreadMetaIndex,
  opts: { nowMs?: number; firstAnswerAtMs?: number; questionText?: string } = {},
): DisplayTitle {
  if (!node || node.key === ROOT_THREAD_KEY) return { title: 'Main conversation', naming: false };
  const meta = metaOf(node, index);
  const own = meta?.title?.trim();
  const label = node.label && node.label !== TREE_LABEL_PLACEHOLDER ? node.label : undefined;
  const question = meta?.question ?? opts.questionText ?? (node.quote ? undefined : label);
  const title = own || fallbackTitle(node.quote?.exact, question);
  let naming = meta?.titleState === 'pending' && meta.titleSource !== 'user';
  // The clock starts at the first answer when the caller knows it, else at the
  // entry's last write (the send that asked for a name): a name that never
  // comes (a lost job, a restart) must not say `Naming…` forever (N2).
  const since = opts.firstAnswerAtMs ?? (meta?.updatedAt ? Date.parse(meta.updatedAt) : NaN);
  if (naming && Number.isFinite(since)) {
    const now = opts.nowMs ?? Date.now();
    if (now - since > NAMING_TIMEOUT_MS) naming = false;
  }
  return { title, naming };
}

// ── Takeaway fallback (spec 7.5) ──

/** Sentences that open with these are skipped (P2 keeps a parity copy server-side). */
export const TAKEAWAY_PREAMBLE_PATTERNS: readonly RegExp[] = [
  /^(good|great) question/i,
  /^short answer/i,
  /^sure[,.]/i,
  /^I'll /i,
  /^Let me /i,
  /^OK[,.]/i,
];
const FALLBACK_TAKEAWAY_MAX = 160;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(sentence: string): number {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  const cjk = (sentence.match(CJK) ?? []).length;
  return Math.max(words, Math.floor(cjk / 2));
}

function sentencesOf(paragraph: string): string[] {
  return (paragraph.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]*/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The last prose paragraph of an answer (code fences and tables skipped). */
function lastParagraph(markdown: string): string {
  const noFences = markdown.replace(/```[\s\S]*?(```|$)/g, '\n\n');
  const paras = noFences.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .filter((p) => !p.split('\n').every((l) => /^\s*\|/.test(l)));
  return paras.length ? stripMarkdown(paras[paras.length - 1]) : '';
}

/** First sentence of the last paragraph of the last answer, skipping short and
 *  preamble sentences; the paragraph's first sentence as-is when all are skipped. */
export function fallbackTakeaway(lastAnswerMarkdown: string | undefined): string {
  const para = lastParagraph(lastAnswerMarkdown ?? '');
  if (!para) return '';
  const sentences = sentencesOf(para);
  if (sentences.length === 0) return '';
  const pick = sentences.find((s) => wordCount(s) >= 6 && !TAKEAWAY_PREAMBLE_PATTERNS.some((re) => re.test(s)))
    ?? sentences[0];
  return pick.length > FALLBACK_TAKEAWAY_MAX ? clipAtWord(pick, FALLBACK_TAKEAWAY_MAX - 1) : pick;
}

/** Case and full/half width insensitive form for the drawer's search. */
export function normalizeForSearch(text: string | undefined): string {
  return (text ?? '').normalize('NFKC').toLowerCase();
}

// ── Upsert merge + stale-record adoption (spec 7.2, 7.3) ──

type MetaField = Exclude<keyof SessionThreadMeta, 'headId'>;
const CAPS: Partial<Record<MetaField, number>> = { title: TITLE_MAX, takeaway: TAKEAWAY_MAX, question: QUESTION_MAX };
/** Server-side pruning only drops an entry without an anchor this old (spec 7.2). */
export const META_PRUNE_AGE_MS = 10 * 60_000;

/** Client mirror of the server's upsert: listed fields overwrite, `null` clears,
 *  unlisted entries and fields stay; each touched entry gets `updatedAt`. */
export function mergeMetaPatch(
  list: readonly SessionThreadMeta[],
  patches: readonly SessionThreadMetaPatch[],
  nowIso: string,
): SessionThreadMeta[] {
  const out = list.slice();
  const pos = new Map(out.map((m, i) => [m.headId, i] as const));
  for (const p of patches) {
    if (!p?.headId) continue;
    const at = pos.get(p.headId);
    const next: Record<string, unknown> = at === undefined ? { headId: p.headId, status: 'older' } : { ...out[at] };
    for (const [k, v] of Object.entries(p)) {
      if (k === 'headId' || v === undefined) continue;
      if (v === null) { delete next[k]; continue; }
      const cap = CAPS[k as MetaField];
      next[k] = cap && typeof v === 'string' && v.length > cap ? v.slice(0, cap) : v;
    }
    if (!next.status) next.status = 'older';
    next.updatedAt = nowIso;
    if (at === undefined) { pos.set(p.headId, out.length); out.push(next as unknown as SessionThreadMeta); }
    else out[at] = next as unknown as SessionThreadMeta;
  }
  return out;
}

/** The patch that puts every field `patch` touches back to what `prev` had.
 *  A question with no entry goes back to `older` (entries are never deleted). */
export function inversePatch(prev: SessionThreadMeta | undefined, patch: SessionThreadMetaPatch): SessionThreadMetaPatch {
  const inv: Record<string, unknown> = { headId: patch.headId };
  for (const k of Object.keys(patch)) {
    if (k === 'headId') continue;
    const was = prev ? (prev as unknown as Record<string, unknown>)[k] : undefined;
    inv[k] = was === undefined ? (k === 'status' ? 'older' : null) : was;
  }
  return inv as SessionThreadMetaPatch;
}

/** Same list, entry for entry (order and every field). */
export function sameMetaList(a: readonly SessionThreadMeta[], b: readonly SessionThreadMeta[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) if (x[k] !== y[k]) return false;
  }
  return true;
}

/**
 * Should the record's meta list replace ours? After a local write, only when
 * every entry we confirmed is present with an `updatedAt` at least as new (a GET
 * issued before our Done can land after it: adopting it would reopen the
 * question). An entry missing from the server list counts as satisfied when the
 * server PRUNED it: its headId is not in the server's anchors and it is older
 * than the prune age (C84), or one prune would block adoption until a reload.
 * Entries another device added are adopted as usual.
 */
export function shouldAdoptServerMeta(
  server: readonly SessionThreadMeta[],
  confirmed: readonly SessionThreadMeta[],
  wroteLocally: boolean,
  serverAnchors: readonly Pick<SessionThreadAnchor, 'msgId'>[] = [],
  nowMs: number = Date.now(),
): boolean {
  if (!wroteLocally) return true;
  const byHead = indexMeta(server);
  let anchorIds: Set<string> | undefined;
  for (const c of confirmed) {
    const s = byHead.get(c.headId);
    if (!s) {
      anchorIds ??= new Set(serverAnchors.map((a) => a.msgId));
      const age = nowMs - Date.parse(c.updatedAt);
      if (!anchorIds.has(c.headId) && age >= META_PRUNE_AGE_MS) continue;
      return false;
    }
    if (Date.parse(s.updatedAt) < Date.parse(c.updatedAt)) return false;
  }
  return true;
}

// ── Action planners (pure; useThreadActions applies them) ──

export interface MetaPlan {
  /** Headed keys the plan touches, the acted-on question first. */
  keys: string[];
  patches: SessionThreadMetaPatch[];
  /** Puts every touched field back (the Undo, and the rollback on failure). */
  undo: SessionThreadMetaPatch[];
}

function plan(tree: ThreadTree, index: ThreadMetaIndex, keys: string[], make: (node: ThreadNode, prev?: SessionThreadMeta) => SessionThreadMetaPatch | null): MetaPlan {
  const out: MetaPlan = { keys: [], patches: [], undo: [] };
  for (const key of keys) {
    const node = tree.byKey.get(key);
    if (!node?.headId || key === ROOT_THREAD_KEY) continue;
    const prev = metaOf(node, index);
    const p = make(node, prev);
    if (!p) continue;
    out.keys.push(key);
    out.patches.push(p);
    out.undo.push(inversePatch(prev, p));
  }
  return out;
}

export interface DonePlanInput {
  /** Markdown of the question's last answer, for the fallback takeaway. */
  lastAnswerOf: (key: string) => string | undefined;
  /** Keys whose answer is still streaming: no takeaway is written for them yet. */
  answering?: ReadonlySet<string>;
  /** false = fallback takeaway only, no AI call (the batch older-questions Done). */
  aiTakeaway?: boolean;
}

/** Resolve each key. Takeaway = the existing one, else the fallback; the AI
 *  refinement is asked for (`takeawayState: 'pending'`) unless a user or AI
 *  takeaway already exists. While the answer streams no takeaway is sent. */
export function planDone(tree: ThreadTree, index: ThreadMetaIndex, keys: string[], input: DonePlanInput): MetaPlan {
  return plan(tree, index, keys, (node, prev) => {
    const p: SessionThreadMetaPatch = { headId: node.headId, status: 'resolved' };
    const settled = prev?.takeaway && (prev.takeawaySource === 'user' || prev.takeawaySource === 'ai');
    if (settled) return p;
    if (input.answering?.has(node.key)) return { ...p, takeawayState: 'pending' };
    const takeaway = prev?.takeaway || fallbackTakeaway(input.lastAnswerOf(node.key));
    if (takeaway) { p.takeaway = takeaway; p.takeawaySource = prev?.takeawaySource ?? 'fallback'; }
    if (input.aiTakeaway !== false) p.takeawayState = 'pending';
    return p;
  });
}

/** `Done, back to start`: this question plus every open ancestor through depth 1. */
export function planDoneChain(tree: ThreadTree, index: ThreadMetaIndex, key: string, input: DonePlanInput): MetaPlan & { above: number } {
  const up = ancestorsOf(tree, key).filter((n) => isOpenish(statusOf(n, index))).map((n) => n.key);
  const p = planDone(tree, index, [key, ...up], input);
  return { ...p, above: Math.max(0, p.keys.length - 1) };
}

/** `Archive all`: this question plus its visible open descendants. */
export function planDoneWithFollowUps(tree: ThreadTree, index: ThreadMetaIndex, key: string, input: DonePlanInput): MetaPlan & { below: number } {
  const down = descendantsOf(tree, key, { visibleOnly: true, index })
    .filter((k) => isOpenish(statusOf(tree.byKey.get(k), index)));
  const p = planDone(tree, index, [key, ...down], input);
  return { ...p, below: Math.max(0, p.keys.length - 1) };
}

/** Back to open. `notYet` also records that the suggestion was dismissed. */
export function planReopen(tree: ThreadTree, index: ThreadMetaIndex, key: string, opts: { notYet?: boolean } = {}): MetaPlan {
  return plan(tree, index, [key], (node) => (opts.notYet
    ? { headId: node.headId, status: 'open', suggestDismissed: true }
    : { headId: node.headId, status: 'open' }));
}

/** Hide the head only; the subtree hides by derivation. `descendants` = how many
 *  visible follow-ups go with it (the toast and the confirm name them). */
export function planRemove(tree: ThreadTree, index: ThreadMetaIndex, key: string): MetaPlan & { descendants: number } {
  const descendants = descendantsOf(tree, key, { visibleOnly: true, index }).length;
  const p = plan(tree, index, [key], (node, prev) => ({ headId: node.headId, hidden: true, ...(prev ? {} : { status: 'older' as const }) }));
  return { ...p, descendants };
}

/** Undo a remove after its toast expired (the Hidden group's Restore). */
export function planRestore(tree: ThreadTree, index: ThreadMetaIndex, key: string): MetaPlan {
  return plan(tree, index, [key], (node, prev) => (prev?.hidden ? { headId: node.headId, hidden: null } : null));
}

/** Rename: '' clears the user title (back to the AI or fallback title). */
export function planRename(tree: ThreadTree, index: ThreadMetaIndex, key: string, text: string): MetaPlan {
  const t = text.trim().slice(0, TITLE_MAX);
  return plan(tree, index, [key], (node, prev) => (t
    ? { headId: node.headId, title: t, titleSource: 'user', titleState: 'done', ...(prev ? {} : { status: 'older' as const }) }
    : { headId: node.headId, title: null, titleSource: null }));
}

/** Edit the takeaway by hand: the AI never overwrites it after this. */
export function planEditTakeaway(tree: ThreadTree, index: ThreadMetaIndex, key: string, text: string): MetaPlan {
  const t = text.trim().slice(0, TAKEAWAY_MAX);
  return plan(tree, index, [key], (node) => (t
    ? { headId: node.headId, takeaway: t, takeawaySource: 'user', takeawayState: 'done' }
    : { headId: node.headId, takeaway: null, takeawaySource: null, takeawayState: null }));
}
