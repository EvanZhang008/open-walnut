import { createContext, useContext } from 'react';
import type { SessionThreadAnchor } from '@/types/session';
import {
  emptyThreadTree, type ComposerThreadAnchor, type ThreadTree,
} from '@/utils/thread-tree';
import type { SessionViewMode } from '@/hooks/useSessionThreads';

/**
 * Conversation threads for the open session: the anchors, the tree derived from
 * them, and the composer's sticky anchor.
 *
 * Context rather than props for the same reason `SessionPinsContext` exists — the
 * surfaces that read this (the timeline's row wrapper, the outline rail, the
 * composer chip) sit on opposite sides of a memoized message tree.
 *
 * The TREE is computed where the loaded transcript lives (SessionChatHistory) and
 * published back up through `setTree`, because the anchors live on the session
 * record (SessionPanel) while the rows they point at live in the history hook.
 * One owner for the state, one owner for the computation.
 */
export interface SessionThreadsApi {
  anchors: SessionThreadAnchor[];
  /** Record (or replace) the anchor for one user message. */
  add: (anchor: SessionThreadAnchor) => void;
  /** Drop one user message's anchor — that turn returns to the top level. */
  remove: (msgId: string) => void;
  /** Derived structure. Empty until the timeline publishes one. */
  tree: ThreadTree;
  /** Publish a freshly derived tree (timeline → panel). */
  setTree: (tree: ThreadTree) => void;
  /** What the NEXT send hangs off. null = top level. */
  composerAnchor: ComposerThreadAnchor | null;
  setComposerAnchor: (anchor: ComposerThreadAnchor | null) => void;
  /** Thread the pointer is over in the outline — tints that thread's rows. */
  hoverThreadKey: string | null;
  setHoverThreadKey: (key: string | null) => void;
  /** Timeline or node view, per session. */
  viewMode: SessionViewMode;
  setViewMode: (mode: SessionViewMode) => void;
  /**
   * The thread the NODE VIEW is showing ('' = top level). Meaningless in linear
   * mode, where every thread is on screen at once.
   *
   * State here rather than in the timeline that navigates, because in tree mode the
   * composer's anchor is DERIVED from this key (see SessionPanel's
   * `effectiveAnchor`): the chip, the send path and the back-reference line must
   * read one value, or they disagree about where a message is going — which is the
   * one thing the node view exists to make obvious.
   */
  currentThreadKey: string;
  setCurrentThreadKey: (key: string) => void;
  /**
   * Is a real store behind this api? FALSE for the stub, and the gate for every
   * Ask affordance.
   *
   * Same contract as `canPinQuote`: a timeline mounted without a session record to
   * PATCH (the side-question drawer) must not offer an "Ask" that silently
   * records nothing.
   */
  canAsk: boolean;
}

const EMPTY: SessionThreadsApi = {
  anchors: [],
  add: () => {},
  remove: () => {},
  tree: emptyThreadTree(),
  setTree: () => {},
  composerAnchor: null,
  setComposerAnchor: () => {},
  hoverThreadKey: null,
  setHoverThreadKey: () => {},
  viewMode: 'linear',
  setViewMode: () => {},
  currentThreadKey: '',
  setCurrentThreadKey: () => {},
  canAsk: false,
};

export const SessionThreadsContext = createContext<SessionThreadsApi>(EMPTY);

/**
 * The inert api, for a timeline mounted INSIDE a panel that owns a different
 * session's threads (the side-question drawer). Without it that timeline would read
 * the parent's anchors, publish its own tree over the parent's, and — in tree mode —
 * filter its rows by the parent's current thread while writing that key back.
 * Same role as `SessionPinsContext`'s stub, for the same reason.
 */
export const NO_THREADS: SessionThreadsApi = EMPTY;

export function useSessionThreadsApi(): SessionThreadsApi {
  return useContext(SessionThreadsContext);
}
