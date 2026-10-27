import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { fetchSession, updateSession } from '@/api/sessions';
import type { ImageAttachment } from '@/api/chat';
import type { SessionPinnedMessage, SessionThreadAnchor, SessionThreadMeta, SessionThreadMetaPatch } from '@/types/session';
import {
  EMPTY_DERIVED, type FileCardHost, type SessionThreadsApi, type ThreadCardPlace, type ThreadCardRequest, type ThreadDerived,
} from '@/contexts/SessionThreadsContext';
import type { ThreadMetaStore, ThreadToastApi } from '@/components/sessions/thread-ui-contract';
import { keepCommandFirst } from '@/components/chat/leading-command';
import { useSessionThreadMeta } from '@/hooks/useSessionThreadMeta';
import { useThreadActions } from '@/hooks/useThreadActions';
import { useThreadStack, type ComposerProbe, type ThreadStackHandle } from '@/hooks/useThreadStack';
import {
  ROOT_THREAD_KEY, composeAnchoredText, composeOrientedText, emptyThreadTree, newUserUuid, threadKeyOf, type ThreadTree,
} from '@/utils/thread-tree';
import { displayTitleOf, hiddenKeysOf, statusOf } from '@/utils/thread-meta';
import { counts as threadCounts, type ThreadCounts } from '@/utils/thread-meta-counts';
import { composerDraftKey, isPendingKey, unreadKeysOf } from '@/utils/thread-stack-state';
import { clearDraft, readDraft, writeDraft } from '@/utils/drafts';
import { carriedRootDraft, composerKeyOf, pendingPageOf } from '@/utils/composer-quote';
import { nextQuestionSeq, questionNumbers, withQuestionBanner } from '@/utils/question-tag';
import { markStatesOf, sameMarkStates, type ThreadMarkState } from '@/utils/thread-mark-state';
import { log } from '@/utils/log';
import { useEvent } from '@/hooks/useWebSocket';
import {
  QUESTION_WRITE_LATER_MS, readUnsavedQuestions, retryWrite, unsavedMeta, withUnsaved, withoutSaved, writeUnsavedQuestions,
  type UnsavedQuestion,
} from '@/utils/question-write-retry';

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const EMPTY_TIMES: ReadonlyMap<string, number> = new Map();

/** One anchor per user message, so the msgId IS the row identity. */
export function anchorKeyOf(anchor: SessionThreadAnchor): string {
  return anchor.msgId;
}

/**
 * Should the record's copy of the anchor list replace ours? Same rule as
 * `shouldAdoptServerPins`, for the same measured reason: the panel's fetch queue
 * routinely holds tens of requests, so a `GET /api/sessions/:id` issued before an
 * anchor write resolves AFTER it and arrives without that anchor. Adopting it
 * would drop the thread the user is typing into.
 *
 * A list that ADDS anchors (another tab, another device) is still adopted; one
 * that only removes them waits for a reload.
 */
export function shouldAdoptServerAnchors(
  server: SessionThreadAnchor[],
  confirmed: SessionThreadAnchor[],
  wroteLocally: boolean,
): boolean {
  if (!wroteLocally) return true;
  const keys = new Set(server.map(anchorKeyOf));
  return confirmed.every((a) => keys.has(anchorKeyOf(a)));
}

/** The confirmed (stored) list holds this anchor. */
function confirmedHas(confirmed: SessionThreadAnchor[], a: SessionThreadAnchor): boolean {
  return confirmed.some((c) => c.msgId === a.msgId);
}

/** The list with `anchor` recorded (one anchor per user row). */
function withAnchor(list: SessionThreadAnchor[], anchor: SessionThreadAnchor): SessionThreadAnchor[] {
  return [...list.filter((a) => a.msgId !== anchor.msgId), anchor];
}

/** Same list, entry for entry. O(n) over a few hundred small records, instead of
 *  two JSON.stringify passes on every record refetch. */
export function sameAnchorList(a: SessionThreadAnchor[], b: SessionThreadAnchor[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.msgId !== y.msgId || x.parent !== y.parent || x.source !== y.source || x.at !== y.at) return false;
    if ((x.quote?.exact ?? '') !== (y.quote?.exact ?? '')) return false;
    if ((x.quote?.prefix ?? '') !== (y.quote?.prefix ?? '')) return false;
    if ((x.quote?.suffix ?? '') !== (y.quote?.suffix ?? '')) return false;
  }
  return true;
}

/** One send's anchor write, staged so the send can carry it in the SAME PATCH
 *  as the question's meta (spec 7.2: one request, both fields). */
export interface ThreadAnchorStage {
  body: { thread_anchors: SessionThreadAnchor[] };
  /** The PATCH answered 2xx. */
  confirm: () => void;
  /** The PATCH failed: the anchor list goes back to the confirmed copy. */
  rollback: () => void;
  /** The PATCH failed but the question went out: the anchor stays on screen,
   *  UNSAVED, and every later write carries it until one lands. */
  keep: () => void;
}

export interface SessionThreadsStore {
  anchors: SessionThreadAnchor[];
  /** Record (or replace) the anchor for one user message. */
  add: (anchor: SessionThreadAnchor) => void;
  /** Drop the anchor for one user message — that turn returns to the top level. */
  remove: (msgId: string) => void;
  /** Optimistically add `anchor` now; the caller sends `body` and settles it. */
  stage: (anchor: SessionThreadAnchor) => ThreadAnchorStage;
  /** Put unsaved anchors (kept from a failed write, read back after a reload)
   *  on screen without a write; the caller writes them. */
  restoreUnsaved: (anchors: SessionThreadAnchor[]) => void;
  /** The newest list (unsaved anchors included), for a write built later. */
  current: () => SessionThreadAnchor[];
}

/** `server` plus every unsaved anchor it does not hold yet. */
export function withUnsavedAnchors(server: SessionThreadAnchor[], unsaved: ReadonlyMap<string, SessionThreadAnchor>): SessionThreadAnchor[] {
  if (unsaved.size === 0) return server;
  const have = new Set(server.map(anchorKeyOf));
  const extra = [...unsaved.values()].filter((a) => !have.has(anchorKeyOf(a)));
  return extra.length ? [...server, ...extra] : server;
}

/**
 * Thread anchors for one session: optimistic locally, persisted on the session
 * record (`PATCH /api/sessions/:id { thread_anchors }`).
 *
 * A near-copy of `useSessionPins` on purpose — same list-on-the-record storage,
 * same adoption guards, same revert-on-failure. Anchoring is part of a SEND, so a
 * round trip may not sit between the gesture and the UI reacting; and the server
 * answer carries nothing the client did not already know, because the client owns
 * the list.
 */
export function useSessionThreads(
  sessionId: string,
  serverAnchors?: SessionThreadAnchor[],
): SessionThreadsStore {
  const [anchors, setAnchors] = useState<SessionThreadAnchor[]>(serverAnchors ?? []);
  // Newest list, for two writes landing in one render (a send + a rail pick).
  const listRef = useRef<SessionThreadAnchor[]>(serverAnchors ?? []);
  const confirmed = useRef<SessionThreadAnchor[]>(serverAnchors ?? []);
  const inFlight = useRef(0);
  const wroteLocally = useRef(false);
  /** Anchors whose write failed after their question went out: never dropped by
   *  a record that lacks them, only by one that holds them (saved). */
  const unsaved = useRef<Map<string, SessionThreadAnchor>>(new Map());

  const adopt = useCallback((next: SessionThreadAnchor[]) => {
    for (const a of next) {
      if (unsaved.current.has(anchorKeyOf(a)) && confirmedHas(confirmed.current, a)) unsaved.current.delete(anchorKeyOf(a));
    }
    const shown = withUnsavedAnchors(next, unsaved.current);
    listRef.current = shown;
    setAnchors(shown);
  }, []);

  // Session switch: adopt the new session's list outright (never carry anchors across).
  useEffect(() => {
    inFlight.current = 0;
    wroteLocally.current = false;
    unsaved.current = new Map();
    confirmed.current = serverAnchors ?? [];
    adopt(serverAnchors ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only; the effect below handles updates
  }, [sessionId]);

  useEffect(() => {
    if (inFlight.current > 0) return;
    const next = serverAnchors ?? [];
    if (sameAnchorList(next, confirmed.current)) return;
    if (!shouldAdoptServerAnchors(next, confirmed.current, wroteLocally.current)) {
      log.info('session', 'ignoring a session record whose thread anchors are behind ours', {
        sessionId, ours: confirmed.current.length, theirs: next.length,
      });
      return;
    }
    confirmed.current = next;
    adopt(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId only labels the log line
  }, [serverAnchors, adopt]);

  /** Optimistic write of a whole list; the caller sends and settles it. */
  const stageList = useCallback((next: SessionThreadAnchor[]): ThreadAnchorStage => {
    adopt(next);
    wroteLocally.current = true;
    inFlight.current += 1;
    let settled = false;
    const done = () => {
      if (settled) return false;
      settled = true;
      inFlight.current = Math.max(0, inFlight.current - 1);
      return true;
    };
    return {
      body: { thread_anchors: next },
      confirm: () => {
        if (!done()) return;
        confirmed.current = next;
        if (unsaved.current.size) adopt(listRef.current);
      },
      rollback: () => {
        if (!done()) return;
        log.warn('threads', 'thread anchor save failed, reverting', { sessionId });
        adopt(confirmed.current);
      },
      keep: () => {
        if (!done()) return;
        const confirmedKeys = new Set(confirmed.current.map(anchorKeyOf));
        for (const a of next) if (!confirmedKeys.has(anchorKeyOf(a))) unsaved.current.set(anchorKeyOf(a), a);
        log.warn('threads', 'thread anchor save failed, kept as unsaved', { sessionId, unsaved: unsaved.current.size });
      },
    };
  }, [sessionId, adopt]);

  const persist = useCallback((next: SessionThreadAnchor[]) => {
    const staged = stageList(next);
    updateSession(sessionId, staged.body).then(staged.confirm, staged.rollback);
  }, [sessionId, stageList]);

  const add = useCallback((anchor: SessionThreadAnchor) => {
    if (!anchor.msgId || !anchor.parent) return;
    persist(withAnchor(listRef.current, anchor));
  }, [persist]);

  const stage = useCallback((anchor: SessionThreadAnchor) => stageList(withAnchor(listRef.current, anchor)), [stageList]);

  const restoreUnsaved = useCallback((list: SessionThreadAnchor[]) => {
    const fresh = list.filter((a) => a.msgId && a.parent && !confirmed.current.some((c) => c.msgId === a.msgId));
    if (fresh.length === 0) return;
    for (const a of fresh) unsaved.current.set(anchorKeyOf(a), a);
    adopt(listRef.current);
  }, [adopt]);

  const current = useCallback(() => listRef.current, []);

  const remove = useCallback((msgId: string) => {
    const current = listRef.current;
    if (!current.some((a) => a.msgId === msgId)) return;
    unsaved.current.delete(msgId);
    persist(current.filter((a) => a.msgId !== msgId));
  }, [persist]);

  return useMemo(() => ({ anchors, add, remove, stage, restoreUnsaved, current }), [anchors, add, remove, stage, restoreUnsaved, current]);
}

/**
 * 'linear' = Conversation Mode (every turn in order, each question's turns
 * labelled; the default) or 'stack' = Tree Mode (the question pages). The header
 * pill names the OTHER one, the one a click switches to.
 */
export type SessionViewMode = 'stack' | 'linear';

/** v2 key: the old 'linear' / 'tree' choice is never read and never deleted
 *  (rollback stays safe). */
export function viewModeKey(sessionId: string): string {
  return `walnut:session-view.v2:${sessionId}`;
}

/** The view a session opens in when it has no choice of its own. */
export const VIEW_MODE_DEFAULT_KEY = 'walnut:session-view.default';
export const DEFAULT_VIEW_MODE: SessionViewMode = 'linear';

function readViewMode(sessionId: string): SessionViewMode {
  try {
    const own = localStorage.getItem(viewModeKey(sessionId));
    if (own === 'linear' || own === 'stack') return own;
    const fallback = localStorage.getItem(VIEW_MODE_DEFAULT_KEY);
    return fallback === 'stack' || fallback === 'linear' ? fallback : DEFAULT_VIEW_MODE;
  } catch { return DEFAULT_VIEW_MODE; }
}

/** Tree Mode (stack) vs Conversation Mode (linear), remembered per session across reloads. */
export function useSessionViewMode(sessionId: string): {
  viewMode: SessionViewMode;
  setViewMode: (mode: SessionViewMode) => void;
} {
  const [viewMode, setState] = useState<SessionViewMode>(() => readViewMode(sessionId));

  // Session switch: read THAT session's preference.
  useEffect(() => { setState(readViewMode(sessionId)); }, [sessionId]);

  const setViewMode = useCallback((mode: SessionViewMode) => {
    setState(mode);
    try { localStorage.setItem(viewModeKey(sessionId), mode); } catch { /* private browsing */ }
  }, [sessionId]);

  return { viewMode, setViewMode };
}

// ── The panel's question wiring (SessionPanel calls this once) ──

type Dispatch = (sessionId: string, message: string, images?: ImageAttachment[], opts?: { userUuid?: string }) => Promise<boolean>;

export interface UsePanelThreadsArgs {
  sessionId: string;
  serverAnchors?: SessionThreadAnchor[];
  serverMeta?: SessionThreadMeta[];
  pins: SessionPinnedMessage[];
  panelRef: RefObject<HTMLElement | null>;
  /** An anchor needs the engine to persist the uuid we pre-assign (not ACP). */
  canAsk: boolean;
  send: Dispatch;
  interruptSend: Dispatch;
  composer: ComposerProbe;
  focusComposer: () => void;
}

export interface PanelThreads {
  api: SessionThreadsApi;
  stack: ThreadStackHandle;
  meta: ThreadMetaStore;
  counts: ThreadCounts;
  /** The session has questions: the toggle, drawer and root menu exist. */
  hasQuestions: boolean;
  hiddenCount: number;
  toast: ThreadToastApi;
  /** Filled by <ThreadToastBridge> inside the panel's toast provider. */
  toastRef: MutableRefObject<ThreadToastApi | null>;
  sendAnchored: (message: string, images: ImageAttachment[] | undefined, interrupt: boolean, targetKey?: string) => Promise<boolean>;
  composerPlaceholder?: string;
  draftKey: string;
  /** Always true now: a pending Ask with words comes back as a draft row after a
   *  reload (thread-stack-persist.ts `askDraftsKey`), and its key is read when it opens. */
  draftKeptOnReload: boolean;
  /** Conversation Mode, the composer replying in a question (or asking a new
   *  one): what its chip names. Absent when it posts to the main conversation. */
  composerTarget?: ComposerTarget;
}

export interface ComposerTarget {
  key: string;
  /** The question's number; none for a question not asked yet. */
  number?: number;
  title: string;
  /** An Ask not sent yet (`title` is then its passage). */
  pending: boolean;
}

function samePlace(a: ThreadCardPlace | null, b: ThreadCardPlace | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight
    && a.grown?.left === b.grown?.left && a.grown?.width === b.grown?.width && a.grown?.maxHeight === b.grown?.maxHeight;
}

export const ASK_PLACEHOLDER = 'Ask about this passage…';
export const FOLLOW_UP_PLACEHOLDER = 'Follow up on this question…';

/** The composer on a question page names the question it posts into (N35,
 *  prototype 01's `Replying in <title>`): `Reply in “<title>”…`, the title cut
 *  to 40 characters so a narrow column still shows the verb. */
export function followUpPlaceholder(title: string | undefined): string {
  const t = (title ?? '').trim();
  if (!t) return FOLLOW_UP_PLACEHOLDER;
  const short = t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t;
  return `Reply in “${short}”…`;
}

export function usePanelThreads(args: UsePanelThreadsArgs): PanelThreads {
  const { sessionId } = args;
  const store = useSessionThreads(sessionId, args.serverAnchors);
  const meta = useSessionThreadMeta(sessionId, args.serverMeta, args.serverAnchors);
  const { viewMode, setViewMode } = useSessionViewMode(sessionId);
  const [tree, setTreeState] = useState<ThreadTree>(emptyThreadTree);
  const [historyComplete, setHistoryComplete] = useState(false);
  const setTree = useCallback((next: ThreadTree, complete?: boolean) => {
    setTreeState(next);
    setHistoryComplete(complete ?? true);
  }, []);
  const [derived, setDerived] = useState<ThreadDerived>(EMPTY_DERIVED);
  const [pinJump, setPinJump] = useState<{ pinKey: string; seq: number } | null>(null);
  /** Key to when this tab last sent into that question (its mark waits from then). */
  const [askedAt, setAskedAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const noteAsked = useCallback((key: string) => {
    setAskedAt((m) => new Map(m).set(key, Date.now()));
  }, []);
  useEffect(() => {
    setTreeState(emptyThreadTree()); setHistoryComplete(false); setDerived(EMPTY_DERIVED); setPinJump(null); setAskedAt(new Map());
  }, [sessionId]);
  const hiddenKeys = useMemo(() => hiddenKeysOf(tree, meta.index), [tree, meta.index]);

  // The toast lives INSIDE the panel (its provider wraps this panel's markup),
  // so the actions reach it through a ref the bridge fills.
  const toastRef = useRef<ThreadToastApi | null>(null);
  const toast = useMemo<ThreadToastApi>(() => ({
    show: (t) => toastRef.current?.show(t),
    dismiss: () => toastRef.current?.dismiss(),
  }), []);

  /** Conversation Mode: the question the chat's composer writes to. Only an
   *  explicit Quote in chat sets it; opening a card never does (composer-quote.ts). */
  const [quotedKey, setQuotedKey] = useState<string | null>(null);
  const quotedRef = useRef(quotedKey);
  quotedRef.current = quotedKey;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  useEffect(() => { setQuotedKey(null); }, [sessionId, viewMode]);
  // A quoted Ask just sent: its question key and head row, until the tree holds
  // it. Without it the composer's key fell back to the main conversation for the
  // frames in between, and a keystroke there went to the main draft.
  const [born, setBorn] = useState<{ key: string; head: string } | null>(null);
  useEffect(() => {
    if (born && (quotedKey !== born.key || tree.byKey.has(born.key))) setBorn(null);
  }, [born, quotedKey, tree]);
  const keepPending = useCallback((pageKey: string) => quotedRef.current === pageKey, []);
  const answeredAtRef = useRef<ReadonlyMap<string, number>>(new Map());
  const answeredAtOf = useCallback((key: string) => answeredAtRef.current.get(key), []);

  const stack = useThreadStack({
    sessionId, tree, anchors: store.anchors, hiddenKeys, metaIndex: meta.index, panelRef: args.panelRef,
    stackView: viewMode === 'stack', composer: args.composer, toast, focusComposer: args.focusComposer,
    historyComplete, keepPending, answeredAtOf,
  });
  const actions = useThreadActions({
    sessionId, tree, meta, toast, nav: stack.bridge,
    lastAnswerOf: (key) => derived.lastAnswer.get(key),
    answeringKeys: derived.answering,
  });

  answeredAtRef.current = derived.answeredAt;
  const refs = useRef({ tree, stack, meta, derived, store, args });
  refs.current = { tree, stack, meta, derived, store, args };
  const titleOfKey = useCallback((key: string) =>
    displayTitleOf(refs.current.tree.byKey.get(key), refs.current.meta.index).title, []);

  // ── Question writes: retried, and never rolled back (question-write-retry.ts) ──
  /** Questions whose write has not landed yet, mirrored in localStorage. */
  const unsavedRef = useRef<UnsavedQuestion[]>([]);
  const flushing = useRef(false);
  const laterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const setUnsaved = useCallback((sid: string, list: UnsavedQuestion[]) => {
    if (sid === sessionRef.current) unsavedRef.current = list;
    writeUnsavedQuestions(sid, list);
  }, []);
  const settleUnsaved = useCallback((sid: string, record: { threadAnchors?: { msgId: string }[] }) => {
    if (sid !== sessionRef.current) return;
    const left = withoutSaved(unsavedRef.current, record.threadAnchors);
    const saved = unsavedRef.current.filter((q) => !left.includes(q));
    if (saved.length === 0) return;
    setUnsaved(sid, left);
    refs.current.meta.clearUnsaved?.(saved.flatMap((q) => q.meta.map((e) => e.headId)));
    log.info('threads', 'unsaved questions written', { sessionId: sid, headIds: saved.map((q) => q.anchor.msgId), left: left.length });
  }, [setUnsaved]);

  /** Write every unsaved question again, with the same retries. The anchor
   *  list is a whole-list write, so it is built from a FRESH read of the record
   *  (after a reload the panel may not have the record yet) plus the unsaved
   *  anchors it lacks; their meta rides in the same PATCH. */
  const flushUnsaved = useCallback((why: string) => {
    const sid = sessionRef.current;
    if (flushing.current || unsavedRef.current.length === 0) return;
    flushing.current = true;
    log.info('threads', 'writing unsaved questions', { sessionId: sid, why, count: unsavedRef.current.length });
    void retryWrite(async () => {
      const fresh = await fetchSession(sid);
      if (!fresh) throw new Error('session record not found');
      const stored = fresh.threadAnchors ?? [];
      const missing = unsavedRef.current.filter((q) => !stored.some((x) => x.msgId === q.anchor.msgId));
      if (missing.length === 0) return fresh;
      return updateSession(sid, {
        thread_anchors: [...stored, ...missing.map((q) => q.anchor)],
        thread_meta: unsavedMeta(missing),
      });
    }, { stop: () => sid !== sessionRef.current }).then(
      (record) => { refs.current.meta.adoptRecord(record); settleUnsaved(sid, record); },
      (err) => log.warn('threads', 'unsaved questions still not written', { sessionId: sid, why, error: String(err) }),
    ).finally(() => { flushing.current = false; });
  }, [settleUnsaved]);

  // Page load / session switch: questions a failed write left behind come back
  // on screen and are written again.
  useEffect(() => {
    const kept = readUnsavedQuestions(sessionId);
    unsavedRef.current = kept;
    if (kept.length === 0) return;
    refs.current.store.restoreUnsaved(kept.map((q) => q.anchor));
    refs.current.meta.restoreUnsaved?.(unsavedMeta(kept));
    flushUnsaved('load');
  }, [sessionId, flushUnsaved]);
  useEvent('_ws:reconnected', () => flushUnsaved('reconnect'));
  // A slow timer while anything is unsaved (the stall that failed it may be long).
  useEffect(() => () => { if (laterTimer.current) clearTimeout(laterTimer.current); }, [sessionId]);
  const flushLater = useCallback(() => {
    if (laterTimer.current) clearTimeout(laterTimer.current);
    laterTimer.current = setTimeout(() => {
      laterTimer.current = null;
      if (unsavedRef.current.length === 0) return;
      flushUnsaved('later');
      flushLater();
    }, QUESTION_WRITE_LATER_MS);
  }, [flushUnsaved]);

  /**
   * Stage the anchor (and meta), send ONE PATCH for both, settle both. The PATCH
   * is an idempotent upsert, so it is retried; if every try fails the question
   * stays on screen as unsaved (its message goes out regardless, so dropping
   * the anchor would strand the question and send the next follow-up typed in
   * its card to the main conversation) and is written again later.
   */
  const persistAnchor = useCallback((anchor: SessionThreadAnchor, metaEntries: SessionThreadMetaPatch[]) => {
    const r = refs.current;
    const sid = sessionId;
    const a = r.store.stage(anchor);
    const m = metaEntries.length > 0 ? r.meta.stage(metaEntries) : null;
    // Recorded first, so a reload in the middle of the retries still knows it.
    setUnsaved(sid, withUnsaved(unsavedRef.current, { anchor, meta: metaEntries, at: Date.now() }));
    // Each try sends the NEWEST anchor list (a whole-list write: a retry carrying
    // the list from before a later question would delete that one), and earlier
    // unsaved questions' meta rides along (their anchors are in the list already).
    const own = m ? m.body.thread_meta : [];
    const bodyNow = () => {
      const carried = unsavedMeta(unsavedRef.current.filter((q) => q.anchor.msgId !== anchor.msgId));
      const meta = [...carried, ...own];
      return { thread_anchors: sid === sessionRef.current ? refs.current.store.current() : a.body.thread_anchors, ...(meta.length ? { thread_meta: meta } : {}) };
    };
    void retryWrite(() => updateSession(sid, bodyNow()), {
      stop: () => sid !== sessionRef.current,
      onRetry: (attempt, err) => log.warn('threads', 'question write failed, retrying', { sessionId: sid, headId: anchor.msgId, attempt, error: String(err) }),
    }).then(
      (record) => { a.confirm(); m?.confirm(record); settleUnsaved(sid, record); },
      (err) => {
        log.warn('threads', 'question write failed, kept as unsaved', { sessionId: sid, headId: anchor.msgId, error: String(err) });
        a.keep();
        m?.keep();
        flushLater();
      },
    );
  }, [sessionId, setUnsaved, settleUnsaved, flushLater]);

  /**
   * One send path for the composer (spec 5.4, 7.2).
   *  - Root page: a plain send; when the newest turn is in a question, the text
   *    leads with `(Back to the main conversation)` (composeOrientedText).
   *  - Pending page (the first send of an Ask): a pre-assigned uuid names the
   *    row before it exists, the text quotes the passage (composeAnchoredText),
   *    the anchor and the question's meta go out in ONE PATCH, and the page
   *    becomes the question in place.
   *  - Question page: a follow-up under the same anchor, oriented by title when
   *    the newest turn is elsewhere.
   * Without `crypto.randomUUID` the message still goes, without an anchor.
   */
  const sendAnchored = useCallback(async (
    message: string, images: ImageAttachment[] | undefined, interrupt: boolean, targetKey?: string,
  ): Promise<boolean> => {
    const r = refs.current;
    const dispatch = interrupt ? r.args.interruptSend : r.args.send;
    const s = r.stack.api;
    // Tree Mode: the page on screen. Conversation Mode: the card's question when
    // the card sends (`targetKey`), else the question quoted into the chat.
    const live = r.stack.active;
    const want = targetKey ?? (viewModeRef.current === 'linear'
      ? composerKeyOf(quotedRef.current, r.tree, s.pending, s.draftPages) : s.currentKey);
    const key = live ? want : ROOT_THREAD_KEY;
    const pending = live ? pendingPageOf(key, s.pending, s.draftPages) : undefined;
    const latestKey = r.tree.latestKey;
    if (key === ROOT_THREAD_KEY) {
      const text = keepCommandFirst(message, (t) => composeOrientedText(t, { latestKey, currentKey: ROOT_THREAD_KEY, titleOfKey }));
      // A pre-assigned uuid files the optimistic row on root in the tree at
      // once, so the NEXT send (a follow-up on a question page, another root
      // send) is oriented against this turn before history catches up (C58).
      const userUuid = live ? newUserUuid() : undefined;
      return userUuid ? dispatch(sessionId, text, images, { userUuid }) : dispatch(sessionId, text, images);
    }
    const node = pending ? undefined : r.tree.byKey.get(key);
    const parent = pending?.parentMsgId ?? node?.parent;
    const quote = pending ? pending.quote : node?.quote;
    // A file question's line rides every turn's anchor, so the tree keeps it
    // when the head row is the one history has not caught up with.
    const line = pending ? pending.line : node?.file?.line;
    const userUuid = newUserUuid();
    if (!userUuid || !parent) {
      log.warn('threads', 'sending without a question anchor', { sessionId, hasUuid: !!userUuid });
      return dispatch(sessionId, message, images);
    }
    const at = new Date().toISOString();
    const anchor: SessionThreadAnchor = {
      msgId: userUuid, parent, ...(quote ? { quote } : {}), ...(line ? { line } : {}), source: pending ? 'selection' : 'manual', at,
    };
    let text: string;
    const metaEntries: SessionThreadMetaPatch[] = [];
    // The question's NUMBER rides the message as a leading banner asking for
    // the `[Q<n>]` reply tag: a new question takes the next free number (stored
    // in its meta), a follow-up reuses its question's.
    if (pending) {
      const seq = nextQuestionSeq(r.tree, r.meta.index, r.meta.list);
      text = keepCommandFirst(message, (t) => withQuestionBanner(
        composeAnchoredText(t, { parent, ...(quote ? { quote } : {}), ...(line ? { line } : {}), source: 'selection', label: pending.title }, latestKey), seq,
      ));
      metaEntries.push({ headId: userUuid, status: 'open', titleState: 'pending', question: message.slice(0, 400), seq });
    } else {
      const seq = questionNumbers(r.tree, r.meta.index).get(key);
      text = keepCommandFirst(message, (t) => {
        const oriented = composeOrientedText(t, { latestKey, currentKey: key, titleOfKey });
        return seq ? withQuestionBanner(oriented, seq) : oriented;
      });
      if (node && statusOf(node, r.meta.index) === 'older') metaEntries.push({ headId: node.headId, status: 'open' });
    }
    persistAnchor(anchor, metaEntries);
    if (pending) {
      r.stack.promotePending(threadKeyOf(anchor), pending.pageKey);
      // The chat's composer stays on the question it asked.
      if (quotedRef.current === pending.pageKey) {
        const asked = threadKeyOf(anchor);
        if (!r.tree.byKey.has(asked)) setBorn({ key: asked, head: userUuid });
        setQuotedKey(asked);
      }
    }
    // Asking is looking at it: its answer turns the mark red only if it lands
    // while the question is off screen.
    const head = pending ? userUuid : node?.headId;
    if (head) r.stack.markHeadViewed(head);
    noteAsked(pending ? threadKeyOf(anchor) : key);
    log.info('threads', pending ? 'question sent' : 'follow-up sent', { sessionId, headId: pending ? userUuid : node?.headId, rowId: userUuid });
    const sent = dispatch(sessionId, text, images, { userUuid });
    if (pending) {
      const stack = r.stack;
      sent.then((ok) => stack.settlePending(pending, ok), () => stack.settlePending(pending, false));
    }
    return sent;
  }, [sessionId, titleOfKey, persistAnchor, noteAsked]);

  /** Retry (spec 5.10): the unanswered question again, same anchor, new uuid. */
  const retry = useCallback((key: string) => {
    const r = refs.current;
    const node = r.tree.byKey.get(key);
    const text = r.derived.lastQuestion.get(key);
    const userUuid = newUserUuid();
    if (!node?.parent || !text || !userUuid) return;
    persistAnchor({
      msgId: userUuid, parent: node.parent, ...(node.quote ? { quote: node.quote } : {}), source: 'manual', at: new Date().toISOString(),
    }, []);
    log.info('threads', 'retry', { sessionId, headId: node.headId, rowId: userUuid });
    r.stack.markHeadViewed(node.headId);
    noteAsked(key);
    void r.args.send(sessionId, text, undefined, { userUuid });
  }, [sessionId, persistAnchor, noteAsked]);

  const requestPinJump = useCallback((pinKey: string, threadKey: string) => {
    const s = refs.current.stack.api;
    if (threadKey !== s.currentKey) s.pushTo(threadKey, 'pin');
    setPinJump((prev) => ({ pinKey, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const [headJump, setHeadJump] = useState<{ threadKey: string; seq: number } | null>(null);
  const requestHeadJump = useCallback((threadKey: string) => {
    const s = refs.current.stack.api;
    if (threadKey !== s.currentKey) s.pushTo(threadKey, 'drawer');
    setHeadJump((prev) => ({ threadKey, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  /** The comment card's box: into the card's question (the stack's key). */
  const sendToTarget = useCallback(
    (text: string) => sendAnchored(text, undefined, false, refs.current.stack.api.currentKey), [sendAnchored]);

  const markViewedNow = useCallback((key: string) => {
    const r = refs.current;
    r.stack.markViewed(key, r.derived.answeredAt.get(key));
  }, []);

  /** Quote a question into the chat: its composer writes there until × (or a Quote of a passage). */
  const quoteInChat = useCallback((key: string, via: string) => {
    setQuotedKey(key === ROOT_THREAD_KEY ? null : key);
    log.info('threads', 'question quoted into the chat', { sessionId, key, via });
    refs.current.args.focusComposer();
  }, [sessionId]);
  const clearQuote = useCallback((via: string, opts?: { keepDraft?: boolean }) => {
    const q = quotedRef.current;
    if (!q) return;
    const r = refs.current;
    // ×: the words typed go with the reader. A passage quoted into the main
    // conversation instead leaves the question's words with the question.
    if (!opts?.keepDraft) {
      const typed = r.args.composer.text();
      const rootKey = composerDraftKey(sessionId, ROOT_THREAD_KEY, r.tree);
      const carried = carriedRootDraft(readDraft(rootKey), typed);
      if (carried.trim()) writeDraft(rootKey, carried);
      // The question's own copy goes once the composer has moved off its key:
      // the composer saves its last keystrokes under the old key as it moves
      // (ChatInput's key change), which would bring the words back there.
      leftKey.current = composerDraftKey(sessionId, q, r.tree);
    }
    setQuotedKey(null);
    quotedRef.current = null;
    // A quoted Ask not sent yet goes with it, wherever it is (on the path, or a
    // draft since another card opened), as an Ask closed with nothing written.
    if (isPendingKey(q) && !opts?.keepDraft) r.stack.api.dropDraft(q, 'quote-clear');
    log.info('threads', 'quoted question let go', { sessionId, key: q, via });
  }, [sessionId]);
  const leftKey = useRef<string | null>(null);
  // Runs after the composer's own key-change effect (a child's effects run first).
  useEffect(() => {
    const k = leftKey.current;
    if (!k || quotedKey !== null) return;
    leftKey.current = null;
    clearDraft(k);
  }, [quotedKey]);

  // The comment card as a shared surface (SessionThreadsContext): the timeline
  // owns and draws it; the Files tab asks for it and lends it a host box.
  const [openCardKey, publishOpenCardKey] = useState<string | null>(null);
  const [cardRequest, setCardRequest] = useState<ThreadCardRequest | null>(null);
  const requestCard = useCallback((key: string | null, via: string) => {
    setCardRequest((prev) => ({ key, via, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const [fileCardHost, setFileCardHostState] = useState<FileCardHost | null>(null);
  const setFileCardHost = useCallback((host: FileCardHost | null) => {
    setFileCardHostState((prev) => {
      if (prev === host) return prev;
      if (prev && host && prev.el === host.el && prev.path === host.path && samePlace(prev.place, host.place)) return prev;
      return host;
    });
  }, []);
  useEffect(() => { publishOpenCardKey(null); setCardRequest(null); setFileCardHostState(null); }, [sessionId]);

  // The question on screen: Tree Mode's page; in Conversation Mode the open
  // card (its target stays set with the card closed, and is then not looked at).
  const viewingKey = viewMode === 'linear' ? openCardKey ?? ROOT_THREAD_KEY : stack.api.currentKey;
  const unreadKeys = useMemo(
    () => unreadKeysOf(tree, derived.answeredAt, stack.lastViewedAt, viewingKey),
    [tree, derived.answeredAt, stack.lastViewedAt, viewingKey],
  );
  // Viewed when it comes on screen, when it leaves, and when an answer lands
  // while it is on screen (so a reload after that finds it read).
  const viewingAnsweredAt = derived.answeredAt.get(viewingKey);
  const lastViewing = useRef(ROOT_THREAD_KEY);
  useEffect(() => { lastViewing.current = ROOT_THREAD_KEY; }, [sessionId]);
  useEffect(() => {
    const r = refs.current;
    const prev = lastViewing.current;
    lastViewing.current = viewingKey;
    if (prev !== viewingKey) r.stack.markViewed(prev, r.derived.answeredAt.get(prev));
    r.stack.markViewed(viewingKey, viewingAnsweredAt);
  }, [viewingKey, viewingAnsweredAt]);

  // The paint of every passage mark (thread-mark-state.ts), one Map identity
  // while nothing changes (the marks re-derive on a new one).
  const markStatesRef = useRef<ReadonlyMap<string, ThreadMarkState>>(new Map());
  const markStates = useMemo(() => {
    const next = markStatesOf({
      tree, live: derived.live, spoke: derived.spoke ?? EMPTY_KEYS, answeredAt: derived.answeredAt,
      datedAt: derived.datedAt ?? EMPTY_TIMES, sentKeys: derived.sentKeys ?? EMPTY_KEYS,
      queuedKeys: derived.queuedKeys ?? EMPTY_KEYS, unsentKeys: derived.unsentKeys ?? EMPTY_KEYS,
      lastViewedAt: stack.lastViewedAt, viewingKey, askedAt,
      isResolved: (node) => statusOf(node, meta.index) === 'resolved',
    });
    if (!sameMarkStates(markStatesRef.current, next)) markStatesRef.current = next;
    return markStatesRef.current;
  }, [tree, derived, stack.lastViewedAt, viewingKey, askedAt, meta.index]);

  const api = useMemo<SessionThreadsApi>(() => ({
    anchors: store.anchors,
    add: store.add,
    remove: store.remove,
    tree,
    setTree,
    viewMode,
    setViewMode,
    currentThreadKey: stack.active ? stack.api.currentKey : ROOT_THREAD_KEY,
    stack: stack.api,
    metaIndex: meta.index,
    hiddenKeys,
    actions,
    derived,
    publishDerived: setDerived,
    unreadKeys,
    markStates,
    openDrawer: stack.drawer.open,
    revealInTree: stack.drawer.reveal,
    retry,
    pinJump,
    requestPinJump,
    headJump,
    requestHeadJump,
    sendToTarget,
    quotedKey,
    quoteInChat,
    clearQuote,
    markViewed: markViewedNow,
    openCardKey,
    publishOpenCardKey,
    cardRequest,
    requestCard,
    fileCardHost,
    setFileCardHost,
    canAsk: args.canAsk,
  }), [store.anchors, store.add, store.remove, tree, viewMode, setViewMode, stack.enabled, stack.api, meta.index,
    hiddenKeys, actions, derived, unreadKeys, markStates, stack.drawer.open, stack.drawer.reveal, retry, pinJump, requestPinJump,
    headJump, requestHeadJump, sendToTarget, quotedKey, quoteInChat, clearQuote, markViewedNow, openCardKey, cardRequest, requestCard, fileCardHost, setFileCardHost, args.canAsk]);

  // The drawer and its toggle need a real question; a draft-only session keeps
  // its draft row on the page it was asked from (SessionChatHistory).
  const hasQuestions = tree.threads.length > 1;
  const threadCount = useMemo(() => threadCounts(tree, meta.index, args.pins, derived.live, hiddenKeys),
    [tree, meta.index, args.pins, derived.live, hiddenKeys]);
  const hiddenCount = useMemo(() => {
    const heads = new Set(tree.threads.map((n) => n.headId));
    return meta.list.filter((m) => m.hidden && heads.has(m.headId)).length;
  }, [tree, meta.list]);
  // The composer's key: Tree Mode's page, Conversation Mode's quoted question.
  const bornNow = viewMode === 'linear' && !!born && quotedKey === born.key && !tree.byKey.has(born.key) ? born : null;
  const pageKey = !stack.active ? ROOT_THREAD_KEY
    : bornNow ? bornNow.key
      : viewMode === 'linear' ? composerKeyOf(quotedKey, tree, stack.api.pending, stack.api.draftPages)
        : stack.api.currentKey;
  const composerPending = pendingPageOf(pageKey, stack.api.pending, stack.api.draftPages);
  const composerPlaceholder = !stack.active || pageKey === ROOT_THREAD_KEY ? undefined
    : composerPending ? ASK_PLACEHOLDER
      : followUpPlaceholder(displayTitleOf(tree.byKey.get(pageKey), meta.index).title);
  // Tree Mode's page already says which question it is; Conversation Mode shows
  // one timeline, so the composer names where its send goes, and lets go of it.
  // An Ask not sent yet is named by its passage (the fallback title is cut short).
  const pendingTitle = composerPending
    ? composerPending.quote?.exact?.replace(/\s+/g, ' ').trim() || composerPending.title : undefined;
  const targetNumber = pageKey === ROOT_THREAD_KEY || pendingTitle !== undefined ? undefined
    : questionNumbers(tree, meta.index).get(pageKey);
  const composerTarget = useMemo<ComposerTarget | undefined>(() => {
    if (viewMode !== 'linear' || pageKey === ROOT_THREAD_KEY) return undefined;
    if (pendingTitle !== undefined) return { key: pageKey, title: pendingTitle, pending: true };
    if (!tree.byKey.has(pageKey)) return undefined;
    return {
      key: pageKey,
      title: displayTitleOf(tree.byKey.get(pageKey), meta.index).title,
      ...(targetNumber !== undefined ? { number: targetNumber } : {}),
      pending: false,
    };
  }, [viewMode, pageKey, pendingTitle, tree, meta.index, targetNumber]);

  return {
    api, stack, meta, counts: threadCount, hasQuestions, hiddenCount, toast, toastRef, sendAnchored,
    ...(composerPlaceholder ? { composerPlaceholder } : {}),
    // A question is keyed by its head row: the one just sent already has it.
    draftKey: bornNow ? `${composerDraftKey(sessionId, ROOT_THREAD_KEY, tree)}:${bornNow.head}` : composerDraftKey(sessionId, pageKey, tree),
    draftKeptOnReload: true,
    ...(composerTarget ? { composerTarget } : {}),
  };
}
