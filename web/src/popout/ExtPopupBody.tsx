/**
 * The toolbar popup on Ask (PopoutExtPanel with `surface=popup`): the asks to continue, then a
 * composer about the page. The popup closes as soon as focus leaves it, so no conversation lives
 * here: a question, or a picked ask, goes to the side panel (the extension page opens it and hands
 * the question over, sidepanel.ts), where the conversation runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { useAskObjectDraft } from '@/components/chat/useAskObjectDraft';
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { ContinueRow, ExtComposerChips } from './ExtAskChrome';
import { toParent } from './ext-frame';
import { log } from '@/utils/log';
import { composerPlaceholderOf, selectionLeftOutOnSwitch, type PanelPage } from './ext-panel-model';
import { sessionOfTask } from './useExtAsks';
import type { KeptAsk } from './ext-continue-kept';

/** As many as fit over the composer in the popup's 560 px. */
const CONTINUE_MAX = 5;

const noop = () => { /* a plain chat has no folder, project or task fields */ };
const known = () => true;

/**
 * The recent asks to continue, newest first: the popup's body, and the side panel's New chat over
 * its composer, so both open the same way. While the board loads, the rows of the last open
 * (`kept`) show in their places, and the real ones replace them; the loading line shows only with
 * none kept.
 */
export function ContinueList({ rows, kept, max, loading, onPick, className = '' }: { rows: DrawerRow[]; kept: readonly KeptAsk[]; max: number; loading: boolean; onPick: (id: string, sessionId?: string) => void; className?: string }) {
  const shown = rows.slice(0, max);
  const old = loading && shown.length === 0 ? kept.slice(0, max) : [];
  if (!shown.length && !old.length && !loading) return null;
  return (
    <div className={`ext-continue ${className}`.trim()} data-testid="ext-continue" data-rows={old.length ? 'kept' : loading ? 'loading' : 'fresh'}>
      <div className="ext-continue-label">Continue</div>
      {shown.map((row) => <ContinueRow key={row.id} row={row} onPick={() => onPick(row.id, sessionOfTask(row.task) ?? undefined)} />)}
      {old.map((k) => <ContinueRow key={k.id} row={{ id: k.id, title: k.title }} kept={k} onPick={() => onPick(k.id, k.sessionId)} />)}
      {loading && shown.length === 0 && old.length === 0 && <p className="ext-continue-empty"><span className="spinner" /> Loading your asks…</p>}
    </div>
  );
}

export function ExtPopupBody({ rows, kept, page, canAct, loading, agentId, agentName }: { rows: DrawerRow[]; kept: readonly KeptAsk[]; page: PanelPage | null; canAct: boolean; loading: boolean; agentId: string; agentName: string }) {
  const draft = useAskObjectDraft('ext-popup');
  const [pageOn, setPageOn] = useState(true);
  const [actOn, setActOn] = useState(false);
  // The page's selection shows as a quote over the composer, with its own ×, apart from the page
  // chip: what shows is what goes, and a selection that does not show never goes (review 2026-11-06).
  const selection = page?.selection?.trim() ?? '';
  const [leftOut, setLeftOut] = useState('');
  const quote = selection && selection !== leftOut ? selection : '';
  // It follows the page's live selection: cleared there, gone here (the next one shows, the same
  // words too); another agent picked is never offered the selection shown before (ext-panel-model).
  useEffect(() => { if (!selection) setLeftOut(''); }, [selection]);
  const pickedAgent = useRef(agentId);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    if (pickedAgent.current !== agentId) setLeftOut(selectionLeftOutOnSwitch(pickedAgent.current, agentId, selectionRef.current));
    pickedAgent.current = agentId;
  }, [agentId]);

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
      <ContinueList rows={rows} kept={kept} max={CONTINUE_MAX} loading={loading} onPick={(taskId, sessionId) => {
        toParent({ type: 'open-side-panel', open: { taskId, ...(sessionId ? { sessionId } : {}) } });
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
          placeholder={composerPlaceholderOf(agentName, true)}
          composerPill={quotePill}
          composerBar={<ExtComposerChips page={page} pageOn={pageOn} onPage={setPageOn} {...(canAct ? { act: { on: actOn, onToggle: setActOn } } : {})} />}
        />
      </div>
    </div>
  );
}
