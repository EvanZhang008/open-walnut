/**
 * Types shared by the stack (P3), the tree drawer (P4) and the foundation (P1).
 * Types only: no runtime code, so any component can import it without pulling a
 * module graph along. Changes here are ADDITIVE only (peers compile against it).
 */
import type { RefObject } from 'react';
import type { SessionPinnedMessage, SessionPinnedQuote, SessionThreadMeta, SessionThreadMetaPatch } from '@/types/session';
import type { SessionPinsApi } from '@/contexts/SessionPinsContext';
import type { SessionViewMode } from '@/hooks/useSessionThreads';
import type { ThreadNode, ThreadTree } from '@/utils/thread-tree';
import type { ThreadCounts, ThreadLiveState, ThreadMetaIndex, ThreadViewStatus } from '@/utils/thread-meta';

export type { ThreadCounts, ThreadLiveState, ThreadMetaIndex, ThreadViewStatus };

/** Why a navigation happened (logged, and it picks the landing/flash rule). */
export type ThreadNavVia =
  | 'back' | 'sliver' | 'crumb' | 'esc' | 'done' | 'done-chain' | 'undo' | 'remove'
  | 'drawer' | 'asked-from' | 'mark' | 'pin' | 'restore' | 'same-passage' | 'reload'
  | (string & {});

/** What the actions need from the stack. P3 implements it. */
export interface ThreadNavBridge {
  /** Key of the page on screen (ROOT_THREAD_KEY at the root). */
  currentKey: string;
  depth: number;
  pushTo: (key: string, via: ThreadNavVia) => void;
  popTo: (key: string, via: ThreadNavVia) => void;
  /** `key` was just hidden: pop to its nearest visible ancestor and land on the
   *  passage `key` came from. No-op when neither the page nor an ancestor of it
   *  is `key`. */
  popToVisibleAncestor: (key: string) => void;
}

/** A left pending page with text in its composer (`New question (draft)`). */
export interface ThreadDraftRow {
  pageKey: string;
  parentKey: string;
  label: string;
}

/** The page pushed by Ask before its first send (nothing persisted yet). */
export interface ThreadPendingPage {
  /** `pending:<parentMsgId>:<quote hash>` (also the composer draft key). */
  pageKey: string;
  /** Thread key of the page it was asked from. */
  parentKey: string;
  /** msgId of the reply the passage is in. */
  parentMsgId: string;
  quote?: SessionPinnedQuote;
  /** Fallback title shown with `Naming…`. */
  title: string;
}

export type ThreadDrawerMode = 'closed' | 'peek' | 'open';
export type ThreadDrawerFilter = 'all' | 'open' | 'pinned';

// ── Toast ──

export interface ThreadToastAction {
  label: string;
  run: () => void;
}

export interface ThreadToastInput {
  text: string;
  action?: ThreadToastAction;
  /** Visible time; hover pauses it. */
  ms: number;
}

export interface ThreadToastApi {
  /** Replaces any toast on screen (the old action counts as committed). */
  show: (toast: ThreadToastInput) => void;
  dismiss: () => void;
}

// ── Meta store (useSessionThreadMeta) ──

export interface ThreadMetaStage {
  /** Merge into the ONE PATCH body the send builds (anchors + meta). */
  body: { thread_meta: SessionThreadMetaPatch[] };
  /** The PATCH answered 2xx with this record. */
  confirm: (record: { threadMeta?: SessionThreadMeta[]; threadAnchors?: { msgId: string }[] }) => void;
  /** The PATCH failed: undo exactly these entries. */
  rollback: () => void;
}

export interface ThreadMetaStore {
  list: SessionThreadMeta[];
  index: ThreadMetaIndex;
  /** Optimistic merge in this frame, then PATCH; false (and rolled back, with
   *  `failText` shown by the caller) when the write failed. */
  patch: (entries: SessionThreadMetaPatch[], opts?: { failText?: string }) => Promise<boolean>;
  /** Optimistic merge now; the caller sends the body and settles it. */
  stage: (entries: SessionThreadMetaPatch[]) => ThreadMetaStage;
  /** Adopt a record returned by a PATCH that carried meta (confirmed copy). */
  adoptRecord: (record: { threadMeta?: SessionThreadMeta[] }) => void;
}

// ── Actions (useThreadActions) ──

export interface ThreadActions {
  /** Resolve; pops when `key` is the page on screen. Undo in the toast. */
  done: (key: string) => Promise<boolean>;
  /** `Done, back to start`: this and every open ancestor through depth 1. */
  doneChain: (key: string) => Promise<boolean>;
  /** `Mark all done`: this and its visible open descendants. */
  doneWithFollowUps: (key: string) => Promise<boolean>;
  reopen: (key: string) => Promise<boolean>;
  /** `Not yet` on a suggested question: back to open, never suggested again. */
  notYet: (key: string) => Promise<boolean>;
  /** Hide from the question views (the transcript keeps every message). */
  remove: (key: string) => Promise<boolean>;
  restore: (key: string) => Promise<boolean>;
  /** '' clears the user title. Capped at 120 chars. */
  rename: (key: string, text: string) => Promise<boolean>;
  /** Capped at 280 chars; the AI never overwrites it after this. */
  editTakeaway: (key: string, text: string) => Promise<boolean>;
  /** `Mark older questions done`: one PATCH, Undo back to older. */
  markOlderDone: (keys: string[]) => Promise<boolean>;
  /** Visible open (or suggested) descendants: `Also mark <N> follow-ups done?`. */
  openBelowCount: (key: string) => number;
  /** Visible descendants: `Remove this question and <N> follow-ups?`. */
  visibleDescendantCount: (key: string) => number;
  /** Keys of every visible `older` question (the `<n> older questions` row). */
  olderKeys: () => string[];
}

// ── Props of the P4 components P3 mounts ──

export interface ThreadDrawerToggleProps {
  counts: ThreadCounts;
  expanded: boolean;
  narrow: boolean;
  onToggle: () => void;
}

export interface ThreadTreeDrawerProps {
  sessionId: string;
  panelRef: RefObject<HTMLElement | null>;
  tree: ThreadTree;
  index: ThreadMetaIndex;
  meta: ThreadMetaStore;
  pins: SessionPinnedMessage[];
  pinsApi: SessionPinsApi;
  live: ReadonlyMap<string, ThreadLiveState>;
  drafts: ThreadDraftRow[];
  pending?: ThreadPendingPage;
  currentKey: string;
  unreadKeys: ReadonlySet<string>;
  /** Thread key to when (ms) its newest answer landed. */
  answeredAt: ReadonlyMap<string, number>;
  mode: ThreadDrawerMode;
  setMode: (mode: ThreadDrawerMode) => void;
  /** Bumped by `Show in tree`: expand ancestors, scroll the current row in, pulse. */
  revealNonce: number;
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
  actions: ThreadActions;
  onNavigate: (key: string, via: ThreadNavVia) => void;
  onJumpPin: (pinKey: string, threadKey: string) => void;
  initialFilter?: ThreadDrawerFilter;
}

export interface ThreadStackHeaderProps {
  sessionId: string;
  /** Root first, the page on screen last. */
  path: ThreadNode[];
  pending?: ThreadPendingPage;
  index: ThreadMetaIndex;
  live: ReadonlyMap<string, ThreadLiveState>;
  panelWidth: number;
  actions: ThreadActions;
  onBack: () => void;
  onPopTo: (key: string) => void;
  onShowInTree: () => void;
  onShowAllInOrder: () => void;
  /** Bumped by the menu's `Rename…`: the title turns into an input. */
  renameNonce: number;
}

/** `key` is reserved by React, so the question's key travels as `threadKey`. */
export interface ThreadStackMenuProps {
  variant: 'page' | 'root';
  threadKey?: string;
  visibleDescendants: number;
  hiddenCount: number;
  viewMode: SessionViewMode;
  actions: ThreadActions;
  onShowInTree: () => void;
  onShowAllInOrder: () => void;
  onBackToQuestions: () => void;
  onShowHidden: () => void;
  onRename?: () => void;
}

export interface ThreadResolvedStripProps {
  threadKey: string;
  meta?: SessionThreadMeta;
  viewStatus: ThreadViewStatus;
  /** Done while the answer streamed: `Summarizing when the answer finishes`. */
  takeawayWaiting: boolean;
  actions: ThreadActions;
  /** Failed page (spec 5.10): re-send the unanswered question on its anchor. */
  onRetry?: () => void;
  /** The page's last message never left the queue (parked): it was not sent,
   *  and its own row carries Retry / Discard, so the strip says so and offers
   *  no second Retry (N41). */
  parked?: boolean;
}
