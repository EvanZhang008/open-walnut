/**
 * A narrow board's opened card (spec 3.0): there is no column beside the board
 * to peek in, so the task REPLACES the board in the same pane. `Back` (or
 * Escape) returns to the board with its scroll and folds as they were (the
 * board stays mounted under this view, hidden). Shows the whole card: title,
 * chips, status, the full summary, waiting on, last activity, and at least
 * everything the card offers (N20): the linked ticket, the session on Home, a
 * message, Complete, and More (Move to lane, the editors). There is no column
 * beside a narrow board, so it never offers to open the task beside it.
 *
 * R3-05: under that header the TASK itself: its session as a real chat (the
 * host's renderSession, so this module never imports SessionPanel), or, with no
 * session, its description and open subtasks (KanbanDetailTask).
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ICON_CHAT, ICON_CHECK, ICON_NEW_TAB } from '@/components/common/Icons';
import { TagChip } from '@/components/tasks/TagChip';
import { useTagDisplay } from '@/stores/tag-display-store';
import { READ_ONLY_TITLE } from './kanban-contract';
import type { KanbanCardVM } from './kanban-card-model';
import { KanbanCardComposer } from './KanbanCardComposer';
import { KanbanCardContext } from './KanbanCard';
import { KanbanCardEditor } from './KanbanCardEditor';
import { KanbanCardMenu } from './KanbanCardMenu';
import { KanbanCardPrompt } from './KanbanCardPrompt';
import { KanbanDetailTask } from './KanbanDetailTask';

/** The host's real session chat for a card opened in place (SessionPanel's inset mode). */
export type KanbanRenderSession = (sessionId: string, opts: { onClose(): void }) => ReactNode;

export interface KanbanCardDetailProps {
  card: KanbanCardVM;
  laneName: string;
  readOnly: boolean;
  onBack(): void;
  onOpenSession(taskId: string, sessionId?: string): void;
  onSeen(taskId: string): void;
  renderSession?: KanbanRenderSession;
}

export function KanbanCardDetail({ card, laneName, readOnly, onBack, onOpenSession, onSeen, renderSession }: KanbanCardDetailProps) {
  const inline = !!(card.sessionId && renderSession);
  const backRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const ctx = useContext(KanbanCardContext);
  const { compiled: tagDisplay } = useTagDisplay();
  const [composer, setComposer] = useState(false);
  const [sent, setSent] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editor, setEditor] = useState<{ field: 'summary' | 'waiting_on'; openedAt: string } | null>(null);
  const openEditor = (field: 'summary' | 'waiting_on') => {
    const raw = ctx?.getCard(card.taskId);
    setEditor({ field, openedAt: (field === 'summary' ? raw?.summary_at : raw?.waiting_on_at) ?? '' });
  };
  useEffect(() => { backRef.current?.focus(); onSeen(card.taskId); }, [card.taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && (t as HTMLInputElement).value.trim()) return;
      if (document.querySelector('.task-kebab-menu, [role="menu"]')) return;
      e.preventDefault();
      onBack();
    };
    // Capture: the full screen sheet's document listener would otherwise close the Board first.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack]);

  return (
    <div className={`kanban-card-detail${inline ? ' has-session' : ''}`} data-testid="kanban-card-detail" data-task-id={card.taskId} role="region" aria-label={card.title}>
      <div className="kanban-detail-bar">
        <button ref={backRef} type="button" className="kanban-text-btn kanban-detail-back" data-testid="kanban-detail-back" onClick={onBack}>Back</button>
        <span className="kanban-detail-lane">{laneName}</span>
      </div>
      <h3 className="kanban-detail-title" title={card.title}>{card.title}</h3>
      {(card.ticket || card.sev) && (
        <div className="kanban-card-ids">
          {card.ticket && (
            <span className="kanban-card-ticket" data-testid="kanban-detail-ticket">
              <TagChip tag={card.ticket.tag} inline whole valueOnly href={tagDisplay.linkFor(card.ticket.tag)} />
            </span>
          )}
          {card.sev && <span className={`kanban-card-sev kanban-sev-${card.sev === '1' ? '1' : card.sev === '2' ? '2' : 'other'}`}>Sev {card.sev}</span>}
        </div>
      )}
      <div className={`kanban-card-status kanban-tone-${card.status.tone} kanban-detail-status`} data-tone={card.status.tone} title={card.status.tooltip}>
        <span className="kanban-card-dot" aria-hidden="true" /><span className="kanban-card-status-text">{card.status.text}</span>
      </div>
      {card.status.prompt && <div className="kanban-card-prompt"><KanbanCardPrompt request={card.status.prompt} onAnswered={() => onSeen(card.taskId)} /></div>}
      {editor ? (
        <div className="kanban-card-editor">
          <KanbanCardEditor field={editor.field} card={card} openedAt={editor.openedAt} api={ctx!.api} onClose={() => { setEditor(null); moreRef.current?.focus(); }} />
        </div>
      ) : card.summary && <p className={`kanban-detail-summary${inline ? ' is-clamped' : ''}`} data-testid="kanban-detail-summary" title={card.summary.tooltip}>{card.summary.text}</p>}
      {card.waiting?.kind === 'text' && <div className="kanban-card-waiting"><span className="kanban-card-waiting-label">Waiting on</span> {card.waiting.text}</div>}
      <div className="kanban-card-foot"><span title={card.foot.activeTooltip}>{sent ? 'Sent' : card.foot.activeText}</span>{card.foot.stale && <span className="kanban-card-stale">{card.foot.stale}</span>}</div>
      <div className="kanban-detail-actions">
        <button type="button" className="btn btn-sm" data-testid="kanban-detail-open" onClick={() => onOpenSession(card.taskId, card.sessionId)}>
          <span aria-hidden="true">{ICON_NEW_TAB}</span> {card.hasSession ? 'Open session' : 'Open the task'}
        </button>
        {!inline && <button type="button" className="btn btn-sm" data-testid="kanban-detail-message" aria-disabled={readOnly || !card.hasSession || undefined}
          title={readOnly ? READ_ONLY_TITLE : card.hasSession ? 'Message the worker' : 'No session yet. Use Start worker.'}
          onClick={() => { if (!readOnly && card.hasSession) setComposer(true); }}>
          <span aria-hidden="true">{ICON_CHAT}</span> Message
        </button>}
        {!card.isComplete && (
          <button type="button" className="btn btn-sm" data-testid="kanban-detail-complete" aria-disabled={readOnly || undefined}
            title={readOnly ? READ_ONLY_TITLE : 'Complete this task'} onClick={() => { if (!readOnly) void ctx?.api.completeTask(card.taskId); }}>
            <span aria-hidden="true">{ICON_CHECK}</span> Complete
          </button>
        )}
        {ctx && (
          <button ref={moreRef} type="button" className="btn btn-sm" data-testid="kanban-detail-more" aria-haspopup="menu" aria-expanded={menu}
            title="Move to lane, edit summary, more" onClick={() => setMenu((v) => !v)}>More</button>
        )}
      </div>
      {menu && ctx && (
        <KanbanCardMenu
          card={card} anchor={{ kind: 'button', from: 'kebab' }} triggerRef={moreRef} lanes={ctx.lanes} api={ctx.api}
          onEdit={openEditor} onClose={(back) => { setMenu(false); if (back) moreRef.current?.focus(); }}
        />
      )}
      {composer && <KanbanCardComposer card={card} onSent={() => { setComposer(false); setSent(true); onSeen(card.taskId); }} onClose={() => setComposer(false)} />}
      {inline && card.sessionId ? (
        <div className="kanban-detail-session" data-testid="kanban-detail-session" data-session-id={card.sessionId}>
          {renderSession!(card.sessionId, { onClose: onBack })}
        </div>
      ) : <KanbanDetailTask taskId={card.taskId} />}
    </div>
  );
}
