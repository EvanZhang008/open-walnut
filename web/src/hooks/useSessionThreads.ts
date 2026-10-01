import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { updateSession } from '@/api/sessions';
import type { ImageAttachment } from '@/api/chat';
import type { SessionPinnedMessage, SessionThreadAnchor, SessionThreadMeta, SessionThreadMetaPatch } from '@/types/session';
import {
  EMPTY_DERIVED, type SessionThreadsApi, type ThreadDerived,
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
import { composerDraftKey, unreadKeysOf } from '@/utils/thread-stack-state';
import { nextQuestionSeq, questionNumbers, withQuestionBanner } from '@/utils/question-tag';
import { log } from '@/utils/log';

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
}

export interface SessionThreadsStore {
  anchors: SessionThreadAnchor[];
  /** Record (or replace) the anchor for one user message. */
  add: (anchor: SessionThreadAnchor) => void;
  /** Drop the anchor for one user message — that turn returns to the top level. */
  remove: (msgId: string) => void;
  /** Optimistically add `anchor` now; the caller sends `body` and settles it. */
  stage: (anchor: SessionThreadAnchor) => ThreadAnchorStage;
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

  const adopt = useCallback((next: SessionThreadAnchor[]) => {
    listRef.current = next;
    setAnchors(next);
  }, []);

  // Session switch: adopt the new session's list outright (never carry anchors across).
  useEffect(() => {
    inFlight.current = 0;
    wroteLocally.current = false;
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
      confirm: () => { if (done()) confirmed.current = next; },
      rollback: () => {
        if (!done()) return;
        log.warn('threads', 'thread anchor save failed, reverting', { sessionId });
        adopt(confirmed.current);
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

  const remove = useCallback((msgId: string) => {
    const current = listRef.current;
    if (!current.some((a) => a.msgId === msgId)) return;
    persist(current.filter((a) => a.msgId !== msgId));
  }, [persist]);

  return useMemo(() => ({ anchors, add, remove, stage }), [anchors, add, remove, stage]);
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
  sendAnchored: (message: string, images: ImageAttachment[] | undefined, interrupt: boolean) => Promise<boolean>;
  composerPlaceholder?: string;
  draftKey: string;
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
  useEffect(() => {
    setTreeState(emptyThreadTree()); setHistoryComplete(false); setDerived(EMPTY_DERIVED); setPinJump(null);
  }, [sessionId]);
  const hiddenKeys = useMemo(() => hiddenKeysOf(tree, meta.index), [tree, meta.index]);

  // The toast lives INSIDE the panel (its provider wraps this panel's markup),
  // so the actions reach it through a ref the bridge fills.
  const toastRef = useRef<ThreadToastApi | null>(null);
  const toast = useMemo<ThreadToastApi>(() => ({
    show: (t) => toastRef.current?.show(t),
    dismiss: () => toastRef.current?.dismiss(),
  }), []);

  const stack = useThreadStack({
    sessionId, tree, anchors: store.anchors, hiddenKeys, metaIndex: meta.index, panelRef: args.panelRef,
    stackView: viewMode === 'stack', composer: args.composer, toast, focusComposer: args.focusComposer,
    historyComplete,
  });
  const actions = useThreadActions({
    sessionId, tree, meta, toast, nav: stack.bridge,
    lastAnswerOf: (key) => derived.lastAnswer.get(key),
    answeringKeys: derived.answering,
  });

  const refs = useRef({ tree, stack, meta, derived, store, args });
  refs.current = { tree, stack, meta, derived, store, args };
  const titleOfKey = useCallback((key: string) =>
    displayTitleOf(refs.current.tree.byKey.get(key), refs.current.meta.index).title, []);

  /** Stage the anchor (and meta), send ONE PATCH for both, settle both. */
  const persistAnchor = useCallback((anchor: SessionThreadAnchor, metaEntries: SessionThreadMetaPatch[]) => {
    const r = refs.current;
    const a = r.store.stage(anchor);
    const m = metaEntries.length > 0 ? r.meta.stage(metaEntries) : null;
    updateSession(sessionId, { ...a.body, ...(m ? m.body : {}) }).then(
      (record) => { a.confirm(); m?.confirm(record); },
      (err) => {
        log.warn('threads', 'question write failed, rolling back', { sessionId, headId: anchor.msgId, error: String(err) });
        a.rollback();
        m?.rollback();
      },
    );
  }, [sessionId]);

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
    message: string, images: ImageAttachment[] | undefined, interrupt: boolean,
  ): Promise<boolean> => {
    const r = refs.current;
    const dispatch = interrupt ? r.args.interruptSend : r.args.send;
    const s = r.stack.api;
    // Both views: in Conversation Mode the path is the composer's target.
    const live = r.stack.active;
    const key = live ? s.currentKey : ROOT_THREAD_KEY;
    const pending = live && s.pending?.pageKey === key ? s.pending : undefined;
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
    const userUuid = newUserUuid();
    if (!userUuid || !parent) {
      log.warn('threads', 'sending without a question anchor', { sessionId, hasUuid: !!userUuid });
      return dispatch(sessionId, message, images);
    }
    const at = new Date().toISOString();
    const anchor: SessionThreadAnchor = {
      msgId: userUuid, parent, ...(quote ? { quote } : {}), source: pending ? 'selection' : 'manual', at,
    };
    let text: string;
    const metaEntries: SessionThreadMetaPatch[] = [];
    // The question's NUMBER rides the message as a leading banner asking for
    // the `[Q<n>]` reply tag: a new question takes the next free number (stored
    // in its meta), a follow-up reuses its question's.
    if (pending) {
      const seq = nextQuestionSeq(r.tree, r.meta.index, r.meta.list);
      text = keepCommandFirst(message, (t) => withQuestionBanner(
        composeAnchoredText(t, { parent, ...(quote ? { quote } : {}), source: 'selection', label: pending.title }, latestKey), seq,
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
    if (pending) r.stack.promotePending(threadKeyOf(anchor));
    log.info('threads', pending ? 'question sent' : 'follow-up sent', { sessionId, headId: pending ? userUuid : node?.headId, rowId: userUuid });
    return dispatch(sessionId, text, images, { userUuid });
  }, [sessionId, titleOfKey, persistAnchor]);

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
    void r.args.send(sessionId, text, undefined, { userUuid });
  }, [sessionId, persistAnchor]);

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

  /** The comment card's composer: the same send the panel's composer makes. */
  const sendToTarget = useCallback((text: string) => sendAnchored(text, undefined, false), [sendAnchored]);

  const unreadKeys = useMemo(
    () => unreadKeysOf(tree, derived.answeredAt, stack.lastViewedAt, stack.api.currentKey),
    [tree, derived.answeredAt, stack.lastViewedAt, stack.api.currentKey],
  );

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
    openDrawer: stack.drawer.open,
    revealInTree: stack.drawer.reveal,
    retry,
    pinJump,
    requestPinJump,
    headJump,
    requestHeadJump,
    sendToTarget,
    canAsk: args.canAsk,
  }), [store.anchors, store.add, store.remove, tree, viewMode, setViewMode, stack.enabled, stack.api, meta.index,
    hiddenKeys, actions, derived, unreadKeys, stack.drawer.open, stack.drawer.reveal, retry, pinJump, requestPinJump,
    headJump, requestHeadJump, sendToTarget, args.canAsk]);

  // The drawer and its toggle need a real question; a draft-only session keeps
  // its draft row on the page it was asked from (SessionChatHistory).
  const hasQuestions = tree.threads.length > 1;
  const threadCount = useMemo(() => threadCounts(tree, meta.index, args.pins, derived.live, hiddenKeys),
    [tree, meta.index, args.pins, derived.live, hiddenKeys]);
  const hiddenCount = useMemo(() => {
    const heads = new Set(tree.threads.map((n) => n.headId));
    return meta.list.filter((m) => m.hidden && heads.has(m.headId)).length;
  }, [tree, meta.list]);
  const pageKey = stack.active ? stack.api.currentKey : ROOT_THREAD_KEY;
  const composerPlaceholder = !stack.active || pageKey === ROOT_THREAD_KEY ? undefined
    : stack.api.pending?.pageKey === pageKey ? ASK_PLACEHOLDER
      : followUpPlaceholder(displayTitleOf(tree.byKey.get(pageKey), meta.index).title);

  return {
    api, stack, meta, counts: threadCount, hasQuestions, hiddenCount, toast, toastRef, sendAnchored,
    ...(composerPlaceholder ? { composerPlaceholder } : {}),
    draftKey: composerDraftKey(sessionId, pageKey, tree),
  };
}
