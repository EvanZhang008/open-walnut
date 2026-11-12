/**
 * The reading pane of the chat's split (reader-split.tsx has the why): the same
 * SessionChatHistory the panel renders, mounted a second time as a passive reader
 * (`readTimeline`: it fetches nothing, it reads the panel's history and stream),
 * on the page the panel shows. It never follows the tail (`readerPane`), keeps its
 * own reading place, and writes nothing panel-wide: the stack's landings and
 * capture, the tree and the derived states, the card and the Files card host stay
 * the panel timeline's (the same read-only api the Tree Mode pages use).
 *
 * A slim bar on top names it and holds its two controls: the other way (stacked or
 * side by side) and close.
 */
import { memo, useLayoutEffect, useMemo, type ComponentProps } from 'react';
import { SessionThreadsContext, passiveThreadsApi, useSessionThreadsApi, type SessionThreadsApi, type ThreadStackApi } from '@/contexts/SessionThreadsContext';
import { readOnlyLandings } from '@/utils/tree-split-state';
import { ICON_CLOSE } from '@/components/common/Icons';
import { SessionChatHistory } from './SessionChatHistory';
import { TreeHalfContext } from './tree-half-context';
import { SessionReaderContext, ICON_READ_SIDE, ICON_READ_SPLIT } from './reader-split';
import '@/styles/tree-split.css';
import '@/styles/reader-split.css';

type HistoryProps = Omit<ComponentProps<typeof SessionChatHistory>,
  'onMessagesDelivered' | 'onBatchCompleted' | 'onBatchFailed' | 'onDeliveryWaiting' | 'onAgentQueued'
  | 'onStreamingChange' | 'onFolderMoved' | 'scrollToBottomNonce' | 'onRequestComposerFocus' | 'readerPane'>;

export interface SessionReaderPaneProps {
  history: HistoryProps;
  /** Remounts the timeline: a rewind, or a new place to land on (a message's split button). */
  historyKey: string;
  orient: 'stack' | 'side';
  /** Side by side is offered only where the column is wide enough for two. */
  canSide: boolean;
  onOrient: (orient: 'stack' | 'side') => void;
  onClose: () => void;
  /** Writes the place this mount lands on (useReaderSplit's `takeLanding`). */
  takeLanding: () => void;
}

/**
 * Writes the landing before the timeline beside it reads it: a sibling's layout
 * effect runs before the next one's, and after the replaced timeline's unmount.
 */
function ReaderLanding({ seq, take }: { seq: string; take: () => void }) {
  useLayoutEffect(() => { take(); }, [seq, take]);
  return null;
}

const NOOP = () => {};

/** The panel's question api, read-only: the pane reads the page, never records on it. */
function useReaderThreads(base: SessionThreadsApi): SessionThreadsApi {
  const baseLandings = base.stack.landings;
  const landings = useMemo(() => readOnlyLandings(baseLandings), [baseLandings]);
  const stack = useMemo<ThreadStackApi>(() => ({ ...base.stack, landings, setCapture: NOOP, samePassageKey: null }), [base.stack, landings]);
  return useMemo(() => passiveThreadsApi(base, stack), [base, stack]);
}

export const SessionReaderPane = memo(function SessionReaderPane(p: SessionReaderPaneProps) {
  const base = useSessionThreadsApi();
  const threads = useReaderThreads(base);
  const other = p.orient === 'stack' ? 'side' : 'stack';
  return (
    <div className={`session-reader-pane is-${p.orient}`} data-testid="session-reader-pane">
      <div className="session-reader-bar">
        <span className="session-reader-title">Reading</span>
        <span className="session-reader-hint">{p.orient === 'side' ? 'stays here while you ask on the right' : 'stays here while you ask below'}</span>
        {p.canSide && (
          <button
            type="button"
            className="session-reader-btn"
            data-testid="session-reader-orient"
            onClick={() => p.onOrient(other)}
            title={other === 'side' ? 'Side by side' : 'One above the other'}
            aria-label={other === 'side' ? 'Show side by side' : 'Show one above the other'}
          >{other === 'side' ? ICON_READ_SIDE : ICON_READ_SPLIT}</button>
        )}
        <button
          type="button"
          className="session-reader-btn"
          data-testid="session-reader-close"
          onClick={p.onClose}
          title="Close the split"
          aria-label="Close the split"
        >{ICON_CLOSE}</button>
      </div>
      <div className="session-reader-body">
        <SessionThreadsContext.Provider value={threads}>
          <TreeHalfContext.Provider value={null}>
            <SessionReaderContext.Provider value={null}>
              <ReaderLanding seq={p.historyKey} take={p.takeLanding} />
              <SessionChatHistory key={p.historyKey} {...p.history} readerPane />
            </SessionReaderContext.Provider>
          </TreeHalfContext.Provider>
        </SessionThreadsContext.Provider>
      </div>
    </div>
  );
});
