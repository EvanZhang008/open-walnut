/**
 * The Ask Walnut slot's header: amber title + the surviving actions on row one,
 * the tab strip on row two.
 *
 * Split out of AskWalnutSlot purely for size. It owns no slot state — every
 * action is a callback, and the selected tab is a prop.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';

/** A task shown as a tab. The just-launched task is not in the store yet, so a
 *  tab is a `{ id, title }` pair rather than a whole Task. */
export interface SlotTab {
  id: string;
  title: string;
}

interface Props {
  visibleTabs: SlotTab[];
  overflowTabs: SlotTab[];
  /** Any tab at all (visible or overflowed) — the strip is hidden when empty. */
  hasTabs: boolean;
  /** null while the slot shows the composer or a pending launch: no tab is
   *  selected then, so none may claim aria-selected. */
  activeTabId: string | null;
  onPickTab: (taskId: string) => void;
  onNew: () => void;
  onOpenTaskComposer: () => void;
  onOpenDraftColumn: () => void;
  /** The session finder overlay. Absent hides the button. */
  onOpenSessionFinder?: () => void;
  onFixWalnut?: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onCloseChat: () => void;
  /** The task composer popover, placed against the "+ Task" button. */
  taskComposer?: ReactNode;
  /** Whether that popover is open — it is placed by useMenuPlacement, which
   *  needs to know when to measure. */
  taskComposerOpen?: boolean;
}

export function AskWalnutSlotHeader({
  visibleTabs, overflowTabs, hasTabs, activeTabId, onPickTab,
  onNew, onOpenTaskComposer, onOpenDraftColumn, onOpenSessionFinder, onFixWalnut,
  inspectorOpen, onToggleInspector, onCloseChat, taskComposer, taskComposerOpen,
}: Props) {
  /** The "+ Task" button — the popover's placement anchor. */
  const taskBtnRef = useRef<HTMLButtonElement>(null);
  // The strip scrolls (hidden scrollbar) when the slot is narrower than its
  // tabs; keep the selected tab fully on screen instead of clipped at an edge.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeTabId) return;
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-task-id="${activeTabId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, visibleTabs]);

  return (
    <div className="ask-walnut-header">
      <div className="ask-walnut-header-top">
        <span className="ask-walnut-title">Ask Walnut</span>
        <div className="ask-walnut-actions">
          <button
            type="button"
            className="session-action-chip ask-walnut-chip"
            data-testid="ask-walnut-new"
            onClick={onNew}
            title="Start a new Ask Walnut session"
          >
            New
          </button>
          <button
            ref={taskBtnRef}
            type="button"
            className="session-action-chip ask-walnut-chip"
            onClick={onOpenTaskComposer}
            title="Create a task without starting a session"
          >
            + Task
          </button>
          <button
            type="button"
            className="session-action-chip ask-walnut-chip"
            onClick={onOpenDraftColumn}
            title="Open a new coding session draft"
          >
            + Session
          </button>
          {onOpenSessionFinder && (
            <button
              type="button"
              className="session-action-chip ask-walnut-chip"
              data-testid="ask-walnut-sessions"
              onClick={onOpenSessionFinder}
              title="Find a session by title, folder or content"
            >
              {'⌕'} Sessions
            </button>
          )}
          {onFixWalnut && (
            <button
              type="button"
              className="session-action-chip ask-walnut-chip"
              data-testid="ask-walnut-fix"
              onClick={onFixWalnut}
              title="Describe what's broken — opens a session in Walnut's own checkout"
            >
              {'\u{1F527}'} Fix Walnut
            </button>
          )}
          <button
            type="button"
            className={`session-action-chip ask-walnut-chip${inspectorOpen ? ' session-action-chip-active' : ''}`}
            data-testid="ask-walnut-inspector"
            aria-pressed={inspectorOpen}
            onClick={onToggleInspector}
            title={inspectorOpen ? 'Hide the launch context' : "Show the selected session's launch context"}
          >
            Context
          </button>
          <button
            type="button"
            className="task-action-btn ask-walnut-close"
            onClick={onCloseChat}
            title="Hide Ask Walnut"
            aria-label="Hide Ask Walnut"
          >
            &times;
          </button>
        </div>
      </div>

      {hasTabs && (
        <div
          ref={tabsRef}
          className="ask-walnut-tabs"
          data-testid="ask-walnut-tabs"
          role="tablist"
          aria-label="Ask Walnut sessions"
        >
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              data-testid="ask-walnut-tab"
              data-task-id={tab.id}
              className={`ask-walnut-tab${tab.id === activeTabId ? ' is-active' : ''}`}
              onClick={() => onPickTab(tab.id)}
              title={tab.title}
            >
              {tab.title}
            </button>
          ))}
          {overflowTabs.length > 0 && (
            <AskWalnutTabOverflow tabs={overflowTabs} onPick={onPickTab} />
          )}
        </div>
      )}

      {taskComposer && (
        <AskWalnutTaskPopover open={taskComposerOpen === true} anchorRef={taskBtnRef}>
          {taskComposer}
        </AskWalnutTaskPopover>
      )}
    </div>
  );
}

/**
 * The "+ Task" popover — portalled to <body> and placed by useMenuPlacement.
 *
 * It used to be a hand-placed `position: absolute; top: 100%` box inside this
 * header, which lives in an `overflow: hidden` slot: a form taller than the room
 * below the header was CLIPPED, with its Create/Cancel buttons unreachable and no
 * scrollbar to reach them (the menus-and-overlays rules in web/src/AGENTS.md).
 * The hook measures the real height, flips up when there is more room above,
 * clamps to the viewport and hands back a `maxHeight` that the wrapper's
 * `overflow-y: auto` turns into an internal scroll.
 *
 * Portals escape clipping, not bubbling — hence the pointerdown stop, so the form
 * can never reach a drag sensor above it in the React tree.
 */
function AskWalnutTaskPopover(
  { open, anchorRef, children }: {
    open: boolean;
    anchorRef: RefObject<HTMLButtonElement | null>;
    children: ReactNode;
  },
) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 'left': the popover opens RIGHTWARD from the "+ Task" chip, which sits
  // mid-row — right-aligning it hid the very button that opened it.
  const placement = useMenuPlacement(open, anchorRef, menuRef, { align: 'left' });
  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="ask-walnut-task-popover"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * The "⋯" tab overflow — its OWN portalled flyout placed by useMenuPlacement, so
 * a long list of asks scrolls inside the menu instead of running off the
 * viewport. Portals escape clipping, not bubbling: the pointerdown stop keeps the
 * click out of any drag sensor above, and the outside-click closer checks the
 * menu ref (which lives on <body>) as well as the trigger.
 */
function AskWalnutTabOverflow({ tabs, onPick }: { tabs: SlotTab[]; onPick: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { onAnchorLost: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ask-walnut-tab ask-walnut-tab-more"
        data-testid="ask-walnut-more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${tabs.length} more Ask Walnut ${tabs.length === 1 ? 'session' : 'sessions'}`}
      >
        &#x22EF;
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="ask-walnut-more-menu"
          role="menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitem"
              className="ask-walnut-more-item"
              // NOT `ask-walnut-tab`: an overflow ROW is not a rendered tab, and
              // sharing the id made every "how many tabs are inline" assertion
              // count menu items it could not see.
              data-testid="ask-walnut-tab-overflow-item"
              data-task-id={tab.id}
              onClick={() => { onPick(tab.id); setOpen(false); }}
              title={tab.title}
            >
              {tab.title}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
