/**
 * One kanban card (spec 6): title, ticket and sev chips, the live status line
 * (a prompt answers in place, a board signal opens the Page, a done lane's open
 * task completes inline, no session starts a worker), the summary (click
 * expands it), the waiting on row (wait lanes only), the leader's suggestion,
 * the foot (activity, stale, changed, unread) with the action bar on hover or
 * focus inside the foot row, the composer and the editors.
 *
 * React.memo: the board keeps a card's view model object while its content is
 * the same, so a session update re-renders only its own card (G36). Everything
 * the card calls back through is in a stable context.
 */
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ICON_CHAT, ICON_CHECK, ICON_NEW_TAB } from '@/components/common/Icons';
import { TagChip } from '@/components/tasks/TagChip';
import { useTagDisplay } from '@/stores/tag-display-store';
import type { BoardCard, BoardLane } from '../../../../../src/core/boards/board-lanes';
import type { ProjectOf } from '../board-view-projects';
import { READ_ONLY_TITLE, type KanbanMode, type KanbanWriteApi } from './kanban-contract';
import type { KanbanCardVM } from './kanban-card-model';
import { KanbanCardMenu, type CardMenuAnchor } from './KanbanCardMenu';
import { KanbanCardPrompt } from './KanbanCardPrompt';
import { KanbanCardEditor } from './KanbanCardEditor';
import { KanbanCardComposer } from './KanbanCardComposer';
import { KanbanCardStart } from './KanbanCardStart';

export interface KanbanCardCtx {
  api: KanbanWriteApi;
  ownerId: string;
  mode: KanbanMode;
  lanes: readonly BoardLane[];
  leader: { taskId: string; title: string; sessionId?: string };
  getCard(taskId: string): BoardCard | undefined;
  /** Click or Enter: the task beside the board (wide) or in place (narrow). */
  openTask(taskId: string): void;
  openSession(taskId: string, sessionId?: string): void;
  /** A red board signal: the Page, scrolled to the choice or thread. */
  openSignal(target: { kind: 'choice' | 'thread'; id: string }): void;
  markSeen(taskId: string): void;
  /** G9: hold the layout while this reason is on. */
  /** G9: hold the lane this card is drawn in (no scope holds every lane). */
  hold(reason: string, on: boolean, scope?: { lane?: string; card?: string }): void;
  /** Roving tabindex and the card keys (arrows, Ctrl+arrows, Space). Returns true when it handled the key. */
  cardKey(e: KeyboardEvent<HTMLDivElement>, taskId: string, laneId: string): boolean;
  focused(taskId: string, laneId: string): void;
  reducedMotion: boolean;
  /** Each card's board project, and the one the board is filtered to (null = none). */
  projectOf: ProjectOf;
  projectFilter: string | null;
  toggleProject(projectId: string): void;
}

export const KanbanCardContext = createContext<KanbanCardCtx | null>(null);

export interface KanbanCardProps {
  vm: KanbanCardVM;
  laneName: string;
  /** This lane's one Tab stop. */
  tabStop: boolean;
  /** G13: matched when the chip was turned on, no longer matches. */
  handled?: boolean;
  /** G9: just moved by a released freeze. */
  moved?: boolean;
  /** A Show or a changed flash (1.2s). */
  flash?: boolean;
  /** Rendered in the DragOverlay (no handlers, no drag). */
  overlay?: boolean;
  /** N3: a keyboard drag holds this card: drawn as the placeholder a pointer drag leaves. */
  lifted?: boolean;
  /** The lane it is DRAWN in (a held layout can differ from vm.lane for up to 400ms). */
  drawnIn?: string;
}

/** Text that changes at most once per `ms` (the last value wins). */
export function useThrottled(text: string, ms: number, on: boolean): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!on) { setShown(text); last.current = Date.now(); return; }
    const wait = last.current + ms - Date.now();
    if (wait <= 0) { setShown(text); last.current = Date.now(); return; }
    const t = setTimeout(() => { setShown(text); last.current = Date.now(); }, wait);
    return () => clearTimeout(t);
  }, [text, ms, on]);
  return on ? shown : text;
}

/** Render counter per card (tests read it to prove one status update renders one card, C96). */
function countRender(taskId: string): void {
  const w = window as unknown as { __kanbanCardRenders?: Record<string, number> };
  (w.__kanbanCardRenders ??= {})[taskId] = (w.__kanbanCardRenders[taskId] ?? 0) + 1;
}

const INTERACTIVE = 'button, a, input, textarea, select, [role="radio"], [role="menuitem"], [data-no-open]';
const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]';

/**
 * G35: a card is ONE Tab stop. Its own controls (ticket link, prompt toggle,
 * Start, the action bar) leave the Tab order until focus is inside the card
 * (a click, or ArrowRight from the card); Tab then walks them and moves on.
 */
function useInnerTabOrder(root: { current: HTMLElement | null }, inside: boolean): void {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    for (const c of Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))) {
      if (c === el || c.closest('.kanban-card-composer-host, .kanban-card-editor')) continue;
      c.tabIndex = inside ? 0 : -1;
    }
  });
}
const cutAt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the draggable shell hands the card body: identities dnd-kit keeps stable for every card it is not dragging. */
interface CardDragProps {
  dragAttributes: ReturnType<typeof useDraggable>['attributes'];
  dragListeners: ReturnType<typeof useDraggable>['listeners'];
  setDragNode: (el: HTMLElement | null) => void;
  isDragging: boolean;
}

function KanbanCardInner({ vm, laneName, tabStop, handled, moved, flash, overlay, drawnIn, lifted, dragAttributes, dragListeners, setDragNode, isDragging }: KanbanCardProps & CardDragProps) {
  const at = drawnIn ?? vm.lane;
  const ctx = useContext(KanbanCardContext);
  if (!ctx) throw new Error('KanbanCard needs a KanbanCardContext');
  countRender(vm.taskId);
  const { api } = ctx;
  const ro = api.readOnly;
  const project = ctx.projectOf.get(vm.taskId);
  const { compiled: tagDisplay } = useTagDisplay();
  const [expanded, setExpanded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [composer, setComposer] = useState(false);
  const [editor, setEditor] = useState<{ field: 'summary' | 'waiting_on'; openedAt: string | undefined } | null>(null);
  const [menu, setMenu] = useState<CardMenuAnchor | null>(null);
  const [sent, setSent] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const statusText = useThrottled(vm.status.text, 2000, vm.status.kind === 'running');
  const [inside, setInside] = useState(false);
  useInnerTabOrder(rootRef, inside);
  // A focused card that leaves the DOM (it moved lanes, so it remounts) fires no focusout,
  // and the G9 focus hold would never end. The cleanup runs while the node is still attached.
  useLayoutEffect(() => () => {
    if (!overlay && rootRef.current?.contains(document.activeElement)) ctx.hold('focus', false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const firstInner = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    .find((c) => c !== rootRef.current && c.offsetParent !== null && getComputedStyle(c).visibility !== 'hidden');

  // G9: an open editor, composer, prompt or menu holds this card's lane (N1: that lane only).
  const holding = !overlay && (promptOpen || composer || !!editor || !!menu);
  useEffect(() => {
    if (overlay) return;
    ctx.hold(`card:${vm.taskId}`, holding, { lane: at });
    return () => ctx.hold(`card:${vm.taskId}`, false);
  }, [holding, vm.taskId, overlay]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);
  // A prompt that is gone (answered, withdrawn) closes its panel.
  useEffect(() => { if (!vm.status.prompt) setPromptOpen(false); }, [vm.status.prompt]);

  const openEditor = (field: 'summary' | 'waiting_on') => {
    const raw = ctx.getCard(vm.taskId);
    setEditor({ field, openedAt: (field === 'summary' ? raw?.summary_at : raw?.waiting_on_at) ?? '' });
  };
  const open = () => { ctx.markSeen(vm.taskId); ctx.openTask(vm.taskId); };
  // N10: a closed menu, composer or editor gives focus back to what opened it (the card, or
  // its kebab), never to <body>, where the next Escape would leave the Board. The kebab is
  // hidden until the card holds focus, so the card takes it first.
  const refocus = (kebab: boolean) => {
    rootRef.current?.focus({ preventScroll: true });
    if (kebab) moreRef.current?.focus({ preventScroll: true });
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (overlay || vm.loading) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if ((e.target as HTMLElement).closest('[data-kanban-zone]')) return;
    open();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) {
      if (e.key === 'Escape' && expanded) { setExpanded(false); e.stopPropagation(); }
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'ArrowLeft' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); rootRef.current?.focus(); }
      return;
    }
    if (ctx.cardKey(e, vm.taskId, at)) return;
    if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setInside(true);
      // After the controls rejoin the Tab order (and the action bar shows on focus-within).
      requestAnimationFrame(() => firstInner()?.focus());
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); open(); return; }
    if (e.key === 'Escape' && expanded) { e.preventDefault(); setExpanded(false); return; }
    if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (vm.hasSession && !ro) { e.preventDefault(); setComposer(true); }
      return;
    }
    if (e.key === '.' || (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      setMenu({ kind: 'button', from: 'card' });
    }
  };
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (overlay || vm.loading) return;
    if ((e.target as HTMLElement).closest('a, input, textarea')) return;
    e.preventDefault();
    setMenu({ kind: 'point', x: e.clientX, y: e.clientY });
  };

  const tone = vm.status.tone;
  const status = vm.status;
  // N1: a held lane still draws a card live data moved; it says where it goes, never that it went.
  const movingTo = drawnIn && drawnIn !== vm.lane ? (ctx.lanes.find((l) => l.id === vm.lane)?.name ?? null) : null;
  const change = movingTo ? null : vm.foot.changed;
  // R3-22 (G23): no middle dot joins a time; two sentences.
  const statusLine = handled ? `Handled. ${statusText}` : statusText;
  const promptToggle = !!status.prompt && !overlay;
  const statusClass = `kanban-card-status kanban-tone-${tone}`;
  const rootProps = overlay ? {} : { ...dragAttributes, ...dragListeners };

  if (vm.loading) {
    return (
      <div className="kanban-card kanban-card-is-loading" data-testid="kanban-card-loading" data-task-id={vm.taskId} data-lane={at}>
        <div className="kanban-card-title kanban-skeleton-bar" title={vm.title || 'Loading this task'}>{vm.title || ' '}</div>
      </div>
    );
  }

  return (
    <div
      ref={(el) => { rootRef.current = el; if (!overlay) setDragNode(el); }}
      {...rootProps}
      role="button"
      tabIndex={overlay ? -1 : tabStop ? 0 : -1}
      aria-label={`${vm.title}, ${laneName}, ${statusLine}`}
      aria-roledescription="card"
      className={`kanban-card kanban-card-tone-${tone}${overlay ? ' kanban-card-overlay' : ''}${isDragging || lifted ? ' is-placeholder' : ''}${lifted ? ' is-key-lifted' : ''}${ro ? ' is-read-only' : ''}`}
      data-testid={overlay ? 'kanban-card-drag-overlay' : 'kanban-card'}
      data-task-id={overlay ? undefined : vm.taskId}
      data-lane={at}
      data-source={vm.source}
      data-completed-after-move={vm.completedAfterMove ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      data-handled={handled ? 'true' : undefined}
      data-moved={moved ? 'true' : undefined}
      data-flash={flash && !ctx.reducedMotion ? 'true' : undefined}
      data-changed={vm.changed ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={(e) => { if (e.target === e.currentTarget) { ctx.focused(vm.taskId, at); setInside(false); } else setInside(true); }}
      onBlur={(e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false); }}
      onContextMenu={onContextMenu}
    >
      <div className="kanban-card-title" data-testid="kanban-card-title" title={vm.title}>{vm.title}</div>
      {(vm.ticket || vm.sev || vm.leaderCount || project) && (
        <div className="kanban-card-ids">
          {vm.ticket && (
            <span className="kanban-card-ticket" data-testid="kanban-card-ticket" data-no-open onPointerDown={(e) => e.stopPropagation()}>
              <TagChip tag={vm.ticket.tag} inline whole valueOnly href={tagDisplay.linkFor(vm.ticket.tag)} />
            </span>
          )}
          {vm.sev && <span className={`kanban-card-sev kanban-sev-${vm.sev === '1' ? '1' : vm.sev === '2' ? '2' : 'other'}`} data-testid="kanban-card-sev">Sev {vm.sev}</span>}
          {vm.leaderCount ? <span className="kanban-card-leader-pill" title={`${vm.leaderCount} open subtasks`}>Leader · {vm.leaderCount}</span> : null}
          {project && (
            <button
              type="button"
              className={`kanban-card-project${ctx.projectFilter === project.id ? ' is-active' : ''}`}
              data-testid="kanban-card-project"
              data-project-id={project.id}
              data-no-open
              aria-pressed={ctx.projectFilter === project.id}
              title={ctx.projectFilter === project.id ? `Project: ${project.title}. Show every project's cards` : `Project: ${project.title}. Show only this project's cards`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); if (!overlay) ctx.toggleProject(project.id); }}
            >{project.title}</button>
          )}
        </div>
      )}
      <div className="kanban-card-status-row">
        {promptToggle ? (
          <div className={statusClass} data-testid="kanban-card-status" data-tone={tone} title={status.tooltip}>
            <button
              type="button" className="kanban-card-status-btn" data-testid="kanban-card-prompt-toggle"
              aria-expanded={promptOpen} title={status.tooltip}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setPromptOpen((v) => !v); }}
            ><span className="kanban-card-dot" aria-hidden="true" /><span className="kanban-card-status-text">{statusLine}</span></button>
          </div>
        ) : status.signalTarget && !overlay ? (
          <button
            type="button" className={statusClass} data-testid="kanban-card-status" data-tone={tone} title={status.tooltip}
            onClick={(e) => { e.stopPropagation(); ctx.openSignal(status.signalTarget!); }}
          ><span className="kanban-card-dot" aria-hidden="true" /><span className="kanban-card-status-text">{statusLine}</span></button>
        ) : (
          <div className={statusClass} data-testid="kanban-card-status" data-tone={tone} title={status.tooltip}>
            <span className="kanban-card-dot" aria-hidden="true" /><span className="kanban-card-status-text">{statusLine}</span>
          </div>
        )}
        {status.kind === 'still-open' && !overlay && (
          <button type="button" className="kanban-text-btn" data-testid="kanban-card-complete-inline"
            aria-disabled={ro || undefined} title={ro ? READ_ONLY_TITLE : 'Complete this task'}
            onClick={(e) => { e.stopPropagation(); if (!ro) void api.completeTask(vm.taskId); }}>Complete</button>
        )}
      </div>
      {status.kind === 'no-session' && !overlay && !vm.isComplete && (
        <div className="kanban-card-start-row" data-kanban-zone><KanbanCardStart card={vm} leader={ctx.leader} laneName={laneName} /></div>
      )}
      {promptOpen && status.prompt && (
        <div className="kanban-card-prompt" data-kanban-zone onPointerDown={(e) => e.stopPropagation()}>
          <KanbanCardPrompt request={status.prompt} onAnswered={() => ctx.markSeen(vm.taskId)} />
        </div>
      )}
      {editor?.field === 'summary' ? (
        <div className="kanban-card-editor" data-kanban-zone onPointerDown={(e) => e.stopPropagation()}>
          <KanbanCardEditor field="summary" card={vm} openedAt={editor.openedAt} api={api} onClose={() => { refocus(false); setEditor(null); }} />
        </div>
      ) : vm.summary ? (
        <div
          className="kanban-card-summary" data-testid="kanban-card-summary" data-kanban-zone
          title={vm.summary.tooltip} data-expanded={expanded ? 'true' : undefined}
          onClick={(e) => { e.stopPropagation(); if (overlay) return; setExpanded((v) => !v); ctx.markSeen(vm.taskId); }}
        >{vm.summary.text}</div>
      ) : null}
      {editor?.field === 'waiting_on' ? (
        <div className="kanban-card-editor" data-kanban-zone onPointerDown={(e) => e.stopPropagation()}>
          <KanbanCardEditor field="waiting_on" card={vm} openedAt={editor.openedAt} api={api} onClose={() => { refocus(false); setEditor(null); }} />
        </div>
      ) : vm.waiting ? (
        vm.waiting.kind === 'text' ? (
          <div className="kanban-card-waiting" data-testid="kanban-card-waiting">
            <span className="kanban-card-waiting-label">Waiting on</span> <span className="kanban-card-waiting-value">{vm.waiting.text}</span>
            {vm.waiting.until && status.kind !== 'waiting-until' ? <span className="kanban-card-waiting-until"> · until {vm.waiting.until}</span> : null}
          </div>
        ) : vm.waiting.kind === 'add-who' ? (
          <button type="button" className="kanban-text-btn kanban-card-add-who" data-testid="kanban-card-waiting"
            aria-disabled={ro || undefined} title={ro ? READ_ONLY_TITLE : 'Say who or what this card waits on'}
            onClick={(e) => { e.stopPropagation(); if (!ro && !overlay) openEditor('waiting_on'); }}>Waiting on: add who</button>
        ) : (
          <div className="kanban-card-parked" data-testid="kanban-card-parked" title="The task parked itself. Nobody placed it in this lane.">
            {/* N11: the status line already says `Waiting until ...`: the date once. */}
            Parked (auto){vm.waiting.until && status.kind !== 'waiting-until' ? <span> · until {vm.waiting.until}</span> : null}
          </div>
        )
      ) : null}
      {vm.suggestion && (
        <div className="kanban-card-suggested" data-testid="kanban-card-suggested" data-kanban-zone>
          <span className="kanban-card-suggested-text" title={vm.suggestion.text}>{vm.suggestion.text}</span>
          {/* N6: the buttons move to a line of their own before the lane name is cut. */}
          <span className="kanban-card-suggested-actions">
          <button type="button" className="kanban-text-btn" data-testid="kanban-card-suggest-accept" aria-disabled={ro || undefined}
            title={ro ? READ_ONLY_TITLE : `Move it to ${vm.suggestion.laneName}`}
            onClick={(e) => { e.stopPropagation(); if (!ro) void api.answerSuggestion(vm.taskId, 'accept'); }}>Accept</button>
          <button type="button" className="kanban-text-btn" data-testid="kanban-card-suggest-dismiss" aria-disabled={ro || undefined}
            title={ro ? READ_ONLY_TITLE : 'Keep it where it is'}
            onClick={(e) => { e.stopPropagation(); if (!ro) void api.answerSuggestion(vm.taskId, 'dismiss'); }}>Dismiss</button>
          </span>
        </div>
      )}
      {/* N12 (spec 6 item 6): a change or a pending move takes the foot's 12px row, one line, cut with a
          tooltip, so a change arriving or clearing never grows the card. It also says what happened (N11). */}
      <div className="kanban-card-foot" data-testid="kanban-card-foot">
        {movingTo ? (
          <span className="kanban-card-foot-change kanban-card-moving" data-testid="kanban-card-moving" title={`Moves to ${movingTo} when the pointer leaves this lane`}>
            <span className="kanban-card-foot-change-text">Moving to {movingTo}</span>
          </span>
        ) : change && !sent ? (
          <span className="kanban-card-foot-change kanban-card-changed" data-testid="kanban-card-changed"
            title={change.more ? `${change.text}\n+${change.more} more: open What changed` : change.text}>
            {/* R3-04: who may be cut, when and +N never are; where it came from is in the tooltip. */}
            <span className="kanban-card-foot-change-text">{change.short}</span>
            {change.clock ? <span className="kanban-card-foot-change-at" data-testid="kanban-card-changed-at"> {change.clock}</span> : null}
            {change.more ? <span className="kanban-card-foot-change-more"> +{change.more}</span> : null}
          </span>
        ) : (
          <span className="kanban-card-active" title={vm.foot.activeTooltip}>{sent ? 'Sent' : vm.foot.activeText}</span>
        )}
        {vm.foot.stale && <span className="kanban-card-stale" data-testid="kanban-card-stale" title={vm.foot.staleTooltip}>{vm.foot.stale}</span>}
        <span className="kanban-card-foot-right">
          {vm.foot.unread && <span className="kanban-card-unread" data-testid="kanban-card-unread" role="img" aria-label="New output you have not seen" title="New output you have not seen" />}
        </span>
        {!overlay && (
          <span className="kanban-card-actions" data-testid="kanban-card-actions" data-kanban-zone onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="kanban-icon-btn" data-testid="kanban-card-open" aria-label="Open session"
              title={vm.hasSession ? 'Open session' : 'Open the task'}
              onClick={(e) => { e.stopPropagation(); ctx.markSeen(vm.taskId); ctx.openSession(vm.taskId, vm.sessionId); }}>{ICON_NEW_TAB}</button>
            <button type="button" className="kanban-icon-btn" data-testid="kanban-card-message" aria-label="Message"
              aria-disabled={ro || !vm.hasSession || undefined}
              title={ro ? READ_ONLY_TITLE : vm.hasSession ? `Message ${cutAt(vm.title, 30)}` : 'No session yet. Use Start worker.'}
              onClick={(e) => { e.stopPropagation(); if (!ro && vm.hasSession) setComposer(true); }}>{ICON_CHAT}</button>
            {!vm.isComplete && (
              <button type="button" className="kanban-icon-btn" data-testid="kanban-card-complete" aria-label="Complete"
                aria-disabled={ro || undefined} title={ro ? READ_ONLY_TITLE : 'Complete'}
                onClick={(e) => { e.stopPropagation(); if (!ro) void api.completeTask(vm.taskId); }}>{ICON_CHECK}</button>
            )}
            <button type="button" ref={moreRef} className="kanban-icon-btn kanban-kebab" data-testid="kanban-card-more" aria-label="More"
              aria-haspopup="menu" aria-expanded={!!menu} title="More"
              onClick={(e) => { e.stopPropagation(); setMenu((m) => (m ? null : { kind: 'button', from: 'kebab' })); }}>⋮</button>
          </span>
        )}
      </div>
      {composer && (
        <div className="kanban-card-composer-host" data-kanban-zone onPointerDown={(e) => e.stopPropagation()}>
          <KanbanCardComposer card={vm} onSent={() => { refocus(false); setComposer(false); setSent(true); ctx.markSeen(vm.taskId); }} onClose={() => { refocus(false); setComposer(false); }} />
        </div>
      )}
      {menu && (
        <KanbanCardMenu
          card={vm} anchor={menu} triggerRef={moreRef} lanes={ctx.lanes} api={api}
          onEdit={(field) => openEditor(field)}
          onClose={(back) => { const kebab = menu.kind === 'button' && menu.from === 'kebab'; setMenu(null); if (back) refocus(kebab); }}
        />
      )}
    </div>
  );
}

const KanbanCardBody = memo(KanbanCardInner);

/**
 * The draggable shell. dnd-kit re-renders every useDraggable when a drag starts and each time it
 * crosses a lane, so the hook lives here and the body re-renders only when its own props change:
 * 37 full cards at a drag start were one long task of 85 to 200ms (C50).
 */
function KanbanCardShell(props: KanbanCardProps) {
  const { vm, overlay } = props;
  const ro = useContext(KanbanCardContext)?.api.readOnly ?? false;
  // A copy (the drag overlay, the keyboard ghost) registers under its own id: dnd-kit keeps one node per id,
  // and a copy unmounting under the card's id would drop the card's own registration with it.
  const drag = useDraggable({ id: overlay ? `copy:${vm.taskId}` : vm.taskId, disabled: ro || overlay || vm.loading, data: { lane: vm.lane } });
  return <KanbanCardBody {...props} dragAttributes={drag.attributes} dragListeners={drag.listeners} setDragNode={drag.setNodeRef} isDragging={drag.isDragging} />;
}

export const KanbanCard = memo(KanbanCardShell);
