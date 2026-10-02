import { createContext, useContext } from 'react';
import type { SessionPinnedQuote, SessionThreadAnchor } from '@/types/session';
import { emptyThreadTree, type ThreadTree } from '@/utils/thread-tree';
import type { SessionViewMode } from '@/hooks/useSessionThreads';
import type {
  ThreadActions, ThreadDraftRow, ThreadDrawerFilter, ThreadLiveState, ThreadMetaIndex, ThreadNavVia, ThreadPendingPage,
} from '@/components/sessions/thread-ui-contract';
import type { PageLanding } from '@/utils/thread-stack-state';

/** One navigation, as the timeline's landing reads it (nonce'd by `seq`). */
export interface ThreadStackNav {
  seq: number;
  from: string;
  to: string;
  direction: 'push' | 'pop' | 'none';
  via: ThreadNavVia;
  /** Pages popped, deepest first: the landing lands on the passage the
   *  shallowest of them came from. */
  popped: string[];
  /** First time this page is entered (scroll to its top). */
  firstEntry: boolean;
}

/**
 * The question stack of one panel (useThreadStack). Only the page on screen is
 * rendered; its ancestors are the sliver.
 */
export interface ThreadStackApi {
  /** Root first, the page on screen last. */
  path: string[];
  currentKey: string;
  depth: number;
  pending?: ThreadPendingPage;
  nav: ThreadStackNav | null;
  pushTo: (key: string, via: ThreadNavVia) => void;
  popTo: (key: string, via: ThreadNavVia) => void;
  /** One level up (the back button, Esc). */
  back: (via: ThreadNavVia) => void;
  /** Ask on a passage: a pending page, or the question already about it.
   *  `focusComposer: false` leaves focus where it is (the comment card takes it). */
  ask: (target: { msgId: string; quote: SessionPinnedQuote; line?: number }, opts?: { focusComposer?: boolean }) => void;
  /** Where each page was left (page key), shared with the timeline's landing. */
  landings: Map<string, PageLanding>;
  /** The timeline records the page it is leaving (scrollTop + passage top)
   *  right before a navigation changes the rows. */
  setCapture: (fn: ((from: string, to: string, pending?: ThreadPendingPage) => void) | null) => void;
  /** Page key showing `You already asked about this passage.` */
  samePassageKey: string | null;
  /** Pending pages left with text (`New question (draft)`). */
  drafts: ThreadDraftRow[];
  /** The same drafts with their passage (the Asked-from list places them). */
  draftPages: ThreadPendingPage[];
  /** Open a draft row's pending page again. */
  openDraft: (pageKey: string) => void;
  /** Write the stack (path, landings, last viewed) to sessionStorage now. */
  persist: () => void;
}

/** Derived from the loaded transcript by the timeline, published up. */
export interface ThreadDerived {
  live: ReadonlyMap<string, ThreadLiveState>;
  /** Thread key to when its newest answer landed (ms). */
  answeredAt: ReadonlyMap<string, number>;
  /** Thread key to its newest answer's markdown (the fallback takeaway). */
  lastAnswer: ReadonlyMap<string, string>;
  /** Thread key to its newest question's text (Retry sends it again). */
  lastQuestion: ReadonlyMap<string, string>;
  /** Keys whose answer is streaming right now. */
  answering: ReadonlySet<string>;
}

/** Where a comment card sits inside its host box (left/top relative to the host). */
export interface ThreadCardPlace {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * The Files tab lends the comment card a place beside a FILE passage: the file
 * view registers the box the card draws into and keeps `place` measured; the
 * timeline (which owns the card: its turns, live blocks and composer) portals
 * the card there while the open question is about `path`.
 */
export interface FileCardHost {
  path: string;
  el: HTMLElement;
  place: ThreadCardPlace | null;
}

/** "Open (or close, key null) a question's card": what the Files tab, a mark in
 *  a file and the sidebar ask of the timeline, which owns the card. */
export interface ThreadCardRequest {
  key: string | null;
  via: string;
  seq: number;
}

/**
 * Questions for the open session: the anchors, the tree derived from them, the
 * stack on screen, meta and the actions.
 *
 * Context rather than props for the same reason `SessionPinsContext` exists: the
 * surfaces that read this (the timeline, the outline rail, the Asked-from rows)
 * sit on opposite sides of a memoized message tree.
 *
 * The TREE is computed where the loaded transcript lives (SessionChatHistory)
 * and published back up through `setTree`, because the anchors live on the
 * session record (SessionPanel) while the rows they point at live in the
 * history hook. One owner for the state, one owner for the computation.
 */
export interface SessionThreadsApi {
  anchors: SessionThreadAnchor[];
  /** Record (or replace) the anchor for one user message. */
  add: (anchor: SessionThreadAnchor) => void;
  /** Drop one user message's anchor. */
  remove: (msgId: string) => void;
  /** Derived structure. Empty until the timeline publishes one. */
  tree: ThreadTree;
  /** `complete`: the tree was built from the WHOLE transcript (not phase 1 or a
   *  windowed tail), so a page head it lacks is really gone. */
  setTree: (tree: ThreadTree, complete?: boolean) => void;
  viewMode: SessionViewMode;
  setViewMode: (mode: SessionViewMode) => void;
  /** The page on screen ('' = the main conversation). */
  currentThreadKey: string;
  stack: ThreadStackApi;
  metaIndex: ThreadMetaIndex;
  hiddenKeys: ReadonlySet<string>;
  actions: ThreadActions | null;
  derived: ThreadDerived;
  publishDerived: (d: ThreadDerived) => void;
  /** Questions answered since their page was last viewed. */
  unreadKeys: ReadonlySet<string>;
  openDrawer: (filter?: ThreadDrawerFilter) => void;
  /** `Show in tree`: open the drawer on the current row, ancestors expanded. */
  revealInTree: () => void;
  /** Resend the unanswered question of `key` under the same anchor. */
  retry: (key: string) => void;
  /** A pin jump waiting for its page (drawer pin row, off-page rail pin). */
  pinJump: { pinKey: string; seq: number } | null;
  /** Go to the pin's page (through the stack), then land on the pin + flash. */
  requestPinJump: (pinKey: string, threadKey: string) => void;
  /** Conversation Mode: a question picked outside the timeline (the drawer). The
   *  timeline lands on the question's first turn; the stack already holds it as
   *  the composer's target. */
  headJump: { threadKey: string; seq: number } | null;
  requestHeadJump: (threadKey: string) => void;
  /** Send into the composer's target (the comment card's composer): the same
   *  anchored path the panel's composer takes. False when nothing was sent. */
  sendToTarget: (text: string) => Promise<boolean>;
  /** The comment card open in Conversation Mode (its question's key, a pending
   *  page key for a draft), published by the timeline; null when closed. */
  openCardKey: string | null;
  publishOpenCardKey: (key: string | null) => void;
  cardRequest: ThreadCardRequest | null;
  requestCard: (key: string | null, via: string) => void;
  fileCardHost: FileCardHost | null;
  setFileCardHost: (host: FileCardHost | null) => void;
  /**
   * Is a real store behind this api? FALSE for the stub, and the gate for every
   * Ask affordance: a timeline mounted without a session record to PATCH (the
   * side-question drawer) must not offer an Ask that silently records nothing.
   */
  canAsk: boolean;
}

const NOOP = () => {};
const EMPTY_MAP: ReadonlyMap<string, never> = new Map<string, never>();
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export const EMPTY_DERIVED: ThreadDerived = {
  live: EMPTY_MAP, answeredAt: EMPTY_MAP, lastAnswer: EMPTY_MAP, lastQuestion: EMPTY_MAP, answering: EMPTY_SET,
};

export const NO_STACK: ThreadStackApi = {
  path: [''],
  currentKey: '',
  depth: 0,
  nav: null,
  pushTo: NOOP,
  popTo: NOOP,
  back: NOOP,
  ask: NOOP,
  landings: new Map(),
  setCapture: NOOP,
  samePassageKey: null,
  drafts: [],
  draftPages: [],
  openDraft: NOOP,
  persist: NOOP,
};

const EMPTY: SessionThreadsApi = {
  anchors: [],
  add: NOOP,
  remove: NOOP,
  tree: emptyThreadTree(),
  setTree: NOOP,
  viewMode: 'linear',
  setViewMode: NOOP,
  currentThreadKey: '',
  stack: NO_STACK,
  metaIndex: new Map(),
  hiddenKeys: EMPTY_SET,
  actions: null,
  derived: EMPTY_DERIVED,
  publishDerived: NOOP,
  unreadKeys: EMPTY_SET,
  openDrawer: NOOP,
  revealInTree: NOOP,
  retry: NOOP,
  pinJump: null,
  requestPinJump: NOOP,
  headJump: null,
  requestHeadJump: NOOP,
  sendToTarget: async () => false,
  openCardKey: null,
  publishOpenCardKey: NOOP,
  cardRequest: null,
  requestCard: NOOP,
  fileCardHost: null,
  setFileCardHost: NOOP,
  canAsk: false,
};

export const SessionThreadsContext = createContext<SessionThreadsApi>(EMPTY);

/**
 * The inert api, for a timeline mounted INSIDE a panel that owns a different
 * session's questions (the side-question drawer). Without it that timeline would
 * read the parent's anchors, publish its own tree over the parent's, and filter
 * its rows by the parent's page. Same role as `SessionPinsContext`'s stub.
 */
export const NO_THREADS: SessionThreadsApi = EMPTY;

export function useSessionThreadsApi(): SessionThreadsApi {
  return useContext(SessionThreadsContext);
}
