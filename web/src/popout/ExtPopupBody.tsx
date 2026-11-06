/**
 * The toolbar popup on Ask (PopoutExtPanel with `surface=popup`): the asks to continue, then a
 * composer about the page. The popup closes as soon as focus leaves it, so no conversation lives
 * here: a question, or a picked ask, goes to the side panel (the extension page opens it and hands
 * the question over, sidepanel.ts), where the conversation runs.
 */
import { useCallback, useState } from 'react';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { useAskObjectDraft } from '@/components/chat/useAskObjectDraft';
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { ContinueRow, ExtComposerChips } from './ExtAskChrome';
import { toParent } from './ext-frame';
import { log } from '@/utils/log';
import type { PanelPage } from './ext-panel-model';
import { sessionOfTask } from './useExtAsks';

/** As many as fit over the composer in the popup's 560 px. */
const CONTINUE_MAX = 5;

const noop = () => { /* a plain chat has no folder, project or task fields */ };
const known = () => true;

/**
 * The recent asks to continue, newest first: the popup's body, and the side panel's New chat over
 * its composer, so both open the same way.
 */
export function ContinueList({ rows, max, loading, onPick, className = '' }: { rows: DrawerRow[]; max: number; loading: boolean; onPick: (row: DrawerRow) => void; className?: string }) {
  const shown = rows.slice(0, max);
  if (!shown.length && !loading) return null;
  return (
    <div className={`ext-continue ${className}`.trim()} data-testid="ext-continue">
      <div className="ext-continue-label">Continue</div>
      {shown.map((row) => <ContinueRow key={row.id} row={row} onPick={() => onPick(row)} />)}
      {loading && shown.length === 0 && <p className="ext-continue-empty"><span className="spinner" /> Loading your asks…</p>}
    </div>
  );
}

export function ExtPopupBody({ rows, page, canAct, loading }: { rows: DrawerRow[]; page: PanelPage | null; canAct: boolean; loading: boolean }) {
  const draft = useAskObjectDraft('ext-popup');
  const [pageOn, setPageOn] = useState(true);
  const [actOn, setActOn] = useState(false);
  // The page's selection shows as a quote over the composer, with its own ×, apart from the page
  // chip: what shows is what goes, and a selection that does not show never goes (review 2026-11-06).
  const selection = page?.selection?.trim() ?? '';
  const [leftOut, setLeftOut] = useState('');
  const quote = selection && selection !== leftOut ? selection : '';

  const onStart = useCallback(async (_id: string, text: string): Promise<boolean> => {
    const question = text.trim();
    if (!question) return false;
    log.info('ext-panel', 'question handed to the side panel', { page: !!page && pageOn, act: canAct && actOn, selChars: quote.length });
    toParent({ type: 'open-side-panel', ask: { text: question, page: !!page && pageOn, act: canAct && actOn, ...(quote ? { sel: quote } : {}) } });
    return true;
  }, [page, pageOn, canAct, actOn, quote]);

  const quotePill = quote ? (
    <div className="ext-panel-selection" data-testid="ext-panel-selection">
      <span className="ext-panel-selection-text" title={quote}><span className="ext-panel-selection-label">Selected on the page:</span> {quote}</span>
      <button type="button" className="ext-panel-selection-drop" data-testid="ext-panel-selection-drop" aria-label="Leave the selection out" title="Leave the selection out of the message" onClick={() => setLeftOut(quote)}>&times;</button>
    </div>
  ) : undefined;

  return (
    <div className="ext-popup-body" data-testid="ext-popup-body">
      <ContinueList rows={rows} max={CONTINUE_MAX} loading={loading} onPick={(row) => {
        const sessionId = sessionOfTask(row.task);
        toParent({ type: 'open-side-panel', open: { taskId: row.id, ...(sessionId ? { sessionId } : {}) } });
      }} />
      <div className="ext-popup-composer">
        <DraftSessionPanel
          draft={draft.draft}
          autoFocus
          onStart={onStart}
          onSaveAsTask={noop}
          onClose={noop}
          onPathChange={noop}
          onProjectChange={noop}
          onMetaChange={draft.onMetaChange}
          isKnownProject={known}
          plainChat
          placeholder="Ask Walnut, or ask it to do something here…"
          composerPill={quotePill}
          composerBar={<ExtComposerChips page={page} pageOn={pageOn} onPage={setPageOn} {...(canAct ? { act: { on: actOn, onToggle: setActOn } } : {})} />}
        />
      </div>
    </div>
  );
}
