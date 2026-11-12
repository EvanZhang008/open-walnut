/**
 * A page left of the panel's own in Tree Mode's split screen (design 4): a level
 * above the right page on its path (the left page of two; the left or middle
 * page of three; Main included), its own timeline and its own composer.
 *
 * The timeline is the same SessionChatHistory the panel renders, mounted a
 * second time under a PINNED question api: the stack it reads is the panel's,
 * with the page on screen set to the left page, so it filters, marks and lands
 * exactly like the page would on its own. Everything panel-wide stays with the
 * panel's own timeline: the tree and the derived states it publishes, the
 * stack's landing capture, card / pin / head jumps, the Files card host, the
 * optimistic bubbles' bookkeeping (those callbacks are not passed here). A
 * navigation it asks for (a mark, an Asked-from row, an Ask) is the panel
 * stack's, so a question opened from a page beside lands on the right.
 *
 * Coming to a page, the half lands on the passage the right page was asked
 * about (a pop landing from the right page, useThreadLanding), which is flashed;
 * the right page's own mark stays painted there. It reads the panel's page
 * landings and never writes them (ReadOnlyLandings).
 *
 * Its timeline is passive: it reads the panel's history and stream
 * (timeline-share.ts) and fetches nothing itself.
 *
 * Its composer sends through the panel's one composer send (`onSend`: an engine
 * picked for the message, the pending comments, then sendAnchored into the left
 * page's question with its anchor, `question` hint and orientation line), takes
 * the panel's blocked / streaming / stop state, and keeps a draft per question
 * (composerDraftKey). An Ask about a passage here hangs on the left page.
 *
 * The same pane is the sibling page (`side: 'S'`, tree-sibling.ts): a question
 * asked on the same page as the right page's, above it in the right column, its
 * own timeline and composer the same way, with a Swap in its row and the divider
 * under it. Every composer here is the light one (the text box, the mic, send:
 * 2026-11-05, the user: "only main chat have the + the bypass the model
 * selection, other just voice and send"), except Main's, which gets the panel's
 * full controls (`fullComposer`).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { ChatInput } from '@/components/chat/ChatInput';
import { MacAwayComposer } from '@/components/layout/AwayLine';
import { SessionThreadsContext, passiveThreadsApi, useSessionThreadsApi, type SessionThreadsApi, type ThreadStackApi, type ThreadStackNav } from '@/contexts/SessionThreadsContext';
import { SessionChatHistory } from './SessionChatHistory';
import { PendingCommentsTray } from './PendingCommentsTray';
import type { SessionPassageComment } from '@/types/session';
import { TreeHalfContext, type TreeHalf } from './tree-half-context';
import { followUpPlaceholder } from '@/hooks/useSessionThreads';
import { composerDraftKey, stackPathOf } from '@/utils/thread-stack-state';
import { readOnlyLandings } from '@/utils/tree-split-state';
import { displayTitleOf } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY } from '@/utils/thread-tree';

const NOOP = () => {};

export const MAIN_HALF_PLACEHOLDER = 'Message the main conversation\u2026';

type HistoryProps = Omit<ComponentProps<typeof SessionChatHistory>,
  'onMessagesDelivered' | 'onBatchCompleted' | 'onBatchFailed' | 'onDeliveryWaiting' | 'onAgentQueued'
  | 'onStreamingChange' | 'onFolderMoved' | 'scrollToBottomNonce' | 'onRequestComposerFocus'>;

export interface TreeSplitLeftProps {
  history: HistoryProps;
  /** Remounts the timeline with the panel's (a rewind). */
  historyKey: string;
  /** Its grid column (1 = the leftmost) and its badge; the sibling page sits in the right column, on top. */
  column: number;
  side: 'L' | 'M' | 'S';
  /** The page this one shows, and the page right of it (the one asked from it). */
  leftKey: string;
  rightKey: string;
  number?: string;
  /** Its close button (useTreeSplit.closePane); the middle page of three has none. */
  onClose?: (key: string) => void;
  mentionCwd?: string;
  mentionHost?: string;
  /** The panel's composer send into this page's question (SessionPanel's sendFor + withComments). */
  onSendFor: (key: string, text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onInterruptSendFor: (key: string, text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onStop: () => void;
  isStreaming: boolean;
  /** The Mac runs this session and is away: sending waits (MacAwayComposer). */
  sendBlocked: boolean;
  /** The quotes and comments made on this page: they go with its next message. */
  pendingComments: SessionPassageComment[];
  onJumpComment: (id: string) => void;
  onRemoveComment: (id: string) => void;
  /** A move to this page (already on screen): its composer takes the focus. */
  focusSeq: number;
  /** ...and the page flashes, so the reader sees where the move went. */
  flash: boolean;
  /** A move back to the passage the page right of it was asked about: it lands there again. */
  landSeq: number;
  /** Main's page: the panel's full composer controls (the "+" menu, Bypass, the model). */
  fullComposer?: Partial<ComponentProps<typeof ChatInput>>;
  /** The sibling page: where it stands among its siblings, its swap, and the divider under it. */
  where?: string;
  onSwap?: () => void;
  divider?: ReactNode;
}

/** The panel's question api with the left page as the page on screen. */
function usePinnedThreads(base: SessionThreadsApi, leftKey: string, rightKey: string, sibling: boolean, landSeq: number): SessionThreadsApi {
  // A landing per page shown here (and per ask to land again): the page lands
  // on the passage the page right of it hangs off. Only this page's own change
  // lands it: a new page on its right (a sibling swapped in, another question
  // picked a level down) leaves it where the reader has it.
  const pair = `${leftKey}\n${landSeq}`;
  const seq = useRef({ pair: '', n: 0, rightKey });
  if (seq.current.pair !== pair) seq.current = { pair, n: seq.current.n + 1, rightKey };
  const n = seq.current.n;
  const landFrom = seq.current.rightKey;
  // The sibling page is no level of the right page's path: it lands where the
  // reader left it (the panel's record), else at its top.
  const nav = useMemo<ThreadStackNav>(() => (sibling
    ? { seq: n, from: landFrom, to: leftKey, direction: 'none', via: 'sibling', popped: [], firstEntry: false }
    : { seq: n, from: landFrom, to: leftKey, direction: 'pop', via: 'split-left', popped: [landFrom], firstEntry: false }
  ), [n, leftKey, landFrom, sibling]);
  const pathSig = base.stack.path.join('\n');
  const tree = base.tree;
  const path = useMemo(() => {
    const at = base.stack.path.indexOf(leftKey);
    return at >= 0 ? base.stack.path.slice(0, at + 1) : stackPathOf(tree, leftKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through its signature
  }, [pathSig, leftKey, tree]);
  const baseLandings = base.stack.landings;
  const landings = useMemo(() => readOnlyLandings(baseLandings), [baseLandings]);
  const stack = useMemo<ThreadStackApi>(() => ({
    ...base.stack,
    landings,
    path,
    currentKey: leftKey,
    depth: path.length - 1,
    nav,
    // The panel's timeline records where its page was left; this one never does.
    setCapture: NOOP,
    samePassageKey: null,
    // A passage here is on this page, whatever the right page is.
    ask: (target, opts) => base.stack.ask(target, { ...opts, onScreenKey: leftKey, onScreenPath: path }),
    // Up from this page (its quote head), not from the panel's right page.
    back: (via) => {
      const up = path[path.length - 2];
      if (up !== undefined) base.stack.popTo(up, via);
    },
  }), [base.stack, landings, path, leftKey, nav]);
  return useMemo<SessionThreadsApi>(() => ({
    ...passiveThreadsApi(base, stack),
    currentThreadKey: leftKey,
    // A pin on this page lands here (the page beside the panel's own shows it).
    pinJump: base.pinJump,
    sendToTarget: (text: string, images?: ImageAttachment[]) => base.sendToQuestion(leftKey, text, images),
  }), [base, stack, leftKey]);
}

export const TreeSplitLeft = memo(function TreeSplitLeft(p: TreeSplitLeftProps) {
  const base = useSessionThreadsApi();
  const pinned = usePinnedThreads(base, p.leftKey, p.rightKey, p.side === 'S', p.landSeq);
  const { onClose, leftKey: pageKey, onSwap, where } = p;
  const close = useCallback(() => onClose?.(pageKey), [onClose, pageKey]);
  const half = useMemo<TreeHalf>(() => ({
    side: p.side, ...(p.number ? { number: p.number } : {}), ...(onClose ? { onClose: close } : {}),
    ...(where ? { where } : {}), ...(onSwap ? { onSwap } : {}),
  }), [p.side, p.number, onClose, close, where, onSwap]);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);
  const requestFocus = useCallback(() => setFocusNonce((x) => x + 1), []);
  // A move to this page: focus its composer (the timeline stays where it is) and flash it.
  const rootRef = useRef<HTMLDivElement>(null);
  const { focusSeq, flash } = p;
  // Each request once: its number only grows (SessionPanel's paneFocus), so a
  // page that comes back to this place, or mounts, never replays an old one.
  const handledSeq = useRef(focusSeq);
  useEffect(() => {
    if (!focusSeq || focusSeq <= handledSeq.current) return;
    handledSeq.current = focusSeq;
    setFocusNonce((x) => x + 1);
    if (!flash) return;
    rootRef.current?.animate?.(
      [{ boxShadow: 'inset 0 0 0 2px var(--accent)' }, { boxShadow: 'inset 0 0 0 2px transparent' }],
      { duration: 700, easing: 'ease-out' },
    );
  }, [focusSeq, flash]);
  const sessionId = p.history.sessionId;
  const { leftKey } = p;
  const draftKey = composerDraftKey(sessionId, leftKey, base.tree);
  const placeholder = leftKey === ROOT_THREAD_KEY
    ? MAIN_HALF_PLACEHOLDER
    : followUpPlaceholder(displayTitleOf(base.tree.byKey.get(leftKey), base.metaIndex).title);
  const { onSendFor, onInterruptSendFor } = p;
  const send = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean> => {
    const ok = await onSendFor(leftKey, text, images);
    if (ok) setScrollNonce((x) => x + 1);
    return ok;
  }, [onSendFor, leftKey]);
  const interruptSend = useCallback((text: string, images?: ImageAttachment[]) => onInterruptSendFor(leftKey, text, images), [onInterruptSendFor, leftKey]);
  return (
    <div className={`tree-split-left${p.side === 'S' ? ' tree-split-sibling' : ''}`} data-tree-half={p.side} data-thread-key={leftKey} ref={rootRef} style={{ gridColumn: p.column }}>
      <SessionThreadsContext.Provider value={pinned}>
        <TreeHalfContext.Provider value={half}>
          <div className="tree-split-left-body">
            <SessionChatHistory
              key={p.historyKey}
              {...p.history}
              scrollToBottomNonce={scrollNonce}
              onRequestComposerFocus={requestFocus}
            />
          </div>
        </TreeHalfContext.Provider>
      </SessionThreadsContext.Provider>
      <div className="session-panel-input tree-split-input">
        {p.sendBlocked && <MacAwayComposer />}
        <PendingCommentsTray pending={p.pendingComments} onJump={p.onJumpComment} onRemove={p.onRemoveComment} />
        <ChatInput
          onSend={send}
          onInterruptSend={interruptSend}
          fileTarget={{ sessionId }}
          onStop={p.onStop}
          isStreaming={p.isStreaming}
          sendBlocked={p.sendBlocked}
          allowEmptySend={p.pendingComments.length > 0}
          draftKey={draftKey}
          placeholder={placeholder}
          showCommands={false}
          focusNonce={focusNonce}
          mentionCwd={p.mentionCwd}
          mentionHost={p.mentionHost}
          enableEntityMention
          sessionMentionSelfId={sessionId}
          light={!p.fullComposer}
          {...p.fullComposer}
        />
      </div>
      {p.divider}
    </div>
  );
});
