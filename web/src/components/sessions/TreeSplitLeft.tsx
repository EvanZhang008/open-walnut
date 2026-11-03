/**
 * The left half of Tree Mode's split screen (design 4): the right page's parent
 * (the level its question was asked in, Main included), its own timeline and
 * its own composer.
 *
 * The timeline is the same SessionChatHistory the panel renders, mounted a
 * second time under a PINNED question api: the stack it reads is the panel's,
 * with the page on screen set to the left page, so it filters, marks and lands
 * exactly like the page would on its own. Everything panel-wide stays with the
 * panel's own timeline: the tree and the derived states it publishes, the
 * stack's landing capture, card / pin / head jumps, the Files card host, the
 * optimistic bubbles' bookkeeping (those callbacks are not passed here). A
 * navigation it asks for (a mark, an Asked-from row, an Ask) is the panel
 * stack's, so a question opened from the left half lands on the right.
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
 */
import { memo, useCallback, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { ChatInput } from '@/components/chat/ChatInput';
import { MacAwayComposer } from '@/components/layout/AwayLine';
import { SessionThreadsContext, useSessionThreadsApi, type SessionThreadsApi, type ThreadStackApi, type ThreadStackNav } from '@/contexts/SessionThreadsContext';
import { SessionChatHistory } from './SessionChatHistory';
import { TreeHalfContext, type TreeHalf } from './tree-half-context';
import { followUpPlaceholder } from '@/hooks/useSessionThreads';
import { composerDraftKey } from '@/utils/thread-stack-state';
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
  leftKey: string;
  rightKey: string;
  number?: string;
  onClose: () => void;
  /** The half's composer box (the panel's Esc probe reads it). */
  composerWrapRef: RefObject<HTMLDivElement | null>;
  mentionCwd?: string;
  mentionHost?: string;
  /** The panel's composer send into the left page's question (SessionPanel's sendFor + withComments). */
  onSend: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onInterruptSend: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onStop: () => void;
  isStreaming: boolean;
  /** The Mac runs this session and is away: sending waits (MacAwayComposer). */
  sendBlocked: boolean;
  /** Pending quotes and comments are a message by themselves. */
  allowEmptySend: boolean;
}

/** The panel's question api with the left page as the page on screen. */
function usePinnedThreads(base: SessionThreadsApi, leftKey: string, rightKey: string): SessionThreadsApi {
  // A landing per pair: the half lands on the passage the right page hangs off.
  const pair = `${leftKey}\n${rightKey}`;
  const seq = useRef({ pair: '', n: 0 });
  if (seq.current.pair !== pair) seq.current = { pair, n: seq.current.n + 1 };
  const n = seq.current.n;
  const nav = useMemo<ThreadStackNav>(() => ({
    seq: n, from: rightKey, to: leftKey, direction: 'pop', via: 'split-left', popped: [rightKey], firstEntry: false,
  }), [n, leftKey, rightKey]);
  const pathSig = base.stack.path.join('\n');
  const path = useMemo(() => {
    const at = base.stack.path.indexOf(leftKey);
    return at >= 0 ? base.stack.path.slice(0, at + 1) : [ROOT_THREAD_KEY];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through its signature
  }, [pathSig, leftKey]);
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
    // A passage here is on the left page, whatever the right page is.
    ask: (target, opts) => base.stack.ask(target, { ...opts, onScreenKey: leftKey }),
  }), [base.stack, landings, path, leftKey, nav]);
  return useMemo<SessionThreadsApi>(() => ({
    ...base,
    stack,
    currentThreadKey: leftKey,
    setTree: NOOP,
    publishDerived: NOOP,
    publishOpenCardKey: NOOP,
    cardRequest: null,
    pinJump: null,
    headJump: null,
    fileCardHost: null,
    setFileCardHost: NOOP,
    sendToTarget: (text: string, images?: ImageAttachment[]) => base.sendToQuestion(leftKey, text, images),
  }), [base, stack, leftKey]);
}

export const TreeSplitLeft = memo(function TreeSplitLeft(p: TreeSplitLeftProps) {
  const base = useSessionThreadsApi();
  const pinned = usePinnedThreads(base, p.leftKey, p.rightKey);
  const half = useMemo<TreeHalf>(() => ({ side: 'L', ...(p.number ? { number: p.number } : {}), onClose: p.onClose }), [p.number, p.onClose]);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);
  const requestFocus = useCallback(() => setFocusNonce((x) => x + 1), []);
  const sessionId = p.history.sessionId;
  const { leftKey } = p;
  const draftKey = composerDraftKey(sessionId, leftKey, base.tree);
  const placeholder = leftKey === ROOT_THREAD_KEY
    ? MAIN_HALF_PLACEHOLDER
    : followUpPlaceholder(displayTitleOf(base.tree.byKey.get(leftKey), base.metaIndex).title);
  const { onSend } = p;
  const send = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean> => {
    const ok = await onSend(text, images);
    if (ok) setScrollNonce((x) => x + 1);
    return ok;
  }, [onSend]);
  return (
    <div className="tree-split-left" data-tree-half="L" data-thread-key={leftKey}>
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
      <div className="session-panel-input tree-split-input" ref={p.composerWrapRef}>
        {p.sendBlocked && <MacAwayComposer />}
        <ChatInput
          onSend={send}
          onInterruptSend={p.onInterruptSend}
          onStop={p.onStop}
          isStreaming={p.isStreaming}
          sendBlocked={p.sendBlocked}
          allowEmptySend={p.allowEmptySend}
          draftKey={draftKey}
          placeholder={placeholder}
          showCommands={false}
          focusNonce={focusNonce}
          mentionCwd={p.mentionCwd}
          mentionHost={p.mentionHost}
          enableEntityMention
          sessionMentionSelfId={sessionId}
        />
      </div>
    </div>
  );
});
